import { makeEntity, SPAWN_GRACE_TICKS, type Entity } from '../entity'
import { generateLevel } from '../levelgen/generate'
import { Tile, type Building } from '../levelgen/level'
import { populateWorld, spawnNpc } from '../populate'
import type { Rng } from '../rng'
import { spawnObject } from './objects'
import { spawnSporeBurst } from './spore'
import { addEntity, type World } from '../world'

export const setupFloor = (w: World): void => {
  // Mission first — door locking depends on which building it targets.
  generateMission(w)
  spawnDoors(w)
  // …then dress the objective's gateway as a real access puzzle (Sporefall):
  // a biolock or an overgrown hatch, with its key/generator/Spore Node placed.
  applyAccessGate(w)
}

/** Absolute-tick countdown a `contain` Spore Node gets before it blooms. Long
 * enough to fight to it and burn it back; short enough that dawdling floods the
 * room (a soft-fail — harder, never a loss). ~40s at 30tps. */
const BLOOM_TICKS = 40 * 30
/** Bog integrity of an overgrown gateway hatch — fire erodes it (interaction). */
const GATEWAY_GROWTH_HP = 12

/** Door entities on every building door tile. Mission building's exterior doors are locked. */
const spawnDoors = (w: World): void => {
  for (let i = 0; i < w.level.buildings.length; i++) {
    const b = w.level.buildings[i]
    for (const d of b.doors) {
      const e = makeEntity('door', 'door', d.x + 0.5, d.y + 0.5, 0.5)
      const isMissionBuilding = i === w.mission.targetBuilding
      // Locks harden with depth: the lock level sets the pick-channel LENGTH
      // (see interaction.pickTicks) — L1 on floors 1-2, L2 from floor 3. Every
      // level is pickable by the default player; grenades breach as the loud
      // alternative (combat.detonate), so mission doors never dead-end a run.
      const lockLevel = isMissionBuilding ? Math.min(2, 1 + Math.floor((w.floor - 1) / 2)) : 0
      e.door = { open: false, locked: isMissionBuilding, lockLevel }
      e.interact = { verb: 'open', range: 1.3 }
      addEntity(w, e)
    }
  }
}

const generateMission = (w: World): void => {
  const rng = w.rng.fork('mission')
  const building = farthestBuilding(w)
  const buildingIdx = building ? w.level.buildings.indexOf(building) : -1

  if (!building) {
    w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Reach the exit' }
    return
  }

  // Deep floors (5+) are the bog's heart: the mission itself becomes a Sporefall
  // objective — CONTAIN a blooming Spore Node, or INFILTRATE past a biolock to a
  // Mireclaw. Gated to floor >= 5 (nothing pins deep floors), and drawn only
  // there: the `&&` short-circuits on shallow floors so the mission RNG stream
  // stays byte-identical to the frozen steal/assassinate placement table.
  if (w.floor >= 5 && generateSporefallMission(w, rng, building, buildingIdx)) return

  if (rng.chance(0.5)) {
    const spot = roomCenter(building)
    const item = makeEntity('pickup', 'pickup.briefcase', spot.x, spot.y, 0.3)
    item.pickup = { itemId: 'briefcase', qty: 1 }
    addEntity(w, item)
    w.mission = {
      template: 'steal',
      targetEntityId: item.id,
      targetBuilding: buildingIdx,
      complete: false,
      exitUnlocked: false,
      description: `Steal the briefcase from the ${building.role}`,
    }
  } else {
    const spot = roomCenter(building)
    const boss = spawnNpc(w, 'boss', spot.x, spot.y)
    w.mission = {
      template: 'assassinate',
      targetEntityId: boss.id,
      targetBuilding: buildingIdx,
      complete: false,
      exitUnlocked: false,
      description: `Take out the boss in the ${building.role}`,
    }
  }
}

