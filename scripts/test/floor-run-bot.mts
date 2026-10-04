// Headless bot playthrough: a run dropped on floor 3 (built by the real floor
// transition, armed kit), then played through the real systems with per-tick
// inputs only. It fights, opens and picks doors, works the objective's access
// gate (fetches the keycard, hacks the generator, kills the Spore Node, or
// breaches with the special's grenade), completes the mission and walks onto
// the exit.
//
//   pnpm exec tsx scripts/test/floor-run-bot.mts [seeds=1,2,3] [floorsToClear=2] [maxTicksPerFloor=12000] [mode=normal|casual]
//
// `casual` (endless self-revives) separates "the floor cannot be finished"
// from "the bot lost the fight": a casual run that times out is stuck.
//
// A seed passes when it clears `floorsToClear` floors from 3, i.e. arrives on
// floor 3 + floorsToClear through the exit. Exit code 1 when any seed fails.
// BOT_HP=1 logs hp and goal every second; BOT_TRACE=1 logs blasts and breaches.
import { tickWorld, createWorld, type World } from '../../src/game/world' // FIRST: breaks the world↔ai import cycle under tsx
import type { Entity } from '../../src/game/entity'
import { hasLineOfSight } from '../../src/game/los'
import { findPath } from '../../src/game/path'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { applyScenario } from '../../src/game/scenarios'
import { playerSpawnPoint } from '../../src/game/spawnPlacement'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput, type InputCmd } from '../../src/game/types'

const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number)
const floorsToClear = Number(process.argv[3] ?? 2)
const maxTicks = Number(process.argv[4] ?? 12000)
const mode = process.argv[5] === 'casual' ? 'casual' : 'normal'
const START_FLOOR = 3
const FIGHT_RANGE = 8
const SHOOT_RANGE = 5
const THROW_STANDOFF = 3.2

type Pt = { x: number; y: number }
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const centre = (p: Pt): Pt => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 })

const boot = (seed: number): { w: World; p: Entity } => {
  const w = createWorld(seed, 1, mode)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  const p = spawnPlayer(w, 0, at.x, at.y)
  applyScenario(w, 'armed', { floor: START_FLOOR })
  return { w, p }
}

/** What the bot is after this tick. `shoot` targets are killed from range,
 * `use` targets are pressed when adjacent, `walk` targets are stood on, and a
 * `breach` target gets a grenade from a standoff. */
type Goal = { at: Pt; act: 'walk' | 'shoot' | 'use' | 'breach'; what: string; ent?: Entity; gate?: Entity }

/** Ticks the bot works one way into a gate before it gives up and breaches. */
const GATE_PATIENCE = 900

const gateOf = (w: World): Entity | undefined => {
  const id = w.mission.objectiveDoorId
  const gate = id !== undefined ? w.byId.get(id) : undefined
  return gate?.door && !gate.door.open && !gate.dead ? gate : undefined
}

const holds = (p: Entity, itemId: string): boolean => (p.loadout?.inventory ?? []).some((s) => s.itemId === itemId)

const tileKey = (w: World, at: Pt): number => Math.floor(at.y) * w.level.w + Math.floor(at.x)

/** Door tiles no hand can open right now: overgrown hatches, power seals, and
 * keycard seals without the card. A plain lock is pickable, so it is not here. */
const sealedDoors = (w: World, p: Entity): Set<number> => {
  const out = new Set<number>()
  for (const e of w.entities) {
    const d = e.door
    if (!d || e.dead || d.open) continue
    const sealed = d.overgrown || d.sealKind === 'power' || (d.sealKind === 'keycard' && !(d.keyId && holds(p, d.keyId)))
    if (sealed) out.add(tileKey(w, e.pos))
  }
  return out
}

const routeTo = (w: World, p: Entity, at: Pt, bestEffort = false): Pt[] | null =>
  findPath(w.level, p.pos.x, p.pos.y, at.x, at.y, { maxNodes: 1_000_000, lockedDoors: sealedDoors(w, p), bestEffort })

