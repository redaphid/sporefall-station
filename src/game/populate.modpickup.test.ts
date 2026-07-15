// Weapon-mod PICKUP placement (feat/mod-pickups): scattered mods so ~1/3 of
// interior rooms carry one to grab while exploring (the #53 draft aside). Strict +
// adversarial: statistical density over many seeds, determinism per seed, and the
// placement invariants (never a wall/exit/spawn tile, at most one per room, the
// spawn room skipped, rarity-weighted so legendaries stay rare, and full round-trip
// through serialize/deserialize).

import { describe, expect, it } from 'vitest'
import { createWorld } from './world'
import { MOD_PICKUP_ROOM_CHANCE, populateWorld } from './populate'
import { deserializeWorld, serializeWorld } from './serialize'
import { Tile } from './levelgen/level'
import { MODS, isModId } from './data/mods'
import type { Entity } from './entity'
import type { Rect } from './levelgen/rooms'

const modPickups = (w: ReturnType<typeof createWorld>): Entity[] =>
  w.entities.filter((e) => e.pickup && e.archetype.startsWith('mod.'))

const populated = (seed: number, floor: number) => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  return w
}

const rectHas = (r: Rect, tx: number, ty: number): boolean =>
  tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h

const seeds = Array.from({ length: 200 }, (_, i) => i + 1)
const floors = [1, 2, 3, 4]

describe('mod-pickup placement — density', () => {
  it('the constant is 1/3 and drives roughly one pickup per three rooms', () => {
    expect(MOD_PICKUP_ROOM_CHANCE).toBeCloseTo(1 / 3, 6)
    let eligibleRooms = 0
    let pickups = 0
    for (const s of seeds) {
      for (const f of floors) {
        const w = createWorld(s, f)
        const spawnTx = Math.floor(w.level.spawn.x)
        const spawnTy = Math.floor(w.level.spawn.y)
        for (const b of w.level.buildings) {
          for (const r of b.rooms) {
            if (!rectHas(r, spawnTx, spawnTy)) eligibleRooms++
          }
        }
        populateWorld(w)
        pickups += modPickups(w).length
      }
    }
    const ratio = pickups / eligibleRooms
    // ~1/3, a touch under because a handful of tiny rooms find no free floor tile.
    // A statistical bound over ~25k rooms, NOT an exact count.
    expect(eligibleRooms).toBeGreaterThan(5000)
    expect(ratio).toBeGreaterThan(0.3)
    expect(ratio).toBeLessThan(0.36)
  })

  it('is weighted by rarity — commons plentiful, legendaries scarce', () => {
    const byRarity = { common: 0, rare: 0, legendary: 0 }
    let total = 0
    for (const s of seeds) {
      for (const f of floors) {
        for (const e of modPickups(populated(s, f))) {
          byRarity[MODS[e.pickup!.itemId].rarity]++
          total++
        }
      }
    }
    expect(total).toBeGreaterThan(1000)
    expect(byRarity.common).toBeGreaterThan(byRarity.rare)
    expect(byRarity.rare).toBeGreaterThan(byRarity.legendary)
    // Legendaries are a rare treat, well under a tenth of all mod drops.
    expect(byRarity.legendary / total).toBeLessThan(0.1)
    expect(byRarity.legendary).toBeGreaterThan(0) // …but they DO show up
  })
})

describe('mod-pickup placement — determinism & invariants', () => {
  it('is deterministic: same seed+floor → identical mods at identical spots', () => {
    for (const s of [1, 7, 42, 123]) {
      for (const f of floors) {
        const a = modPickups(populated(s, f)).map((e) => ({ id: e.pickup!.itemId, x: e.pos.x, y: e.pos.y }))
        const b = modPickups(populated(s, f)).map((e) => ({ id: e.pickup!.itemId, x: e.pos.x, y: e.pos.y }))
        expect(a).toEqual(b)
      }
    }
  })

  it('different seeds diverge (not every floor is the same layout)', () => {
    const a = JSON.stringify(modPickups(populated(1, 3)).map((e) => [e.pickup!.itemId, e.pos.x, e.pos.y]))
    const b = JSON.stringify(modPickups(populated(2, 3)).map((e) => [e.pickup!.itemId, e.pos.x, e.pos.y]))
    expect(a).not.toEqual(b)
  })

  it('every pickup carries a REAL, inspectable mod id (nothing bogus)', () => {
    for (const s of seeds.slice(0, 40)) {
      for (const f of floors) {
        for (const e of modPickups(populated(s, f))) {
          expect(isModId(e.pickup!.itemId)).toBe(true)
          expect(e.pickup!.qty).toBe(1)
          expect(MODS[e.pickup!.itemId]).toBeDefined()
        }
      }
    }
  })

  it('never places a pickup in a wall, on the exit, or on the spawn tile', () => {
    for (const s of seeds.slice(0, 60)) {
      for (const f of floors) {
        const w = populated(s, f)
        const exitTx = Math.floor(w.level.exit.x)
        const exitTy = Math.floor(w.level.exit.y)
        const spawnTx = Math.floor(w.level.spawn.x)
        const spawnTy = Math.floor(w.level.spawn.y)
        for (const e of modPickups(w)) {
          const tx = Math.floor(e.pos.x)
          const ty = Math.floor(e.pos.y)
          expect(w.level.tiles[ty * w.level.w + tx]).toBe(Tile.Floor)
          expect(tx === exitTx && ty === exitTy).toBe(false)
          expect(tx === spawnTx && ty === spawnTy).toBe(false)
        }
      }
    }
  })

  it('skips the spawn room, never stacks two pickups on one tile, count ≤ rooms', () => {
    for (const s of seeds.slice(0, 60)) {
      for (const f of floors) {
        const w = populated(s, f)
        const spawnTx = Math.floor(w.level.spawn.x)
        const spawnTy = Math.floor(w.level.spawn.y)
        const picks = modPickups(w)
        // No mod may sit in a room that contains the spawn tile.
        for (const b of w.level.buildings) {
          for (const r of b.rooms) {
            if (!rectHas(r, spawnTx, spawnTy)) continue
            for (const e of picks) {
              expect(rectHas(r, Math.floor(e.pos.x), Math.floor(e.pos.y)), 'mod in the spawn room').toBe(false)
            }
          }
        }
        // At most one pickup per tile (one roll per room → they can't stack).
        const tiles = picks.map((e) => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`)
        expect(new Set(tiles).size).toBe(tiles.length)
        // Never more pickups than there are rooms to hold them.
        const totalRooms = w.level.buildings.reduce((n, b) => n + b.rooms.length, 0)
        expect(picks.length).toBeLessThanOrEqual(totalRooms)
      }
    }
  })
})

describe('mod-pickup placement — serialization', () => {
  it('placed pickups round-trip byte-for-byte through serialize/deserialize', () => {
    for (const s of [3, 11, 99]) {
      for (const f of floors) {
        const w = populated(s, f)
        const json = serializeWorld(w)
        const back = serializeWorld(deserializeWorld(json))
        expect(back).toEqual(json)
        // and the mod pickups actually survived the trip
        const restored = deserializeWorld(json)
        expect(modPickups(restored).map((e) => e.pickup!.itemId)).toEqual(modPickups(w).map((e) => e.pickup!.itemId))
      }
    }
  })
})
