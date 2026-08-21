import { describe, expect, it } from 'vitest'
import { createWorld } from './world'
import { populateWorld } from './populate'
import { itemClass } from './data/items'

// Was six items; the cull left the grenade as the only throwable. Deliberately
// still a SET and still called the element pool: the depth gate it checks is
// unchanged, and a new throwable is added here rather than rewriting the tests.
const ELEMENT_THROWABLES = new Set(['grenade'])

const lootIds = (seed: number, floor: number): string[] => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  return w.entities.filter((e) => e.pickup).map((e) => e.pickup!.itemId)
}

const collect = (floors: number[], seeds: number[]): string[] => {
  const ids: string[] = []
  for (const s of seeds) for (const f of floors) ids.push(...lootIds(s, f))
  return ids
}

const seeds = Array.from({ length: 30 }, (_, i) => i + 1)

describe('populate loot', () => {
  it('is deterministic: the same seed+floor yields identical pickups', () => {
    expect(lootIds(7, 3)).toEqual(lootIds(7, 3))
  })

  it('surfaces element throwables in deeper-floor loot', () => {
    const ids = collect([3, 4, 5], seeds)
    expect(ids.some((id) => ELEMENT_THROWABLES.has(id))).toBe(true)
  })

  it('shops stock element gear even on floor 1 (random loot there is basic)', () => {
    // Floor-1 random loot is basics only, so any element pickup came from a shop.
    const ids = collect([1], seeds)
    expect(ids.some((id) => ELEMENT_THROWABLES.has(id))).toBe(true)
  })

  it('spawns throwables and cash — never a weapon, and no longer a consumable', () => {
    // The player carries one permanent weapon, so no melee/ranged item is loot.
    // Consumables flipped from REQUIRED to FORBIDDEN here: the item cull removed
    // the whole class (bandage/medkit/burger/adrenaline), so a consumable
    // appearing in loot would mean one had been quietly reinstated.
    const classes = new Set(collect([1, 2, 3, 4, 5], seeds).map(itemClass))
    expect(classes.has('throwable')).toBe(true)
    expect(classes.has('cash')).toBe(true)
    expect(classes.has('consumable')).toBe(false)
    expect(classes.has('ranged')).toBe(false)
    expect(classes.has('melee')).toBe(false)
    // NB: no 'unknown' assertion here — this helper counts weapon-MOD pickups
    // too, whose itemId is a mod id and classes as 'unknown' by design.
    // populate.loot.test.ts makes that assertion with mod pickups filtered out.
  })
})