/** Deep-floor (5+) Sporefall objective. Returns true if it claimed the mission.
 *  contain    — a Spore Node grows in the core; destroy it before it blooms.
 *  infiltrate — a Mireclaw hides behind a biolock; get past it and put it down.
 * The gateway seal + key/generator/node are placed later by applyAccessGate,
 * which reads w.mission.template, so the two stay in lock-step. */
const generateSporefallMission = (w: World, rng: Rng, building: Building, buildingIdx: number): boolean => {
  const spot = roomCenter(building)
  if (rng.chance(0.5)) {
    const node = spawnObject(w, 'sporeNode', Math.floor(spot.x), Math.floor(spot.y))
    w.mission = {
      template: 'contain',
      targetEntityId: node.id,
      targetBuilding: buildingIdx,
      complete: false,
      exitUnlocked: false,
      description: `Destroy the Spore Node in the ${building.role} before it blooms`,
      bloomTick: w.tick + BLOOM_TICKS,
    }
  } else {
    const boss = spawnNpc(w, 'boss', spot.x, spot.y)
    w.mission = {
      template: 'infiltrate',
      targetEntityId: boss.id,
      targetBuilding: buildingIdx,
      complete: false,
      exitUnlocked: false,
      description: `Breach the biolock and take out the Mireclaw in the ${building.role}`,
    }
  }
  return true
}

/**
 * Dress the mission building's GATEWAY (the door nearest the objective room) as
 * a real access puzzle — the heart of the redesign. The scheme is chosen to fit
 * the template (contain → overgrown, infiltrate → biolock, steal/assassinate →
 * any of the three) from a DEDICATED `access` fork, so it never perturbs the
 * mission/loot/populate streams. Every scheme leaves the BREACH path open (a
 * grenade opens any hatch — combat.detonate), and places its own soft key
 * (keycard / generator / a reachable Spore Node), so a run is never dead-ended.
 * Only floors >= 2 are gated (floor 1 stays the tutorial city of plain locks).
 */
const applyAccessGate = (w: World): void => {
  if (w.floor < 2) return
  const bi = w.mission.targetBuilding
  if (bi === undefined || bi < 0) return
  const building = w.level.buildings[bi]
  const doors = buildingDoors(w, building)
  if (doors.length === 0) return
  const rng = w.rng.fork('access')
  const room = building.objectiveRoom ?? building.rect
  const cx = room.x + room.w / 2
  const cy = room.y + room.h / 2
  // The gateway is the door nearest the objective room; outer doors stay plain
  // (pickable) so only the LAST step is gated — never the whole building.
  const gate = doors.reduce((best, d) =>
    Math.hypot(d.pos.x - cx, d.pos.y - cy) < Math.hypot(best.pos.x - cx, best.pos.y - cy) ? d : best,
  )
  const wing = `wing${bi}`
  // contain → overgrown; infiltrate → biolock (keycard/power); else free choice.
  const scheme =
    w.mission.template === 'contain'
      ? 2
      : w.mission.template === 'infiltrate'
        ? rng.int(0, 1)
        : rng.int(0, 2)

  if (scheme === 0) {
    // Keycard biolock: card carried in a cargo pod elsewhere in the building.
    gate.door!.locked = true
    gate.door!.sealKind = 'keycard'
    gate.door!.keyId = `keycard.${wing}`
    gate.door!.wing = wing
    placeKeycard(w, building, `keycard.${wing}`, rng)
  } else if (scheme === 1) {
    // Power biolock: cut the wing at its generator (the loud, systemic key).
    gate.door!.locked = true
    gate.door!.sealKind = 'power'
    gate.door!.wing = wing
    placeGenerator(w, building, wing, rng)
  } else {
    // Overgrown hatch fed by a Spore Node. For a `contain` mission the node IS
    // the objective (already placed); otherwise spawn a fresh, reachable node.
    gate.door!.locked = true
    gate.door!.overgrown = true
    gate.door!.growthHp = GATEWAY_GROWTH_HP
    gate.flammable = true // fire can catch on the bog and erode the growth
    const nodeId =
      w.mission.template === 'contain' && w.mission.targetEntityId !== undefined
        ? w.mission.targetEntityId
        : placeSporeNode(w, building, rng)?.id
    if (nodeId !== undefined) gate.door!.nodeId = nodeId
  }
}

