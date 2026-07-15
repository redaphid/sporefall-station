import { describe, it, expect } from 'vitest'
import { readPad } from './readPad'
import { padProfile } from './padProfile'

const btn = (pressed: boolean) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })

const fakePad = (over: { buttons?: boolean[]; axes?: number[] } = {}) => {
  const buttons = Array.from({ length: 17 }, (_, i) => btn(over.buttons?.[i] ?? false))
  const axes = Array.from({ length: 10 }, (_, i) => over.axes?.[i] ?? 0)
  return { id: 'test', mapping: 'standard', buttons, axes } as unknown as Gamepad
}

const std = padProfile({ id: 'x', mapping: 'standard' })

describe('readPad', () => {
  describe('movement from the left stick', () => {
    it('ignores tiny drift inside the deadzone', () => {
      const s = readPad(fakePad({ axes: [0.1, -0.1] }), std)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })
    it('passes through a real push past the deadzone', () => {
      const s = readPad(fakePad({ axes: [0.9, 0] }), std)
      expect(s.moveX).toBeCloseTo(0.9)
    })
  })

  describe('movement from the d-pad buttons', () => {
    it('reads left as moveX -1', () => {
      const buttons: boolean[] = []
      buttons[14] = true
      expect(readPad(fakePad({ buttons }), std).moveX).toBe(-1)
    })
    it('reads down as moveY 1', () => {
      const buttons: boolean[] = []
      buttons[13] = true
      expect(readPad(fakePad({ buttons }), std).moveY).toBe(1)
    })
  })

  describe('movement from a hat axis (8bitdo non-standard)', () => {
    const zero2 = padProfile({ id: '8BitDo Zero 2', mapping: '' })

    it('decodes the "up" hat value as moveY -1', () => {
      const axes: number[] = []
      axes[9] = -1
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveY).toBe(-1)
      expect(s.moveX).toBe(0)
    })
    it('decodes the "right" hat value as moveX 1', () => {
      const axes: number[] = []
      axes[9] = -0.4285714
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBe(1)
      expect(s.moveY).toBe(0)
    })
    it('treats an out-of-range rest value as no direction', () => {
      const axes: number[] = []
      axes[9] = 3.2857
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })
  })

  describe('action buttons', () => {
    it('reports attack when the bottom face button is down', () => {
      const buttons: boolean[] = []
      buttons[0] = true
      expect(readPad(fakePad({ buttons }), std).attack).toBe(true)
    })
    it('reports interact on the right face button', () => {
      const buttons: boolean[] = []
      buttons[1] = true
      expect(readPad(fakePad({ buttons }), std).interact).toBe(true)
    })
    it('reports special on the left face button', () => {
      const buttons: boolean[] = []
      buttons[2] = true
      expect(readPad(fakePad({ buttons }), std).special).toBe(true)
    })
    it('reports pause on Start', () => {
      const buttons: boolean[] = []
      buttons[9] = true
      expect(readPad(fakePad({ buttons }), std).pause).toBe(true)
    })
    it('reports nothing when idle', () => {
      const s = readPad(fakePad(), std)
      expect(s.attack).toBe(false)
      expect(s.pause).toBe(false)
    })
  })
})
