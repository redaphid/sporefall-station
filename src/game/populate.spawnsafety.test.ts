import { describe, expect, it } from 'vitest'
import { SPAWN_GRACE_TICKS } from './entity'
import { Tile } from './levelgen/level'
import { spawnPlayer } from './player'
import { populateWorld, spawnNpc, SPAWN_SAFE_RADIUS } from './populate'
import { setupFloor, nextFloor } from './systems/missions'
import type { InputCmd } from './types'
import { createWorld, tickWorld } from './world'

/**
 * Spawn safety — the "beaten to death at spawn before your first input" bug.
 *
 * With `world.hostile` (default), every NPC engages players on sight. Before
 * the SPAWN_SAFE_RADIUS guard, street life could populate right next to the
 * fixed floor-1 spawn: on seed 7 a bat-wielding civilian spawned 2.2 tiles
 * away and downed an idle player by tick ~111. Sweeping seeds 1..100, 8%
 * died within 10 idle seconds. These tests pin the guard and the grace.
 */

const idle: InputCmd = {
  seq: 0,
  moveX: 0,
  moveY: 0,
  aimX: 1,
  aimY: 0,
  attack: false,
  interact: false,
  special: false,
  hotbar: -1,
  throwItem: false,
  roll: false,
}

const buildRun = (seed: number) => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return { w, p }
}

const streetTile = (t: number): boolean => t === Tile.Street || t === Tile.Sidewalk

describe('street life keeps SPAWN_SAFE_RADIUS clear of the player spawn', () => {
  it('no street/sidewalk NPC within the radius, seeds 1..60', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const w = createWorld(seed, 1, 'normal')
      populateWorld(w)
      for (const e of w.entities) {
        if (e.kind !== 'npc') continue
        const tile = w.level.tiles[Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)]
        if (!streetTile(tile)) continue // interior NPCs are exempt: walls block sight
        const d = Math.hypot(e.pos.x - w.level.spawn.x, e.pos.y - w.level.spawn.y)
        expect(d, `seed ${seed}: ${e.archetype}#${e.id} at ${e.pos.x},${e.pos.y}`).toBeGreaterThanOrEqual(
          SPAWN_SAFE_RADIUS,
        )
      }
    }
  })

  it('street patrol beats never route a waypoint into the spawn-safe zone', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const w = createWorld(seed, 1, 'normal')
      populateWorld(w)
      for (const e of w.entities) {
        if (e.archetype !== 'cop' || !e.ai?.params?.waypoints) continue
        for (const wp of e.ai.params.waypoints) {
          const d = Math.hypot(wp.x - w.level.spawn.x, wp.y - w.level.spawn.y)
          expect(d, `seed ${seed}: cop#${e.id} waypoint`).toBeGreaterThanOrEqual(SPAWN_SAFE_RADIUS)
        }
      }
    }
  })
})

describe('an idle just-spawned player survives (the seed-7 regression)', () => {
  // Every seed that killed an idle spawn within 300 ticks before the fix.
  const fatalSeeds = [7, 28, 47, 53, 64, 65, 79, 95]

  it.each(fatalSeeds)('seed %d: 300 idle ticks, never downed', (seed) => {
    const { w, p } = buildRun(seed)
    const inputs = new Map([[0, idle]])
    for (let t = 0; t < 300; t++) {
      tickWorld(w, inputs)
      expect(p.playerCtl!.downed, `downed at tick ${t}`).toBeUndefined()
    }
    expect(p.health!.hp).toBeGreaterThan(0)
  })

  // 100 full worldgens × 300 ticks is real work (~10s on a loaded box) — the 5s
  // default timeout flakes when the suite runs alongside other jobs, so allow 30s.
  // That ceiling also GUARDS the furnished-interiors perf fix: furniture (~175
  // props/floor, all with hp) used to join the O(n²) collision + fire-spread scans
  // and blew this sweep past 60s; if that superlinear cost ever returns, 30s trips.
  it('sweep seeds 1..100: no idle spawn is downed within 10 seconds', { timeout: 30000 }, () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { w, p } = buildRun(seed)
      const inputs = new Map([[0, idle]])
      for (let t = 0; t < 300; t++) tickWorld(w, inputs)
      expect(p.playerCtl!.downed, `seed ${seed}`).toBeUndefined()
      expect(p.health!.hp, `seed ${seed} hp`).toBeGreaterThan(0)
    }
  })
})

describe('spawn grace iframes', () => {
  it('a hostile thug in melee range cannot touch the player during grace', () => {
    const w = createWorld(123, 1, 'normal')
    setupFloor(w)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    expect(p.health!.iframes).toBe(SPAWN_GRACE_TICKS)
    // Adversarial: hostile melee NPC ALREADY in swing range at tick 0.
    spawnNpc(w, 'thug', w.level.spawn.x + 0.8, w.level.spawn.y)
    const inputs = new Map([[0, idle]])
    for (let t = 0; t < SPAWN_GRACE_TICKS - 1; t++) tickWorld(w, inputs)
    expect(p.health!.hp).toBe(p.health!.max)
  })

  it('grace expires: the same thug connects once iframes run out', () => {
    const w = createWorld(123, 1, 'normal')
    setupFloor(w)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    spawnNpc(w, 'thug', w.level.spawn.x + 0.8, w.level.spawn.y)
    const inputs = new Map([[0, idle]])
    for (let t = 0; t < SPAWN_GRACE_TICKS + 120; t++) tickWorld(w, inputs)
    expect(p.health!.hp).toBeLessThan(p.health!.max)
  })

  it('nextFloor re-grants grace on the new floor landing', () => {
    const { w, p } = buildRun(3)
    const inputs = new Map([[0, idle]])
    for (let t = 0; t < SPAWN_GRACE_TICKS + 30; t++) tickWorld(w, inputs)
    expect(p.health!.iframes).toBe(0)
    nextFloor(w)
    expect(p.health!.iframes).toBe(SPAWN_GRACE_TICKS)
  })

  it('grace is invulnerability, not a stun: the player can move during it', () => {
    const { w, p } = buildRun(7)
    const startX = p.pos.x
    const inputs = new Map([[0, { ...idle, moveX: 1 }]])
    for (let t = 0; t < 30; t++) tickWorld(w, inputs)
    expect(p.pos.x).toBeGreaterThan(startX)
  })
})
