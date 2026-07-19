import { describe, it, expect } from 'vitest'
import { padProfile, type PadProfile } from './padProfile'

/** A pad descriptor as padProfile sees it. `axes` is load-bearing now: its
 * LENGTH is what tells the canonical Android shape from a raw desktop one. */
const desc = (id: string, mapping: GamepadMappingType, axisCount: number) => ({
  id,
  mapping,
  axes: Array.from({ length: axisCount }, () => 0),
})

/** Every verb a profile binds, so the collision sweep can't silently miss one. */
const allButtons = (p: PadProfile) => [
  ...p.attack,
  ...p.interact,
  ...p.special,
  ...p.roll,
  ...p.pause,
  ...p.throw,
  ...p.hotbarPrev,
  ...p.hotbarNext,
]

describe('padProfile', () => {
  describe('a standard-mapping pad (Xbox/PS/8bitdo in X-input)', () => {
    const p = padProfile(desc('Xbox Wireless Controller', 'standard', 4))

    it('is the standard profile', () => {
      expect(p.kind).toBe('standard')
    })
    it('maps attack to the bottom face button', () => {
      expect(p.attack).toContain(0)
    })
    it('maps L2 (button 6) to attack — the explicit fire trigger', () => {
      expect(p.attack).toContain(6)
    })
    it('keeps R2 (button 7) and RB (5) on attack alongside L2', () => {
      expect(p.attack).toContain(7)
      expect(p.attack).toContain(5)
    })
    it('moves dodge-roll off L2 onto LB alone, so roll and fire cannot collide', () => {
      expect(p.roll).toEqual([4])
      expect(p.roll).not.toContain(6)
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
    it('reads aim from the right stick axes 2/3', () => {
      expect(p.aimAxes).toEqual([2, 3])
    })
    it('has no separate hat axis', () => {
      expect(p.hatAxis).toBe(null)
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
    it('never binds a verb to a d-pad button', () => {
      for (const b of allButtons(p)) expect(p.dpad).not.toContain(b)
    })

    // The regression guard that matters most: the exact shipped layout.
    // L2 (6) is attack — the explicit fire trigger — and roll is LB (4) alone.
    it('is byte-for-byte the documented button map', () => {
      expect(p).toEqual({
        kind: 'standard',
        attack: [0, 5, 6, 7],
        interact: [1],
        special: [2, 3],
        roll: [4],
        pause: [9],
        throw: [8],
        hotbarPrev: [10],
        hotbarNext: [11],
        dpad: [12, 13, 14, 15],
        moveAxes: [0, 1],
        aimAxes: [2, 3],
        hatAxis: null,
      })
    })
  })

  /**
   * The heart of this change. Chromium on Android NEVER hands JS a raw pad:
   * UnknownGamepadMappings writes into CanonicalAxisIndex/CanonicalButtonIndex
   * and only overrides isStandard() to false. So mapping '' + exactly 4 axes is
   * the canonical shape, and its indices are already W3C-correct.
   */
  describe('a canonical-shaped pad (mapping "", exactly 4 axes — every Android pad)', () => {
    const p = padProfile(desc('Xbox Wireless Controller', '', 4))

    it('is recognised as the canonical profile', () => {
      expect(p.kind).toBe('canonical')
    })

    it('trusts the canonical layout — identical to standard but for the label', () => {
      expect({ ...p, kind: 'standard' }).toEqual(padProfile(desc('x', 'standard', 4)))
    })

    it('reads the d-pad from buttons 12-15, where Chromium puts the hat', () => {
      expect(p.dpad).toEqual([12, 13, 14, 15])
    })

    // Chromium allocates mAxisValues as new float[CanonicalAxisIndex.COUNT] --
    // exactly 4 -- so axis 9 provably does not exist on Android.
    it('has no hat axis, because a 4-axis pad provably has no axis 9', () => {
      expect(p.hatAxis).toBe(null)
    })

    // Triggers go to mappedButtons[LEFT/RIGHT_TRIGGER] (6/7), never to an axis,
    // so axes 2/3 are the right stick or zero-filled -- never a resting -1.
    it('trusts axes 2/3 as the right stick, because triggers land on buttons 6/7', () => {
      expect(p.aimAxes).toEqual([2, 3])
    })

    it('binds attack to the canonical A button', () => {
      expect(p.attack).toContain(0)
    })
    it('binds interact to the canonical B button, not the old guessed A/B attack pair', () => {
      expect(p.interact).toEqual([1])
      expect(p.attack).not.toContain(1)
    })
    it('never binds a verb to a d-pad button', () => {
      for (const b of allButtons(p)) expect(p.dpad).not.toContain(b)
    })
  })

  /**
   * mapping '' with an axis count that is NOT 4 cannot have come from Android's
   * canonical mapper. It is a genuinely raw pad -- desktop Linux/evdev -- where
   * the axis indices are the driver's, not the W3C's.
   */
  describe('a raw pad (mapping "", an axis count that is not the canonical 4)', () => {
    const p = padProfile(desc('Some Generic USB Joystick', '', 8))

    it('is recognised as the raw profile', () => {
      expect(p.kind).toBe('raw')
    })

    // The bug-2 fix. On a raw evdev pad axes 2/3 are as likely to be analog
    // triggers (resting at -1 once touched) as a right stick. A guessed aim
    // stick would pin aim to a constant diagonal with no recourse; refusing
    // costs twin-stick aim while aim-where-you-move and the fire buttons work.
    it('refuses to guess an aim stick, so a resting trigger pair cannot steer aim', () => {
      expect(p.aimAxes).toBe(null)
    })

    it('keeps the hat axis, which is real on desktop Linux', () => {
      expect(p.hatAxis).toBe(9)
    })

    // One button map for every profile: the W3C order is the best guess we have
    // for an unknown pad (it is the order browsers themselves map unknowns
    // into), and a single map means one obvious place bindings live.
    it('shares the standard button map — raw differs only in analog trust', () => {
      const std = padProfile(desc('x', 'standard', 4))
      expect({ ...p, kind: std.kind, aimAxes: std.aimAxes, hatAxis: std.hatAxis }).toEqual(std)
    })

    it('still offers a face button for attack', () => {
      expect(p.attack.length).toBeGreaterThan(0)
    })
    it('puts pause on Start (9) and fire on L2 (6), same as standard', () => {
      expect(p.pause).toEqual([9])
      expect(p.attack).toContain(6)
    })
    it('also maps throw and weapon-cycle (best-guess, needs a real-device check)', () => {
      expect(p.throw.length).toBeGreaterThan(0)
      expect(p.hotbarPrev.length).toBeGreaterThan(0)
      expect(p.hotbarNext.length).toBeGreaterThan(0)
      expect(p.hotbarPrev).not.toEqual(p.hotbarNext)
    })
    it('never binds a verb to a d-pad button', () => {
      for (const b of allButtons(p)) expect(p.dpad).not.toContain(b)
    })
  })

  /**
   * The 8bitdo special case is gone. It never earned its keep: permissive('zero2')
   * and permissive('generic') were byte-identical but for the label, so the regex
   * bought no behaviour and matched over-broadly (any id containing "zero"). The
   * shape rule now serves the Zero 2 strictly better than its name ever did.
   */
  describe('an 8bitdo Zero 2, which no longer gets a name-based special case', () => {
    it('gets the canonical profile on Android, where it reports 4 canonical axes', () => {
      expect(padProfile(desc('8BitDo Zero 2 gamepad', '', 4)).kind).toBe('canonical')
    })

    it('gets the raw profile (and its hat) on desktop, where its axes are raw', () => {
      const p = padProfile(desc('8BitDo Zero 2 gamepad', '', 10))
      expect(p.kind).toBe('raw')
      expect(p.hatAxis).toBe(9)
    })

    it('is decided by shape, not by id — the id has no influence at all', () => {
      for (const id of ['8BitDo Zero 2', 'Zero-G Racer', '', 'Xbox Wireless Controller']) {
        expect(padProfile(desc(id, '', 4))).toEqual(padProfile(desc('anything else', '', 4)))
        expect(padProfile(desc(id, '', 8))).toEqual(padProfile(desc('anything else', '', 8)))
      }
    })
  })

  describe('degenerate pad descriptors', () => {
    it('treats a pad with no axes at all as raw', () => {
      expect(padProfile(desc('x', '', 0)).kind).toBe('raw')
    })

    it('treats an absurdly long axes array as raw', () => {
      expect(padProfile(desc('x', '', 64)).kind).toBe('raw')
    })

    it.each([1, 2, 3, 5, 6, 8, 10])('treats a %i-axis non-standard pad as raw', (n) => {
      expect(padProfile(desc('x', '', n)).kind).toBe('raw')
    })

    it('survives a missing axes array rather than throwing', () => {
      const p = padProfile({ id: 'x', mapping: '' } as unknown as Gamepad)
      expect(p.kind).toBe('raw')
      expect(p.aimAxes).toBe(null)
    })

    // mapping 'standard' is the W3C vouching for the layout; the axis count is
    // irrelevant to it and must never downgrade it.
    it.each([0, 4, 6, 10])('keeps a standard-mapping pad standard at %i axes', (n) => {
      expect(padProfile(desc('x', 'standard', n)).kind).toBe('standard')
    })
  })
})