/** Door entities standing on this building's door tiles. */
const buildingDoors = (w: World, building: Building): Entity[] =>
  w.entities.filter(
    (e) => e.door && building.doors.some((d) => d.x === Math.floor(e.pos.x) && d.y === Math.floor(e.pos.y)),
  )

/** A random interior Floor tile of the building (never spawn/exit), or null. */
const randomFloorTile = (w: World, building: Building, rng: Rng): { tx: number; ty: number } | null => {
  const sx = Math.floor(w.level.spawn.x)
  const sy = Math.floor(w.level.spawn.y)
  for (let attempt = 0; attempt < 24; attempt++) {
    const tx = rng.int(building.rect.x + 1, building.rect.x + building.rect.w - 2)
    const ty = rng.int(building.rect.y + 1, building.rect.y + building.rect.h - 2)
    if (w.level.tiles[ty * w.level.w + tx] !== Tile.Floor) continue
    if (tx === sx && ty === sy) continue
    if (tx === w.level.exit.x && ty === w.level.exit.y) continue
    return { tx, ty }
  }
  return null
}

/** Drop the wing keycard in a cargo pod somewhere in the building (reachable —
 * outside the gate it opens). Guaranteed by breach even if placement fails. */
const placeKeycard = (w: World, building: Building, keyId: string, rng: Rng): void => {
  const t = randomFloorTile(w, building, rng)
  if (!t) return
  const e = makeEntity('pickup', `pickup.${keyId}`, t.tx + 0.5, t.ty + 0.5, 0.3)
  e.pickup = { itemId: keyId, qty: 1 }
  addEntity(w, e)
}

/** Spawn the wing's generator inside the building — hacking it cuts the wing. */
const placeGenerator = (w: World, building: Building, wing: string, rng: Rng): void => {
  const t = randomFloorTile(w, building, rng)
  if (!t) return
  const gen = spawnObject(w, 'generator', t.tx, t.ty)
  gen.wing = wing
}

/** Spawn a reachable Spore Node (its death un-overgrows the linked gateway). */
const placeSporeNode = (w: World, building: Building, rng: Rng): Entity | null => {
  const t = randomFloorTile(w, building, rng)
  if (!t) return null
  return spawnObject(w, 'sporeNode', t.tx, t.ty)
}

const farthestBuilding = (w: World): Building | null => {
  let best: Building | null = null
  let bestDist = -1
  for (const b of w.level.buildings) {
    const cx = b.rect.x + b.rect.w / 2
    const cy = b.rect.y + b.rect.h / 2
    const d = Math.hypot(cx - w.level.spawn.x, cy - w.level.spawn.y)
    if (d > bestDist) {
      best = b
      bestDist = d
    }
  }
  return best
}

/** Centre of the building's EXPLICIT objective room — the room its generator
 * designated for mission targets (bunker core, vault, loop core, …). No array-
 * order inference: if a generator forgot to designate one, fall back to the
 * whole interior so the target still lands inside the building. */
const roomCenter = (b: Building): { x: number; y: number } => {
  const room = b.objectiveRoom ?? { x: b.rect.x + 1, y: b.rect.y + 1, w: b.rect.w - 2, h: b.rect.h - 2 }
  return { x: room.x + room.w / 2, y: room.y + room.h / 2 }
}

