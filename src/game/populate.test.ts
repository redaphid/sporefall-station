import { describe, expect, it } from 'vitest'
import { createWorld } from './world'
import { populateWorld } from './populate'
import { itemClass } from './data/items'

const ELEMENT_THROWABLES = new Set(['molotov', 'grenade', 'freezeGrenade', 'chloroform', 'banana', 'gasGrenade'])

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

  it('NEVER surfaces a weapon — the player has one permanent pistol', () => {
    const ids = collect([1, 2, 3, 4, 5], seeds)
    for (const id of ids) {
      const c = itemClass(id)
      expect(c === 'melee' || c === 'ranged', `${id} spawned as loot`).toBe(false)
    }
  })

  it('shops stock element gear even on floor 1 (random loot there is basic)', () => {
    // Floor-1 random loot is basics only, so any DEEP element pickup came from a shop.
    const ids = collect([1], seeds)
    expect(ids.some((id) => ['freezeGrenade', 'chloroform', 'banana', 'gasGrenade'].includes(id))).toBe(true)
  })

  it('covers the surviving item classes — throwable and consumable both spawn', () => {
    const classes = new Set(collect([1, 2, 3, 4, 5], seeds).map(itemClass))
    expect(classes.has('throwable')).toBe(true)
    expect(classes.has('consumable')).toBe(true)
  })
})
