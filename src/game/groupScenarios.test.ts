// The group-layer set-pieces (`?scenario=tide-*`, `hound-ring`, `hive-spread`)
// are the reproducible "interesting situations" a capture agent records and
// shares via `?state=` (docs/testing-video.md). Three promises are tested here:
//   1. they are SHAREABLE — they never touch a tile, so a world captured from
//      one restores through deserializeWorld (which refuses a level drift);
//   2. they are REPRODUCIBLE — on the documented seed, the moment each one
//      exists to show really happens, on the same tick, every time;
//   3. they survive REAL PLAY — staged the way the app stages them (HostSession:
//      mission + doors from setupFloor, the free spawn tile), with a player who
//      stands still AND one who moves and shoots, the beat lands inside ~15s.
//
// Promise 3 is the one that was missing. The old harness skipped setupFloor, so
// the floor had no mission: on the live link the player was sealed into the
// room holding the briefcase, picked it up on tick 1, and the mission's station
// alert threw every "locked" door open before the Blast Diver arrived. The
// medic's grunts spawned already beside the medic (no retreat to see) and were
// then shot dead by their own raid. The test passed throughout.

import { describe, expect, it } from 'vitest'
import type { Entity } from './entity'
import { levelChecksum } from './levelgen/level'
import { spawnPlayer } from './player'
import { populateWorld } from './populate'
import { applyScenario, GROUP_SCENARIOS } from './scenarios'
import { deserializeWorld, serializeWorld } from './serialize'
import { playerSpawnPoint } from './spawnPlacement'
import { HEAL_RANGE, RETREAT_FRAC, RETURN_FRAC } from './systems/groups'
import { setupFloor } from './systems/missions'
import { emptyInput, SIM_RATE, type InputCmd, type SimEvent } from './types'
import { createWorld, tickWorld, type World } from './world'

/** The seed every group scenario is documented against (docs/design/enemy-groups.md). */
const GROUP_SCENARIO_SEED = 3
const S = SIM_RATE

/** Stage a scenario exactly as the app does for `?mode=solo&seed=N&scenario=…`:
 * HostSession.buildRun (populate, setupFloor, the free spawn tile), then
 * applyScenario on top (main.ts). */
const stage = (name: string, seed = GROUP_SCENARIO_SEED): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  applyScenario(w, name)
  return w
}

const player = (w: World) => w.entities.find((e) => e.playerCtl)!
const raiders = (w: World): Entity[] => w.entities.filter((e) => !e.dead && e.ai?.group)

/** A player's input for this tick. */
type Pilot = (w: World) => InputCmd

/** Touches nothing: the owner watching the set-piece. */
const idle: Pilot = () => emptyInput()

/** Fights: circle-strafes and holds the trigger on the nearest live raider. */
const fighter: Pilot = (w) => {
  const me = player(w)
  const cmd = emptyInput()
  const phase = (w.tick / (1.5 * S)) * Math.PI
  cmd.moveX = Math.cos(phase)
  cmd.moveY = Math.sin(phase)
  let best: Entity | undefined
  let bd = Infinity
  for (const r of raiders(w)) {
    const d = Math.hypot(r.pos.x - me.pos.x, r.pos.y - me.pos.y)
    if (d < bd) {
      bd = d
      best = r
    }
  }
  if (best) {
    cmd.aimX = best.pos.x - me.pos.x
    cmd.aimY = best.pos.y - me.pos.y
    cmd.attack = true
  }
  return cmd
}

/** Run up to `n` ticks, returning the tick each event type FIRST fired. */
const firsts = (w: World, n: number, log?: SimEvent[], pilot: Pilot = idle, each?: (w: World) => void): Record<string, number> => {
  const out: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([[0, pilot(w)]]))
    for (const e of w.events) {
      out[e.type] ??= w.tick
      log?.push(e)
    }
    each?.(w)
  }
  return out
}

describe('group scenarios are shareable', () => {
  for (const name of Object.keys(GROUP_SCENARIOS)) {
    it(`${name}: leaves the level untouched and restores from a mid-scene capture`, () => {
      const fresh = createWorld(GROUP_SCENARIO_SEED, 1)
      const w = stage(name)
      expect(levelChecksum(w.level)).toBe(levelChecksum(fresh.level))
      firsts(w, 150)
      const json = JSON.parse(JSON.stringify(serializeWorld(w)))
      const back = deserializeWorld(json)
      firsts(w, 60)
      firsts(back, 60)
      expect(serializeWorld(back)).toEqual(serializeWorld(w))
    })
  }
})

