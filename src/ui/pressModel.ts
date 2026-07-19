// Pure press-gesture classifier for tap-to-inspect — the touch-side twin of
// pinch.ts's claiming brain. DOM-free (ids, coordinates, and times come in as
// arguments) so every discrimination rule is exhaustively unit-testable; the
// wiring in touch.ts / overlay.ts is thin.
//
// THE DISCRIMINATION RULE (must never steal input from sticks or pinch):
//
//   The virtual-stick zones cover the whole screen, so "neutral space" is
//   BEHAVIORAL, not spatial: a press is neutral (CLEAN) only while it has done
//   nothing — moved less than PRESS_SLOP_PX, not been joined by another fresh
//   finger, not been claimed elsewhere (pinch), and not landed on a button/
//   hotbar (those elements are filtered out by the wiring and never reach this
//   tracker).
//
//   • Movement past PRESS_SLOP_PX → the press IS the stick; it never inspects.
//     (PRESS_SLOP_PX === pinch CLAIM_SLOP, so "became a stick" means the same
//     thing to both trackers.)
//   • A new finger arriving while another press is still CLEAN → pinch or
//     twin-thumb play forming; BOTH become non-neutral. But a new finger while
//     every other press is already established/dead (e.g. tapping an NPC with
//     the right thumb while the left thumb drags the move stick) starts a fresh
//     clean press — tap-while-moving works. Invariant: at most ONE clean press
//     exists at any time.
//   • cancel(id) → the wiring learned the touch was claimed elsewhere.
//   • Released clean before LONG_PRESS_MS → 'tap' (compact info chip).
//   • Held clean to LONG_PRESS_MS or beyond → 'longpress' (full info card),
//     fired at most once. The stick claim is NOT cancelled by the wiring: a
//     long-press has sub-threshold deflection so no movement/aim was emitted,
//     and leaving the claim alive means a thumb that rests then moves still
//     drives the stick — inspect is purely additive and steals nothing.
//
//   Exact boundary: elapsed >= LONG_PRESS_MS is a long-press, < is a tap —
//   deterministic for any timestamp stream.

/** Hold this long (ms) for a long-press (full info card). */
export const LONG_PRESS_MS = 400
/** A press that travels this far (px) is a stick/drag, never an inspect. Kept
 * identical to pinch.ts CLAIM_SLOP so "established as a stick" means one thing. */
export const PRESS_SLOP_PX = 12

export type PressOutcome = 'tap' | 'longpress' | null

export interface PressTracker {
  /** A pointer went down at (x,y). */
  down(id: number, x: number, y: number, t: number): void
  /** Pointer moved — drifting past PRESS_SLOP_PX disqualifies that press. */
  move(id: number, x: number, y: number): void
  /** The wiring learned this press belongs elsewhere (pinch claimed it). */
  cancel(id: number): void
  /**
   * Time-based check while held: returns 'longpress' exactly once when the
   * clean press has been held for LONG_PRESS_MS. Call from a timer (any clock).
   */
  poll(t: number): PressOutcome
  /** Pointer lifted. 'tap' if that press stayed clean and elapsed < LONG_PRESS_MS;
   * 'longpress' if it crossed the threshold and poll() never fired (late timer). */
  up(id: number, t: number): PressOutcome
  /** Where the clean press started (for picking the entity under the finger). */
  origin(): { x: number; y: number } | undefined
}

interface Press {
  x0: number
  y0: number
  t0: number
  /** No longer neutral: moved, joined, or claimed elsewhere. */
  dead: boolean
  /** poll() already emitted the longpress for this press. */
  fired: boolean
}

export const createPressTracker = (): PressTracker => {
  const touches = new Map<number, Press>()

  /** The single clean press, if any (invariant: down() keeps it unique). */
  const clean = (): Press | undefined => {
    for (const p of touches.values()) if (!p.dead) return p
    return undefined
  }

  return {
    down(id, x, y, t): void {
      // A fresh finger next to a still-clean press = pinch/twin-plant forming:
      // both lose neutrality. Next to only established/dead presses it starts
      // clean (tap-while-moving).
      let joined = false
      for (const p of touches.values())
        if (!p.dead) {
          p.dead = true
          joined = true
        }
      touches.set(id, { x0: x, y0: y, t0: t, dead: joined, fired: false })
    },

    move(id, x, y): void {
      const p = touches.get(id)
      if (p && Math.hypot(x - p.x0, y - p.y0) >= PRESS_SLOP_PX) p.dead = true
    },

    cancel(id): void {
      const p = touches.get(id)
      if (p) p.dead = true
    },

    poll(t): PressOutcome {
      const p = clean()
      if (!p || p.fired) return null
      if (t - p.t0 >= LONG_PRESS_MS) {
        p.fired = true
        return 'longpress'
      }
      return null
    },

    up(id, t): PressOutcome {
      const p = touches.get(id)
      touches.delete(id)
      if (!p || p.dead || p.fired) return null
      return t - p.t0 >= LONG_PRESS_MS ? 'longpress' : 'tap'
    },

    origin(): { x: number; y: number } | undefined {
      const p = clean()
      return p ? { x: p.x0, y: p.y0 } : undefined
    },
  }
}
