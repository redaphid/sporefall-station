/**
 * Pure math for screen juice: shake stacking/decay, hitstop frame accounting,
 * damage vignette + low-health pulse, and element post-tint intensity. No pixi,
 * no DOM, no wall-clock — the renderer feeds it dt and reads back numbers, and
 * every function here is unit-testable in isolation.
 */

import type { SimEvent } from '../game/types'

// --- Screen shake (magnitude in world tiles) ---------------------------------

/** Hard ceiling so a pile-up of explosions can't fling the camera off-screen. */
export const SHAKE_MAX = 0.55
/** Below this the shake reads as still; snap to zero so it truly rests. */
const SHAKE_MIN = 0.001

/** Add to the current shake and clamp — multiple hits in a tick stack, but the
 * total is bounded. */
export const stackShake = (current: number, add: number): number =>
  Math.min(SHAKE_MAX, Math.max(0, current) + Math.max(0, add))

/** Exponential decay toward zero; snaps to 0 once imperceptible. */
export const decayShake = (mag: number, dt: number): number => {
  const next = mag * Math.exp(-6 * dt)
  return next < SHAKE_MIN ? 0 : next
}

// --- Hitstop (whole frames of freeze on a weighty hit) -----------------------

/** Never freeze longer than this — a few frames reads as weight, more as lag. */
export const HITSTOP_MAX = 6

/** Queue up freeze frames, clamped and never below zero. */
export const addHitstop = (current: number, frames: number): number =>
  Math.min(HITSTOP_MAX, Math.max(0, current) + Math.max(0, Math.floor(frames)))

/** Consume one frame of freeze; never goes negative. */
export const tickHitstop = (current: number): number => Math.max(0, current - 1)

// --- Damage vignette + low-health pulse (screen-space red overlay alpha) ------

export const VIGNETTE_MAX = 0.5
const VIGNETTE_FADE = 1.4 // alpha/sec
/** Below this fraction the player "feels" the danger via a pulsing red edge. */
export const LOW_HP = 0.3
const PULSE_HZ = 3

/** Fade a one-shot damage flash toward zero. */
export const decayVignette = (alpha: number, dt: number): number =>
  Math.max(0, alpha - dt * VIGNETTE_FADE)

/** Pulsing red intensity when hurt; exactly 0 at or above LOW_HP. `tSec` drives
 * the sine so the caller controls phase. Result is in [0, VIGNETTE_MAX]. */
export const lowHealthPulse = (hpFrac: number, tSec: number): number => {
  if (hpFrac >= LOW_HP || hpFrac < 0) return 0
  const severity = 1 - hpFrac / LOW_HP // 0 at threshold → 1 at death's door
  const wave = 0.5 + 0.5 * Math.sin(tSec * PULSE_HZ * Math.PI * 2)
  return severity * wave * VIGNETTE_MAX
}

/** The just-enough view of the local player the low-health pulse cares about. */
export interface SelfVitals {
  hpFrac: number
  /** Bleeding out (hp 0, revive timer running) — resolving, not "low health". */
  downed: boolean
  /** Dead body not yet swept from the snapshot. */
  dead: boolean
}

/**
 * Gated low-health red pulse for the LOCAL player. The raw `lowHealthPulse`
 * screams red at any hp ≤ 0 — which is exactly the state a downed/dead body sits
 * in for the whole 30s bleed-out and again at game-over, so it would stick the
 * screen full-red until a page reload (#52). Gate it: the pulse is a warning for
 * a LIVE, upright, low-health player only. When `self` is downed or dead, or the
 * run is over (the restart overlay owns the screen), it is OFF — the death/revive
 * flow is resolving and must not be buried under a frozen red wash.
 */
export const lowHealthVignette = (
  self: SelfVitals | null | undefined,
  gameOver: boolean,
  tSec: number,
): number => {
  if (!self || gameOver || self.downed || self.dead) return 0
  return lowHealthPulse(self.hpFrac, tSec)
}

// --- Element post-tint (fire warm / frost cold), intensity 0..1 --------------

const TINT_FADE = 1.2 // intensity/sec

export const decayTint = (v: number, dt: number): number => Math.max(0, v - dt * TINT_FADE)

/** Warm (fire) vs cold (frost) intensity an event contributes, 0 if neither.
 * Explosions/fire-DOT hits warm the scene; shatter/shock chill it. */
export const tintForEvent = (ev: SimEvent): { warm: number; cold: number } => {
  switch (ev.type) {
    case 'explosion':
      return { warm: 0.8, cold: 0 }
    case 'shatter':
      return { warm: 0, cold: 0.7 }
    case 'shock':
      return { warm: 0, cold: 0.4 }
    default:
      return { warm: 0, cold: 0 }
  }
}

/** Per-event camera-shake magnitude. `isSelf` = the event's subject is the
 * local player (harder shake when it's you getting hit). Returns 0 for events
 * that shouldn't move the camera. */
export const shakeForEvent = (ev: SimEvent, isSelf: boolean): number => {
  switch (ev.type) {
    case 'explosion':
      return 0.28
    case 'shatter':
      return 0.14
    case 'hit':
      return isSelf ? 0.14 : ev.amount > 0 ? 0.05 : 0
    case 'death':
      return isSelf ? 0.2 : 0.05
    case 'shock':
      return isSelf ? 0.08 : 0
    default:
      return 0
  }
}

/** Frames of hitstop an event earns — only genuinely weighty impacts. */
export const hitstopForEvent = (ev: SimEvent, isSelf: boolean): number => {
  switch (ev.type) {
    case 'explosion':
      return 5
    case 'shatter':
      return 4
    case 'death':
      return isSelf ? 4 : 2
    case 'hit':
      return isSelf && ev.amount >= 20 ? 3 : 0
    default:
      return 0
  }
}
