import { describe, expect, it } from 'vitest'
import { SPAWN_GRACE_TICKS } from './entity'
import { Tile } from './levelgen/level'
import { findPath } from './path'
import { spawnPlayer } from './player'
import { LANDING_HOSTILES, LANDING_SAFE_RADIUS, populateWorld, spawnNpc, SPAWN_SAFE_RADIUS } from './populate'
import { NPCS } from './data/npcs'
import { setupFloor, nextFloor } from './systems/missions'
import type { InputCmd } from './types'
import { createCityWorld, frozenWorld } from './testkit'
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

describe('the landing keeps every body out of LANDING_SAFE_RADIUS', () => {
  it('no NPC of any kind starts within the landing berth on floor 1, seeds 1..80', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const { w } = buildRun(seed)
      for (const e of w.entities) {
        if (e.kind !== 'npc') continue
        const d = Math.hypot(e.pos.x - w.level.spawn.x, e.pos.y - w.level.spawn.y)
        expect(d, `seed ${seed} (${w.level.theme}): ${e.archetype}#${e.id} at ${e.pos.x},${e.pos.y}`).toBeGreaterThanOrEqual(LANDING_SAFE_RADIUS)
      }
    }
  })

  // Indoor and outdoor beats alike, the straight leg and the route the walker
  // actually takes round the buildings.
  it('no patrol beat on floor 1 walks a leg, or its route, within the landing berth, seeds 1..80', () => {
    const toLeg = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }
    for (let seed = 1; seed <= 80; seed++) {
      const { w } = buildRun(seed)
      for (const e of w.entities) {
        const wps = e.ai?.params?.waypoints
        if (!wps || wps.length < 2) continue
        for (let i = 0; i < wps.length; i++) {
          const a = wps[i]
          const b = wps[(i + 1) % wps.length]
          expect(toLeg(w.level.spawn, a, b), `seed ${seed}: ${e.archetype}#${e.id} leg ${i}`).toBeGreaterThanOrEqual(LANDING_SAFE_RADIUS)
          for (const n of findPath(w.level, a.x, a.y, b.x, b.y, { maxNodes: w.level.w * w.level.h }) ?? []) {
            const d = Math.hypot(n.x - w.level.spawn.x, n.y - w.level.spawn.y)
            expect(d, `seed ${seed}: ${e.archetype}#${e.id} route of leg ${i}`).toBeGreaterThanOrEqual(LANDING_SAFE_RADIUS)
          }
        }
      }
    }
  })
})

describe('every district lands equally gentle', () => {
  it('floor 1 fields LANDING_HOSTILES always-hostile bodies in every district, seeds 1..120', () => {
    const per = new Map<string, number[]>()
    for (let seed = 1; seed <= 120; seed++) {
      const { w } = buildRun(seed)
      const n = w.entities.filter((e) => e.kind === 'npc' && !e.dead && NPCS[e.archetype]?.hostility === 'always' && e.archetype !== 'boss').length
      expect(n, `seed ${seed} (${w.level.theme})`).toBeGreaterThanOrEqual(LANDING_HOSTILES[0])
      expect(n, `seed ${seed} (${w.level.theme})`).toBeLessThanOrEqual(LANDING_HOSTILES[1])
      per.set(w.level.theme!, [...(per.get(w.level.theme!) ?? []), n])
    }
    expect(per.size).toBe(4)
    const means = [...per.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length)
    expect(Math.max(...means) - Math.min(...means)).toBeLessThan(1.5)
  })

  it('a district balances only its own landing: floor 2 and an authored level keep their crews', () => {
    const city = createCityWorld(5, 2)
    populateWorld(city)
    const authored = frozenWorld(7, 1)
    populateWorld(authored)
    const again = frozenWorld(7, 1)
    populateWorld(again)
    expect(authored.entities.length).toBe(again.entities.length)
    expect(city.level.theme).toBeDefined()
  })
})

describe('an idle just-spawned player survives (the seed-7 regression)', () => {
  // Every seed that killed an idle spawn within 300 ticks before the fix, on
  // the landing maps of the day (frozen fixtures: the regression is layout).
  const fatalSeeds = [7, 28, 47, 53, 64, 65, 79, 95]

  it.each(fatalSeeds)('seed %d: 300 idle ticks, never downed', (seed) => {
    const w = frozenWorld(seed, 1, 'normal')
    populateWorld(w)
    setupFloor(w)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
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
  it('sweep seeds 1..200: no idle spawn is downed within 10 seconds', { timeout: 60000 }, () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { w, p } = buildRun(seed)
      const inputs = new Map([[0, idle]])
      for (let t = 0; t < 300; t++) tickWorld(w, inputs)
      expect(p.playerCtl!.downed, `seed ${seed} (${w.level.theme})`).toBeUndefined()
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

// The group layer (packs, hive spires) and the complex floorplans landed on
// separate branches: the new archetypes put a gatehouse right at the airlock,
// so pin that no standing group lands inside the spawn-safe radius there.
describe('complex floors: no group spawns inside SPAWN_SAFE_RADIUS', () => {
  it('packs and hives keep clear of the airlock, seeds 1..20 on floors 3/5/7/9', () => {
    for (const floor of [3, 5, 7, 9]) {
      for (let seed = 1; seed <= 20; seed++) {
        const w = createWorld(seed, floor, 'normal')
        populateWorld(w)
        expect(w.level.complex, `seed ${seed} floor ${floor}`).toBeDefined()
        for (const e of w.entities) {
          if (e.dead || !(e.ai?.group || e.hive)) continue
          const d = Math.hypot(e.pos.x - w.level.spawn.x, e.pos.y - w.level.spawn.y)
          expect(d, `seed ${seed} floor ${floor}: ${e.kind}#${e.id}`).toBeGreaterThanOrEqual(SPAWN_SAFE_RADIUS)
        }
      }
    }
  })
})
