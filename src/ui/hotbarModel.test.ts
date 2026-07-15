import { describe, expect, it } from 'vitest'
import { hasThrowable, hotbarSlots } from './hotbarModel'

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

describe('hasThrowable', () => {
  it('is true when a throwable is carried', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 6 }, { itemId: 'grenade', qty: 2 }])).toBe(true)
  })
  it('is false with no throwables', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 6 }])).toBe(false)
  })
})
