// The held-weapon POSE: which pre-drawn weapon drawing a wielder shows, which
// way it is mirrored, and whether it sits in front of or behind the body.
// Pure (no pixi, no DOM, no clock, no randomness) and a function of
// sim-derived signals only, so every device and every replay draws the same
// frame.
//
// A weapon is pixel art (weaponSprites.ts), so it is never rotated freely:
// rotating a 15px pistol by an arbitrary angle resamples it into a grey
// sliver. Instead the compass is split into eight 45° sectors and each sector
// has its own drawing (five drawn, the west three mirrored), the way a 16-bit
// sprite sheet carries a frame per direction. The body itself is drawn in the
// same eight directions, so the weapon's sector is the body's facing when it
// aims, one sector further down when it is at low-ready, and a short run of
// sectors for a melee chop.

import type { Dir } from './anim'
import type { WeaponView } from './theme'

/** The compass ring, clockwise on screen (+y is down): index 0 points east. */
export const RING = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'] as const

const RING_OF_DIR: Record<Dir, number> = { e: 0, se: 1, s: 2, ne: 7, n: 6 }

/** Ring index → the drawing that points that way and whether it is mirrored. */
const DRAWING: readonly (readonly [WeaponView, boolean])[] = [
  ['e', false],
  ['se', false],
  ['s', false],
  ['se', true],
  ['e', true],
  ['ne', true],
  ['n', false],
  ['ne', false],
]

const wrap = (i: number): number => ((i % 8) + 8) % 8

/** The body's facing as a ring index (the west half is the east art mirrored). */
export const facingSector = (dir: Dir, flip: boolean): number => {
  const i = RING_OF_DIR[dir]
  return flip ? wrap(4 - i) : i
}

/** A chop in four beats over the attack window, as sector steps from the
 * facing toward "forward-down": raised overhead, coming over, striking along
 * the facing, follow-through (which is also the melee rest pose). */
export const SWING_STEPS = [-2, -1, 0, 1] as const

/** Ticks a wielder keeps its weapon up after an attack before it lowers to
 * low-ready again (1.5 s). */
export const AIM_HOLD_TICKS = 45

export interface HoldInput {
  /** Drawn body facing and its west-half mirror (anim.facingDir). */
  dir: Dir
  flip: boolean
  /** A gun (aims and recoils) rather than a melee weapon (chops). */
  ranged: boolean
  /** Weapon up: a gun held level along the facing. Otherwise low-ready. */
  aiming: boolean
  /** Attack progress in [0,1) over the attack window, or undefined at rest. */
  progress?: number
}

export interface HeldPose {
  /** Ring index the drawing points along. */
  sector: number
  view: WeaponView
  /** Mirror the drawing horizontally (scale.x = -1); never any other scale. */
  mirror: boolean
  /** Draw behind the body: the wielder faces away (ne/n), so the arm and the
   * weapon are on the far side of it. */
  behind: boolean
  /** Redraw the wielder's own fist over the grip. Off behind the body (the body
   * already covers it) and for a weapon pointed at the camera, whose muzzle is
   * nearer the viewer than the hand. */
  cap: boolean
}

/** The held-weapon pose. */
export const heldPose = ({ dir, flip, ranged, aiming, progress }: HoldInput): HeldPose => {
  const f = facingSector(dir, flip)
  // "Forward-down" turns clockwise on the east half, counter-clockwise on the west.
  const down = flip ? -1 : 1
  const swinging = !ranged && progress !== undefined && progress >= 0 && progress < 1
  const step = swinging ? SWING_STEPS[Math.min(3, Math.floor(progress * 4))] : ranged && aiming ? 0 : 1
  const sector = wrap(f + down * step)
  const [view, drawnMirror] = DRAWING[sector]
  // s and n drawings face the camera; they take the body's own mirror.
  const mirror = view === 's' || view === 'n' ? flip : drawnMirror
  const behind = dir === 'ne' || dir === 'n'
  return { sector, view, mirror, behind, cap: !behind && view !== 's' }
}

/** Is the wielder's weapon up? An NPC engaged with a target, anyone who
 * attacked in the last AIM_HOLD_TICKS, or a player strafing (moving one way,
 * facing another: the twin-stick aim). */
export const isAiming = (s: { engaged: boolean; ticksSinceAttack?: number; strafing: boolean }): boolean =>
  s.engaged ||
  s.strafing ||
  (s.ticksSinceAttack !== undefined && s.ticksSinceAttack >= 0 && s.ticksSinceAttack < AIM_HOLD_TICKS)

/** Fallback hand position per drawn facing when the frame carries no measured
 * fist (procedural bodies, a pack without anchors): the grip's offset from the
 * feet anchor in 48-unit character px (+x right, +y down). */
export const HAND_RIG: Record<Dir, { hx: number; hy: number }> = {
  s: { hx: 8, hy: -20 },
  se: { hx: 7, hy: -21 },
  e: { hx: -3, hy: -20 },
  ne: { hx: 7, hy: -20 },
  n: { hx: 8, hy: -20 },
}

/** Ranged recoil: the gun punches back this many character px at the peak of
 * the attack window (sin envelope), 0 at rest. The renderer snaps it to the
 * art grid. */
export const RECOIL_PX = 2
export const recoilKick = (progress: number | undefined): number =>
  progress !== undefined && progress >= 0 && progress < 1 ? -RECOIL_PX * Math.sin(progress * Math.PI) : 0
