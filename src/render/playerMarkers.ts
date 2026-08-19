/**
 * Player marker MODEL — pure geometry and style for the feet rings that make a
 * co-op crew readable. DOM-free and pixi-free so all of it is unit-tested;
 * `playerMarkerLayer.ts` is a thin pixi draw on top.
 *
 * ── THE TWO QUESTIONS ───────────────────────────────────────────────────────
 *
 * A player in a fight asks two different things, and they are NOT equally
 * urgent, so they deliberately do not get equal treatment:
 *
 *   1. "who is that?"     → teammates: a thin slot-coloured ring + their numeral.
 *   2. "which one is ME?" → you: a categorically DIFFERENT MARKER FORM — a
 *                           double ring with four cardinal ticks, breathing,
 *                           with a white outer rim and the word YOU.
 *
 * (2) is the one that loses fights, so it wins the eye contest against (1) by
 * FORM, not merely by being brighter: even in a greyscale screenshot, with
 * every hue stripped, exactly one marker on screen has ticks and two rims.
 *
 * ── WHY A RING AT THE FEET ──────────────────────────────────────────────────
 *
 * The pre-existing on-screen caret was centred on the body, so it covered the
 * character art it was labelling — eight players meant eight glyphs sitting on
 * eight sprites. A ring drawn at the FEET is anchored to the thing it marks,
 * scales with the camera, and leaves the whole sprite visible.
 *
 * ── AND WHY IT MUST NOT SHOUT ───────────────────────────────────────────────
 *
 * Props already render as the brightest thing on screen after the HUD. Markers
 * have to beat the furniture without beating the THREATS, so:
 *   - teammate rings are thin and part-transparent — present, not loud;
 *   - every ring gets a dark backing stroke, which buys contrast against a pale
 *     floor from VALUE rather than from saturation (saturation is what competes
 *     with enemies and with hit flashes);
 *   - the layer is mounted UNDER the status-fx / bullet / explosion layers, so
 *     anything actually trying to kill you paints over the top of it.
 */

import { DOWNED_COLOR_INT, playerColorInt, playerLabel, SELF_LABEL } from './playerIdentity'

/** Ticks for one full breathe of the local player's ring (30 ticks = 1s). */
export const PULSE_TICKS = 48

/** Ground rings are squashed to read as lying ON the floor, not as a halo. */
export const GROUND_SQUASH = 0.52

/** Ring radii in TILES. Yours is larger as well as differently shaped. */
export const SELF_RADIUS = 0.62
export const MATE_RADIUS = 0.42
/** The local player's inner rim, in your own slot hue, so you still learn which
 * colour is "you" — that is what the off-screen teammate arrows speak in. */
export const SELF_INNER_RADIUS = 0.4

/** How far the local player's ring swells at the top of its breath (fraction). */
export const PULSE_AMPLITUDE = 0.08

/**
 * World-pixels the name sits ABOVE the feet — i.e. hard up against the top of
 * its own ring, NOT floating over the head.
 *
 * Overhead names were tried first and are wrong here. Characters are drawn 48px
 * tall on 32px tiles while players huddle a single tile apart, so a name lifted
 * clear of its own head lands squarely on the head of whoever is standing
 * behind — and in the first render `P3` came to rest beside an enemy, reading
 * as a label FOR the enemy. Sitting the name on its ring makes ownership
 * unambiguous: the only thing it touches is the shins of the player it names,
 * and shins carry no information.
 */
export const labelRisePx = (style: MarkerStyle, tilePx: number): number =>
  style.radius * tilePx * GROUND_SQUASH + 3

/** Everything the model needs about one player to style their marker. */
export interface MarkerSubject {
  /** Player slot (`playerCtl.playerId`) — the deterministic identity source. */
  slot: number
  /** Is this the player holding the phone? */
  self: boolean
  /** Downed and bleeding out (revivable). */
  downed: boolean
}

/**
 * A pale alarm-red for the DOWNED name, rather than the ring's saturated red.
 *
 * Verified against a full-greyscale render (`e2e/crew-identity.mjs --grey`):
 * `#ff4d4d` has almost exactly the luminance of this game's lit floor tiles, so
 * with the hue taken away the most urgent label on screen was the hardest one to
 * read. Lifting the VALUE keeps it legible for a player with no colour vision
 * while it still reads as "red, something is wrong" for everyone else. The ring
 * and its struck-through X stay the loud saturated red.
 */
export const DOWNED_LABEL_COLOR = 0xffd6d6

