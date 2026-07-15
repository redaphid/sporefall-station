import { describe, expect, it } from 'vitest'
import { hasThrowable, hotbarSlots, modBadge } from './hotbarModel'

describe('hotbarSlots', () => {
  it('keeps each item pointing at its real inventory index across the briefcase filter', () => {
    const inv = [{ itemId: 'briefcase', qty: 1 }, { itemId: 'pistol', qty: 6 }, { itemId: 'bat', qty: 1 }]
    const slots = hotbarSlots(inv, 2)
    // Briefcase dropped from display, but the bat keeps its true index 2.
    expect(slots.map((s) => s.itemId)).toEqual(['pistol', 'bat'])
    expect(slots.map((s) => s.index)).toEqual([1, 2])
    expect(slots.find((s) => s.itemId === 'bat')!.active).toBe(true)
    expect(slots.find((s) => s.itemId === 'pistol')!.active).toBe(false)
  })

  it('marks no slot active when activeSlot is -1', () => {
    const slots = hotbarSlots([{ itemId: 'pistol', qty: 6 }], -1)
    expect(slots.every((s) => !s.active)).toBe(true)
  })
})

describe('modBadge / hotbar mod display', () => {
  it('is empty for a vanilla weapon', () => {
    expect(modBadge({ itemId: 'pistol', qty: 6 })).toBe('')
    expect(hotbarSlots([{ itemId: 'pistol', qty: 6 }], 0)[0].mods).toBe('')
  })
  it('shows an icon per mod, with ×N for a stack', () => {
    const badge = modBadge({ itemId: 'shotgun', qty: 6, mods: [{ id: 'frost', stacks: 1 }, { id: 'bounce', stacks: 2 }] })
    expect(badge).toContain('❄️')
    expect(badge).toContain('🪃×2')
  })
  it('surfaces the badge through hotbarSlots', () => {
    const slots = hotbarSlots([{ itemId: 'pistol', qty: 6, mods: [{ id: 'overload', stacks: 3 }] }], 0)
    expect(slots[0].mods).toContain('💥×3')
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
