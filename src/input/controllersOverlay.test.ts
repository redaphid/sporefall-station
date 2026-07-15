import { describe, it, expect } from 'vitest'
import { formatPadRow } from './controllersOverlay'
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
})
