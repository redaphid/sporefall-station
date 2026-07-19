// Camera-focus state machine for objective hyperlinks — PURE (no DOM, no pixi,
// no clocks), so every transition is unit-testable. main.ts owns one FocusState
// and advances it per render frame; the camera is a VIEW concern, so none of
// this ever touches sim state or determinism.
//
// Lifecycle: tap a link → 'pan' (the camera GLIDES to the target and holds
// there) → 'return' (glides back to the player) → undefined (normal follow).
// The pan is animated by easing the camera's follow rate down while a focus is
// live (see focusPanRate) rather than snapping — the same exponential-lerp
// camera, just with a gentler time constant.

import type { ObjectiveLink } from './missionModel'

/** Seconds the camera dwells on the target (including the glide out). Generous
 * on purpose: any real movement input cancels the focus instantly, so the long
 * dwell only ever plays out when the player is actually standing still. */
export const FOCUS_SECONDS = 5
/** Seconds of eased glide back to the player after the dwell. */
export const RETURN_SECONDS = 1.2
/** Player displacement (world tiles) from the tap position that cancels the
 * focus — the player moved, so they've taken the camera back. */
export const FOCUS_CANCEL_DIST = 1.5
/** Exponential follow rate while a focus is live — slower than the normal 8 so
 * the pan reads as a deliberate animated glide, not a cut. */
export const FOCUS_PAN_RATE = 3
/** The camera's normal follow rate (mirrors Camera.follow's default). */
export const NORMAL_PAN_RATE = 8

export interface FocusState {
  target: ObjectiveLink
  phase: 'pan' | 'return'
  secondsLeft: number
  /** Player position when the focus started — moving away from it cancels. */
  anchor: { x: number; y: number }
}

/** Begin focusing a link. Replaces any focus in flight. */
export const startFocus = (target: ObjectiveLink, self: { x: number; y: number }, seconds = FOCUS_SECONDS): FocusState => ({
  target,
  phase: 'pan',
  secondsLeft: seconds,
  anchor: { x: self.x, y: self.y },
})

/**
 * Advance the state machine by `dt` seconds. Returns the next state, or
 * `undefined` when focus is over and normal follow should resume.
 *
 * Ends (or skips straight past 'return') when:
 * - the dwell then the return glide run out,
 * - the player moves > FOCUS_CANCEL_DIST from where they tapped (they took over
 *   — return immediately with NO extra glide state, their input is live), or
 * - the target became unresolvable mid-pan (entity died/despawned).
 */
export const tickFocus = (
  s: FocusState | undefined,
  dt: number,
  self: { x: number; y: number },
  targetPos: { x: number; y: number } | undefined,
): FocusState | undefined => {
  if (!s) return undefined
  if (Math.hypot(self.x - s.anchor.x, self.y - s.anchor.y) > FOCUS_CANCEL_DIST) return undefined
  if (s.phase === 'pan' && !targetPos) return undefined // link died mid-focus
  const secondsLeft = s.secondsLeft - dt
  if (secondsLeft > 0) return { ...s, secondsLeft }
  if (s.phase === 'pan') return { ...s, phase: 'return', secondsLeft: RETURN_SECONDS }
  return undefined
}

/** Camera follow target for this frame: the link while panning, the player on
 * the way back. `targetPos` is the caller-resolved live link position. */
export const focusCameraTarget = (
  s: FocusState,
  self: { x: number; y: number },
  targetPos: { x: number; y: number } | undefined,
): { x: number; y: number } => (s.phase === 'pan' && targetPos ? targetPos : self)

/** Follow rate for this frame — eased while any focus state is live so both the
 * pan out AND the glide home are animated. */
export const focusPanRate = (s: FocusState | undefined): number => (s ? FOCUS_PAN_RATE : NORMAL_PAN_RATE)
