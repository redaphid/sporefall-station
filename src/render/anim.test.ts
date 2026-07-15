import { describe, expect, it } from 'vitest'
import { burnPulse, cycleFrame, facingDir, isMoving, onceFrame, walkBob } from './anim'

describe('facingDir', () => {
  const PI = Math.PI
  it('maps heading down (+y) to front, no flip', () => {
    expect(facingDir(PI / 2)).toEqual({ dir: 'front', flip: false })
  })
  it('maps heading up (-y) to back, no flip', () => {
    expect(facingDir(-PI / 2)).toEqual({ dir: 'back', flip: false })
  })
  it('maps heading right to side, no flip', () => {
    expect(facingDir(0)).toEqual({ dir: 'side', flip: false })
  })
  it('maps heading left to side, flipped', () => {
    expect(facingDir(PI)).toEqual({ dir: 'side', flip: true })
  })
})

describe('cycleFrame', () => {
  it('holds on frame 0 for a single-frame clip', () => {
    expect(cycleFrame(0, 1, 6)).toBe(0)
    expect(cycleFrame(999, 1, 6)).toBe(0)
  })

  it('advances one frame every ticksPerFrame and wraps', () => {
    expect(cycleFrame(0, 3, 5)).toBe(0)
    expect(cycleFrame(4, 3, 5)).toBe(0)
    expect(cycleFrame(5, 3, 5)).toBe(1)
    expect(cycleFrame(10, 3, 5)).toBe(2)
    expect(cycleFrame(15, 3, 5)).toBe(0)
  })

  it('is deterministic — same tick yields the same frame', () => {
    expect(cycleFrame(37, 4, 3)).toBe(cycleFrame(37, 4, 3))
  })
})

describe('onceFrame', () => {
  it('is -1 before the clip starts', () => {
    expect(onceFrame(4, 5, 3, 4)).toBe(-1)
  })

  it('walks frames from the start tick', () => {
    expect(onceFrame(10, 10, 3, 4)).toBe(0)
    expect(onceFrame(13, 10, 3, 4)).toBe(0)
    expect(onceFrame(14, 10, 3, 4)).toBe(1)
    expect(onceFrame(21, 10, 3, 4)).toBe(2)
  })

  it('is -1 once every frame has played (finished)', () => {
    expect(onceFrame(21, 10, 3, 4)).toBe(2)
    expect(onceFrame(22, 10, 3, 4)).toBe(-1)
    expect(onceFrame(500, 10, 3, 4)).toBe(-1)
  })
})

describe('isMoving', () => {
  it('is false when velocity is under the threshold', () => {
    expect(isMoving(0, 0)).toBe(false)
    expect(isMoving(0.01, -0.02)).toBe(false)
  })

  it('is true when the entity is walking', () => {
    expect(isMoving(1.5, 0)).toBe(true)
    expect(isMoving(0, -2)).toBe(true)
  })
})

describe('walkBob', () => {
  it('is zero at the start of the cycle', () => {
    expect(walkBob(0)).toBeCloseTo(0, 5)
  })

  it('stays within the bob amplitude', () => {
    for (let t = 0; t < 20; t += 0.37) expect(Math.abs(walkBob(t))).toBeLessThanOrEqual(1.5001)
  })
})

describe('burnPulse', () => {
  it('stays within 0..1', () => {
    for (let t = 0; t < 20; t += 0.29) {
      const p = burnPulse(t)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('is deterministic for a given time', () => {
    expect(burnPulse(3.5)).toBe(burnPulse(3.5))
  })
})
