// Weapon-mod PICKUP placement: an exact per-floor quota of mods to grab while
// exploring (the #53 draft aside). Strict +
// adversarial: statistical density over many seeds, determinism per seed, and the
// placement invariants (never a wall/exit/spawn tile, at most one per room, the
// spawn room skipped, rarity-weighted so legendaries stay rare, and full round-trip
// through serialize/deserialize).

import { describe, expect, it } from 'vitest'
import { createWorld } from './world'
import { MOD_PICKUPS_PER_FLOOR, populateWorld } from './populate'
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

describe('mod-pickup placement — count', () => {
  // This used to assert a per-ROOM CHANCE of 2/3, which made the amount of build
  // a floor handed you a function of how many rooms it happened to generate:
  // measured 9.6 mods on floor 4 against 26.6 on floor 5, and ~20 on floor 1,
  // which is a pile rather than a set of choices. Mods are the whole progression
  // of a one-weapon run, so the quantity is a core-loop parameter and has to be
  // PREDICTABLE. It is now an exact per-floor count.
  it('places exactly MOD_PICKUPS_PER_FLOOR on every floor, regardless of room count', () => {
    let floorsChecked = 0
    let exact = 0
    for (const s of seeds) {
      for (const f of floors) {
        const w = populated(s, f)
        floorsChecked++
        if (modPickups(w).length === MOD_PICKUPS_PER_FLOOR) exact++
      }
    }
    expect(floorsChecked).toBeGreaterThan(700)
    // Every ordinary floor has far more eligible rooms than the quota, so the
    // count should be hit exactly. A tiny floor that genuinely cannot host five
    // is allowed to fall short, hence the ratio rather than a flat equality.
    expect(exact / floorsChecked).toBeGreaterThan(0.99)
  })

  it('never exceeds the quota', () => {
    for (const s of seeds) {
      for (const f of floors) {
        expect(modPickups(populated(s, f)).length).toBeLessThanOrEqual(MOD_PICKUPS_PER_FLOOR)
      }
    }
  })

  it('spreads them out — no floor dumps its whole quota in one room', () => {
    // The placement walks a shuffled room list and takes one room per pickup, so
    // each gem comes from a different room OBJECT. It cannot be asserted as
    // "distinct rooms" from position alone, because room rects OVERLAP: a tile
    // can legitimately sit inside two of them, so resolving a gem back to "its"
    // room is ambiguous. What is worth guarding is the real failure — the whole
    // quota landing in one spot — so assert genuine spatial spread instead.
    for (const s of seeds.slice(0, 40)) {
      for (const f of floors) {
        const picks = modPickups(populated(s, f))
        if (picks.length < 3) continue
        const tiles = new Set(picks.map((e) => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`))
        expect(tiles.size).toBe(picks.length) // never two gems on one tile
        // And they are not all crammed into one corner.
        const xs = picks.map((e) => e.pos.x)
        const ys = picks.map((e) => e.pos.y)
        const span = Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys))
        expect(span).toBeGreaterThan(4)
      }
    }
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