describe('group scenarios reproduce their moment', () => {
  it('tide-staging: the muster gathers out of sight, then every fighter commits together', () => {
    const w = stage('tide-staging')
    const g = w.groups!.list[0]
    expect(g.phase).toBe('staging')
    const t = firsts(w, 30 * 20)
    expect(t.groupPhase).toBeGreaterThan(20) // a real gather, not a formality
    expect(g.phase).toBe('attack')
  })

  it('tide-siege: the battery sets up and shells the player', () => {
    const w = stage('tide-siege')
    const log: SimEvent[] = []
    const t = firsts(w, 30 * 20, log)
    expect(t.lob).toBeDefined()
    expect(log.some((e) => e.type === 'explosion')).toBe(true)
  })

  it('hound-ring: the near pack surrounds the player before it closes', () => {
    const w = stage('hound-ring')
    const t = firsts(w, 30 * 10)
    expect(t.packHunt).toBeDefined()
    expect(t.packClose).toBeGreaterThan(t.packHunt)
  })

  it('hive-spread: the spire buds at the player, and 30s in it roots a second spire', () => {
    const w = stage('hive-spread')
    const t = firsts(w, 30 * 32)
    expect(t.hiveSpawn).toBeDefined()
    expect(t.hiveSpread).toBeDefined()
    expect(w.entities.filter((e) => e.hive && !e.dead).length).toBeGreaterThanOrEqual(2)
  })

  it('the same seed stages the same moment twice (byte-identical)', () => {
    for (const name of Object.keys(GROUP_SCENARIOS)) {
      const a = stage(name)
      const b = stage(name)
      firsts(a, 200)
      firsts(b, 200)
      expect(serializeWorld(a), name).toEqual(serializeWorld(b))
    }
  })

  it('every scenario keeps the player standing (a clip never ends on a down)', () => {
    for (const name of Object.keys(GROUP_SCENARIOS)) {
      const w = stage(name)
      firsts(w, 30 * 20)
      expect(player(w).playerCtl!.downed, name).toBeUndefined()
    }
  })

  it('a group set-piece stands the floor mission down, so nothing can unseal the map under it', () => {
    for (const name of Object.keys(GROUP_SCENARIOS)) {
      const w = stage(name)
      const t = firsts(w, 30 * 5, undefined, fighter)
      expect(t.missionComplete, name).toBeUndefined()
      expect(t.stationAlert, name).toBeUndefined()
      expect(t.doorsReleased, name).toBeUndefined()
    }
  })
})

// ── The two beats the owner played and saw nothing of ─────────────────────

const PILOTS: [string, Pilot][] = [
  ['a player who stands still', idle],
  ['a player who moves and shoots', fighter],
]

const sealedDoors = (w: World): Entity[] => w.entities.filter((e) => e.door && e.door.locked && !e.door.open && !e.dead)

/** The building the player stands in (the one the sapper scenario sealed). */
const playerBuilding = (w: World) => {
  const p = player(w)
  return w.level.buildings.find((b) => {
    const r = b.rect
    return p.pos.x > r.x && p.pos.x < r.x + r.w && p.pos.y > r.y && p.pos.y < r.y + r.h
  })
}

describe('tide-sappers: sealed in, then the Blast Diver blows the way through', () => {
  it('stages the player inside a building whose every doorway is a locked, closed door', () => {
    const w = stage('tide-sappers')
    const b = playerBuilding(w)
    expect(b).toBeDefined()
    for (const d of b!.doors) {
      const door = w.entities.find((e) => e.door && !e.dead && Math.floor(e.pos.x) === d.x && Math.floor(e.pos.y) === d.y)
      expect(door?.door, `door at ${d.x},${d.y}`).toMatchObject({ open: false, locked: true })
    }
    expect(w.groups!.list[0].phase).toBe('sapping')
  })

  for (const [who, pilot] of PILOTS) {
    it(`with ${who}: the doors hold until the charge, which is planted and blown inside 15s, and the raid comes in`, () => {
      const w = stage('tide-sappers')
      const room = playerBuilding(w)!.rect
      const within = (e: Entity) => e.pos.x > room.x && e.pos.x < room.x + room.w && e.pos.y > room.y && e.pos.y < room.y + room.h
      const doors = sealedDoors(w)
      const doorIds = new Set(doors.map((d) => d.id))
      const log: SimEvent[] = []
      let openedEarly: string | undefined
      let charged = false
      let cameIn: number | undefined
      const t = firsts(w, 30 * 20, log, pilot, (w) => {
        charged ||= w.events.some((e) => e.type === 'sapperCharge')
        if (charged) {
          if (raiders(w).some(within)) cameIn ??= w.tick
          return
        }
        for (const d of doors) if (d.door!.open || !d.door!.locked) openedEarly ??= `door ${d.id} at tick ${w.tick}`
      })
      expect(openedEarly, 'a sealed door opened before any charge was planted').toBeUndefined()
      expect(t.sapperCharge, 'no charge planted').toBeDefined()
      expect(t.sapperCharge).toBeLessThanOrEqual(15 * S)
      const charge = log.find((e) => e.type === 'sapperCharge')!
      expect(charge.type === 'sapperCharge' && doorIds.has(charge.doorId)).toBe(true)
      const breach = log.find((e) => e.type === 'doorBreach')
      expect(breach, 'the charge never went off').toBeDefined()
      expect(breach!.type === 'doorBreach' && charge.type === 'sapperCharge' && breach!.entityId === charge.doorId).toBe(true)
      expect(t.doorBreach - t.sapperCharge).toBeLessThanOrEqual(2 * S) // the fuse, not a stall
      expect(t.doorBreach).toBeLessThanOrEqual(15 * S)
      // …and the raid actually pours through the hole into the player's room.
      expect(cameIn, 'nobody came through the breach').toBeDefined()
      expect(cameIn! - t.doorBreach).toBeLessThanOrEqual(5 * S)
      if (pilot === idle) expect(log.some((e) => e.type === 'raidRouted'), 'the raid broke on its own threshold').toBe(false)
    })
  }
})

