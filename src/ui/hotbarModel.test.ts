import { describe, expect, it } from 'vitest'
import { hasThrowable, hotbarSlots, modBadge } from './hotbarModel'

describe('hotbarSlots', () => {
  it('keeps each item pointing at its real inventory index across the filter', () => {
    // Slot 0 is the permanent weapon and slot 1 the briefcase — both hidden — so
    // the surviving items must still carry their TRUE indices, or a tapped strip
    // position equips the wrong slot.
    const inv = [
      { itemId: 'pistol', qty: 1 },
      { itemId: 'briefcase', qty: 1 },
      { itemId: 'grenade', qty: 2 },
      { itemId: 'bandage', qty: 3 },
    ]
    const slots = hotbarSlots(inv, 3)
    expect(slots.map((s) => s.itemId)).toEqual(['grenade', 'bandage'])
    expect(slots.map((s) => s.index)).toEqual([2, 3])
    expect(slots.find((s) => s.itemId === 'bandage')!.active).toBe(true)
    expect(slots.find((s) => s.itemId === 'grenade')!.active).toBe(false)
  })

  it('NEVER shows a weapon — the one permanent weapon is not switchable', () => {
    // Weapons live in the inventory only so their mods have a home. Showing one
    // would offer a swap that cannot happen, and gamepad cycling walks exactly
    // this list, so a shown weapon would also be a cyclable dead end.
    const inv = [
      { itemId: 'pistol', qty: 1 },
      { itemId: 'bat', qty: 16 },
      { itemId: 'shotgun', qty: 1 },
      { itemId: 'molotov', qty: 1 },
    ]
    expect(hotbarSlots(inv, 0).map((s) => s.itemId)).toEqual(['molotov'])
  })

  it('is empty when the player carries nothing but their weapon', () => {
    expect(hotbarSlots([{ itemId: 'pistol', qty: 1 }], 0)).toEqual([])
  })

  it('marks no slot active when activeSlot is -1', () => {
    const slots = hotbarSlots([{ itemId: 'grenade', qty: 1 }], -1)
    expect(slots.every((s) => !s.active)).toBe(true)
  })
})

describe('modBadge / hotbar mod display', () => {
  it('is empty for a vanilla weapon', () => {
    expect(modBadge({ itemId: 'pistol', qty: 6 })).toBe('')
    expect(modBadge({ itemId: 'grenade', qty: 2 })).toBe('')
  })
  it('shows an icon per mod, with ×N for a stack', () => {
    const badge = modBadge({ itemId: 'shotgun', qty: 6, mods: [{ id: 'frost', stacks: 1 }, { id: 'bounce', stacks: 2 }] })
    expect(badge).toContain('❄️')
    expect(badge).toContain('🪃×2')
  })
  it('the WEAPON badge is still readable even though the weapon has no hotbar slot', () => {
    // Mods are the whole progression, so hiding the weapon slot must not hide the
    // player's mods. `modBadge` is now called directly by the HUD against the
    // weapon's stack (ui/hud.ts) — this pins that it still renders.
    const weapon = { itemId: 'pistol', qty: 1, mods: [{ id: 'overload', stacks: 3 }] }
    expect(hotbarSlots([weapon], 0)).toEqual([]) // not in the strip...
    expect(modBadge(weapon)).toContain('💥×3') // ...but the badge still resolves
  })
  it('ignores unknown / zero-stack mods', () => {
    expect(modBadge({ itemId: 'pistol', qty: 6, mods: [{ id: 'nope', stacks: 2 }, { id: 'frost', stacks: 0 }] })).toBe('')
  })
})

describe('hasThrowable', () => {
  it('is true when a throwable is carried', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 6 }, { itemId: 'grenade', qty: 2 }])).toBe(true)
  })
  it('is false with no throwables', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 6 }])).toBe(false)
  })
})
