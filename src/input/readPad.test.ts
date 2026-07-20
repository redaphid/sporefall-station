import { describe, it, expect } from 'vitest'
import { DEADZONE, readPad } from './readPad'
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

/** Expected stick output after the RADIAL deadzone + rescale: magnitude ramps
 * from 0 at the 0.28 rim to 1 at full tilt, direction preserved, clamped at 1.
 * Computed independently of the implementation. */
const dz = (x: number, y = 0) => {
  const mag = Math.hypot(x, y)
  if (mag < 0.28) return { x: 0, y: 0 }
  const k = Math.min(1, (mag - 0.28) / (1 - 0.28)) / mag
  return { x: x * k, y: y * k }
}

const std = padProfile(fakePad({ mapping: 'standard' }))

describe('readPad', () => {
  describe('movement from the left stick', () => {
    it('ignores tiny drift inside the deadzone', () => {
      const s = readPad(fakePad({ axes: [0.1, -0.1] }), std)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })
    it('rescales a real push past the deadzone (radial: 0 at the rim, 1 at full tilt)', () => {
      const s = readPad(fakePad({ axes: [0.9, 0] }), std)
      expect(s.moveX).toBeCloseTo(dz(0.9).x, 5)
    })
    it('ramps smoothly from the deadzone rim instead of snapping to 0.28', () => {
      const s = readPad(fakePad({ axes: [0.29, 0] }), std)
      expect(s.moveX).toBeGreaterThan(0)
      expect(s.moveX).toBeLessThan(0.03)
    })
    it('keeps the pushed direction on a near-vertical diagonal (no axis snapping)', () => {
      const s = readPad(fakePad({ axes: [0.15, -0.9] }), std)
      expect(s.moveX).toBeGreaterThan(0) // per-axis clipping would zero this
      expect(s.moveY / s.moveX).toBeCloseTo(-0.9 / 0.15, 5) // direction preserved
    })
    it('reaches exactly full speed at full tilt', () => {
      const s = readPad(fakePad({ axes: [1, 0] }), std)
      expect(s.moveX).toBeCloseTo(1, 5)
    })
    it('clamps an out-of-spec axis (>1) to magnitude 1', () => {
      const s = readPad(fakePad({ axes: [1.6, 0] }), std)
      expect(s.moveX).toBeCloseTo(1, 5)
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
    const zero2 = padProfile(fakePad({ id: '8BitDo Zero 2', mapping: '' }))

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
    const zero2 = padProfile(fakePad({ id: '8BitDo Zero 2', mapping: '' }))
    const gen = padProfile(fakePad({ id: 'Some Generic USB Joystick', mapping: '' }))

    it('reports no movement when the hat axis is absent entirely (4-axis pad)', () => {
      const s = readPad(fakePad({ axisCount: 4 }), gen)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })

    it('respects the stick when the hat axis is absent entirely', () => {
      const s = readPad(fakePad({ axisCount: 4, axes: [0, -0.9] }), gen)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBeCloseTo(dz(-0.9).x, 5)
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
      expect(s.moveY).toBeCloseTo(dz(-0.9).x, 5)
    })

    it('respects the stick when the hat axis rests at 3.2857', () => {
      const axes: number[] = [0, -0.9]
      axes[9] = 3.2857
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveY).toBeCloseTo(dz(-0.9).x, 5)
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
    const zero2 = padProfile(fakePad({ id: '8BitDo Zero 2', mapping: '' }))

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
      expect(s.moveX).toBeCloseTo(dz(-0.9).x, 5)
    })

    it('fills only the axis the stick leaves centred when the hat is diagonal', () => {
      const axes: number[] = [-0.9, 0]
      axes[9] = hatValue(3) // hat says down-right: (1, 1)
      const s = readPad(fakePad({ axes }), zero2)
      expect(s.moveX).toBeCloseTo(dz(-0.9).x, 5) // stick keeps X
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
    const prof = padProfile(fakePad({ id: 'Xbox Wireless Controller', mapping: '', axisCount: 4 }))

    it('does not pin the player to a constant +Y when idle', () => {
      const s = readPad(pad([0, 0, 0, 0]), prof)
      expect(s.moveY).toBe(0)
      expect(s.moveX).toBe(0)
    })

    it('lets the player walk up', () => {
      expect(readPad(pad([0, -0.9, 0, 0]), prof).moveY).toBeCloseTo(dz(-0.9).x, 5)
    })

    it('lets the player walk down deliberately', () => {
      expect(readPad(pad([0, 0.9, 0, 0]), prof).moveY).toBeCloseTo(dz(0.9).x, 5)
    })

    it('lets the player walk left and right', () => {
      expect(readPad(pad([-0.9, 0, 0, 0]), prof).moveX).toBeCloseTo(dz(-0.9).x, 5)
      expect(readPad(pad([0.9, 0, 0, 0]), prof).moveX).toBeCloseTo(dz(0.9).x, 5)
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
      expect(s.moveX).toBeCloseTo(dz(0.9, -0.5).x, 5)
      expect(s.moveY).toBeCloseTo(dz(0.9, -0.5).y, 5)
    })
  })

  describe('aim from the right stick', () => {
    it('reads the right stick (axes 2/3) into aimX/aimY past the deadzone', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.8, -0.9] }), std)
      expect(s.aimX).toBeCloseTo(dz(0.8, -0.9).x, 5)
      expect(s.aimY).toBeCloseTo(dz(0.8, -0.9).y, 5)
    })
    it('ignores right-stick drift inside the deadzone', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.1, -0.1] }), std)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
    })
  })

  /**
   * Analog-stick DRIFT rejection — the 8BitDo-Lite-2-keeps-walking report. A
   * drifty Bluetooth pad does not return its sticks to exactly 0; the radial
   * deadzone (readPad.radialDeadzone, DEADZONE) is what makes a RELEASED stick
   * yield exactly zero movement/aim. These pin the property on BOTH sticks with
   * the exact adversarial vectors, so a future tweak to DEADZONE or the rescale
   * can't silently reopen the drift.
   */
  describe('drift rejection on a released stick (radial deadzone, both sticks)', () => {
    it('has a deadzone radius generous enough for a drifty BT pad (>= 0.15)', () => {
      // The residual noise of a worn/cheap stick sits well under this; a value
      // in the 0.15..0.30 band kills it without eating meaningful deflection.
      expect(DEADZONE).toBeGreaterThanOrEqual(0.15)
      expect(DEADZONE).toBeLessThanOrEqual(0.35)
    })

    // Movement stick.
    it('a residual left-stick drift of (0.08, 0.05) yields exactly zero movement', () => {
      const s = readPad(fakePad({ axes: [0.08, 0.05] }), std)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })
    it('asymmetric release noise (-0.12, 0.19) — magnitude still inside the rim — is zero', () => {
      const s = readPad(fakePad({ axes: [-0.12, 0.19] }), std) // mag ≈ 0.225 < 0.28
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })
    it('a deflection just past the rim is small but nonzero and smoothly scaled (no snap)', () => {
      const s = readPad(fakePad({ axes: [DEADZONE + 0.01, 0] }), std)
      expect(s.moveX).toBeGreaterThan(0)
      expect(s.moveX).toBeLessThan(0.05) // ramps from 0 at the rim, not a jump to 0.28
    })
    it('full deflection still reaches full magnitude (deadzone did not cost range)', () => {
      const s = readPad(fakePad({ axes: [0, 1] }), std)
      expect(Math.hypot(s.moveX, s.moveY)).toBeCloseTo(1, 5)
    })

    // Aim stick — the SAME treatment (drift would otherwise nudge the reticle).
    it('a residual right-stick drift of (0.08, 0.05) yields exactly zero aim', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.08, 0.05] }), std)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
    })
    it('a real right-stick push past the rim survives (aim is not over-suppressed)', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0, -0.95] }), std)
      expect(Math.hypot(s.aimX, s.aimY)).toBeGreaterThan(0)
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

  /**
   * The exact reported symptom, pinned by index: "R2 (button 7) triggers Start".
   * These guard the DISJOINTNESS of the W3C standard layout — that a physical
   * index fires only its own action and never a neighbour's — since the mapping
   * table (padProfile) is off-by-nothing today but is precisely what a shifted
   * or non-standard-pad table would corrupt.
   */
  describe('button-index → action disjointness (W3C standard mapping)', () => {
    const press = (i: number) => {
      const buttons: boolean[] = []
      buttons[i] = true
      return readPad(fakePad({ buttons }), std)
    }

    it('index 7 (R2, the right trigger) fires attack and NOT pause/start', () => {
      const s = press(7)
      expect(s.attack).toBe(true)
      expect(s.pause).toBe(false)
    })

    it('index 9 (Start) fires pause and NOT attack — the inverse of the bug', () => {
      const s = press(9)
      expect(s.pause).toBe(true)
      expect(s.attack).toBe(false)
    })

    // A representative sweep of the standard layout: each index lights its own
    // action and no other. Attack is intentionally the OR of {0,5,6,7}, so those
    // four share it; every other index owns exactly one action.
    it.each([
      [0, { attack: true }], // A
      [1, { interact: true }], // B
      [2, { special: true }], // X
      [3, { special: true }], // Y
      [4, { roll: true }], // LB
      [5, { attack: true }], // RB
      [6, { attack: true }], // L2
      [7, { attack: true }], // R2
      [8, { throwItem: true }], // Back/Select
      [9, { pause: true }], // Start
      [10, { hotbarPrev: true }], // L3
      [11, { hotbarNext: true }], // R3
    ] as const)('index %i lights exactly its own action', (i, expected) => {
      const s = press(i)
      const fields = ['attack', 'interact', 'special', 'roll', 'pause', 'throwItem', 'hotbarPrev', 'hotbarNext'] as const
      for (const f of fields) expect(s[f]).toBe(f in expected ? expected[f as keyof typeof expected] : false)
    })

    it('composes simultaneous presses — R2 + Start fire attack AND pause together', () => {
      const buttons: boolean[] = []
      buttons[7] = true // R2
      buttons[9] = true // Start
      const s = readPad(fakePad({ buttons }), std)
      expect(s.attack).toBe(true)
      expect(s.pause).toBe(true)
      expect(s.interact).toBe(false)
    })
  })

  describe('throw / weapon-switch buttons', () => {
    const gen = padProfile(fakePad({ id: 'Some Generic USB Joystick', mapping: '' }))

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

  // Firing is buttons only: the aim stick aims and NEVER fires. (Touch keeps
  // its own aim-to-fire rule — a phone has no trigger; a pad has four.)
  describe('the aim stick aims but never fires', () => {
    it('does not fire from a fully deflected right stick', () => {
      const s = readPad(fakePad({ axes: [0, 0, 0.9, 0] }), std)
      expect(s.attack).toBe(false)
      expect(s.aimX).toBeCloseTo(dz(0.9).x, 5)
    })
    it('does not fire from a hard diagonal deflection either', () => {
      const s = readPad(fakePad({ axes: [0, 0, -1, -1] }), std)
      expect(s.attack).toBe(false)
    })
    it('still fires from the attack button with the aim stick centred', () => {
      const buttons: boolean[] = []
      buttons[0] = true
      expect(readPad(fakePad({ buttons }), std).attack).toBe(true)
    })
  })

  describe('L2 fires (the explicit trigger), with analog .value tolerance', () => {
    const withBtn = (i: number, b: { pressed: boolean; value: number }) => {
      const pad = fakePad()
      ;(pad.buttons as unknown as { pressed: boolean; touched: boolean; value: number }[])[i] = {
        ...b,
        touched: b.pressed,
      }
      return pad
    }

    it('fires while L2 (button 6) is pressed', () => {
      const buttons: boolean[] = []
      buttons[6] = true
      expect(readPad(fakePad({ buttons }), std).attack).toBe(true)
    })
    it('fires while R2 (button 7) is pressed', () => {
      const buttons: boolean[] = []
      buttons[7] = true
      expect(readPad(fakePad({ buttons }), std).attack).toBe(true)
    })
    it('does not roll when L2 fires — roll lives on LB alone now', () => {
      const buttons: boolean[] = []
      buttons[6] = true
      const s = readPad(fakePad({ buttons }), std)
      expect(s.roll).toBe(false)
      expect(readPad(fakePad({ buttons: (() => { const b: boolean[] = []; b[4] = true; return b })() }), std).roll).toBe(true)
    })
    it('fires from analog travel past half even when .pressed lags (value 0.8, pressed false)', () => {
      expect(readPad(withBtn(6, { pressed: false, value: 0.8 }), std).attack).toBe(true)
    })
    it('does not fire from a light squeeze (value 0.3)', () => {
      expect(readPad(withBtn(6, { pressed: false, value: 0.3 }), std).attack).toBe(false)
    })
    it('does not fire at exactly the threshold (value 0.5)', () => {
      expect(readPad(withBtn(6, { pressed: false, value: 0.5 }), std).attack).toBe(false)
    })
    // Adversarial: .value is specced 0..1, so out-of-range garbage — a raw-pad
    // trigger resting at -1, NaN, or a wild 100 — must never fake a press.
    it.each([-1, -0.75, NaN, 100, 2, Infinity])('never fires from garbage value %p', (v) => {
      expect(readPad(withBtn(6, { pressed: false, value: v }), std).attack).toBe(false)
    })
    it('fires on the raw profile too — L2 is the same guess there', () => {
      const raw = padProfile(fakePad({ id: 'Some Generic USB Joystick', mapping: '', axisCount: 8 }))
      const buttons: boolean[] = []
      buttons[6] = true
      expect(readPad(fakePad({ buttons, mapping: '', axisCount: 8 }), raw).attack).toBe(true)
    })
    // A raw pad fresh from the driver: even if every button object reports a
    // resting value of 0 and pressed false, nothing fires.
    it('an untouched raw pad with idle trigger buttons stays silent', () => {
      const raw = padProfile(fakePad({ id: 'Some Generic USB Joystick', mapping: '', axisCount: 8 }))
      const s = readPad(fakePad({ mapping: '', axisCount: 8 }), raw)
      expect(s.attack).toBe(false)
      expect(s.roll).toBe(false)
      expect(s.pause).toBe(false)
    })
  })

  /**
   * The bug-2 repro. On a RAW pad, axes 2/3 are as likely to be analog triggers
   * as a right stick. Analog triggers rest at -1 once touched, and when aim
   * could still fire that meant an untouched pad fired forever and aimed pinned
   * up-left. Two independent defences now stand: a raw profile names no aim
   * axes at all, AND firing is buttons-only so no axis can shoot on any pad.
   * This suite pins both.
   */
  describe('a raw pad cannot fire itself from axes it never proved were a stick', () => {
    const raw = padProfile(fakePad({ id: 'Some Generic USB Joystick', mapping: '', axisCount: 8 }))

    it('is the raw profile with no aim axes (the precondition for everything below)', () => {
      expect(raw.kind).toBe('raw')
      expect(raw.aimAxes).toBe(null)
    })

    // The exact shipped bug.
    it('does not fire when axes 2/3 rest at -1 like a pair of untouched triggers', () => {
      const s = readPad(fakePad({ axes: [0, 0, -1, -1], axisCount: 8 }), raw)
      expect(s.attack).toBe(false)
    })

    it('does not pin aim up-left when axes 2/3 rest at -1', () => {
      const s = readPad(fakePad({ axes: [0, 0, -1, -1], axisCount: 8 }), raw)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
    })

    /**
     * Why connect-time resting-value sampling would NOT have saved us, and why
     * this asserts across both states: a trigger reports 0 until it is first
     * touched and only then starts resting at -1. Sampling at connect time
     * samples a lie. Naming no aim axes is immune to the transition.
     */
    it.each([
      ['untouched, still reporting 0', 0],
      ['touched once, now resting at -1', -1],
    ])('does not fire with triggers %s', (_label, rest) => {
      const s = readPad(fakePad({ axes: [0, 0, rest, rest], axisCount: 8 }), raw)
      expect(s.attack).toBe(false)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
    })

    // Adversarial: no value on the un-named axes may ever reach aim or attack.
    it.each([-1, 1, 0.9, -0.9, 0.5, 3.2857, 100, -100, NaN])(
      'ignores axes 2/3 entirely when they read %p',
      (v) => {
        const s = readPad(fakePad({ axes: [0, 0, v, v], axisCount: 8 }), raw)
        expect(s.attack).toBe(false)
        expect(s.aimX).toBe(0)
        expect(s.aimY).toBe(0)
      },
    )

    it('still fires from the attack BUTTON — refusing to guess aim is not disarming the pad', () => {
      const buttons: boolean[] = []
      buttons[raw.attack[0]] = true
      const s = readPad(fakePad({ buttons, axes: [0, 0, -1, -1], axisCount: 8 }), raw)
      expect(s.attack).toBe(true)
    })

    it('still moves from the left stick with the triggers resting at -1', () => {
      const s = readPad(fakePad({ axes: [0.9, -0.9, -1, -1], axisCount: 8 }), raw)
      expect(s.moveX).toBeCloseTo(dz(0.9, -0.9).x, 5)
      expect(s.moveY).toBeCloseTo(dz(0.9, -0.9).y, 5)
    })

    it('survives an empty axes array with no aim axes named', () => {
      const s = readPad(fakePad({ axisCount: 0 }), raw)
      expect(s.attack).toBe(false)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
    })
  })

  /**
   * The canonical Android shape. Chromium routes triggers to BUTTONS 6/7 and
   * writes axes 2/3 only from a real right stick, leaving them zero-filled
   * otherwise -- so here axes 2/3 are trustworthy and twin-stick aim is kept.
   */
  describe('a canonical pad (mapping "", 4 axes) keeps a working right stick', () => {
    const canon = padProfile(fakePad({ id: 'Xbox Wireless Controller', mapping: '', axisCount: 4 }))
    const canonPad = (over: { buttons?: boolean[]; axes?: number[] } = {}) =>
      fakePad({ ...over, axisCount: 4, id: 'Xbox Wireless Controller', mapping: '' })

    it('is the canonical profile aiming on axes 2/3', () => {
      expect(canon.kind).toBe('canonical')
      expect(canon.aimAxes).toEqual([2, 3])
    })

    // A canonical pad with no right stick leaves axes 2/3 zero-filled, so the
    // idle reading is (0,0) whether or not the stick physically exists.
    it('does not fire or aim or move when idle', () => {
      const s = readPad(canonPad(), canon)
      expect(s.attack).toBe(false)
      expect(s.aimX).toBe(0)
      expect(s.aimY).toBe(0)
      expect(s.moveX).toBe(0)
      expect(s.moveY).toBe(0)
    })

    it('aims from a genuinely deflected right stick without firing (buttons fire)', () => {
      const s = readPad(canonPad({ axes: [0, 0, 0.9, -0.8] }), canon)
      expect(s.aimX).toBeCloseTo(dz(0.9, -0.8).x, 5)
      expect(s.aimY).toBeCloseTo(dz(0.9, -0.8).y, 5)
      expect(s.attack).toBe(false)
    })

    it('fires from L2 (canonical button 6, where Chromium puts the left trigger)', () => {
      const buttons: boolean[] = []
      buttons[6] = true
      expect(readPad(canonPad({ buttons }), canon).attack).toBe(true)
    })

    // Chromium hands the hat over as buttons 12-15 here; there is no axis 9.
    it.each([
      ['up', 12, 0, -1],
      ['down', 13, 0, 1],
      ['left', 14, -1, 0],
      ['right', 15, 1, 0],
    ])('reads d-pad %s from canonical button %i, where Chromium puts the hat', (_d, b, x, y) => {
      const buttons: boolean[] = []
      buttons[b as number] = true
      const s = readPad(canonPad({ buttons }), canon)
      expect(s.moveX).toBe(x)
      expect(s.moveY).toBe(y)
    })

    it('has no hat axis to decode, so a 4-axis pad can never invent a direction', () => {
      expect(canon.hatAxis).toBe(null)
    })

    it('reads interact from canonical B, which the old guessed profile called attack', () => {
      const buttons: boolean[] = []
      buttons[1] = true
      const s = readPad(canonPad({ buttons }), canon)
      expect(s.interact).toBe(true)
      expect(s.attack).toBe(false)
    })
  })
})
