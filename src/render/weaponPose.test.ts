import { describe, expect, it } from 'vitest'
import { facingDir, type Dir } from './anim'
import { AIM_HOLD_TICKS, facingSector, heldPose, isAiming, RECOIL_PX, recoilKick, RING, SWING_STEPS } from './weaponPose'

/** Every 8-way heading, as the renderer resolves it (facingDir). */
const HEADINGS = RING.map((name, i) => ({ name, ...facingDir((i * Math.PI) / 4) }))

describe('facingSector', () => {
  it('maps every 8-way heading back to its own ring index (west half mirrored)', () => {
    HEADINGS.forEach((h, i) => expect(facingSector(h.dir, h.flip), h.name).toBe(i))
  })
})

describe('heldPose: aiming points the drawing along the facing', () => {
  const expected: Record<string, [string, boolean]> = {
    e: ['e', false],
    se: ['se', false],
    s: ['s', false],
    sw: ['se', true],
    w: ['e', true],
    nw: ['ne', true],
    n: ['n', false],
    ne: ['ne', false],
  }
  it.each(HEADINGS)('$name: the drawing for that sector, mirrored only in the west half', (h) => {
    const pose = heldPose({ dir: h.dir, flip: h.flip, ranged: true, aiming: true })
    expect([pose.view, pose.mirror]).toEqual(expected[h.name])
    expect(RING[pose.sector]).toBe(h.name)
  })

  it('every facing has its own drawing: the five drawn views are all used', () => {
    const views = new Set(HEADINGS.map((h) => heldPose({ dir: h.dir, flip: h.flip, ranged: true, aiming: true }).view))
    expect([...views].sort()).toEqual(['e', 'n', 'ne', 's', 'se'])
  })

  it('facing the camera the gun points AT the camera, never down the leg', () => {
    const s = heldPose({ dir: 's', flip: false, ranged: true, aiming: true })
    expect(s.view).toBe('s')
    expect(s.cap).toBe(false) // the muzzle is nearer the viewer than the fist
  })

  it('away-facing (ne, n, nw) draws behind the body; toward-camera facings in front', () => {
    for (const h of HEADINGS) {
      const pose = heldPose({ dir: h.dir, flip: h.flip, ranged: true, aiming: true })
      expect(pose.behind, h.name).toBe(h.dir === 'ne' || h.dir === 'n')
      if (pose.behind) expect(pose.cap, h.name).toBe(false)
    }
  })
})

describe('heldPose: low-ready lowers the weapon one sector toward the ground', () => {
  it.each(HEADINGS)('$name', (h) => {
    const up = heldPose({ dir: h.dir, flip: h.flip, ranged: true, aiming: true })
    const low = heldPose({ dir: h.dir, flip: h.flip, ranged: true, aiming: false })
    const down = h.flip ? -1 : 1
    expect(low.sector).toBe((up.sector + down + 8) % 8)
  })

  it('profile east at rest angles the gun down-forward (se), and across the body facing the camera', () => {
    expect(heldPose({ dir: 'e', flip: false, ranged: true, aiming: false }).view).toBe('se')
    const s = heldPose({ dir: 's', flip: false, ranged: true, aiming: false })
    expect([s.view, s.mirror]).toEqual(['se', true]) // sw: across the body from the right hand
  })

  it('a melee weapon at rest is held low too, aiming or not', () => {
    for (const aiming of [true, false]) expect(heldPose({ dir: 'e', flip: false, ranged: false, aiming }).view).toBe('se')
  })
})

describe('heldPose: a melee chop steps through the drawings, a gun never swings', () => {
  it('raised overhead, over, strike along the facing, follow-through', () => {
    const at = (p: number) => heldPose({ dir: 'e', flip: false, ranged: false, aiming: false, progress: p })
    expect([0, 0.3, 0.55, 0.9].map((p) => RING[at(p).sector])).toEqual(['n', 'ne', 'e', 'se'])
    expect(SWING_STEPS).toHaveLength(4)
  })

  it('the west-facing chop is the mirror of the east one', () => {
    const at = (p: number) => heldPose({ dir: 'e', flip: true, ranged: false, aiming: false, progress: p })
    expect([0, 0.3, 0.55, 0.9].map((p) => RING[at(p).sector])).toEqual(['n', 'nw', 'w', 'sw'])
  })

  it('progress outside [0,1) is the rest pose; a gun ignores progress', () => {
    const rest = heldPose({ dir: 'e', flip: false, ranged: false, aiming: false })
    for (const p of [-0.1, 1, 7, Number.NaN]) {
      expect(heldPose({ dir: 'e', flip: false, ranged: false, aiming: false, progress: p }).sector, String(p)).toBe(rest.sector)
    }
    expect(heldPose({ dir: 'e', flip: false, ranged: true, aiming: true, progress: 0.2 }).sector).toBe(0)
  })

  it('every drawn facing yields a valid drawing at every swing beat', () => {
    const dirs: Dir[] = ['s', 'se', 'e', 'ne', 'n']
    for (const dir of dirs)
      for (const flip of [false, true])
        for (let p = 0; p < 1; p += 0.05) {
          const pose = heldPose({ dir, flip, ranged: false, aiming: false, progress: p })
          expect(['e', 'se', 's', 'ne', 'n']).toContain(pose.view)
          expect(pose.sector).toBeGreaterThanOrEqual(0)
          expect(pose.sector).toBeLessThan(8)
        }
  })
})

describe('isAiming', () => {
  it('an engaged NPC, a strafing player, or a recent attack raises the weapon', () => {
    expect(isAiming({ engaged: true, strafing: false })).toBe(true)
    expect(isAiming({ engaged: false, strafing: true })).toBe(true)
    expect(isAiming({ engaged: false, strafing: false, ticksSinceAttack: 0 })).toBe(true)
    expect(isAiming({ engaged: false, strafing: false, ticksSinceAttack: AIM_HOLD_TICKS - 1 })).toBe(true)
  })

  it('otherwise it is low-ready: never attacked, attacked long ago, or a tick from the future', () => {
    expect(isAiming({ engaged: false, strafing: false })).toBe(false)
    expect(isAiming({ engaged: false, strafing: false, ticksSinceAttack: AIM_HOLD_TICKS })).toBe(false)
    expect(isAiming({ engaged: false, strafing: false, ticksSinceAttack: -3 })).toBe(false)
  })
})

describe('recoilKick', () => {
  it('is 0 at rest and outside the window, peaks at -RECOIL_PX mid-window', () => {
    expect(recoilKick(undefined)).toBe(0)
    expect(recoilKick(-0.5)).toBe(0)
    expect(recoilKick(1)).toBe(0)
    expect(recoilKick(0.5)).toBeCloseTo(-RECOIL_PX)
  })
})
