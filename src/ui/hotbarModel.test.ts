import { describe, expect, it } from 'vitest'
import { hasThrowable, hotbarSlots, modBadge } from './hotbarModel'

describe('hotbarSlots', () => {
  it('keeps each item pointing at its real inventory index across the filters', () => {
    // The briefcase AND the permanent weapon are both filtered out of display,
    // so a tapped strip position must map back through `index`.
    const inv = [
      { itemId: 'briefcase', qty: 1 },
      { itemId: 'pistol', qty: 1 },
      { itemId: 'grenade', qty: 2 },
      { itemId: 'medkit', qty: 1 },
    ]
    const slots = hotbarSlots(inv, 3)
    expect(slots.map((s) => s.itemId)).toEqual(['grenade', 'medkit'])
    expect(slots.map((s) => s.index)).toEqual([2, 3])
    expect(slots.find((s) => s.itemId === 'medkit')!.active).toBe(true)
    expect(slots.find((s) => s.itemId === 'grenade')!.active).toBe(false)
  })

  it('NEVER shows a weapon — there is no weapon-selected indicator any more', () => {
    const inv = [{ itemId: 'pistol', qty: 1 }, { itemId: 'bat', qty: 12 }, { itemId: 'grenade', qty: 2 }]
    expect(hotbarSlots(inv, 0).map((s) => s.itemId)).toEqual(['grenade'])
  })

  it('marks no slot active when activeSlot is -1', () => {
    const slots = hotbarSlots([{ itemId: 'grenade', qty: 2 }], -1)
    expect(slots.every((s) => !s.active)).toBe(true)
  })
})

describe('modBadge / hotbar mod display', () => {
  it('is empty for a vanilla weapon', () => {
    expect(modBadge({ itemId: 'pistol', qty: 6 })).toBe('')
    expect(hotbarSlots([{ itemId: 'grenade', qty: 2 }], 0)[0].mods).toBe('')
  })
  it('shows an icon per mod, with ×N for a stack', () => {
    const badge = modBadge({ itemId: 'shotgun', qty: 6, mods: [{ id: 'frost', stacks: 1 }, { id: 'bounce', stacks: 2 }] })
    expect(badge).toContain('❄️')
    expect(badge).toContain('🪃×2')
  })
  it('surfaces the badge through hotbarSlots', () => {
    const slots = hotbarSlots([{ itemId: 'grenade', qty: 2, mods: [{ id: 'overload', stacks: 3 }] }], 0)
    expect(slots[0].mods).toContain('💥×3')
  })
  it('ignores unknown / zero-stack mods', () => {
    expect(modBadge({ itemId: 'pistol', qty: 6, mods: [{ id: 'nope', stacks: 2 }, { id: 'frost', stacks: 0 }] })).toBe('')
  })
})

describe('hasThrowable', () => {
  it('is true when a throwable is carried', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 1 }, { itemId: 'grenade', qty: 2 }])).toBe(true)
  })
  it('is false with no throwables', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 1 }])).toBe(false)
  })
})
