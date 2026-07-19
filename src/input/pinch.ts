/**
 * Pure pinch-gesture tracker — the touch-claiming brain for pinch-to-zoom.
 * DOM-free (times and coordinates come in as arguments) so the claiming rules
 * are exhaustively unit-testable; touch.ts is thin wiring on top.
 *
 * THE CLAIMING RULE (must never fight the twin-stick controls):
 *
 *   A pinch is two concurrent touches on the SAME screen half where neither
 *   touch is an ESTABLISHED stick. A stick touch is "established" once it has
 *   moved past CLAIM_SLOP px or lived past CLAIM_MS — before that it is "fresh"
 *   and may be re-claimed into a pinch (its stick output is cancelled, which is
 *   glitch-free: a fresh stick has near-zero deflection, below the aim/fire
 *   threshold, so nothing has fired or moved yet).
 *
 *   Why same-half? Planting BOTH thumbs at once (left+right zones) is exactly
 *   how twin-stick play starts — it must never be misread as a pinch. A pinch
 *   with two fingers on one half (thumb+index, the natural mobile gesture) has
 *   no such ambiguity. Fingers on opposite halves therefore NEVER pinch.
 *
 *   While a pinch is active its two touches are `consumed` — they emit no stick
 *   input, ever again (even after the pinch ends), so releasing a pinch can't
 *   cause a phantom stick jump. Other fingers are untouched: an established
 *   stick keeps working while two more fingers pinch beside it.
 */

export type Side = 'left' | 'right'

/** A fresh stick claim may still be converted to a pinch within this movement… */
export const CLAIM_SLOP = 12
/** …and this age (ms). Past either, the stick is established and un-pinchable. */
export const CLAIM_MS = 150

/** Two-finger tap (quick, no spread change) — two in a row reset the zoom. */
export const TAP_MS = 250
export const TAP_DIST_SLOP = 12
export const DOUBLE_TAP_MS = 400

export interface PinchState {
  /** Current finger spread (px) and the spread when the pinch formed. */
  dist: number
  startDist: number
  /** Current midpoint between the two fingers (same space as the input coords). */
  midX: number
  midY: number
}

export interface PinchUpResult {
  /** This lift ended an active pinch. */
  pinchEnded: boolean
  /** Second quick two-finger tap in a row → caller should reset zoom. */
  resetTap: boolean
}

interface TrackedTouch {
  id: number
  side: Side
  x: number
  y: number
  x0: number
  y0: number
  t0: number
  stickClaimed: boolean
  consumed: boolean
}

export interface PinchTracker {
  /**
   * Register a touch. `stickClaimed` = this touch just became (or already was)
   * a virtual-stick pointer. Returns the ids newly consumed by a pinch forming
   * — the caller must cancel any stick claim on those ids. Empty when no pinch
   * formed.
   */
  down(id: number, x: number, y: number, side: Side, stickClaimed: boolean, now: number): number[]
  /** Track movement. Returns live pinch state when `id` is a pinching finger. */
  move(id: number, x: number, y: number): PinchState | null
  up(id: number, now: number): PinchUpResult
  /** Consumed touches must never emit stick/aim input. */
  consumed(id: number): boolean
  pinchActive(): boolean
  /**
   * Forget every tracked touch and any active pinch. For when the touch layer
   * is hidden mid-gesture (controller takeover): its pointerup events will
   * never arrive, and a half-tracked ghost finger must not pair with a real
   * one into a phantom pinch after the controls come back.
   */
  reset(): void
}

export const createPinchTracker = (): PinchTracker => {
  const touches = new Map<number, TrackedTouch>()
  let pinch: { a: number; b: number; startDist: number; t0: number; maxSpreadDelta: number } | null = null
  let lastTapT = -Infinity

  const dist = (a: TrackedTouch, b: TrackedTouch): number => Math.hypot(a.x - b.x, a.y - b.y)

  /** May this touch still be claimed into a pinch? */
  const eligible = (t: TrackedTouch, now: number): boolean =>
    !t.consumed &&
    (!t.stickClaimed || (now - t.t0 < CLAIM_MS && Math.hypot(t.x - t.x0, t.y - t.y0) < CLAIM_SLOP))

  const state = (): PinchState | null => {
    if (!pinch) return null
    const a = touches.get(pinch.a)
    const b = touches.get(pinch.b)
    if (!a || !b) return null
    const d = dist(a, b)
    pinch.maxSpreadDelta = Math.max(pinch.maxSpreadDelta, Math.abs(d - pinch.startDist))
    return { dist: d, startDist: pinch.startDist, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 }
  }

  return {
    down(id, x, y, side, stickClaimed, now): number[] {
      const me: TrackedTouch = { id, side, x, y, x0: x, y0: y, t0: now, stickClaimed, consumed: false }
      touches.set(id, me)
      if (pinch) return [] // one pinch at a time
      for (const other of touches.values()) {
        if (other.id === id || other.side !== side) continue
        if (!eligible(other, now) || !eligible(me, now)) continue
        other.consumed = true
        me.consumed = true
        pinch = { a: other.id, b: id, startDist: Math.max(dist(other, me), 1), t0: now, maxSpreadDelta: 0 }
        return [other.id, id]
      }
      return []
    },

    move(id, x, y): PinchState | null {
      const t = touches.get(id)
      if (!t) return null
      t.x = x
      t.y = y
      return pinch && (id === pinch.a || id === pinch.b) ? state() : null
    },

    up(id, now): PinchUpResult {
      const t = touches.get(id)
      touches.delete(id)
      if (!t || !pinch || (id !== pinch.a && id !== pinch.b)) return { pinchEnded: false, resetTap: false }
      // Ending a pinch: the surviving finger stays consumed (inert until lifted)
      // so it can never turn into a phantom stick mid-flight.
      const survivor = touches.get(id === pinch.a ? pinch.b : pinch.a)
      if (survivor) survivor.consumed = true
      const quickTap = now - pinch.t0 < TAP_MS && pinch.maxSpreadDelta < TAP_DIST_SLOP
      pinch = null
      const resetTap = quickTap && now - lastTapT < DOUBLE_TAP_MS
      lastTapT = quickTap && !resetTap ? now : -Infinity
      return { pinchEnded: true, resetTap }
    },

    consumed: (id) => touches.get(id)?.consumed ?? false,
    pinchActive: () => pinch !== null,
    reset(): void {
      touches.clear()
      pinch = null
      // lastTapT intentionally survives: a double-tap-to-reset straddling a
      // hide/show would just fail to reset zoom, which is harmless either way.
    },
  }
}