describe('tide-medic: the wounded fall back to the Bog Mender, are patched, and rejoin', () => {
  it('starts the grunts wounded below the retreat line, forward of the medic', () => {
    const w = stage('tide-medic')
    const medic = raiders(w).find((r) => r.ai!.group!.role === 'medic')!
    const grunts = raiders(w).filter((r) => r.ai!.group!.role === 'grunt')
    expect(grunts.length).toBe(3)
    const p = player(w)
    for (const g of grunts) {
      expect(g.health!.hp / g.health!.max).toBeLessThan(RETREAT_FRAC)
      // closer to the player than the medic is, and well out of its reach:
      // the fall-back is a run the player can watch
      expect(Math.hypot(g.pos.x - p.pos.x, g.pos.y - p.pos.y)).toBeLessThan(Math.hypot(medic.pos.x - p.pos.x, medic.pos.y - p.pos.y))
      expect(Math.hypot(g.pos.x - medic.pos.x, g.pos.y - medic.pos.y)).toBeGreaterThan(HEAL_RANGE + 1)
    }
  })

  for (const [who, pilot] of PILOTS) {
    it(`with ${who}: a grunt runs back, is healed to 80% and walks back in, all inside 15s`, () => {
      const w = stage('tide-medic')
      const p0 = { ...player(w).pos }
      const raid = w.groups!.list[0]
      const medic = raiders(w).find((r) => r.ai!.group!.role === 'medic')!
      const grunts = raiders(w).filter((r) => r.ai!.group!.role === 'grunt')
      interface Beat {
        retreated?: number
        reachedMedic?: number
        healed: number
        rejoined?: number
        rejoinDist?: number
        /** Distance to the player 2s after rejoining, if it lived that long. */
        walkedIn?: number
      }
      const beats = new Map<number, Beat>(grunts.map((g) => [g.id, { healed: 0 }]))
      const log: SimEvent[] = []
      const dist = (g: Entity) => Math.hypot(g.pos.x - p0.x, g.pos.y - p0.y)
      firsts(w, 15 * S, log, pilot, (w) => {
        if (raid.phase === 'routed') return // the rout ends the beat; it clears `healing` too
        for (const g of grunts) {
          const b = beats.get(g.id)!
          if (g.dead) continue
          if (g.ai!.healing) b.retreated ??= w.tick
          if (Math.hypot(g.pos.x - medic.pos.x, g.pos.y - medic.pos.y) <= HEAL_RANGE) b.reachedMedic ??= w.tick
          b.healed += w.events.filter((e) => e.type === 'heal' && e.entityId === g.id).length
          if (b.retreated !== undefined && !g.ai!.healing && b.rejoined === undefined) {
            // the latch lets go only once the medic has it back over the line
            expect(g.health!.hp / g.health!.max).toBeGreaterThanOrEqual(RETURN_FRAC)
            b.rejoined = w.tick
            b.rejoinDist = dist(g)
          }
          if (b.rejoined !== undefined && w.tick === b.rejoined + 2 * S) b.walkedIn = dist(g)
        }
      })
      const full = [...beats.values()].filter(
        (b) => b.retreated !== undefined && b.reachedMedic !== undefined && b.healed >= 1 && b.rejoined !== undefined,
      )
      const story = JSON.stringify([...beats.entries()])
      expect(full.length, story).toBeGreaterThanOrEqual(pilot === idle ? 3 : 1)
      // Retreat is the FIRST thing they do: the latch is set on the opening tick.
      for (const b of full) expect(b.retreated, story).toBeLessThanOrEqual(2)
      // Rejoining means walking back IN, toward the player.
      const walked = full.filter((b) => b.walkedIn !== undefined)
      expect(walked.length, story).toBeGreaterThan(0)
      for (const b of walked) expect(b.walkedIn!, story).toBeLessThan(b.rejoinDist! - 1)
      // A fighter may well break the raid afterwards (catching the wounded is
      // the counter); the player who only watches must see it hold together.
      if (pilot === idle) expect(log.some((e) => e.type === 'raidRouted')).toBe(false)
      expect(medic.dead).toBeFalsy()
    })
  }
})