const reachable = (w: World, p: Entity, at: Pt): boolean => routeTo(w, p, at) !== null

const pickGoal = (w: World, p: Entity, breachOnly: Set<number>): Goal => {
  const target = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  if (!w.mission.complete && target && !target.dead) {
    const gate = gateOf(w)
    if (gate?.door && (gate.door.locked || gate.door.overgrown)) {
      const d = gate.door
      if (breachOnly.has(tileKey(w, gate.pos))) {
        // fall through to the breach below
      } else if (d.sealKind === 'keycard' && d.keyId && !holds(p, d.keyId)) {
        const card = w.entities.find((e) => e.pickup?.itemId === d.keyId)
        if (card && reachable(w, p, card.pos)) return { at: card.pos, act: 'walk', what: 'keycard', ent: card, gate }
      } else if (d.sealKind === 'keycard') {
        return { at: gate.pos, act: 'use', what: 'gate(keycard)', ent: gate, gate }
      } else if (d.sealKind === 'power') {
        const gen = w.entities.find((e) => e.wing === d.wing && e.archetype === 'generator' && !e.dead)
        if (gen && reachable(w, p, gen.pos)) return { at: gen.pos, act: 'use', what: 'generator', ent: gen, gate }
      } else if (d.overgrown) {
        const node = d.nodeId !== undefined ? w.byId.get(d.nodeId) : undefined
        if (node && !node.dead && reachable(w, p, node.pos)) return { at: node.pos, act: 'shoot', what: 'gate node', ent: node, gate }
      } else {
        return { at: gate.pos, act: 'use', what: 'gate(pick)', ent: gate, gate }
      }
      return { at: gate.pos, act: 'breach', what: 'gate breach', ent: gate }
    }
    return { at: target.pos, act: target.pickup ? 'walk' : 'shoot', what: `mission ${target.archetype}`, ent: target }
  }
  return { at: centre(w.mission.extractPoint ?? w.level.exit), act: 'walk', what: 'exit' }
}

const nearestFoe = (w: World, p: Entity): Entity | undefined => {
  let best: Entity | undefined
  let bestD = FIGHT_RANGE
  for (const e of w.entities) {
    if (e.kind !== 'npc' || e.dead || !e.health) continue
    const d = dist(e.pos, p.pos)
    if (d < bestD && hasLineOfSight(w.level, p.pos.x, p.pos.y, e.pos.x, e.pos.y)) {
      best = e
      bestD = d
    }
  }
  return best
}

const closedDoorAhead = (w: World, p: Entity, toward: Pt): Entity | undefined => {
  let best: Entity | undefined
  let bestD = 2.2
  for (const e of w.entities) {
    if (!e.door || e.dead || e.door.open) continue
    const d = dist(e.pos, p.pos)
    if (d < bestD && dist(e.pos, toward) < dist(p.pos, toward) + 1) {
      best = e
      bestD = d
    }
  }
  return best
}

interface FloorReport {
  floor: number
  biome: string
  archetype: string
  mission: string
  gate: string
  npcs: number
  pickups: number
  completedAt?: number
  exitedAt?: number
  doors: number
  picks: number
  throws: number
  kills: number
  downs: number
  minHp: number
  stuck?: string
}

