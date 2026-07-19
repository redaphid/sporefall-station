/**
 * Procedural character MOTION — layer 2 of the animation system. Small,
 * mobile-cheap transform offsets (position/rotation/scale/alpha) composed onto
 * the sprite each frame, so even 2-frame art feels alive: movement lean,
 * walk bob, attack lunge, hurt flinch, post-roll landing squash, death
 * fall+fade, idle breathing.
 *
 * Pure math: everything derives from the animation state (animState.ts), the
 * continuous view-time t (sim tick + interpolation alpha — the same clock the
 * existing juice/bob uses), and the entity's own fields. No pixi, no DOM, no
 * wall clock, no randomness — deterministic and unit-testable.
 *
 * Composition contract (sprites.ts): offsets apply around the character's
 * FEET anchor (0.5, 1), so scale squash compresses the body DOWNWARD onto the
 * planted feet and rotation topples around them. `dx/dy` are world-pixel
 * offsets added after feet anchoring; `sx/sy` multiply the base scale (the
 * facing mirror's sign composes outside); `rot` adds to sprite rotation in
 * parent space (visually identical whether or not the sprite is mirrored);
 * `alpha` multiplies the sprite alpha. Only the deliberate hop components
 * (walk bob, attack lunge) ever move `dy` — every other state keeps dy = 0 so
 * the feet never leave the ground.
 */

import type { AnimStateName } from './animState'
import { STATE_TICKS } from './animState'
import { walkBob } from './anim'

/** THE tunable table. Amplitudes are deliberately subtle — px are world
 * pixels on the 48px character canvas, rotations radians, times sim ticks. */
export const MOTION = {
  /** Vertical walk hop (reuses anim.walkBob): |dy| ≤ amp px. */
  walkBob: { amp: 1.5 },
  /** Lean into horizontal heading while walking: rot = clamp(vx/ref)·rad. */
  lean: { rad: 0.09, refSpeed: 3 },
  /** Idle breathing: sy pulses ±amp around 1, freq in rad/tick. */
  breathe: { amp: 0.012, freq: 0.16 },
  /** Attack: brief forward lunge along facing, peak px at mid-window. */
  attackLunge: { px: 3.5 },
  /** Hurt: decaying sideways shudder, freq in rad/tick. */
  hurtFlinch: { px: 2.5, freq: 2.4 },
  /** Post-roll landing squash: sy dips −amount, sx bulges +amount, then eases
   * out over `ticks` after the roll window ends. */
  landSquash: { amount: 0.14, ticks: 5 },
  /** Death: topple to ±rot around the feet while fading alpha 1 → 0. */
  deathFall: { rot: Math.PI / 2 },
} as const

export interface MotionInput {
  state: AnimStateName
  /** State start tick (one-shots; loops ignore it). */
  start: number
  /** Integer sim tick. */
  tick: number
  /** Continuous view-time (tick + render alpha) — smoothness only. */
  t: number
  /** Entity id — deterministic per-entity variation (breathe phase, fall side). */
  id: number
  /** Heading (radians, screen coords) — attack lunge direction. */
  facing: number
  /** Horizontal velocity (tiles/s) — walk lean direction/amount. */
  vx: number
  /** isMoving(vel) — gates the walk components. */
  moving: boolean
  /** The last roll's `untilTick`, while the sim still carries the roll object
   * (it persists through cooldown) — drives the landing squash after it ends. */
  rollUntil?: number
}

/** Transform offsets to compose onto the sprite (identity = no motion). */
export interface MotionPose {
  dx: number
  dy: number
  rot: number
  sx: number
  sy: number
  alpha: number
}

export const IDENTITY_POSE: MotionPose = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1 }

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Compose every active motion component for this frame. The roll state itself
 * returns identity — the whole-body tumble (anchor swap + spin) stays in
 * sprites.ts, and this layer adds only the LANDING squash after it. */
export const composeMotion = (m: MotionInput): MotionPose => {
  const p: MotionPose = { ...IDENTITY_POSE }

  switch (m.state) {
    case 'walk': {
      p.dy += walkBob(m.t)
      const lean = Math.max(-1, Math.min(1, m.vx / MOTION.lean.refSpeed))
      p.rot += lean * MOTION.lean.rad
      break
    }
    case 'idle': {
      // Slow breathe, phase-shifted per entity so crowds don't sync.
      p.sy += Math.sin(m.t * MOTION.breathe.freq + (m.id % 32)) * MOTION.breathe.amp
      break
    }
    case 'attack': {
      // Out-and-back lunge along facing: sin(π·progress) peaks mid-window and
      // returns exactly to 0 at the end.
      const prog = clamp01((m.t - m.start) / STATE_TICKS.attack)
      const env = Math.sin(prog * Math.PI) * MOTION.attackLunge.px
      p.dx += Math.cos(m.facing) * env
      p.dy += Math.sin(m.facing) * env
      break
    }
    case 'hurt': {
      // Sideways shudder that decays to zero across the hurt window.
      const prog = clamp01((m.t - m.start) / STATE_TICKS.hurt)
      p.dx += Math.sin((m.t - m.start) * MOTION.hurtFlinch.freq * Math.PI) * MOTION.hurtFlinch.px * (1 - prog)
      break
    }
    case 'death': {
      // Topple around the feet (side chosen deterministically per entity) and
      // fade out; alpha hits exactly 0 as the window closes.
      const prog = clamp01((m.t - m.start) / STATE_TICKS.death)
      const side = m.id % 2 === 0 ? 1 : -1
      p.rot += side * MOTION.deathFall.rot * Math.pow(prog, 0.7)
      p.alpha *= 1 - prog
      break
    }
    case 'roll':
      break // tumble handled whole-body in sprites.ts
  }

  // Post-roll landing squash: fires once the roll window has just closed,
  // regardless of the state that follows (idle/walk/…), easing out over ticks.
  if (m.state !== 'roll' && m.rollUntil !== undefined && m.tick >= m.rollUntil) {
    const since = m.t - m.rollUntil
    if (since < MOTION.landSquash.ticks) {
      const q = 1 - clamp01(since / MOTION.landSquash.ticks)
      p.sy *= 1 - MOTION.landSquash.amount * q
      p.sx *= 1 + MOTION.landSquash.amount * q
    }
  }

  return p
}
