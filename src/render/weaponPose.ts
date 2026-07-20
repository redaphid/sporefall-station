// The held-weapon POSE — where the weapon sits in the wielder's hand and how it
// swings on attack. Layer-2 of the weapon layer (mirrors motion.ts for the body):
// a PURE function of the CONTINUOUS aim + the drawn facing + the sim-derived
// attack progress, so the pose is deterministic and replay-stable (same tick →
// same angle on every device). No pixi, no DOM, no wall clock, no randomness —
// unit-testable in full.
//
// Aim is CONTINUOUS. The weapon rotates to the wielder's exact aim heading
// (`entity.facing`, radians, screen +x right / +y down) — the SAME signal the
// twin-stick reticle and the fired bullet both use (movement.ts sets
// `facing = atan2(aimY, aimX)`; combat fires along `facing`). So the muzzle
// points down the aim line, for the full 360° INCLUDING straight down, decoupled
// from the body's 8-way sprite quantization. The body sprite stays quantized
// (only 8 drawn facings exist); only the hand PLACEMENT borrows that quantized
// facing, never the weapon's rotation.
//
// Attack progress `p` is (tick − attackStart) / STATE_TICKS.attack — the SAME
// clock the body's attack lunge reads (motion.ts). At rest (no attack, or p
// outside [0,1)) the weapon points exactly at the aim. During the window a
// melee weapon sweeps an arc ON TOP of that aim and returns exactly to it at p=1.

import type { Dir } from './anim'

/** Peak arc the weapon sweeps through mid-swing, in radians. Chosen wide enough
 * to read as a decisive swing at gameplay zoom, short enough to stay on-canvas. */
export const SWING_ARC = 1.8

/** Per-drawn-direction hand rig — WHERE the grip pins to the body. `hx/hy` place
 * the grip relative to the sprite's FEET anchor (canvas px: +x right of centre,
 * +y DOWN from the feet — so hy is negative, up at hand height). Only the hand
 * PLACEMENT is quantized to the 8 drawn facings; the weapon's rotation follows
 * the continuous aim independently (see `weaponPose`). */
interface HandRig {
  hx: number
  hy: number
}

/** The five DRAWN facings (west half is these mirrored). */
export const HAND_RIG: Record<Dir, HandRig> = {
  s: { hx: 11, hy: -18 },
  se: { hx: 12, hy: -18 },
  e: { hx: 12, hy: -18 },
  ne: { hx: 10, hy: -20 },
  n: { hx: 7, hy: -20 },
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Swing envelope over progress p ∈ [0,1]: 0 at rest, rising to a peak of 1 at
 * mid-window, back to 0 at the end — a struck arc that returns to the aim hold.
 * sin(πp), the same out-and-back envelope the body's attack lunge uses, so the
 * weapon and the body move in lockstep. Monotonic increasing on [0, 0.5]. */
export const swingSweep = (p: number): number => Math.sin(clamp01(p) * Math.PI)

export interface WeaponPose {
  /** Hand grip offset from the feet anchor (canvas px), mirror already applied. */
  hx: number
  hy: number
  /** Weapon rotation in screen radians — the aim heading with any swing folded
   * in. The sprite's local +x (its barrel/blade) points along this. */
  angle: number
  /** Mirror the weapon sprite VERTICALLY (scale.y < 0). Set when aiming into the
   * left half so the grip keeps hanging DOWN (never upside-down) and the sprite
   * matches the body's west-half mirror. The barrel still points along `angle`
   * (a y-flip leaves the local +x axis untouched). */
  flipY: boolean
  /** Draw the weapon behind the body (aiming up/away, into the north hemisphere). */
  behind: boolean
}

/**
 * The held-weapon pose.
 * @param aim   CONTINUOUS aim heading in screen radians (`entity.facing`) — the
 *              weapon points exactly here (full 360°, incl. straight down).
 * @param dir   drawn body facing (s/se/e/ne/n) — used ONLY to place the hand.
 * @param progress attack progress (tick−start)/STATE_TICKS.attack, or undefined /
 *                 outside [0,1) for the idle hold (weapon points at aim, no swing)
 * @param flip  true for the mirrored west half — mirrors hx AND flips the sprite
 *              vertically (the same mirror the body uses), so the grip stays down.
 */
export const weaponPose = (aim: number, dir: Dir, progress: number | undefined, flip: boolean): WeaponPose => {
  const rig = HAND_RIG[dir]
  const swinging = progress !== undefined && progress >= 0 && progress < 1
  const sweep = swinging ? swingSweep(progress) : 0
  // Compose the swing arc ON TOP of the aim (idle = points at aim). On the
  // mirrored (west) side the sprite is y-flipped, which reverses the visual sense
  // of rotation — so negate the sweep there to keep the chop reading identically
  // left and right. At rest (sweep = 0) the angle is exactly the aim.
  const swingSign = flip ? -1 : 1
  return {
    hx: flip ? -rig.hx : rig.hx,
    hy: rig.hy,
    angle: aim + swingSign * SWING_ARC * sweep,
    flipY: flip,
    behind: Math.sin(aim) < 0, // aim points up/north (screen −y) → tuck behind
  }
}

/** Ranged recoil kick along the aim (screen px), out-and-back over the attack
 * window — a small nudge so guns punch rather than swing. 0 at rest / outside
 * the window. Melee never uses this (it swings instead). */
export const RECOIL_PX = 3
export const recoilKick = (progress: number | undefined): number =>
  progress !== undefined && progress >= 0 && progress < 1 ? -RECOIL_PX * swingSweep(progress) : 0
