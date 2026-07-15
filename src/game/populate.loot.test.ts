// Loot generation: exhaustive determinism + depth-gating, and adversarial
// bounds (no buildings, no shop, a tiny level) that must not crash. Complements
// populate.test.ts, which covers the happy-path element surfacing.

import { describe, expect, it } from 'vitest'
import { createWorld, type World } from './world'
import { populateWorld } from './populate'
import { Tile, type Building, type Level } from './levelgen/level'
import { itemClass } from './data/items'

const BASIC = new Set(['bat', 'knife', 'bandage', 'medkit', 'cash'])
const ELEMENT_WEAPONS = new Set(['freezeRay', 'tranquilizer', 'sledgehammer', 'flamethrower', 'stunGun'])
const ELEMENT_THROWABLES = new Set(['molotov', 'grenade', 'freezeGrenade', 'chloroform', 'banana', 'gasGrenade'])
const isElement = (id: string): boolean => ELEMENT_WEAPONS.has(id) || ELEMENT_THROWABLES.has(id)

interface Pickup {
  itemId: string
  x: number
  y: number
  qty: number
}

/** A random-loot / shop pickup — i.e. NOT a weapon-mod pickup (`mod.*`), which
 * this suite covers separately (populate.modpickup.test.ts). The loot-table
 * assertions below only concern item ids, so mod pickups are filtered out here. */
const isLootPickup = (e: { pickup?: unknown; archetype: string }): boolean =>
  !!e.pickup && !e.archetype.startsWith('mod.')

const loot = (seed: number, floor: number): Pickup[] => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  return w.entities.filter(isLootPickup).map((e) => ({ itemId: e.pickup!.itemId, x: e.pos.x, y: e.pos.y, qty: e.pickup!.qty }))
}

const inRect = (x: number, y: number, b: Building): boolean =>
  x >= b.rect.x && x < b.rect.x + b.rect.w && y >= b.rect.y && y < b.rect.y + b.rect.h

const seeds = Array.from({ length: 40 }, (_, i) => i * 3 + 1)

describe('loot determinism', () => {
  it('same seed+floor yields byte-identical loot (ids, positions, quantities)', () => {
    for (const s of [1, 7, 42]) {
      for (const f of [1, 3, 5]) {
        expect(loot(s, f)).toEqual(loot(s, f))
      }
    }
  })

  it('different seeds produce different loot layouts', () => {
    const a = JSON.stringify(loot(1, 3))
    const b = JSON.stringify(loot(2, 3))
    expect(a).not.toEqual(b)
  })

  it('different floors of the same seed differ', () => {
    // Different floor => different sim rng stream and different table.
    const a = JSON.stringify(loot(5, 1))
    const b = JSON.stringify(loot(5, 4))
    expect(a).not.toEqual(b)
  })

  it('cash pickups carry a plausible quantity; non-cash carry exactly one', () => {
    for (const s of seeds.slice(0, 12)) {
      for (const p of loot(s, 3)) {
        if (p.itemId === 'cash') {
          expect(p.qty).toBeGreaterThanOrEqual(10)
          expect(p.qty).toBeLessThanOrEqual(40)
        } else {
          expect(p.qty).toBe(1)
        }
      }
    }
  })
})

