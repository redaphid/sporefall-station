// `?scenario=armed&floor=N`: a solo run dropped straight onto a station
// complex floor with a survival loadout. The level must be the REAL complex for
// that floor (not a floor-1 city with the number changed), the player must be
// kitted out, and the exit must be reachable from where they land.

import { describe, expect, it } from 'vitest'
import { biomeForFloor, isComplexFloor } from './levelgen/complex'
import { generateLevel } from './levelgen/generate'
import { levelChecksum, type Level } from './levelgen/level'
import { populateWorld } from './populate'
import { spawnPlayer } from './player'
import {
  ARMED_DEFAULT_FLOOR,
  ARMED_GRENADES,
  ARMED_HP,
  applyScenario,
  isKnownScenario,
  SCENARIO_NAMES,
} from './scenarios'
import { playerSpawnPoint } from './spawnPlacement'
import { setupFloor } from './systems/missions'
import { floodLinked, storeyOf } from './stairs'
import { expectWorldEqual, runTicks } from './testkit'
import { createWorld, type World } from './world'

/** A fresh solo run exactly as HostSession.buildRun makes one, then the scenario. */
const armedRun = (seed: number, floor?: number): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  applyScenario(w, 'armed', { floor })
  return w
}

const reachFrom = (level: Level, sx: number, sy: number): Uint8Array => {
  const { w, h } = level
  const reach = new Uint8Array(w * h)
  const queue = [sy * w + sx]
  reach[queue[0]] = 1
  while (queue.length > 0) {
    const i = queue.pop()!
    const x = i % w
    const y = (i / w) | 0
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const n = ny * w + nx
      if (reach[n] || level.solid[n]) continue
      reach[n] = 1
      queue.push(n)
    }
  }
  return reach
}

// The showcase links handed to the owner: seed/floor → the layout they promise.
const SHOWCASE = [
  { seed: 16, floor: 3, archetype: 'palladian' }, // habitation: symmetric grand axis, gatehouse to great hall
  { seed: 5, floor: 5, archetype: 'cloister' }, // flooded: a court ringed by its cloister walk
  { seed: 1, floor: 7, archetype: 'ship' }, // reactor: one long keel corridor, decks either side
  { seed: 8, floor: 9, archetype: 'pavilion' }, // overgrown: hospital pavilions round garden courts
] as const

describe('armed scenario', () => {
  for (const { seed, floor } of SHOWCASE) {
    it(`seed ${seed} floor ${floor}: lands on the real complex, armed, with the exit reachable`, () => {
      const w = armedRun(seed, floor)
      expect(w.floor).toBe(floor)
      expect(isComplexFloor(floor)).toBe(true)
      expect(w.level.complex?.biome).toBe(biomeForFloor(floor))
      // Bit-identical to the level a run reaching this floor generates.
      expect(levelChecksum(w.level)).toBe(levelChecksum(generateLevel(seed, floor)))
      expect(w.mission.template).toBeDefined()

      const players = w.entities.filter((e) => e.playerCtl)
      expect(players).toHaveLength(1)
      const p = players[0]
      expect(p.dead).toBeFalsy()
      expect(p.health).toMatchObject({ hp: ARMED_HP, max: ARMED_HP })
      expect(p.combat?.weapon).toBe('machinegun')
      const gun = p.loadout!.inventory.find((s) => s.itemId === 'machinegun')
      expect(gun?.mods?.length).toBeGreaterThanOrEqual(4)
      expect(p.loadout!.inventory.find((s) => s.itemId === 'grenade')?.qty).toBe(ARMED_GRENADES)

      const px = Math.floor(p.pos.x)
      const py = Math.floor(p.pos.y)
      expect(w.level.solid[py * w.level.w + px]).toBeFalsy()
      const reach = reachFrom(w.level, px, py)
      expect(reach[Math.floor(w.level.exit.y) * w.level.w + Math.floor(w.level.exit.x)]).toBe(1)

      // It plays: a couple of seconds of sim with the player standing still.
      runTicks(w, new Map([[0, {}]]), 60)
      expect(p.dead).toBeFalsy()
    })
  }

  it('the showcase seeds carry the archetypes their links promise', () => {
    for (const { seed, floor, archetype } of SHOWCASE) {
      expect(generateLevel(seed, floor).complex?.archetype, `seed ${seed} floor ${floor}`).toBe(archetype)
    }
  })

  it('defaults to the first complex floor and is deterministic', () => {
    const a = armedRun(7)
    expect(a.floor).toBe(ARMED_DEFAULT_FLOOR)
    expect(a.level.complex).toBeDefined()
    expectWorldEqual(a, armedRun(7))
  })
})

