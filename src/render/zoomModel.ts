import { TILE_PX } from './art'

/**
 * Pure view-zoom math (issue: pinch/scrollwheel camera zoom). Everything here is
 * DOM-free and unit-tested; camera.ts and the input layer are thin wiring on top.
 *
 * Zoom is VIEW-ONLY: it scales the world container and every world→screen
 * projection (locatorModel.ts already multiplies TILE_PX by it) but never touches
 * the sim, the InputCmd, or aim (aim is stick-relative).
 */

/** Farthest out: a 390px-wide phone shows ~24 tiles — a whole room and change. */
export const ZOOM_MIN = 0.5
/** Farthest in: 32px tiles at 4× = 128px — sprite-admiring range. Matches the
 * historical `?zoom=` upper bound so existing e2e URLs keep working. */
export const ZOOM_MAX = 4
export const ZOOM_DEFAULT = 1

export const clampZoom = (z: number): number =>
  Number.isNaN(z) ? ZOOM_DEFAULT : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** Wheel sensitivity: ~one detent (100 deltaY px) ≈ ×1.16. Multiplicative, so
 * N identical notches compose to factor^N and in/out are exact inverses. */
const WHEEL_SENSITIVITY = 0.0015

/**
 * Multiplicative zoom factor for one wheel event. `deltaMode` normalises
 * line/page deltas (Firefox line mode) to pixels first. Negative deltaY (scroll
 * up) zooms IN (>1), matching every map app.
 */
export const wheelZoomFactor = (deltaY: number, deltaMode = 0): number => {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 120 : deltaY
  return Math.exp(-px * WHEEL_SENSITIVITY)
}

/**
 * Map a pinch gesture to a zoom level: the zoom scales by the same ratio the
 * finger distance did, from the zoom captured when the pinch formed. Clamped;
 * degenerate start distances (fingers on the same point) return the start zoom.
 */
export const pinchZoom = (startZoom: number, startDist: number, dist: number): number =>
  startDist > 0 && dist > 0 ? clampZoom(startZoom * (dist / startDist)) : clampZoom(startZoom)

/**
 * Framerate-independent exponential approach of `current` toward `target`,
 * snapping when within a hair so the camera settles instead of asymptoting.
 */
export const smoothZoom = (current: number, target: number, dt: number): number => {
  const k = 1 - Math.exp(-14 * dt)
  const next = current + (target - current) * k
  return Math.abs(next - target) < 1e-3 ? target : next
}

/**
 * New camera centre (world tiles) that keeps the world point under the screen
 * anchor (ax,ay) stationary across a zoom step z0→z1. Derivation from the
 * projection `screen = screenCentre + (world - camCentre) * TILE_PX * zoom`:
 * hold `world` and `screen` fixed, solve for the new centre. Edge clamping in
 * Camera.apply may still override this near level borders — that is desired
 * (never show past the edge just to honour an anchor).
 */
export const anchoredCenter = (
  cx: number,
  cy: number,
  z0: number,
  z1: number,
  ax: number,
  ay: number,
  screenW: number,
  screenH: number,
): { x: number; y: number } => {
  const t0 = TILE_PX * z0
  const t1 = TILE_PX * z1
  const k = 1 / t0 - 1 / t1
  return { x: cx + (ax - screenW / 2) * k, y: cy + (ay - screenH / 2) * k }
}

/** How the input layer drives the camera's zoom — implemented by Camera, faked in tests. */
export interface ZoomSink {
  /** Current zoom TARGET (not the mid-interpolation value) so successive wheel
   * notches compound instead of fighting the smoothing. */
  get(): number
  /** Set the zoom target, anchored so the world point under screen (ax,ay) stays put. */
  set(z: number, ax: number, ay: number): void
  /** Quick reset to the default zoom (two-finger double-tap), centre-anchored. */
  reset(): void
}