describe('depth gating', () => {
  it('floor-1 RANDOM loot (outside shops) is strictly basic', () => {
    // Any element item on floor 1 must sit inside a shop building; the random
    // sprinkle table on floor 1 is basics only.
    for (const s of seeds) {
      const w = createWorld(s, 1)
      populateWorld(w)
      const shops = w.level.buildings.filter((b) => b.role === 'shop')
      for (const e of w.entities) {
        if (!e.pickup) continue
        if (!isElement(e.pickup.itemId)) continue
        const inAShop = shops.some((b) => inRect(e.pos.x, e.pos.y, b))
        expect(inAShop, `${e.pickup.itemId} at ${e.pos.x},${e.pos.y} on floor 1`).toBe(true)
      }
    }
  })

  it('with every shop removed, floor-1 loot contains no element gear at all', () => {
    for (const s of seeds.slice(0, 15)) {
      const w = createWorld(s, 1)
      w.level.buildings = w.level.buildings.filter((b) => b.role !== 'shop')
      populateWorld(w)
      const ids = w.entities.filter(isLootPickup).map((e) => e.pickup!.itemId)
      expect(ids.every((id) => BASIC.has(id))).toBe(true)
    }
  })

  it('element weapons only enter random loot from floor 3 (floor 2 = throwables + a couple weapons)', () => {
    // Remove shops so all loot is from the random table, isolating the gate.
    const randomLoot = (seed: number, floor: number): string[] => {
      const w = createWorld(seed, floor)
      w.level.buildings = w.level.buildings.filter((b) => b.role !== 'shop')
      populateWorld(w)
      return w.entities.filter(isLootPickup).map((e) => e.pickup!.itemId)
    }
    const floor2 = seeds.flatMap((s) => randomLoot(s, 2))
    // Floor 2 admits throwables and freezeRay/sledgehammer, but NOT flamethrower/stunGun/tranquilizer.
    expect(floor2.some((id) => ELEMENT_THROWABLES.has(id))).toBe(true)
    expect(floor2.every((id) => !['flamethrower', 'stunGun', 'tranquilizer'].includes(id))).toBe(true)

    const floor3 = seeds.flatMap((s) => randomLoot(s, 3))
    expect(floor3.some((id) => ['flamethrower', 'stunGun', 'tranquilizer'].includes(id))).toBe(true)
  })

  it('shops stock the element pool (weapons AND throwables) across seeds', () => {
    const shopStock: string[] = []
    for (const s of seeds) {
      const w = createWorld(s, 1)
      // Isolate shop loot: only keep pickups sitting inside a shop.
      populateWorld(w)
      const shops = w.level.buildings.filter((b) => b.role === 'shop')
      for (const e of w.entities) {
        if (isLootPickup(e) && shops.some((b) => inRect(e.pos.x, e.pos.y, b))) shopStock.push(e.pickup!.itemId)
      }
    }
    expect(shopStock.some((id) => ELEMENT_WEAPONS.has(id))).toBe(true)
    expect(shopStock.some((id) => ELEMENT_THROWABLES.has(id))).toBe(true)
  })

  it('every generated loot id resolves to a real item class (nothing bogus dropped)', () => {
    for (const s of seeds.slice(0, 20)) {
      for (const f of [1, 2, 3, 4, 5]) {
        for (const p of loot(s, f)) {
          const c = itemClass(p.itemId)
          expect(c, p.itemId).not.toBe('unknown')
        }
      }
    }
  })
})

describe('adversarial bounds — must not crash', () => {
  it('a level with zero buildings populates without throwing and drops no building loot', () => {
    const w = createWorld(3, 4)
    w.level.buildings = []
    expect(() => populateWorld(w)).not.toThrow()
    // No buildings => sprinkleLoot has nowhere to place; only street life spawns.
    expect(w.entities.some((e) => e.pickup)).toBe(false)
  })

  it('a level with buildings but no shop skips shop stocking cleanly', () => {
    const w = createWorld(9, 3)
    w.level.buildings = w.level.buildings.map((b) => ({ ...b, role: 'apartment' as const }))
    expect(() => populateWorld(w)).not.toThrow()
  })

  it('a tiny hand-rolled level populates without crashing', () => {
    const size = 4
    const tiles = new Uint8Array(size * size).fill(Tile.Floor)
    const level: Level = {
      w: size,
      h: size,
      tiles,
      solid: new Uint8Array(size * size),
      buildings: [{ rect: { x: 0, y: 0, w: size, h: size }, rooms: [], doors: [], role: 'shop' }],
      spawn: { x: 1.5, y: 1.5 },
      exit: { x: 2.5, y: 2.5 },
    }
    const w: World = { ...createWorld(1, 1), level }
    expect(() => populateWorld(w)).not.toThrow()
  })

  it('a level whose only building is degenerate (1x1 interior) never wedges', () => {
    const w = createWorld(11, 2)
    w.level.buildings = [{ rect: { x: 2, y: 2, w: 3, h: 3 }, rooms: [], doors: [], role: 'warehouse' }]
    expect(() => populateWorld(w)).not.toThrow()
  })
})
