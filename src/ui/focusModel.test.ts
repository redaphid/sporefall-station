import { describe, expect, it } from 'vitest'
import {
  FOCUS_CANCEL_DIST,
  FOCUS_PAN_RATE,
  FOCUS_SECONDS,
  NORMAL_PAN_RATE,
  RETURN_SECONDS,
  focusCameraTarget,
  focusPanRate,
  startFocus,
  tickFocus,
  type FocusState,
} from './focusModel'

const self = { x: 5, y: 5 }
const target = { x: 20, y: 20 }

describe('startFocus', () => {
  it('begins in the pan phase, anchored to where the player tapped', () => {
    const s = startFocus({ targetId: 3 }, self)
    expect(s.phase).toBe('pan')
    expect(s.secondsLeft).toBe(FOCUS_SECONDS)
    expect(s.anchor).toEqual({ x: 5, y: 5 })
    expect(s.anchor).not.toBe(self) // a copy — later self mutation can't corrupt it
  })
})

describe('tickFocus — lifecycle', () => {
  it('undefined in → undefined out (no focus is a stable state)', () => {
    expect(tickFocus(undefined, 0.016, self, target)).toBeUndefined()
  })

  it('counts the dwell down across frames, then eases into the return phase', () => {
    let s: FocusState | undefined = startFocus({ targetId: 3 }, self, 0.05)
    s = tickFocus(s, 0.03, self, target)
    expect(s?.phase).toBe('pan')
    expect(s?.secondsLeft).toBeCloseTo(0.02)
    s = tickFocus(s, 0.03, self, target) // dwell exhausted → return glide starts
    expect(s?.phase).toBe('return')
    expect(s?.secondsLeft).toBe(RETURN_SECONDS)
  })

  it('the return phase ends the focus once its own timer runs out', () => {
    let s: FocusState | undefined = { target: {}, phase: 'return', secondsLeft: 0.02, anchor: { ...self } }
    s = tickFocus(s, 0.05, self, undefined)
    expect(s).toBeUndefined()
  })

  it('dt=0 leaves the state ticking (no accidental instant expiry)', () => {
    const s = tickFocus(startFocus({}, self), 0, self, target)
    expect(s?.secondsLeft).toBe(FOCUS_SECONDS)
  })

  it('a fresh startFocus replaces any focus in flight (last tap wins)', () => {
    const first = startFocus({ targetId: 1 }, self)
    const second = startFocus({ targetId: 2 }, self)
    expect(second.target).toEqual({ targetId: 2 })
    expect(first.target).toEqual({ targetId: 1 }) // untouched — pure values
  })
})

describe('tickFocus — cancellation', () => {
  it('cancels the moment the player moves beyond FOCUS_CANCEL_DIST (they took the camera back)', () => {
    const s = startFocus({ targetId: 3 }, self)
    const moved = { x: self.x + FOCUS_CANCEL_DIST + 0.01, y: self.y }
    expect(tickFocus(s, 0.016, moved, target)).toBeUndefined()
  })

  it('small drift under the threshold does NOT cancel', () => {
    const s = startFocus({ targetId: 3 }, self)
    const drift = { x: self.x + 0.4, y: self.y + 0.4 }
    expect(tickFocus(s, 0.016, drift, target)).toBeDefined()
  })

  it('cancels mid-pan when the target becomes unresolvable (entity died/despawned)', () => {
    const s = startFocus({ targetId: 3 }, self)
    expect(tickFocus(s, 0.016, self, undefined)).toBeUndefined()
  })

  it('the return phase does not need the target — a dead link cannot strand the camera', () => {
    const s: FocusState = { target: { targetId: 3 }, phase: 'return', secondsLeft: 1, anchor: { ...self } }
    const next = tickFocus(s, 0.016, self, undefined)
    expect(next?.phase).toBe('return')
  })
})

describe('focusCameraTarget / focusPanRate', () => {
  it('pans to the target while panning, back to the player on return', () => {
    const pan: FocusState = { target: {}, phase: 'pan', secondsLeft: 1, anchor: { ...self } }
    const ret: FocusState = { target: {}, phase: 'return', secondsLeft: 1, anchor: { ...self } }
    expect(focusCameraTarget(pan, self, target)).toEqual(target)
    expect(focusCameraTarget(ret, self, target)).toEqual(self)
  })

  it('falls back to the player if the target vanished the same frame', () => {
    const pan: FocusState = { target: {}, phase: 'pan', secondsLeft: 1, anchor: { ...self } }
    expect(focusCameraTarget(pan, self, undefined)).toEqual(self)
  })

  it('eases the camera (slow rate) for BOTH phases, normal rate otherwise — the pan is animated, never a cut', () => {
    const pan: FocusState = { target: {}, phase: 'pan', secondsLeft: 1, anchor: { ...self } }
    const ret: FocusState = { target: {}, phase: 'return', secondsLeft: 1, anchor: { ...self } }
    expect(focusPanRate(pan)).toBe(FOCUS_PAN_RATE)
    expect(focusPanRate(ret)).toBe(FOCUS_PAN_RATE)
    expect(focusPanRate(undefined)).toBe(NORMAL_PAN_RATE)
    expect(FOCUS_PAN_RATE).toBeLessThan(NORMAL_PAN_RATE)
  })
})
