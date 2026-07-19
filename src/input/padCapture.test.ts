// The "press a button…" capture machine. The adversarial cases are the point:
// axis noise (a raw pad's triggers resting at -1), garbage button values,
// buttons already held when capture opens, and pads that only appear after a
// press (Chrome's exposure rule) must all resolve the way a player expects.

import { describe, expect, it } from 'vitest'
import { CAPTURE_TIMEOUT_MS, createButtonCapture } from './padCapture'

const pad = (over: { index?: number; buttons?: { pressed?: boolean; value?: number }[]; axes?: number[] } = {}) =>
  ({
    index: over.index ?? 0,
    id: 'Fake Pad',
    mapping: 'standard',
    connected: true,
    buttons: Array.from({ length: 17 }, (_, i) => {
      const b = over.buttons?.[i]
      return { pressed: b?.pressed ?? false, touched: false, value: b?.value ?? (b?.pressed ? 1 : 0) }
    }),
    axes: over.axes ?? [0, 0, 0, 0],
  }) as unknown as Gamepad

const press = (...idxs: number[]) => {
  const b: { pressed?: boolean; value?: number }[] = []
  for (const i of idxs) b[i] = { pressed: true }
  return b
}

describe('createButtonCapture', () => {
  it('reports no-pads while getGamepads is empty (Chrome exposes pads only after a press)', () => {
    const c = createButtonCapture()
    expect(c.poll([], 0)).toEqual({ phase: 'no-pads' })
    expect(c.poll([null, null], 100)).toEqual({ phase: 'no-pads' })
  })

  it('waits while a pad is present but nothing is pressed', () => {
    const c = createButtonCapture()
    expect(c.poll([pad()], 0)).toEqual({ phase: 'waiting' })
  })

  it('binds the first NEW press', () => {
    const c = createButtonCapture()
    c.poll([pad()], 0)
    expect(c.poll([pad({ buttons: press(1) })], 50)).toEqual({ phase: 'bound', button: 1 })
  })

  it('binds an analog-only press (value 0.8, pressed=false) — same rule that fires L2 in game', () => {
    const c = createButtonCapture()
    c.poll([pad()], 0)
    expect(c.poll([pad({ buttons: [{}, {}, {}, {}, {}, {}, { value: 0.8 }] })], 50)).toEqual({ phase: 'bound', button: 6 })
  })

  it.each([
    ['a resting-trigger value of -1', -1],
    ['an out-of-range value', 3],
    ['NaN', NaN],
    ['a sub-threshold value', 0.4],
  ])('never binds on %s', (_n, value) => {
    const c = createButtonCapture()
    c.poll([pad()], 0)
    expect(c.poll([pad({ buttons: [{ value }] })], 50)).toEqual({ phase: 'waiting' })
  })

  it('never reads axes: a wildly deflected stick/trigger array binds nothing', () => {
    const c = createButtonCapture()
    c.poll([pad({ axes: [1, -1, -1, -1, 0.7, -0.3, 1, 1] })], 0)
    expect(c.poll([pad({ axes: [-1, 1, 1, 1, -0.7, 0.3, -1, -1] })], 50)).toEqual({ phase: 'waiting' })
  })

  it('a button HELD when capture opens is inert until released and pressed again', () => {
    const c = createButtonCapture()
    expect(c.poll([pad({ buttons: press(0) })], 0)).toEqual({ phase: 'waiting' }) // held at open
    expect(c.poll([pad({ buttons: press(0) })], 50)).toEqual({ phase: 'waiting' }) // still held
    expect(c.poll([pad()], 100)).toEqual({ phase: 'waiting' }) // released
    expect(c.poll([pad({ buttons: press(0) })], 150)).toEqual({ phase: 'bound', button: 0 }) // re-press counts
  })

  it('a DIFFERENT button binds even while the stale one is still held', () => {
    const c = createButtonCapture()
    c.poll([pad({ buttons: press(0) })], 0)
    expect(c.poll([pad({ buttons: press(0, 3) })], 50)).toEqual({ phase: 'bound', button: 3 })
  })

  it('a pad APPEARING mid-capture binds on the very press that exposed it', () => {
    const c = createButtonCapture()
    expect(c.poll([], 0)).toEqual({ phase: 'no-pads' })
    expect(c.poll([pad({ buttons: press(2) })], 500)).toEqual({ phase: 'bound', button: 2 })
  })

  it('a second pad joining an existing capture is not baselined either', () => {
    const c = createButtonCapture()
    c.poll([pad({ index: 0 })], 0)
    expect(c.poll([pad({ index: 0 }), pad({ index: 1, buttons: press(9) })], 50)).toEqual({ phase: 'bound', button: 9 })
  })

  it('binds exotic indices past the canonical 16', () => {
    const c = createButtonCapture()
    const exotic = pad()
    ;(exotic.buttons as unknown as { pressed: boolean; value: number }[]).push(
      ...Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })),
    )
    c.poll([exotic], 0)
    const pressed24 = pad()
    ;(pressed24.buttons as unknown as { pressed: boolean; value: number }[]).push(
      ...Array.from({ length: 8 }, (_, i) => ({ pressed: i === 0, value: i === 0 ? 1 : 0 })),
    )
    expect(c.poll([pressed24], 50)).toEqual({ phase: 'bound', button: 17 })
  })

  it('times out after the deadline, pads or no pads', () => {
    const c = createButtonCapture()
    c.poll([pad()], 0)
    expect(c.poll([pad()], CAPTURE_TIMEOUT_MS - 1)).toEqual({ phase: 'waiting' })
    expect(c.poll([pad()], CAPTURE_TIMEOUT_MS)).toEqual({ phase: 'timed-out' })
  })

  it('a press ON the timeout edge loses to the timeout (no last-instant surprise bind)', () => {
    const c = createButtonCapture()
    c.poll([pad()], 0)
    expect(c.poll([pad({ buttons: press(0) })], CAPTURE_TIMEOUT_MS + 1)).toEqual({ phase: 'timed-out' })
  })

  it('is terminal once bound: later polls (even with new presses) return the same result', () => {
    const c = createButtonCapture()
    c.poll([pad()], 0)
    c.poll([pad({ buttons: press(1) })], 50)
    expect(c.poll([pad({ buttons: press(4) })], 100)).toEqual({ phase: 'bound', button: 1 })
    expect(c.poll([], 9999999)).toEqual({ phase: 'bound', button: 1 }) // not even the timeout reopens it
  })

  it('is terminal once timed out', () => {
    const c = createButtonCapture()
    c.poll([pad()], 0)
    c.poll([pad()], CAPTURE_TIMEOUT_MS)
    expect(c.poll([pad({ buttons: press(0) })], CAPTURE_TIMEOUT_MS + 50)).toEqual({ phase: 'timed-out' })
  })

  it('respects a custom timeout', () => {
    const c = createButtonCapture(1000)
    c.poll([pad()], 0)
    expect(c.poll([pad()], 1000)).toEqual({ phase: 'timed-out' })
  })
})
