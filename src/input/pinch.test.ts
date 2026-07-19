import { describe, expect, it } from 'vitest'
import { CLAIM_MS, CLAIM_SLOP, createPinchTracker, DOUBLE_TAP_MS, TAP_MS } from './pinch'

// Claiming-rule torture tests. Coordinates are screen px; `now` is explicit so
// every timing rule is deterministic. Stick-claimed = the touch became a virtual
// stick pointer in touch.ts.

describe('pinch formation — the claiming rule', () => {
  it('two unclaimed fingers on the same half form a pinch', () => {
    const t = createPinchTracker()
    expect(t.down(1, 100, 300, 'left', false, 0)).toEqual([])
    expect(t.down(2, 200, 300, 'left', false, 50)).toEqual([1, 2])
    expect(t.pinchActive()).toBe(true)
    expect(t.consumed(1)).toBe(true)
    expect(t.consumed(2)).toBe(true)
  })

  it('a fresh stick claim is converted: pinch forms and reports BOTH ids for cancel', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'right', true, 0) // claimed the aim stick, not yet moved
    const consumed = t.down(2, 180, 340, 'right', false, CLAIM_MS - 1)
    expect(consumed).toEqual([1, 2])
    expect(t.pinchActive()).toBe(true)
  })

  it('an ESTABLISHED stick (older than the claim window) is never stolen', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'right', true, 0)
    expect(t.down(2, 180, 340, 'right', false, CLAIM_MS + 1)).toEqual([])
    expect(t.pinchActive()).toBe(false)
    expect(t.consumed(1)).toBe(false)
  })

  it('an actively-deflected stick (moved past slop) is never stolen even if young', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', true, 0)
    t.move(1, 100 + CLAIM_SLOP + 1, 300) // thumb already driving
    expect(t.down(2, 180, 340, 'left', false, 10)).toEqual([])
    expect(t.pinchActive()).toBe(false)
  })

  it('fingers on OPPOSITE halves never pinch — twin-thumb stick planting is sacred', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', true, 0)
    expect(t.down(2, 500, 300, 'right', true, 5)).toEqual([]) // simultaneous thumbs
    expect(t.pinchActive()).toBe(false)
    expect(t.consumed(1)).toBe(false)
    expect(t.consumed(2)).toBe(false)
  })

  it('a stick crossing INTO the other half keeps its down-side: still no cross-half pinch', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', true, 0)
    t.move(1, 500, 300) // dragged across the middle
    expect(t.down(2, 520, 320, 'right', false, 10)).toEqual([])
    expect(t.pinchActive()).toBe(false)
  })

  it('third finger beside an established stick pairs with the other free finger', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'right', true, 0)
    t.move(1, 130, 300) // establish the aim stick
    t.down(2, 400, 500, 'right', false, 200) // reserve finger, unclaimed
    const consumed = t.down(3, 460, 520, 'right', false, 1000) // unclaimed touches stay eligible forever
    expect(consumed).toEqual([2, 3])
    expect(t.consumed(1)).toBe(false) // the stick keeps driving through the pinch
  })

  it('only one pinch at a time — extra fingers during a pinch are ignored', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0)
    t.down(2, 200, 300, 'left', false, 10)
    expect(t.down(4, 150, 350, 'left', false, 20)).toEqual([])
    expect(t.consumed(4)).toBe(false)
  })
})

