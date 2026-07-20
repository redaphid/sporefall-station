// @vitest-environment happy-dom
/**
 * The 8BitDo-in-D-input (non-standard pad) reproduction, end to end through the
 * REAL read path: padProfile → remapProfile → readPad.
 *
 * ## Why this suite exists
 *
 * The reported symptom is "physical R2 pauses the game" on an 8BitDo Lite 2 over
 * Bluetooth on Android. That pad connects in D-input mode (its physical [S]/[D]
 * slider — it has no XInput mode), where Chromium reports `mapping === ''` and
 * DRIVER-DEFINED button indices. D-input has no universal button order (each
 * vendor picks its own; cf. Chromium issue 40282092 "8BitDo Game Controllers
 * Buttons Mapped Incorrectly"), so the pad's physical R2 does NOT necessarily
 * live at the W3C index 7 — it can land on index 9, which the shared standard
 * BUTTONS table reads as Start → pause. That is the bug, reproduced below.
 *
 * The engine deliberately does NOT hardcode a per-device index table (see
 * padProfile.ts: the 8bitdo name-based special case was removed on purpose, and
 * padProfile.test.ts pins "decided by shape, not by id"). D-input indices are
 * undocumented and vary by firmware/mode, so a hardcoded guess would be both
 * unverifiable and a design regression. The SUPPORTED correction for a
 * misreporting pad is the user remap (Settings → Controller): capture the
 * physical button per action. This suite proves that path actually fixes a
 * non-standard pad, so the fix does not depend on knowing the exact layout.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { padProfile } from './padProfile'
import { readPad } from './readPad'
import { bindButton, getButtonMap, remapProfile, resetButtonMapCacheForTest, setButtonMap, setPadCapture } from './remap'

const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
})

beforeEach(() => {
  localStorage.clear()
  resetButtonMapCacheForTest()
  setPadCapture(false)
})

/** A pad reporting `mapping: ''` with `pressed` indices we choose. 8 axes so it
 * resolves to the RAW profile (not the canonical 4-axis Android shape), matching
 * a D-input pad that also exposes a hat + trigger axes. */
const nonStandardPad = (pressed: number[], axisCount = 8): Gamepad =>
  ({
    id: '8BitDo Lite 2 gamepad',
    mapping: '' as GamepadMappingType,
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: pressed.includes(i),
      touched: pressed.includes(i),
      value: pressed.includes(i) ? 1 : 0,
    })),
    axes: Array.from({ length: axisCount }, () => 0),
  }) as unknown as Gamepad

// The hypothesised broken layout: physical R2 reports at index 9, physical Start
// at index 7 — the classic "trigger and menu swapped" D-input misreport. The
// real device's exact indices are unknown until read off the F9 overlay; this
// suite is written against the REPORTED symptom, not a claimed ground truth.
const PHYS_R2 = 9
const PHYS_START = 7

describe('a non-standard pad whose physical R2 reports at index 9', () => {
  it('is the raw profile, applying the shared standard-index BUTTONS table', () => {
    const prof = padProfile(nonStandardPad([]))
    expect(prof.kind).toBe('raw')
    // The best-guess table: attack on 7, pause on 9. Correct for a conformant
    // pad, wrong for this one — which is the whole bug.
    expect(prof.attack).toContain(7)
    expect(prof.pause).toEqual([9])
  })

  it('REPRODUCES THE BUG: pressing physical R2 pauses instead of attacking (defaults)', () => {
    const prof = remapProfile(padProfile(nonStandardPad([PHYS_R2])))
    const s = readPad(nonStandardPad([PHYS_R2]), prof)
    expect(s.pause).toBe(true) // physical R2 wrongly fires pause
    expect(s.attack).toBe(false) // and does NOT fire attack
  })

  it('THE FIX: after remapping attack→9 and pause→7, physical R2 attacks and physical Start pauses', () => {
    // The user opens Settings → Controller, taps Attack, presses R2 (index 9);
    // taps Pause, presses Start (index 7). bindButton's swap keeps each index on
    // exactly one action. This is what padCapture/settingsPanel drive live.
    let map = getButtonMap()
    map = bindButton(map, 'attack', PHYS_R2)
    map = bindButton(map, 'pause', PHYS_START)
    setButtonMap(map)

    const prof = remapProfile(padProfile(nonStandardPad([])))

    const onR2 = readPad(nonStandardPad([PHYS_R2]), prof)
    expect(onR2.attack).toBe(true) // physical R2 now attacks
    expect(onR2.pause).toBe(false)

    const onStart = readPad(nonStandardPad([PHYS_START]), prof)
    expect(onStart.pause).toBe(true) // physical Start now pauses
    expect(onStart.attack).toBe(false)
  })

  it('does not disturb a conformant standard pad: the remap overlay is index-based, not device-based', () => {
    // With the same remap in force, a real standard pad (R2 at 7, Start at 9)
    // would now be "wrong" — which is exactly why the fix is a USER remap, per
    // pad-owner, not a global default. Documented here so the trade-off is explicit.
    let map = getButtonMap()
    map = bindButton(map, 'attack', PHYS_R2)
    setButtonMap(map)
    const std = remapProfile(padProfile({ id: 'x', mapping: 'standard', axes: [0, 0, 0, 0] } as unknown as Gamepad))
    // attack was narrowed to [9] by the single-button bind — a standard pad's R2
    // (index 7) no longer attacks under this user's map. Confirms remaps are
    // per-user config, and standard pads should simply not carry a 8BitDo remap.
    expect(std.attack).toEqual([9])
  })
})
