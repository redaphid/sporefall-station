import { describe, expect, it } from 'vitest'
import { STATE_TICKS, type AnimStateName } from './animState'
import { composeMotion, IDENTITY_POSE, MOTION, type MotionInput, type MotionPose } from './motion'

const base = (over: Partial<MotionInput>): MotionInput => ({
  state: 'idle',
  start: 0,
  tick: 100,
  t: 100,
  id: 1,
  facing: 0,
  vx: 0,
  moving: false,
  ...over,
})

const STATES: AnimStateName[] = ['idle', 'walk', 'attack', 'hurt', 'roll', 'death']

describe('composeMotion — composition invariants', () => {
  it('roll state is identity (the tumble is whole-body, owned by sprites.ts)', () => {
    expect(composeMotion(base({ state: 'roll', start: 95 }))).toEqual(IDENTITY_POSE)
  })

  it('FEET STAY PLANTED: dy is zero for every state except the deliberate hops (walk bob, attack lunge)', () => {
    for (const state of STATES) {
      if (state === 'walk' || state === 'attack') continue
      for (let dt = 0; dt < 20; dt += 0.5) {
        const p = composeMotion(base({ state, start: 100, tick: 100 + Math.floor(dt), t: 100 + dt }))
        expect(p.dy, `${state} at +${dt}`).toBe(0)
      }
    }
  })

  it('scale offsets never collapse or flip the body (sx, sy stay well positive)', () => {
    for (const state of STATES) {
      for (let dt = 0; dt < 25; dt += 0.25) {
        const p = composeMotion(
          base({ state, start: 100, tick: 100 + Math.floor(dt), t: 100 + dt, rollUntil: 100, vx: 5 }),
        )
        expect(p.sx, `${state} sx`).toBeGreaterThan(0.5)
        expect(p.sy, `${state} sy`).toBeGreaterThan(0.5)
        expect(p.alpha).toBeGreaterThanOrEqual(0)
        expect(p.alpha).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is deterministic: identical inputs give identical poses', () => {
    const input = base({ state: 'hurt', start: 97, t: 101.5, tick: 101 })
    expect(composeMotion(input)).toEqual(composeMotion(input))
  })
})

describe('walk motion', () => {
  it('bobs vertically within the tuned amplitude', () => {
    for (let t = 100; t < 130; t += 0.3) {
      const p = composeMotion(base({ state: 'walk', t, tick: Math.floor(t), moving: true, vx: 3 }))
      expect(Math.abs(p.dy)).toBeLessThanOrEqual(MOTION.walkBob.amp + 1e-9)
    }
  })

  it('leans INTO the horizontal heading, clamped at the tuned angle', () => {
    const right = composeMotion(base({ state: 'walk', vx: 10, moving: true }))
    const left = composeMotion(base({ state: 'walk', vx: -10, moving: true }))
    expect(right.rot).toBeCloseTo(MOTION.lean.rad, 6)
    expect(left.rot).toBeCloseTo(-MOTION.lean.rad, 6)
    // Slow drift leans proportionally less.
    const slow = composeMotion(base({ state: 'walk', vx: MOTION.lean.refSpeed / 2, moving: true }))
    expect(slow.rot).toBeCloseTo(MOTION.lean.rad / 2, 6)
  })

  it('pure vertical movement does not lean sideways', () => {
    expect(composeMotion(base({ state: 'walk', vx: 0, moving: true })).rot).toBe(0)
  })
})

describe('attack lunge', () => {
  it('lunges along the facing, peaks mid-window, returns EXACTLY to rest at the end', () => {
    const start = 100
    const mid = composeMotion(base({ state: 'attack', start, t: start + STATE_TICKS.attack / 2, facing: 0 }))
    expect(mid.dx).toBeCloseTo(MOTION.attackLunge.px, 5)
    expect(mid.dy).toBeCloseTo(0, 5)
    const end = composeMotion(base({ state: 'attack', start, t: start + STATE_TICKS.attack, facing: 0 }))
    expect(end.dx).toBeCloseTo(0, 5)
    const past = composeMotion(base({ state: 'attack', start, t: start + STATE_TICKS.attack + 5, facing: 0 }))
    expect(past.dx).toBeCloseTo(0, 5)
  })

  it('follows the facing direction (south lunge goes down-screen, west goes left)', () => {
    const start = 100
    const t = start + STATE_TICKS.attack / 2
    const south = composeMotion(base({ state: 'attack', start, t, facing: Math.PI / 2 }))
    expect(south.dy).toBeCloseTo(MOTION.attackLunge.px, 5)
    const west = composeMotion(base({ state: 'attack', start, t, facing: Math.PI }))
    expect(west.dx).toBeCloseTo(-MOTION.attackLunge.px, 5)
  })

  it('lunge magnitude never exceeds the tuning table amplitude', () => {
    for (let dt = -2; dt < STATE_TICKS.attack + 4; dt += 0.1) {
      const p = composeMotion(base({ state: 'attack', start: 100, t: 100 + dt, facing: 1.1 }))
      expect(Math.hypot(p.dx, p.dy)).toBeLessThanOrEqual(MOTION.attackLunge.px + 1e-9)
    }
  })
})

describe('hurt flinch', () => {
  it('shudders sideways, bounded, and decays to zero by the end of the window', () => {
    let sawMotion = false
    for (let dt = 0; dt <= STATE_TICKS.hurt; dt += 0.25) {
      const p = composeMotion(base({ state: 'hurt', start: 100, t: 100 + dt }))
      expect(Math.abs(p.dx)).toBeLessThanOrEqual(MOTION.hurtFlinch.px + 1e-9)
      if (Math.abs(p.dx) > 0.1) sawMotion = true
    }
    expect(sawMotion).toBe(true)
    const end = composeMotion(base({ state: 'hurt', start: 100, t: 100 + STATE_TICKS.hurt }))
    expect(end.dx).toBeCloseTo(0, 5)
  })
})

describe('death fall', () => {
  it('topples toward ±deathFall.rot and fades alpha to exactly 0 at the window end', () => {
    const start = 100
    const end = composeMotion(base({ state: 'death', start, t: start + STATE_TICKS.death, id: 2 }))
    expect(Math.abs(end.rot)).toBeCloseTo(MOTION.deathFall.rot, 5)
    expect(end.alpha).toBeCloseTo(0, 5)
    const mid = composeMotion(base({ state: 'death', start, t: start + STATE_TICKS.death / 2, id: 2 }))
    expect(mid.alpha).toBeGreaterThan(0)
    expect(mid.alpha).toBeLessThan(1)
    expect(Math.abs(mid.rot)).toBeGreaterThan(0)
  })

  it('falls to a deterministic side per entity id (both sides occur)', () => {
    const t = 100 + STATE_TICKS.death / 2
    const even = composeMotion(base({ state: 'death', start: 100, t, id: 2 }))
    const odd = composeMotion(base({ state: 'death', start: 100, t, id: 3 }))
    expect(Math.sign(even.rot)).toBe(1)
    expect(Math.sign(odd.rot)).toBe(-1)
  })

  it('rotation progresses monotonically (no jitter on the way down)', () => {
    let prev = 0
    for (let dt = 0; dt <= STATE_TICKS.death; dt += 0.5) {
      const p = composeMotion(base({ state: 'death', start: 100, t: 100 + dt, id: 2 }))
      expect(p.rot).toBeGreaterThanOrEqual(prev)
      prev = p.rot
    }
  })
})

describe('post-roll landing squash', () => {
  it('squashes down and bulges out right after the roll window, easing back to identity', () => {
    const rollUntil = 100
    const justLanded = composeMotion(base({ state: 'idle', tick: rollUntil, t: rollUntil, rollUntil }))
    // sy carries the full squash (the idle breathe adds at most ±breathe.amp on top).
    expect(justLanded.sy).toBeLessThanOrEqual((1 - MOTION.landSquash.amount) * (1 + MOTION.breathe.amp))
    expect(justLanded.sy).toBeGreaterThanOrEqual((1 - MOTION.landSquash.amount) * (1 - MOTION.breathe.amp))
    expect(justLanded.sx).toBeCloseTo(1 + MOTION.landSquash.amount, 5)
    const later = composeMotion(
      base({ state: 'idle', tick: rollUntil + MOTION.landSquash.ticks, t: rollUntil + MOTION.landSquash.ticks, rollUntil }),
    )
    expect(later.sx).toBeCloseTo(1, 5)
    // The idle breathe still moves sy a hair; the squash itself must be gone.
    expect(Math.abs(later.sy - 1)).toBeLessThanOrEqual(MOTION.breathe.amp + 1e-9)
  })

  it('does NOT squash while the roll is still active (mid-roll is identity here)', () => {
    const p = composeMotion(base({ state: 'roll', tick: 95, t: 95, rollUntil: 100 }))
    expect(p).toEqual(IDENTITY_POSE)
  })

  it('does not fire before the roll ends even in another state (rewind-safe)', () => {
    const p = composeMotion(base({ state: 'idle', tick: 90, t: 90, rollUntil: 100 }))
    expect(p.sx).toBe(1)
  })
})

describe('idle breathe', () => {
  it('pulses sy subtly around 1, phase-shifted per entity', () => {
    const poses: MotionPose[] = []
    for (let id = 0; id < 4; id++) poses.push(composeMotion(base({ state: 'idle', id, t: 107.3 })))
    for (const p of poses) expect(Math.abs(p.sy - 1)).toBeLessThanOrEqual(MOTION.breathe.amp + 1e-9)
    const distinct = new Set(poses.map((p) => p.sy.toFixed(6)))
    expect(distinct.size).toBeGreaterThan(1)
  })
})