/**
 * Scale for the name text, cancelling the camera zoom so a name stays readable
 * when the player pinches out — CLAMPED, because a fully constant on-screen size
 * means that at minimum zoom the rings have halved while the names have not, and
 * eight names collide into a single stripe. Capping the compensation trades a
 * little size for legible spacing exactly where crowding starts.
 */
export const labelScale = (zoom: number): number => (zoom > 0 ? Math.min(1 / zoom, 1.6) : 1)

/** A fully resolved marker, in world tiles / world pixels. */
export interface MarkerStyle {
  color: number
  /** Name colour — not always the ring colour (see DOWNED_LABEL_COLOR). */
  labelColor: number
  label: string
  /** Ring radius in tiles (x); multiply by GROUND_SQUASH for y. */
  radius: number
  /** Stroke width in world pixels. */
  width: number
  alpha: number
  /** Second, inner rim + four cardinal ticks — the local player only. */
  reticle: boolean
  /** Inner rim radius in tiles (only meaningful when `reticle`). */
  innerRadius: number
  /** Inner rim colour: your slot hue, so you can still learn "you are teal". */
  innerColor: number
  /** Struck-through X — the shape half of the downed cue. */
  cross: boolean
}

/**
 * A 0..1 triangle-free breathe from the render tick. Deterministic (tick-driven,
 * never `Date.now()`), continuous, and period-exact so the pulse never jitters
 * when the frame rate does. `t` may be fractional (tick + interpolation alpha).
 */
export const breathe = (t: number): number => 0.5 - 0.5 * Math.cos((t / PULSE_TICKS) * Math.PI * 2)

/**
 * Resolve one player's marker. `t` is the continuous render tick and only
 * affects the local player's pulse — teammate rings are deliberately static, so
 * a crowded screen has exactly ONE moving marker on it and that one is yours.
 */
export const markerStyle = (s: MarkerSubject, t: number): MarkerStyle => {
  const slotColor = playerColorInt(s.slot)
  if (s.self) {
    const swell = 1 + PULSE_AMPLITUDE * breathe(t)
    return {
      // A white rim, not a saturated one: it wins on VALUE against the brown/
      // green palette without adding another loud hue to a busy fight.
      color: s.downed ? DOWNED_COLOR_INT : 0xffffff,
      labelColor: s.downed ? DOWNED_LABEL_COLOR : 0xffffff,
      label: s.downed ? `${SELF_LABEL} DOWN` : SELF_LABEL,
      radius: SELF_RADIUS * swell,
      width: 3,
      alpha: 0.95,
      reticle: true,
      innerRadius: SELF_INNER_RADIUS * swell,
      innerColor: s.downed ? DOWNED_COLOR_INT : slotColor,
      cross: s.downed,
    }
  }
  return {
    color: s.downed ? DOWNED_COLOR_INT : slotColor,
    labelColor: s.downed ? DOWNED_LABEL_COLOR : slotColor,
    label: s.downed ? `${playerLabel(s.slot)} DOWN` : playerLabel(s.slot),
    radius: MATE_RADIUS,
    width: 2.5,
    // A downed teammate is an emergency, so that ring alone is allowed to be
    // as loud as yours; an upright one stays quiet.
    alpha: s.downed ? 0.95 : 0.7,
    reticle: false,
    innerRadius: 0,
    innerColor: slotColor,
    cross: s.downed,
  }
}

/** The four cardinal tick marks of the local player's reticle, as world-pixel
 * segments around a centre. Cardinal (not diagonal) so they read as a compass
 * rose rather than as sparkle, and so they survive the ground squash legibly. */
export const reticleTicks = (
  cx: number,
  cy: number,
  radius: number,
  tilePx: number,
): { x1: number; y1: number; x2: number; y2: number }[] => {
  const rx = radius * tilePx
  const ry = rx * GROUND_SQUASH
  const len = tilePx * 0.14
  return [
    { x1: cx - rx, y1: cy, x2: cx - rx - len, y2: cy },
    { x1: cx + rx, y1: cy, x2: cx + rx + len, y2: cy },
    { x1: cx, y1: cy - ry, x2: cx, y2: cy - ry - len },
    { x1: cx, y1: cy + ry, x2: cx, y2: cy + ry + len },
  ]
}

/** Draw order for the markers: downed LAST so the emergency paints on top, then
 * the local player, then teammates by slot (stable — never reorders per frame). */
export const markerOrder = <T extends MarkerSubject>(subjects: readonly T[]): T[] =>
  subjects
    .slice()
    .sort((a, b) => Number(a.downed) - Number(b.downed) || Number(a.self) - Number(b.self) || a.slot - b.slot)
