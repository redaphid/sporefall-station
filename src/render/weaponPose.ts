// The held-weapon POSE — where the weapon sits in the wielder's hand and how it
// swings on attack. Layer-2 of the weapon layer (mirrors motion.ts for the body):
// a PURE function of the drawn facing + the sim-derived attack progress, so the
// swing is deterministic and replay-stable (same tick → same angle on every
// device). No pixi, no DOM, no wall clock, no randomness — unit-testable in full.
//
// Attack progress `p` is (tick − attackStart) / STATE_TICKS.attack — the SAME
// clock the body's attack lunge reads (motion.ts). At rest (no attack, or p
// outside [0,1)) the weapon holds its idle pose; during the window it sweeps an
// arc and returns exactly to that idle at p = 1.

import type { Dir } from './anim'

/** Peak arc the weapon sweeps through mid-swing, in radians. Chosen wide enough
 * to read as a decisive swing at gameplay zoom, short enough to stay on-canvas. */
export const SWING_ARC = 1.8

/** Per-drawn-direction hand rig. `hx/hy` place the grip relative to the sprite's
 * FEET anchor (canvas px: +x right of centre, +y DOWN from the feet — so hy is
 * negative, up at hand height). `idle` is the resting weapon angle in SCREEN
 * radians (+x right, +y down) for the EAST-side art; the west half mirrors it.
 * `behind` marks away-facing poses whose weapon should draw behind the body. */
interface HandRig {
  hx: number
  hy: number
  idle: number
  behind: boolean
}

/** The five DRAWN facings (west half is these mirrored). Idle angles are a
 * "raised ready" hold so the downward chop has room to travel. */
export const HAND_RIG: Record<Dir, HandRig> = {
  s: { hx: 11, hy: -18, idle: 0.2, behind: false },
  se: { hx: 12, hy: -18, idle: -0.1, behind: false },
  e: { hx: 12, hy: -18, idle: -0.4, behind: false },
  ne: { hx: 10, hy: -20, idle: -0.9, behind: true },
  n: { hx: 7, hy: -20, idle: -1.3, behind: true },
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Swing envelope over progress p ∈ [0,1]: 0 at rest, rising to a peak of 1 at
 * mid-window, back to 0 at the end — a struck arc that returns to the idle hold.
 * sin(πp), the same out-and-back envelope the body's attack lunge uses, so the
 * weapon and the body move in lockstep. Monotonic increasing on [0, 0.5]. */
export const swingSweep = (p: number): number => Math.sin(clamp01(p) * Math.PI)

export interface WeaponPose {
  /** Hand grip offset from the feet anchor (canvas px), mirror already applied. */
  hx: number
  hy: number
  /** Weapon rotation in screen radians, mirror already applied. */
  angle: number
  /** Draw the weapon behind the body (away-facing poses). */
  behind: boolean
}

/**
 * The held-weapon pose for a drawn facing.
 * @param dir   drawn facing (s/se/e/ne/n) — west facings pass their east twin + flip
 * @param progress attack progress (tick−start)/STATE_TICKS.attack, or undefined /
 *                 outside [0,1) for the idle hold (no swing)
 * @param flip  true for the mirrored west half — mirrors hx and the angle
 */
export const weaponPose = (dir: Dir, progress: number | undefined, flip: boolean): WeaponPose => {
  const rig = HAND_RIG[dir]
  const swinging = progress !== undefined && progress >= 0 && progress < 1
  const sweep = swinging ? swingSweep(progress) : 0
  // Chop DOWNWARD (increasing screen angle) from the raised idle, then back.
  const eastAngle = rig.idle + SWING_ARC * sweep
  // West half: mirror x (negate hx) and reflect the angle across vertical
  // (π − θ flips the horizontal component, preserves the vertical), so the swing
  // reads identically on both sides.
  return {
    hx: flip ? -rig.hx : rig.hx,
    hy: rig.hy,
    angle: flip ? Math.PI - eastAngle : eastAngle,
    behind: rig.behind,
  }
}

/** Ranged recoil kick along the aim (screen px), out-and-back over the attack
 * window — a small nudge so guns punch rather than swing. 0 at rest / outside
 * the window. Melee never uses this (it swings instead). */
export const RECOIL_PX = 3
export const recoilKick = (progress: number | undefined): number =>
  progress !== undefined && progress >= 0 && progress < 1 ? -RECOIL_PX * swingSweep(progress) : 0
