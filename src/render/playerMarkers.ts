/**
 * Player marker MODEL — pure geometry and style for the tiny feet rings that
 * make a co-op crew readable. DOM-free and pixi-free so all of it is
 * unit-tested; `playerMarkerLayer.ts` is a thin pixi draw on top.
 *
 * ── TINY CIRCLES, NOTHING ELSE ───────────────────────────────────────────────
 *
 * Earlier versions of this marker grew a second rim, four cardinal ticks, a
 * breathing pulse and a floating name label — each addition individually
 * justified, but the sum sat on top of the character it was supposed to be
 * labelling. This version is deliberately minimal: a small ring at the feet,
 * colour-coded, nothing that grows, animates, or adds a second shape EXCEPT
 * the downed X below — kept because it is the one shape a bleeding-out
 * teammate's life may depend on reading correctly with no colour vision.
 *
 *   - "who is that?"     → a teammate's own slot colour, thin and quiet.
 *   - "which one is ME?" → white, and very slightly bigger — the only two
 *                          differences from a teammate ring. No second rim,
 *                          no ticks, no motion.
 *   - "who is DOWN?"     → the ring turns the alarm red AND gets a struck
 *                          X — the one place this file still pairs colour
 *                          with a shape, because red-on-red-floor is a real,
 *                          measured colourblind failure (see DOWNED_COLOR_INT
 *                          in playerIdentity.ts).
 *
 * ── WHY A RING AT THE FEET ──────────────────────────────────────────────────
 *
 * A marker centred on the body covers the character art it labels. A ring at
 * the FEET is anchored to the thing it marks, scales with the camera, and
 * — as long as it stays small — leaves the sprite fully visible above it.
 */

import { DOWNED_COLOR_INT, playerColorInt } from './playerIdentity'

/** Ground rings are squashed to read as lying ON the floor, not as a halo. */
export const GROUND_SQUASH = 0.52

/** Ring radii in TILES — deliberately tiny: a mark at the shoes, not a halo
 * around the shins. Yours is only slightly bigger than a teammate's. */
export const SELF_RADIUS = 0.22
export const MATE_RADIUS = 0.16

/** Everything the model needs about one player to style their marker. */
export interface MarkerSubject {
  /** Player slot (`playerCtl.playerId`) — the deterministic identity source. */
  slot: number
  /** Is this the player holding the phone? */
  self: boolean
  /** Downed and bleeding out (revivable). */
  downed: boolean
}

/** A fully resolved marker, in world tiles / world pixels. */
export interface MarkerStyle {
  color: number
  /** Ring radius in tiles (x); multiply by GROUND_SQUASH for y. */
  radius: number
  /** Stroke width in world pixels. */
  width: number
  alpha: number
  /** Struck-through X — downed only, the one non-colour cue this file keeps. */
  cross: boolean
}

/** Resolve one player's marker. Static — nothing here reads the clock or the
 * render tick, so there is nothing to animate and nothing to keep in sync. */
export const markerStyle = (s: MarkerSubject): MarkerStyle => {
  const slotColor = playerColorInt(s.slot)
  const radius = s.self ? SELF_RADIUS : MATE_RADIUS
  if (s.downed) {
    return { color: DOWNED_COLOR_INT, radius, width: s.self ? 2 : 1.5, alpha: 0.85, cross: true }
  }
  if (s.self) {
    // White, not a saturated hue: it wins on VALUE against the brown/green
    // palette without adding another loud colour to a busy fight.
    return { color: 0xffffff, radius, width: 1.5, alpha: 0.8, cross: false }
  }
  return { color: slotColor, radius, width: 1.25, alpha: 0.55, cross: false }
}

/** Draw order for the markers: downed LAST so the emergency paints on top, then
 * the local player, then teammates by slot (stable — never reorders per frame). */
export const markerOrder = <T extends MarkerSubject>(subjects: readonly T[]): T[] =>
  subjects
    .slice()
    .sort((a, b) => Number(a.downed) - Number(b.downed) || Number(a.self) - Number(b.self) || a.slot - b.slot)