export const missionSystem = (w: World): void => {
  if (w.gameOver) return

  if (!w.mission.complete) {
    if (w.mission.template === 'steal') {
      const holder = w.entities.find(
        (e) => e.playerCtl && e.playerCtl.inventory.some((s) => s.itemId === 'briefcase'),
      )
      if (holder) completeMission(w)
    } else if (
      w.mission.template === 'assassinate' ||
      w.mission.template === 'infiltrate' ||
      w.mission.template === 'contain'
    ) {
      // All three complete when their target is gone — the boss/Mireclaw is
      // dead, or the Spore Node is destroyed (by ANY cause: shot, burned, blasted).
      const target = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
      if (!target || target.dead) completeMission(w)
      else if (w.mission.template === 'contain') maybeBloom(w, target)
    }
  }

  // Floor transition: any live player standing on the unlocked exit tile
  if (w.mission.exitUnlocked) {
    for (const e of w.entities) {
      if (!e.playerCtl || e.playerCtl.downed || e.dead) continue
      if (Math.floor(e.pos.x) === w.level.exit.x && Math.floor(e.pos.y) === w.level.exit.y) {
        nextFloor(w)
        return
      }
    }
  }

  // Run over: nobody is left standing AND nobody can still be saved. This is a
  // real game-over — the session stays connected (the transport is untouched),
  // and a host-driven `restart()` rebuilds the run in place, so "play again"
  // needs no reconnect or app restart. See NetHostSession.restart / the overlay.
  //
  // The lone downed player is the one exception: with no teammate to revive them
  // they bleed out to a SELF-revive (interaction.ts), so a solo down is not yet a
  // loss — only a solo *death* (the revive pool ran dry, marked dead by kill) is.
  // A co-op wipe (2+ players, all down/dead) has no possible rescuer → run over.
  const players = w.entities.filter((e) => e.playerCtl)
  if (players.length === 0) return
  if (!players.every((e) => e.playerCtl!.downed || e.dead)) return
  if (players.length === 1 && !players[0].dead) return
  w.gameOver = true
  w.events.push({ type: 'runOver', floor: w.floor })
}

/** `contain` soft-fail: if the Spore Node lives past its bloom tick, it BLOOMS —
 * a spore gout floods the core (harder to fight through), latched once. This is
 * never a loss: the objective is still to destroy the node, just now amid spores. */
const maybeBloom = (w: World, node: Entity): void => {
  if (w.mission.bloomed || w.mission.bloomTick === undefined) return
  if (w.tick < w.mission.bloomTick) return
  w.mission.bloomed = true
  spawnSporeBurst(w, Math.floor(node.pos.x), Math.floor(node.pos.y))
  w.events.push({ type: 'bloom', x: node.pos.x, y: node.pos.y, entityId: node.id })
}

const completeMission = (w: World): void => {
  w.mission.complete = true
  w.mission.exitUnlocked = true
  w.events.push({ type: 'missionComplete', description: w.mission.description })
}

/** Regenerate the world in place for the next floor, carrying players over. */
export const nextFloor = (w: World): void => {
  const players = w.entities.filter((e) => e.playerCtl)
  w.floor++
  w.level = generateLevel(w.seed, w.floor)
  w.entities = []
  w.byId.clear()
  w.rng = w.baseRng.fork(`sim:${w.floor}`)
  for (const p of players) {
    p.pos.x = w.level.spawn.x
    p.pos.y = w.level.spawn.y
    p.prevPos.x = p.pos.x
    p.prevPos.y = p.pos.y
    p.vel.x = 0
    p.vel.y = 0
    if (p.health) {
      p.health.hp = Math.max(p.health.hp, Math.floor(p.health.max / 2))
      // Fresh-floor landing gets the same spawn grace as a fresh run.
      p.health.iframes = SPAWN_GRACE_TICKS
    }
    if (p.playerCtl) {
      p.playerCtl.downed = undefined
      p.playerCtl.channel = undefined
      p.playerCtl.crimeUntilTick = 0
      // Key items don't carry across floors
      p.playerCtl.inventory = p.playerCtl.inventory.filter((s) => s.itemId !== 'briefcase')
    }
    p.dead = false
    w.entities.push(p)
    w.byId.set(p.id, p)
  }
  w.alarm = 0
  w.powerCut = {} // a fresh floor is fully powered again
  populateWorld(w)
  setupFloor(w)
  w.events.push({ type: 'floorChange', floor: w.floor })
}
