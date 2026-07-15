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

  describe('aim from the right stick', () => {
    it('reads the right stick (axes 2/3) into aimX/aimY past the deadzone', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.8, -0.9] }), std)
      expect(s.aimX).toBeCloseTo(0.8)
      expect(s.aimY).toBeCloseTo(-0.9)
    })
    it('ignores right-stick drift inside the deadzone', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.1, -0.1] }), std)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
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

  describe('throw / weapon-switch buttons', () => {
    const gen = padProfile({ id: 'Some Generic USB Joystick', mapping: '' })

    it('reports throwItem when the standard throw button is down', () => {
      const buttons: boolean[] = []
      buttons[std.throw[0]] = true
      expect(readPad(fakePad({ buttons }), std).throwItem).toBe(true)
    })
    it('reports hotbarNext when the standard next button is down', () => {
      const buttons: boolean[] = []
      buttons[std.hotbarNext[0]] = true
      const s = readPad(fakePad({ buttons }), std)
      expect(s.hotbarNext).toBe(true)
      expect(s.hotbarPrev).toBe(false)
    })
    it('reports hotbarPrev when the standard prev button is down', () => {
      const buttons: boolean[] = []
      buttons[std.hotbarPrev[0]] = true
      expect(readPad(fakePad({ buttons }), std).hotbarPrev).toBe(true)
    })
    it('maps the same verbs on the generic profile too', () => {
      const buttons: boolean[] = []
      buttons[gen.throw[0]] = true
      expect(readPad(fakePad({ buttons }), gen).throwItem).toBe(true)
      const b2: boolean[] = []
      b2[gen.hotbarNext[0]] = true
      expect(readPad(fakePad({ buttons: b2 }), gen).hotbarNext).toBe(true)
    })
    it('is all false when idle', () => {
      const s = readPad(fakePad(), std)
      expect(s.throwItem).toBe(false)
      expect(s.hotbarPrev).toBe(false)
      expect(s.hotbarNext).toBe(false)
    })
  })

  describe('aim-to-fire parity with touch', () => {
    it('fires attack when the right stick deflects past the fire threshold, no button', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.9, 0] }), std)
      expect(s.attack).toBe(true)
    })
    it('does not fire from a small right-stick nudge below the threshold', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.3, 0] }), std)
      expect(s.attack).toBe(false)
    })
    it('still fires from the attack button with the aim stick centred', () => {
      const buttons: boolean[] = []
      buttons[0] = true
      expect(readPad(fakePad({ buttons }), std).attack).toBe(true)
    })
  })
})
