import { describe, it, expect } from 'vitest'
import { readPad } from './readPad'
import { padProfile } from './padProfile'

const btn = (pressed: boolean) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })

const fakePad = (
  over: { buttons?: boolean[]; axes?: number[]; axisCount?: number; id?: string; mapping?: string } = {},
) => {
  const buttons = Array.from({ length: 17 }, (_, i) => btn(over.buttons?.[i] ?? false))
  const n = over.axisCount ?? 10
  const axes = Array.from({ length: n }, (_, i) => over.axes?.[i] ?? 0)
  return {
    id: over.id ?? 'test',
    mapping: over.mapping ?? 'standard',
    buttons,
    axes,
  } as unknown as Gamepad
}

/** The exact axis value a one-axis hat reports for evdev hat `state`.
 * value = state * (2/7) - 1  →  states 0-7 are directions, 15 is "no direction". */
const hatValue = (state: number) => state * (2 / 7) - 1

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

    // The full evdev hat table: states 0-7 are the eight directions clockwise
    // from up. Anything not landing on one of these exact values is not a hat
    // reading at all -- see the neutrality suite below.
    it.each([
      [0, 0, -1],
      [1, 1, -1],
      [2, 1, 0],
      [3, 1, 1],
      [4, 0, 1],
      [5, -1, 1],
      [6, -1, 0],
      [7, -1, -1],
    ])('decodes hat state %i as (%i, %i)', (state, x, y) => {
      const axes: number[] = []
      axes[9] = hatValue(state)
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBe(x)
      expect(s.moveY).toBe(y)
    })
  })

  // Regression suite for the "runs straight down forever" bug: a hat axis that
  // is absent, resting, or simply not a hat must read as NO direction, and must
  // never overwrite a stick the player is actually pushing.
  describe('hat neutrality (the phantom-down bug)', () => {
    const zero2 = padProfile({ id: '8BitDo Zero 2', mapping: '' })
    const gen = padProfile({ id: 'Some Generic USB Joystick', mapping: '' })

    it('reports no movement when the hat axis is absent entirely (4-axis pad)', () => {
      const s = readPad(fakePad({ axisCount: 4 }), gen)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })

    it('respects the stick when the hat axis is absent entirely', () => {
      const s = readPad(fakePad({ axisCount: 4, axes: [0, -0.9] }), gen)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBeCloseTo(-0.9)
    })

    // 0 decodes to state 3.5 -- exactly between two directions, so it is not a
    // valid hat encoding. The old decode rounded it to state 4 = DOWN.
    it('reports no movement when the hat axis reads exactly 0', () => {
      const axes: number[] = []
      axes[9] = 0
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })

    it('respects the stick when the hat axis reads exactly 0', () => {
      const s = readPad(fakePad({ axes: [0, -0.9, 0, 0, 0, 0, 0, 0, 0, 0] }), zero2)
      expect(s.moveY).toBeCloseTo(-0.9)
    })

    it('respects the stick when the hat axis rests at 3.2857', () => {
      const axes: number[] = [0, -0.9]
      axes[9] = 3.2857
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveY).toBeCloseTo(-0.9)
    })

    it.each([-0.3, 0.3, 0.05, -0.9, 0.62, 2, -1.4, 100, -100])(
      'treats %p -- not an exact hat state -- as no direction',
      (v) => {
        const axes: number[] = []
        axes[9] = v
        const s = readPad(fakePad({ axes }), zero2)
        expect(s.moveX).toBe(0)
        expect(s.moveY).toBe(0)
      },
    )

    it('treats a NaN hat axis as no direction', () => {
      const axes: number[] = []
      axes[9] = NaN
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })

    it('treats NaN stick axes as centred rather than leaking NaN into moveX/moveY', () => {
      const s = readPad(fakePad({ axes: [NaN, NaN, NaN, NaN] }), std)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
    })

    it('survives an empty axes array', () => {
      const s = readPad(fakePad({ axisCount: 0 }), gen)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
    })

    it('survives an axes array longer than expected and still finds the hat', () => {
      const axes: number[] = []
      axes[9] = hatValue(0)
      const s = readPad(fakePad({ axes, axisCount: 24 }), zero2)
      expect(s.moveY).toBe(-1)
    })
  })

  // How the hat composes with the other movement sources. The hat decode on a
  // non-standard pad is a heuristic guess; the stick and d-pad buttons are not.
  // So the hat FILLS IN only -- it claims an axis nothing else has moved.
  describe('hat vs stick precedence', () => {
    const zero2 = padProfile({ id: '8BitDo Zero 2', mapping: '' })

    it('lets the hat move an axis the stick leaves centred', () => {
      const axes: number[] = []
      axes[9] = hatValue(2) // right
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBe(1)
    })

    it('lets a deflected stick win over an active hat on the same axis', () => {
      const axes: number[] = [-0.9]
      axes[9] = hatValue(2) // hat says right, stick says hard left
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBeCloseTo(-0.9)
    })

    it('fills only the axis the stick leaves centred when the hat is diagonal', () => {
      const axes: number[] = [-0.9, 0]
      axes[9] = hatValue(3) // hat says down-right: (1, 1)
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBeCloseTo(-0.9) // stick keeps X
      expect(s.moveY).toBe(1) // hat fills Y
    })

    it('lets a pressed d-pad button win over the hat', () => {
      const axes: number[] = []
      axes[9] = hatValue(4) // hat says down
      const buttons: boolean[] = []
      buttons[12] = true // d-pad up
      const s = readPad(fakePad({ axes, buttons }), zero2)
      expect(s.moveY).toBe(-1)
    })
  })

  // The exact Android repro: Chromium reports mapping '' for many pads, which
  // resolves to the permissive profile with its speculative hatAxis: 9.
  describe('the Android repro: a non-standard-mapping pad with only 4 axes', () => {
    const pad = (axes: number[]) =>
      fakePad({ axes, axisCount: 4, id: 'Xbox Wireless Controller', mapping: '' })
    const prof = padProfile({ id: 'Xbox Wireless Controller', mapping: '' })

    it('does not pin the player to a constant +Y when idle', () => {
      const s = readPad(pad([0, 0, 0, 0]), prof)
      expect(s.moveY).toBe(0)
      expect(s.moveX).toBe(0)
    })

    it('lets the player walk up', () => {
      expect(readPad(pad([0, -0.9, 0, 0]), prof).moveY).toBeCloseTo(-0.9)
    })

    it('lets the player walk down deliberately', () => {
      expect(readPad(pad([0, 0.9, 0, 0]), prof).moveY).toBeCloseTo(0.9)
    })

    it('lets the player walk left and right', () => {
      expect(readPad(pad([-0.9, 0, 0, 0]), prof).moveX).toBeCloseTo(-0.9)
      expect(readPad(pad([0.9, 0, 0, 0]), prof).moveX).toBeCloseTo(0.9)
    })
  })

  // A standard-mapping pad has hatAxis: null, so axis 9 must never reach move.
  describe('standard-mapping pads are unaffected (regression guard)', () => {
    it('ignores axis 9 entirely, whatever it reads', () => {
      for (const v of [0, -1, 1, 3.2857, NaN]) {
        const axes: number[] = []
        axes[9] = v
        const s = readPad(fakePad({ axes }), std)
        expect(s.moveX).toBe(0)
        expect(s.moveY).toBe(0)
      }
    })

    it('still reads the left stick normally with axis 9 populated', () => {
      const axes: number[] = [0.9, -0.5]
      axes[9] = -1
      const s = readPad(fakePad({ axes }), std)
      expect(s.moveX).toBeCloseTo(0.9)
      expect(s.moveY).toBeCloseTo(-0.5)
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