// An unknown name used to be a silent no-op, which on a stale build turned
// `?scenario=armed` into an ordinary floor-1 run that looked like the player's
// own game. Now it is reported, and the world is left exactly as it was.
describe('unknown scenario names', () => {
  it('are reported, not silently ignored, and leave the world untouched', () => {
    const w = createWorld(18, 1)
    populateWorld(w)
    setupFloor(w)
    const at = playerSpawnPoint(w.level, 0)
    spawnPlayer(w, 0, at.x, at.y)
    const before = levelChecksum(w.level)
    const entities = w.entities.length
    expect(isKnownScenario('armd')).toBe(false)
    expect(applyScenario(w, 'armd', { floor: 3 })).toBe(false)
    expect(w.floor).toBe(1)
    expect(levelChecksum(w.level)).toBe(before)
    expect(w.entities.length).toBe(entities)
  })

  it('every listed scenario is known and applies', () => {
    expect(SCENARIO_NAMES).toContain('armed')
    for (const name of SCENARIO_NAMES) expect(isKnownScenario(name)).toBe(true)
    expect(applyScenario(armedRun(18, 3), 'armed', { floor: 3 })).toBe(true)
    // Prototype keys are not scenarios.
    expect(isKnownScenario('toString')).toBe(false)
    expect(isKnownScenario('__proto__')).toBe(false)
  })
})

// Stairs links handed to the owner (docs/design/stairs-and-storeys.md): the
// `armed` link must land on a floor that HAS a loft, and `stairs-demo` must
// stand the player right at the stair so walking forward climbs.
const STAIRS_ARMED_LINK = { seed: 18, floor: 5 } as const
const STAIRS_DEMO_LINKS = [
  { seed: 1, floor: 3 },
  { seed: 42, floor: 3 },
] as const

describe('stairs links', () => {
  it(`?scenario=armed&seed=${STAIRS_ARMED_LINK.seed}&floor=${STAIRS_ARMED_LINK.floor} lands on a floor with a loft, reachable from the player`, () => {
    const w = armedRun(STAIRS_ARMED_LINK.seed, STAIRS_ARMED_LINK.floor)
    expect(w.floor).toBe(STAIRS_ARMED_LINK.floor)
    expect(w.level.storeys?.map((s) => s.z)).toEqual([0, 1])
    const p = w.entities.find((e) => e.playerCtl)!
    const reach = floodLinked(w.level, Math.floor(p.pos.y) * w.level.w + Math.floor(p.pos.x))
    const up = w.level.stairs!.find((l) => l.from.x < 80)!
    expect(reach[up.landing.y * w.level.w + up.landing.x]).toBe(1)
  })

  for (const { seed, floor } of STAIRS_DEMO_LINKS) {
    it(`stairs-demo seed ${seed} floor ${floor}: the player starts at the stair, walks forward and climbs into the loft`, () => {
      const w = createWorld(seed, 1)
      populateWorld(w)
      setupFloor(w)
      const at = playerSpawnPoint(w.level, 0)
      spawnPlayer(w, 0, at.x, at.y)
      expect(applyScenario(w, 'stairs-demo', { floor })).toBe(true)
      expect(w.floor).toBe(floor)
      const p = w.entities.find((e) => e.playerCtl)!
      const up = w.level.stairs!.find((l) => l.from.x < 80)!
      expect(Math.hypot(p.pos.x - (up.from.x + 0.5), p.pos.y - (up.from.y + 0.5))).toBeLessThanOrEqual(3.01)
      const toward = { moveX: Math.round(Math.cos(p.facing)), moveY: Math.round(Math.sin(p.facing)) }
      runTicks(w, new Map([[0, toward]]), 45)
      expect(storeyOf(p.pos.x)).toBe(1)
      expect(p.dead).toBeFalsy()
      // The loft is stocked: the cache crate stands upstairs.
      expect(w.entities.some((e) => e.archetype === 'crate' && storeyOf(e.pos.x) === 1)).toBe(true)
    })
  }

  it('stairs-demo is deterministic and known', () => {
    expect(isKnownScenario('stairs-demo')).toBe(true)
    const make = (): World => {
      const w = createWorld(1, 1)
      populateWorld(w)
      setupFloor(w)
      spawnPlayer(w, 0, playerSpawnPoint(w.level, 0).x, playerSpawnPoint(w.level, 0).y)
      applyScenario(w, 'stairs-demo', { floor: 3 })
      return w
    }
    expectWorldEqual(make(), make())
  })
})
