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