describe('pinch tracking and release', () => {
  it('reports spread and midpoint as the fingers move', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0)
    t.down(2, 200, 300, 'left', false, 10)
    const st = t.move(1, 60, 300)
    expect(st).not.toBeNull()
    expect(st!.startDist).toBe(100)
    expect(st!.dist).toBe(140)
    expect(st!.midX).toBe(130)
    expect(st!.midY).toBe(300)
  })

  it('moves from non-pinch fingers report nothing', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0)
    expect(t.move(1, 120, 300)).toBeNull()
    t.down(2, 200, 300, 'left', false, 10)
    t.down(3, 500, 300, 'right', true, 20)
    expect(t.move(3, 520, 310)).toBeNull() // right stick, unrelated to the pinch
  })

  it('lifting one finger ends the pinch; the survivor stays inert (no phantom stick)', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0)
    t.down(2, 200, 300, 'left', false, 10)
    t.move(2, 300, 300)
    const r = t.up(1, 600)
    expect(r.pinchEnded).toBe(true)
    expect(t.pinchActive()).toBe(false)
    expect(t.consumed(2)).toBe(true) // must never become a stick mid-flight
    expect(t.move(2, 400, 300)).toBeNull()
  })

  it('after both fingers lift, brand-new touches behave normally again', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0)
    t.down(2, 200, 300, 'left', false, 10)
    t.up(1, 500)
    t.up(2, 520)
    expect(t.down(5, 100, 300, 'left', true, 1000)).toEqual([])
    expect(t.consumed(5)).toBe(false) // new stick claim works
    expect(t.down(6, 200, 300, 'left', false, 1030)).toEqual([5, 6]) // and fresh pinches still form
  })

  it('lifting an unknown / never-tracked pointer is a safe no-op', () => {
    const t = createPinchTracker()
    expect(t.up(99, 0)).toEqual({ pinchEnded: false, resetTap: false })
    expect(t.consumed(99)).toBe(false)
  })
})

describe('two-finger double-tap → zoom reset', () => {
  const tap = (t: ReturnType<typeof createPinchTracker>, ids: [number, number], at: number): boolean => {
    t.down(ids[0], 100, 300, 'left', false, at)
    t.down(ids[1], 160, 300, 'left', false, at + 10)
    const r1 = t.up(ids[0], at + 80)
    const r2 = t.up(ids[1], at + 90)
    return r1.resetTap || r2.resetTap
  }

  it('two quick two-finger taps reset; a single tap does not', () => {
    const t = createPinchTracker()
    expect(tap(t, [1, 2], 0)).toBe(false)
    expect(tap(t, [3, 4], 200)).toBe(true)
  })

  it('taps too far apart do not reset', () => {
    const t = createPinchTracker()
    expect(tap(t, [1, 2], 0)).toBe(false)
    expect(tap(t, [3, 4], 80 + DOUBLE_TAP_MS + 1)).toBe(false)
  })

  it('a real pinch (spread changed) is never counted as a tap', () => {
    const t = createPinchTracker()
    expect(tap(t, [1, 2], 0)).toBe(false)
    t.down(3, 100, 300, 'left', false, 200)
    t.down(4, 160, 300, 'left', false, 210)
    t.move(4, 300, 300) // spread grows well past the tap slop
    expect(t.up(3, 260).resetTap).toBe(false)
    t.up(4, 265)
  })

  it('a slow two-finger hold is not a tap', () => {
    const t = createPinchTracker()
    tap(t, [1, 2], 0)
    t.down(3, 100, 300, 'left', false, 200)
    t.down(4, 160, 300, 'left', false, 210)
    expect(t.up(3, 210 + TAP_MS + 50).resetTap).toBe(false)
  })
})

describe('reset — the touch layer vanished mid-gesture (controller takeover)', () => {
  it('forgets an active pinch: pinchActive false, old fingers no longer consumed', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0)
    t.down(2, 200, 300, 'left', false, 50)
    expect(t.pinchActive()).toBe(true)
    t.reset()
    expect(t.pinchActive()).toBe(false)
    expect(t.consumed(1)).toBe(false)
    expect(t.consumed(2)).toBe(false)
  })

  it('a ghost finger (down, never up) cannot pair into a phantom pinch after reset', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0) // its up will never arrive
    t.reset()
    // A genuinely new touch on the same half must NOT pinch with the ghost.
    expect(t.down(2, 160, 300, 'left', false, 20)).toEqual([])
    expect(t.pinchActive()).toBe(false)
  })

  it('after reset the tracker still works: two fresh fingers pinch normally', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'right', true, 0)
    t.reset()
    expect(t.down(3, 100, 300, 'right', false, 500)).toEqual([])
    expect(t.down(4, 180, 300, 'right', false, 520)).toEqual([3, 4])
    expect(t.pinchActive()).toBe(true)
  })

  it('an orphaned up after reset is a harmless no-op', () => {
    const t = createPinchTracker()
    t.down(1, 100, 300, 'left', false, 0)
    t.down(2, 200, 300, 'left', false, 50)
    t.reset()
    expect(t.up(1, 100)).toEqual({ pinchEnded: false, resetTap: false })
  })
})
