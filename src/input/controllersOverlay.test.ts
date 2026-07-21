import { describe, it, expect } from 'vitest'
import { formatPadDiag, formatPadRow } from './controllersOverlay'
import type { CoopDebugPad } from './gamepadCoop'
import type { PadState } from './readPad'

const state = (over: Partial<PadState> = {}): PadState => ({
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  attack: false,
  roll: false,
  interact: false,
  special: false,
  pause: false,
  throwItem: false,
  hotbarPrev: false,
  hotbarNext: false,
  ...over,
})

const dpad = (over: Partial<CoopDebugPad> = {}): CoopDebugPad => ({
  padIndex: 0,
  id: '8BitDo Zero 2 gamepad',
  slot: 0,
  state: state(),
  ...over,
})

describe('formatPadRow', () => {
  it('labels an assigned pad with its human player number', () => {
    // slot 0 is the first pad and shares player 0 (the camera target) = P1
    expect(formatPadRow(dpad({ slot: 0 }))).toContain('P1')
    expect(formatPadRow(dpad({ slot: 1 }))).toContain('P2')
  })
  it('prompts an unassigned pad to press to join', () => {
    expect(formatPadRow(dpad({ slot: null }))).toMatch(/join/i)
  })
  it('shows the controller name', () => {
    expect(formatPadRow(dpad())).toContain('8BitDo Zero 2')
  })
  it('shows a right + up movement as R and U', () => {
    const row = formatPadRow(dpad({ state: state({ moveX: 1, moveY: -1 }) }))
    expect(row).toContain('R')
    expect(row).toContain('U')
  })
  it('shows a held attack as A', () => {
    expect(formatPadRow(dpad({ state: state({ attack: true }) }))).toContain('A')
  })
  it('shows a pressed pause as P', () => {
    expect(formatPadRow(dpad({ state: state({ pause: true }) }))).toContain('P')
  })

  // The diagnostic segment: raw indices/axes are what a non-standard pad must be
  // read off by, since the decoded action (P) alone can't tell you WHICH index
  // fired it. See formatPadDiag's doc.
  it('appends the raw button indices and axes for a non-standard pad', () => {
    const row = formatPadRow(dpad({ mapping: '', kind: 'raw', buttonsDown: [0, 9], axes: [0, 0, -1, 0.5] }))
    expect(row).toContain('btn:0,9')
    expect(row).toContain('ax:0.00,0.00,-1.00,0.50')
    expect(row).toContain('raw')
  })
  it('omits the diagnostic entirely on a bare CoopDebugPad (backward compatible)', () => {
    expect(formatPadRow(dpad())).not.toContain('«')
  })
})

describe('formatPadDiag (the raw ground-truth line for non-standard pads)', () => {
  const diag = (over: Partial<CoopDebugPad>) => formatPadDiag(dpad(over))

  it('renders an empty mapping string as "" so it is visible, not blank', () => {
    expect(diag({ mapping: '', kind: 'raw' })).toContain('"" raw')
  })
  it('shows a standard pad plainly', () => {
    expect(diag({ mapping: 'standard', kind: 'standard' })).toContain('standard standard')
  })
  it('lists every pressed index so R2-lands-on-Start is directly readable', () => {
    // The reported 8BitDo symptom: physical R2 reports as index 9 (Start's slot).
    // The overlay must surface "btn:9" so the misreport is unambiguous.
    expect(diag({ buttonsDown: [9] })).toContain('btn:9')
  })
  it('shows nothing for the pressed-index piece when no button is down', () => {
    expect(diag({ buttonsDown: [] })).not.toContain('btn:')
  })
  it('is empty when a fixture supplies no diagnostic fields at all', () => {
    expect(formatPadDiag(dpad())).toBe('')
  })
})
