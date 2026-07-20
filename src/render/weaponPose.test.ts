import { describe, expect, it } from 'vitest'
import { HAND_RIG, recoilKick, SWING_ARC, swingSweep, weaponPose } from './weaponPose'
import type { Dir } from './anim'

const DIRS: Dir[] = ['s', 'se', 'e', 'ne', 'n']

describe('swingSweep', () => {
  it('is 0 at rest (p=0) and back to 0 at the end (p=1)', () => {
    expect(swingSweep(0)).toBeCloseTo(0)
    expect(swingSweep(1)).toBeCloseTo(0)
  })

  it('peaks (=1) at mid-window', () => {
    expect(swingSweep(0.5)).toBeCloseTo(1)
  })

  it('rises monotonically over the strike (p in [0, 0.5])', () => {
    let prev = -Infinity
    for (let p = 0; p <= 0.5 + 1e-9; p += 0.05) {
      const v = swingSweep(p)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('clamps out-of-range progress to the rest value', () => {
    expect(swingSweep(-1)).toBeCloseTo(0)
    expect(swingSweep(2)).toBeCloseTo(0)
  })
})

describe('weaponPose — idle hold', () => {
  it('holds the rig idle angle when there is no attack (undefined progress)', () => {
    for (const d of DIRS) {
      const pose = weaponPose(d, undefined, false)
      expect(pose.angle).toBeCloseTo(HAND_RIG[d].idle)
      expect(pose.hx).toBe(HAND_RIG[d].hx)
      expect(pose.hy).toBe(HAND_RIG[d].hy)
    }
  })

  it('holds idle for progress outside the swing window (>= 1)', () => {
    expect(weaponPose('e', 1, false).angle).toBeCloseTo(HAND_RIG.e.idle)
    expect(weaponPose('e', 1.5, false).angle).toBeCloseTo(HAND_RIG.e.idle)
  })

  it('returns to exactly the idle angle at the very end of the swing (p=1)', () => {
    for (const d of DIRS) {
      // p=1 is treated as outside the window → idle; and the sweep itself is 0 there.
      expect(weaponPose(d, 0.999999, false).angle).toBeCloseTo(HAND_RIG[d].idle, 3)
    }
  })
})

describe('weaponPose — swing', () => {
  it('angle is a monotonic (non-decreasing) function of progress over the strike', () => {
    for (const d of DIRS) {
      let prev = -Infinity
      for (let p = 0; p <= 0.5 + 1e-9; p += 0.05) {
        const a = weaponPose(d, p, false).angle
        expect(a).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = a
      }
    }
  })

  it('peak deflection from idle equals the full arc at mid-window', () => {
    for (const d of DIRS) {
      const a = weaponPose(d, 0.5, false).angle
      expect(a - HAND_RIG[d].idle).toBeCloseTo(SWING_ARC)
    }
  })

  it('chops DOWNWARD — the swung angle exceeds the raised idle', () => {
    for (const d of DIRS) {
      expect(weaponPose(d, 0.5, false).angle).toBeGreaterThan(HAND_RIG[d].idle)
    }
  })
})

describe('weaponPose — west mirror (flip)', () => {
  it('mirrors the hand across the body (negated hx)', () => {
    for (const d of DIRS) {
      expect(weaponPose(d, undefined, true).hx).toBe(-HAND_RIG[d].hx)
      expect(weaponPose(d, undefined, true).hy).toBe(HAND_RIG[d].hy)
    }
  })

  it('reflects the angle across vertical (π − θ): x flips, y sign preserved', () => {
    for (const d of DIRS) {
      const east = weaponPose(d, 0.3, false).angle
      const west = weaponPose(d, 0.3, true).angle
      expect(Math.cos(west)).toBeCloseTo(-Math.cos(east))
      expect(Math.sin(west)).toBeCloseTo(Math.sin(east))
    }
  })

  it('preserves the swing envelope under mirror (still returns to idle)', () => {
    const restWest = weaponPose('e', undefined, true).angle
    expect(weaponPose('e', 0, true).angle).toBeCloseTo(restWest)
    expect(weaponPose('e', 1, true).angle).toBeCloseTo(restWest)
  })
})

describe('recoilKick', () => {
  it('is 0 at rest and outside the window', () => {
    expect(recoilKick(undefined)).toBe(0)
    expect(recoilKick(1)).toBe(0)
    expect(recoilKick(-0.2)).toBe(0)
  })

  it('kicks backward (negative) during the window, peaking mid', () => {
    expect(recoilKick(0.5)).toBeLessThan(0)
    expect(recoilKick(0.5)).toBeLessThanOrEqual(recoilKick(0.25))
  })
})