const play = (seed: number): { ok: boolean; floors: FloorReport[] } => {
  const { w, p } = boot(seed)
  const floors: FloorReport[] = []
  const startOf = (): FloorReport => {
    const gate = gateOf(w)?.door
    return {
      floor: w.floor,
      biome: w.level.complex?.biome ?? `city:${w.level.theme}`,
      archetype: w.level.complex?.archetype ?? '-',
      mission: w.mission.template,
      gate: gate ? (gate.overgrown ? 'overgrown' : (gate.sealKind ?? (gate.locked ? 'pick' : 'open'))) : 'none',
      npcs: w.entities.filter((e) => e.kind === 'npc' && !e.dead).length,
      pickups: w.entities.filter((e) => e.pickup).length,
      doors: 0,
      picks: 0,
      throws: 0,
      kills: 0,
      downs: 0,
      minHp: p.health!.hp,
    }
  }
  let cur = startOf()
  let floorTick = 0
  let lastPos = { ...p.pos }
  let stuckTicks = 0
  let waitUntil = 0
  let route: Pt[] = []
  let routeKey = ''
  const breachOnly = new Set<number>()
  const gateTicks = new Map<number, number>()
  const pickTries = new Map<number, number>()
  let wasDowned = false

  while (floors.length < floorsToClear) {
    if (floorTick > maxTicks || w.gameOver) {
      const g = pickGoal(w, p, breachOnly)
      cur.stuck = `${w.gameOver ? 'run over' : 'out of time'} at (${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)}) going for ${g.what}@(${g.at.x.toFixed(1)},${g.at.y.toFixed(1)})`
      floors.push(cur)
      return { ok: false, floors }
    }
    const cmd: InputCmd = { ...emptyInput(), seq: w.tick }
    if (p.playerCtl!.draft) cmd.draftPick = 0

    const goal = pickGoal(w, p, breachOnly)
    if (goal.gate) {
      const key = tileKey(w, goal.gate.pos)
      gateTicks.set(key, (gateTicks.get(key) ?? 0) + 1)
      if (gateTicks.get(key)! > GATE_PATIENCE) breachOnly.add(key)
    }
    const foe = nearestFoe(w, p)
    if (foe) {
      cmd.aimX = foe.pos.x - p.pos.x
      cmd.aimY = foe.pos.y - p.pos.y
      cmd.attack = true
    }

    const d = dist(p.pos, goal.at)
    const sees = hasLineOfSight(w.level, p.pos.x, p.pos.y, goal.at.x, goal.at.y)
    const busy = w.tick < waitUntil || !!p.playerCtl!.channel
    if (goal.act === 'shoot' && d < SHOOT_RANGE && sees) {
      cmd.aimX = goal.at.x - p.pos.x
      cmd.aimY = goal.at.y - p.pos.y
      cmd.attack = true
    } else if (goal.act === 'use' && d < 1.2 && !busy) {
      cmd.interact = true
      if (goal.ent?.door) cur.picks++
      waitUntil = w.tick + (goal.ent?.door ? 170 : 15)
    } else if (goal.act === 'breach' && d < THROW_STANDOFF + 1.5 && d > THROW_STANDOFF - 1 && sees && !busy) {
      cmd.aimX = goal.at.x - p.pos.x
      cmd.aimY = goal.at.y - p.pos.y
      cmd.attack = false
      if (p.playerCtl!.abilityCooldown <= 0) {
        cmd.special = true
        cur.throws++
        waitUntil = w.tick + 50
      }
    } else if (!busy) {
      const away = goal.act === 'breach' && d <= THROW_STANDOFF - 1
      const aim = away ? { x: p.pos.x + (p.pos.x - goal.at.x), y: p.pos.y + (p.pos.y - goal.at.y) } : goal.at
      const key = `${goal.what}:${Math.floor(aim.x)},${Math.floor(aim.y)}`
      if (key !== routeKey || route.length === 0 || stuckTicks === 30) {
        route = routeTo(w, p, aim, true) ?? []
        routeKey = key
      }
      while (route.length > 0 && dist(p.pos, route[0]) < 0.35) route.shift()
      const next = route[0] ?? centre(aim)
      const len = dist(next, p.pos) || 1
      cmd.moveX = (next.x - p.pos.x) / len
      cmd.moveY = (next.y - p.pos.y) / len
      if (stuckTicks > 15) {
        const door = closedDoorAhead(w, p, next)
        const dd = door?.door
        if (dd && !dd.locked && !dd.overgrown) {
          cmd.interact = true
          cur.doors++
          waitUntil = w.tick + 10
        } else if (dd && dd.locked && !dd.overgrown && (dd.sealKind === undefined || dd.sealKind === 'pick')) {
          const tries = (pickTries.get(door!.id) ?? 0) + 1
          pickTries.set(door!.id, tries)
          if (tries > 2 && p.playerCtl!.abilityCooldown <= 0) {
            // Picks keep getting interrupted: blow it from where we stand.
            cmd.aimX = door!.pos.x - p.pos.x
            cmd.aimY = door!.pos.y - p.pos.y
            cmd.attack = false
            cmd.special = true
            cur.throws++
            waitUntil = w.tick + 40
          } else if (!foe) {
            cmd.interact = true
            cur.picks++
            waitUntil = w.tick + 170
          }
        }
        if (dd) {
          cmd.moveX = 0
          cmd.moveY = 0
          stuckTicks = 0
        }
      }
    }

    const floorBefore = w.floor
    tickWorld(w, new Map([[0, cmd]]))
    floorTick++
    for (const ev of w.events) {
      if (ev.type === 'death') cur.kills++
      if (process.env.BOT_TRACE && (ev.type === 'explosion' || ev.type === 'doorBreach')) console.log(`    t${floorTick} ${JSON.stringify(ev)} p=(${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)}) goal=${goal.what}@(${goal.at.x.toFixed(1)},${goal.at.y.toFixed(1)})`)
    }
    const downed = !!p.playerCtl!.downed
    if (downed && !wasDowned) cur.downs++
    wasDowned = downed
    cur.minHp = Math.min(cur.minHp, p.health!.hp)
    if (process.env.BOT_HP && floorTick % 30 === 0) {
      const near = w.entities.filter((e) => e.kind === 'npc' && !e.dead && dist(e.pos, p.pos) < 6).map((e) => e.archetype)
      console.log(`    t${floorTick} hp=${p.health!.hp} downed=${!!p.playerCtl!.downed} p=(${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)}) goal=${goal.what}@(${goal.at.x.toFixed(1)},${goal.at.y.toFixed(1)}) fx=${JSON.stringify(p.fx ?? {})} near=${near.join(',')}`)
    }
    if (w.mission.complete && cur.completedAt === undefined) cur.completedAt = floorTick
    if (w.floor !== floorBefore) {
      cur.exitedAt = floorTick
      floors.push(cur)
      cur = startOf()
      floorTick = 0
      route = []
      routeKey = ''
      stuckTicks = 0
      waitUntil = 0
      breachOnly.clear()
      gateTicks.clear()
      pickTries.clear()
    }
    stuckTicks = dist(p.pos, lastPos) < 0.02 && (cmd.moveX !== 0 || cmd.moveY !== 0) ? stuckTicks + 1 : 0
    lastPos = { ...p.pos }
  }
  floors.push(startOf())
  return { ok: true, floors }
}

let failures = 0
for (const seed of seeds) {
  const { ok, floors } = play(seed)
  if (!ok) failures++
  console.log(`seed ${seed}: ${ok ? 'CLEARED' : 'FAILED'} floors ${START_FLOOR}..${START_FLOOR + floorsToClear - 1}${ok ? `, arrived on floor ${START_FLOOR + floorsToClear}` : ''}`)
  for (const f of floors) {
    const played = f.exitedAt !== undefined || f.stuck
    console.log(
      `  floor ${f.floor} ${f.biome}/${f.archetype} mission=${f.mission} gate=${f.gate} npcs=${f.npcs} pickups=${f.pickups}` +
        (played
          ? ` | done@${f.completedAt ?? '-'} exit@${f.exitedAt ?? '-'} kills=${f.kills} doors=${f.doors} picks=${f.picks} throws=${f.throws} downs=${f.downs} minHp=${f.minHp}`
          : ' | arrived') +
        (f.stuck ? `\n    STUCK: ${f.stuck}` : ''),
    )
  }
}
process.exit(failures > 0 ? 1 : 0)
