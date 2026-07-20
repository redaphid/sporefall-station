import { describe, expect, it } from 'vitest'
import { HAND_RIG, recoilKick, SWING_ARC, swingSweep, weaponPose } from './weaponPose'
import type { Dir } from './anim'

const DIRS: Dir[] = ['s', 'se', 'e', 'ne', 'n']

// Screen radians: +x right (east), +y down (south). So +π/2 is straight DOWN.
const DOWN = Math.PI / 2
const UP = -Math.PI / 2
const RIGHT = 0
const LEFT = Math.PI

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

describe('weaponPose — points at the continuous aim (idle hold)', () => {
  it('idle angle equals the aim exactly, for the full 360° sweep of aim', () => {
    // Non-quantized: every continuous aim maps to its own weapon rotation.
    for (let aim = -Math.PI; aim <= Math.PI + 1e-9; aim += 0.2) {
      const { dir, flip } = pick(aim)
      const pose = weaponPose(aim, dir, undefined, flip)
      expect(pose.angle).toBeCloseTo(aim)
    }
  })

  it('points DOWN when the aim is straight down (+π/2) — proves "below" works', () => {
    const pose = weaponPose(DOWN, 's', undefined, false)
    expect(pose.angle).toBeCloseTo(DOWN)
    // Its barrel (local +x) resolves to a screen vector pointing down (+y).
    expect(Math.sin(pose.angle)).toBeCloseTo(1)
    expect(Math.cos(pose.angle)).toBeCloseTo(0)
  })

  it('points UP when the aim is straight up (−π/2)', () => {
    const pose = weaponPose(UP, 'n', undefined, false)
    expect(Math.sin(pose.angle)).toBeCloseTo(-1)
    expect(Math.cos(pose.angle)).toBeCloseTo(0)
  })

  it('holds the aim for progress outside the swing window (>= 1)', () => {
    expect(weaponPose(0.7, 'e', 1, false).angle).toBeCloseTo(0.7)
    expect(weaponPose(0.7, 'e', 1.5, false).angle).toBeCloseTo(0.7)
  })

  it('yields CONTINUOUS (non-quantized) rotations — not 8 buckets', () => {
    const angles = new Set<number>()
    for (let aim = -Math.PI; aim < Math.PI; aim += Math.PI / 24) {
      // Hold the drawn facing fixed: the rotation must still track aim, proving
      // it is decoupled from the 8-way body quantization.
      angles.add(Number(weaponPose(aim, 's', undefined, false).angle.toFixed(4)))
    }
    // 48 distinct aims → 48 distinct rotations (far more than 8).
    expect(angles.size).toBeGreaterThan(24)
  })
})

describe('weaponPose — swing composes ON TOP of aim', () => {
  it('at rest the swing contributes nothing (angle == aim)', () => {
    for (const aim of [RIGHT, DOWN, UP, 1.234]) {
      expect(weaponPose(aim, 's', 0, false).angle).toBeCloseTo(aim)
      expect(weaponPose(aim, 's', undefined, false).angle).toBeCloseTo(aim)
    }
  })

  it('peak deflection from the aim equals the full arc at mid-window', () => {
    for (const aim of [RIGHT, DOWN, 0.4, -1.1]) {
      const a = weaponPose(aim, 's', 0.5, false).angle
      expect(a - aim).toBeCloseTo(SWING_ARC)
    }
  })

  it('sweeps around the aim and returns exactly to it at p=1', () => {
    const aim = DOWN
    expect(weaponPose(aim, 's', 0, false).angle).toBeCloseTo(aim)
    expect(weaponPose(aim, 's', 0.5, false).angle).toBeCloseTo(aim + SWING_ARC)
    expect(weaponPose(aim, 's', 1, false).angle).toBeCloseTo(aim) // outside window → hold
  })

  it('the swing offset is monotonic over the strike (p in [0, 0.5])', () => {
    const aim = 0.3
    let prev = -Infinity
    for (let p = 0; p <= 0.5 + 1e-9; p += 0.05) {
      const a = weaponPose(aim, 's', p, false).angle
      expect(a).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = a
    }
  })
})

describe('weaponPose — west-half mirror (flip)', () => {
  it('aiming left flips the sprite vertically so the grip is not upside-down', () => {
    // Aiming right: no vertical mirror. Aiming left: mirror (grip stays down).
    expect(weaponPose(RIGHT, 'e', undefined, false).flipY).toBe(false)
    expect(weaponPose(LEFT, 'e', undefined, true).flipY).toBe(true)
  })

  it('mirrors the hand across the body (negated hx), hy unchanged', () => {
    for (const d of DIRS) {
      expect(weaponPose(0, d, undefined, true).hx).toBe(-HAND_RIG[d].hx)
      expect(weaponPose(0, d, undefined, true).hy).toBe(HAND_RIG[d].hy)
    }
  })

  it('the barrel still points along the aim even when mirrored (y-flip keeps +x)', () => {
    // flipY mirrors vertically; the local +x axis (the barrel) is untouched, so
    // rotation == aim still aims the muzzle correctly on the west side.
    const aim = LEFT
    expect(weaponPose(aim, 'e', undefined, true).angle).toBeCloseTo(aim)
    expect(Math.cos(aim)).toBeCloseTo(-1) // points left
  })

  it('the swing sense is mirrored on the west side (returns to aim at rest)', () => {
    const aim = LEFT
    // Peak deflection is mirrored (opposite sign) but same magnitude.
    const east = weaponPose(0.4, 's', 0.5, false).angle - 0.4
    const west = weaponPose(aim, 's', 0.5, true).angle - aim
    expect(west).toBeCloseTo(-east)
    // And the swing still resolves back to the plain aim at the ends.
    expect(weaponPose(aim, 's', 0, true).angle).toBeCloseTo(aim)
    expect(weaponPose(aim, 's', 1, true).angle).toBeCloseTo(aim)
  })
})

describe('weaponPose — behind (draw order)', () => {
  it('aiming up/north tucks the weapon behind the body', () => {
    expect(weaponPose(UP, 'n', undefined, false).behind).toBe(true)
    expect(weaponPose(-2.0, 'ne', undefined, false).behind).toBe(true)
  })

  it('aiming down/toward the camera keeps the weapon in front', () => {
    expect(weaponPose(DOWN, 's', undefined, false).behind).toBe(false)
    expect(weaponPose(0.5, 'se', undefined, false).behind).toBe(false)
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

// Mirror the renderer's facingDir → {dir, flip} choice closely enough for tests
// that just need a plausible drawn facing for a given aim.
function pick(aim: number): { dir: Dir; flip: boolean } {
  const c = Math.cos(aim)
  const s = Math.sin(aim)
  const flip = c < 0
  const dir: Dir = s > 0.4 ? 's' : s < -0.4 ? 'n' : 'e'
  return { dir, flip }
}
