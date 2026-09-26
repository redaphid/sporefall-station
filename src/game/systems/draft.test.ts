import { describe, expect, it } from 'vitest'
import { MODS } from '../data/mods'
import type { ItemStack } from '../entity'
import { applyDraftPick, draftCards, floorDraftOffer } from './draft'

describe('floorDraftOffer — deterministic pick-1-of-N', () => {
  it('is a pure function of (seed, floor): identical on repeated calls', () => {
    expect(floorDraftOffer(7, 1)).toEqual(floorDraftOffer(7, 1))
    expect(floorDraftOffer(7, 3)).toEqual(floorDraftOffer(7, 3))
  })

  it('offers N distinct, real mod ids', () => {
    const offer = floorDraftOffer(42, 2, 3)
    expect(offer).toHaveLength(3)
    expect(new Set(offer).size).toBe(3) // distinct
    for (const id of offer) expect(MODS[id]).toBeDefined()
  })

  it('different floors generally yield different hands (independent streams)', () => {
    const a = floorDraftOffer(7, 1)
    const b = floorDraftOffer(7, 2)
    expect(a).not.toEqual(b)
  })

  it('respects a requested hand size, capped at the registry size', () => {
    expect(floorDraftOffer(1, 1, 2)).toHaveLength(2)
    expect(floorDraftOffer(1, 1, 999).length).toBe(Object.keys(MODS).length)
  })

  // Captured on main @ 7853983, before the draft dealt a YOU card. The gun
  // stream must never move: a seed shared on an old build still deals the same guns.
  it('draws the same three-gun stream main drew', () => {
    const MAIN: Record<string, string[]> = {
      '1:1': ['overload', 'heavy', 'pierce'],
      '1:6': ['explosive', 'choke', 'rapid'],
      '7:1': ['bounce', 'heavy', 'homing'],
      '7:4': ['shock', 'split', 'bounce'],
      '42:3': ['shock', 'bulk', 'heavy'],
      '1234:3': ['homing', 'choke', 'detonator'],
      '3735928559:2': ['bulk', 'choke', 'glassCannon'],
      '3735928559:6': ['pierce', 'incendiary', 'splinterShot'],
    }
    for (const [key, offer] of Object.entries(MAIN)) {
      const [seed, floor] = key.split(':').map(Number)
      expect(floorDraftOffer(seed, floor, 3), key).toEqual(offer)
    }
  })
})

describe('draftCards — display data', () => {
  it('maps ids to kid-readable cards, dropping unknowns', () => {
    const cards = draftCards({ offer: ['frost', 'nope', 'bounce'] })
    expect(cards.map((c) => c.id)).toEqual(['frost', 'bounce'])
    expect(cards[0]).toMatchObject({ name: MODS.frost.name, blurb: MODS.frost.blurb, icon: MODS.frost.icon, rarity: 'rare' })
  })
})

describe('applyDraftPick — append / stack / cap', () => {
  it('appends a new mod to a vanilla weapon', () => {
    const stack: ItemStack = { itemId: 'pistol', qty: 8 }
    applyDraftPick(stack, 'frost')
    expect(stack.mods).toEqual([{ id: 'frost', stacks: 1 }])
  })

  it('stacks an already-picked mod', () => {
    const stack: ItemStack = { itemId: 'pistol', qty: 8, mods: [{ id: 'overload', stacks: 1 }] }
    applyDraftPick(stack, 'overload')
    expect(stack.mods).toEqual([{ id: 'overload', stacks: 2 }])
  })

  it('never exceeds a mod maxStacks', () => {
    const stack: ItemStack = { itemId: 'pistol', qty: 8 }
    for (let i = 0; i < 20; i++) applyDraftPick(stack, 'frost') // frost maxStacks = 1
    expect(stack.mods).toEqual([{ id: 'frost', stacks: 1 }])
  })

  it('rejects an unknown mod id', () => {
    expect(() => applyDraftPick({ itemId: 'pistol', qty: 8 }, 'nope')).toThrow(/unknown mod/)
  })
})
