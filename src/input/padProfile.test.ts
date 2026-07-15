import { describe, it, expect } from 'vitest'
import { padProfile } from './padProfile'

describe('padProfile', () => {
  describe('a standard-mapping pad (Xbox/PS/8bitdo in X-input)', () => {
    const p = padProfile({ id: 'Xbox Wireless Controller', mapping: 'standard' })

    it('maps attack to the bottom face button', () => {
      expect(p.attack).toContain(0)
    })
    it('maps interact to the right face button', () => {
      expect(p.interact).toContain(1)
    })
    it('maps special to the left/top face buttons', () => {
      expect(p.special).toContain(2)
    })
    it('maps pause to Start (button 9)', () => {
      expect(p.pause).toContain(9)
    })
    it('reads the d-pad from standard buttons 12-15', () => {
      expect(p.dpad).toEqual([12, 13, 14, 15])
    })
    it('reads movement from the left stick axes 0/1', () => {
      expect(p.moveAxes).toEqual([0, 1])
    })
    it('has no separate hat axis', () => {
      expect(p.hatAxis).toBe(null)
    })
    it('lets any face button or start trigger press-to-join', () => {
      expect(p.join).toEqual(expect.arrayContaining([0, 1, 2, 3, 9]))
    })
    it('maps throw and weapon-cycle to free buttons that do not collide with move/attack/roll', () => {
      expect(p.throw.length).toBeGreaterThan(0)
      expect(p.hotbarPrev.length).toBeGreaterThan(0)
      expect(p.hotbarNext.length).toBeGreaterThan(0)
      const taken = new Set([...p.attack, ...p.interact, ...p.special, ...p.roll, ...p.dpad])
      for (const b of [...p.throw, ...p.hotbarPrev, ...p.hotbarNext]) expect(taken.has(b)).toBe(false)
      // prev and next must be distinct buttons
      expect(p.hotbarPrev).not.toEqual(p.hotbarNext)
    })
  })

  describe('an 8bitdo Zero 2 in a non-standard mode', () => {
    const p = padProfile({ id: '8BitDo Zero 2 gamepad', mapping: '' })

    it('is recognised as the zero2 profile', () => {
      expect(p.kind).toBe('zero2')
    })
    it('decodes the d-pad from the hat on axis 9', () => {
      expect(p.hatAxis).toBe(9)
    })
    it('still offers a face button for attack', () => {
      expect(p.attack.length).toBeGreaterThan(0)
    })
    it('still offers a pause button', () => {
      expect(p.pause.length).toBeGreaterThan(0)
    })
    it('also maps throw and weapon-cycle (best-guess, needs a real-device check)', () => {
      expect(p.throw.length).toBeGreaterThan(0)
      expect(p.hotbarPrev.length).toBeGreaterThan(0)
      expect(p.hotbarNext.length).toBeGreaterThan(0)
      expect(p.hotbarPrev).not.toEqual(p.hotbarNext)
    })
  })

  describe('an unknown non-standard pad', () => {
    const p = padProfile({ id: 'Some Generic USB Joystick', mapping: '' })

    it('falls back to the permissive generic profile', () => {
      expect(p.kind).toBe('generic')
    })
    it('still has a hat axis so its d-pad can work', () => {
      expect(p.hatAxis).toBe(9)
    })
  })
})
