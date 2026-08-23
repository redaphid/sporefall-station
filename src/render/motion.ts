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
 *
 * That last sentence holds for `stride`, which is every character with legs and
 * the default for anything not listed in LOCOMOTION. It is deliberately NOT true
 * of `hover`, whose whole job is to keep the body off the floor — see
 * LocomotionStyle below. Read "feet never leave the ground" as a statement about
 * bodies that have feet, not as a global invariant of this module.
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
  /** HOVER locomotion: continuous vertical float, idle and moving alike. Larger
   * than walkBob because it is the character's whole read — a drone that does
   * not visibly hover just looks like a static sprite sliding along the floor. */
  hover: { amp: 2.2, freq: 0.11, movingScale: 1.35 },
  /** PULSE locomotion: volume-ish-preserving radial breath (sx up as sy down).
   * Never touches dy — a sac sitting on the ground stays on the ground. */
  pulse: { amp: 0.06, freq: 0.13, movingScale: 1.6 },
} as const

/** How a character's body carries itself. The 48px canvas is the reason this
 * exists: a limb is 1–2px there, so articulating legs is mush, while moving the
 * WHOLE sprite reads cleanly. Rather than draw walk frames a body plan does not
 * have, pick the transform that matches how the thing actually moves.
 *
 * - `stride` — feet on the ground: walk bob + lean, idle breathe. The default,
 *   and the only style that assumes legs.
 * - `hover`  — never touches the floor: continuous float in every state. Feet
 *   deliberately DO leave the ground; that is the point.
 * - `pulse`  — grounded but boneless: radial breath, no vertical travel. */
export type LocomotionStyle = 'stride' | 'hover' | 'pulse'

/** Per-archetype locomotion. Anything absent is `stride`, so adding a character
 * never silently changes how it moves — you opt in. Keyed by the same archetype
 * string the art registry uses. */
export const LOCOMOTION: Readonly<Record<string, LocomotionStyle>> = {
  'spore-drone': 'hover',
  'gloom-lurker': 'hover',
  'brood-sac': 'pulse',
  'sporeling-mite': 'pulse',
}

export const locomotionFor = (archetype: string): LocomotionStyle =>
  LOCOMOTION[archetype] ?? 'stride'

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
  /** How this body carries itself. Omitted = `stride`, so every existing caller
   * keeps its current motion exactly. */
  style?: LocomotionStyle
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

/** Whole-body locomotion for non-striding bodies, shared by idle and walk (they
 * differ only in gain — these creatures never change gait, they just do more of
 * the same). Phase-shifted per entity id so a cluster does not pulse in unison.
 *
 * `hover` is the ONE place dy moves outside walk bob and attack lunge, and it is
 * deliberate: the feet-stay-planted invariant is a statement about bodies that
 * have feet. A drone that plants itself on the floor reads as a bug. */
const applyLocomotion = (
  p: MotionPose,
  style: Exclude<LocomotionStyle, 'stride'>,
  m: MotionInput,
  moving: boolean,
): void => {
  const cfg = MOTION[style]
  const gain = moving ? cfg.movingScale : 1
  const wave = Math.sin(m.t * cfg.freq + (m.id % 32))
  if (style === 'hover') {
    p.dy += wave * cfg.amp * gain
    return
  }
  // Radial breath: widen as it flattens, so the footprint stays put.
  const q = wave * cfg.amp * gain
  p.sx += q
  p.sy -= q
}

/** Compose every active motion component for this frame. The roll state itself
 * returns identity — the whole-body tumble (anchor swap + spin) stays in
 * sprites.ts, and this layer adds only the LANDING squash after it. */
export const composeMotion = (m: MotionInput): MotionPose => {
  const p: MotionPose = { ...IDENTITY_POSE }
  const style = m.style ?? 'stride'

  switch (m.state) {
    case 'walk': {
      if (style === 'stride') {
        p.dy += walkBob(m.t)
        const lean = Math.max(-1, Math.min(1, m.vx / MOTION.lean.refSpeed))
        p.rot += lean * MOTION.lean.rad
      } else {
        // A hoverer/pulser in motion does MORE of what it already does; it does
        // not acquire a gait. No lean either — leaning implies planted feet to
        // lean against.
        applyLocomotion(p, style, m, true)
      }
      break
    }
    case 'idle': {
      if (style === 'stride') {
        // Slow breathe, phase-shifted per entity so crowds don't sync.
        p.sy += Math.sin(m.t * MOTION.breathe.freq + (m.id % 32)) * MOTION.breathe.amp
      } else {
        applyLocomotion(p, style, m, false)
      }
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
