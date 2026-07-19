import { describe, expect, it } from 'vitest'
import { createPressTracker, LONG_PRESS_MS, PRESS_SLOP_PX } from './pressModel'

describe('pressModel — tap vs long-press discrimination', () => {
  it('clean quick release is a tap', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 1000)
    expect(p.up(1, 1000 + LONG_PRESS_MS - 1)).toBe('tap')
  })

  it('clean hold to the threshold fires longpress via poll, exactly once', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 0)
    expect(p.poll(LONG_PRESS_MS - 1)).toBeNull()
    expect(p.poll(LONG_PRESS_MS)).toBe('longpress')
    expect(p.poll(LONG_PRESS_MS + 100)).toBeNull() // fired once
    expect(p.up(1, LONG_PRESS_MS + 200)).toBeNull() // release after fire emits nothing more
  })

  it('exact-boundary release is deterministic: elapsed >= threshold is longpress, < is tap', () => {
    const a = createPressTracker()
    a.down(1, 0, 0, 0)
    expect(a.up(1, LONG_PRESS_MS)).toBe('longpress') // late timer: up() still classifies
    const b = createPressTracker()
    b.down(1, 0, 0, 0)
    expect(b.up(1, LONG_PRESS_MS - 0.001)).toBe('tap')
  })

  it('drift past the slop cancels — the press became a stick and never inspects', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 0)
    p.move(1, 100 + PRESS_SLOP_PX, 100) // exactly at slop → dead (>= rule)
    expect(p.poll(LONG_PRESS_MS)).toBeNull()
    expect(p.up(1, 50)).toBeNull()
  })

  it('sub-slop wiggle stays clean', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 0)
    p.move(1, 100 + PRESS_SLOP_PX - 1, 100)
    p.move(1, 100, 100 - PRESS_SLOP_PX + 1)
    expect(p.up(1, 100)).toBe('tap')
  })

  it('drift is measured from the ORIGIN, not step to step (slow creep still cancels)', () => {
    const p = createPressTracker()
    p.down(1, 0, 0, 0)
    for (let i = 1; i <= PRESS_SLOP_PX; i++) p.move(1, i, 0) // 1px steps
    expect(p.up(1, 50)).toBeNull()
  })

  it('a second finger disqualifies both presses (pinch/twin-stick forming)', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 0)
    p.down(2, 140, 100, 10)
    expect(p.poll(LONG_PRESS_MS + 10)).toBeNull()
    expect(p.up(1, 50)).toBeNull()
    expect(p.up(2, 60)).toBeNull()
  })

  it('tap-while-moving works: a new finger beside an ESTABLISHED stick is neutral', () => {
    const p = createPressTracker()
    p.down(1, 0, 0, 0)
    p.move(1, 60, 0) // left thumb is now the established move stick
    p.down(2, 300, 100, 100) // right thumb taps an NPC mid-run
    expect(p.up(2, 150)).toBe('tap')
    expect(p.up(1, 500)).toBeNull() // the stick press itself never inspects
  })

  it('at most one clean press exists: a third finger beside a clean one kills both, later solo presses recover', () => {
    const q = createPressTracker()
    q.down(1, 0, 0, 0)
    q.down(2, 50, 0, 5) // twin fresh plant — both dead
    q.up(1, 10)
    q.down(3, 80, 0, 20) // only DEAD finger 2 remains → 3 starts clean
    expect(q.up(3, 30)).toBe('tap')
    q.up(2, 40)
    q.down(4, 10, 10, 50) // all lifted → fresh solo press
    expect(q.up(4, 60)).toBe('tap')
  })

  it('cancel() (pinch consumed the touch) kills the press', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 0)
    p.cancel(1)
    expect(p.poll(LONG_PRESS_MS)).toBeNull()
    expect(p.up(1, 10)).toBeNull()
  })

  it('cancel of an unknown id is a no-op', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 0)
    p.cancel(99)
    expect(p.up(1, 10)).toBe('tap')
  })

  it('moves/ups from other pointer ids never affect the live press', () => {
    const p = createPressTracker()
    p.down(1, 100, 100, 0)
    p.move(99, 500, 500)
    expect(p.up(99, 10)).toBeNull()
    expect(p.up(1, 20)).toBe('tap')
  })

  it('origin() reports where the press started, for picking under the finger', () => {
    const p = createPressTracker()
    expect(p.origin()).toBeUndefined()
    p.down(1, 123, 456, 0)
    expect(p.origin()).toEqual({ x: 123, y: 456 })
    p.up(1, 10)
    expect(p.origin()).toBeUndefined()
  })

  it('tracker is reusable after each gesture', () => {
    const p = createPressTracker()
    p.down(1, 0, 0, 0)
    expect(p.up(1, 10)).toBe('tap')
    p.down(1, 0, 0, 100)
    p.move(1, 100, 100)
    expect(p.up(1, 110)).toBeNull()
    p.down(1, 0, 0, 200)
    expect(p.poll(200 + LONG_PRESS_MS)).toBe('longpress')
    expect(p.up(1, 200 + LONG_PRESS_MS + 1)).toBeNull()
  })
})
