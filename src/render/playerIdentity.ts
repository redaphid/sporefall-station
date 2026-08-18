/**
 * WHO IS WHO — the single source of truth for a player's identity colour and
 * label, shared by every surface that has to answer "which one is that?":
 * the world-space feet rings (playerMarkerLayer.ts), the off-screen teammate
 * arrows and the on-screen name tags (ui/locatorModel.ts, ui/screens.ts).
 *
 * It lives in `src/render/` rather than `src/ui/` because `ui` already imports
 * `render` (locatorModel pulls TILE_PX and the camera clamp from here) and the
 * reverse would close an import cycle.
 *
 * ── COLOUR IS NEVER THE ONLY CUE ────────────────────────────────────────────
 *
 * ~1 man in 12 has a colour-vision deficiency, and this game is played on
 * phones, in a lit room, glanced at mid-fight. So every marker built on this
 * module pairs its hue with a SHAPE or a GLYPH that carries the same
 * information on its own:
 *
 *   - teammates  → slot colour + the numeral `P2`…`P8`   (the numeral alone is
 *                  sufficient; the colour is the fast path, not the only path)
 *   - you        → a categorically DIFFERENT marker form (double ring, cardinal
 *                  ticks, a breathing pulse) + the word `YOU`
 *   - downed     → red + an X struck through the ring    (shape, not just hue)
 *
 * Derivation is from the player SLOT, which is already deterministic and
 * already on the wire — never from a random draw or the clock.
 */

/** Stable per-slot identity hues; a player keeps the same one all run.
 * Eight distinct hues so a full 8-player run (slots 0..7) never collides. */
export const SLOT_COLORS = [
  0x5aa9ff, 0x7fd17f, 0xffd76a, 0xd17fd1, 0xff9a5a, 0x6ad1c8, 0xc98cff, 0xff7fa8,
] as const

/** Downed players override their slot hue with a loud red — rush to revive. */
export const DOWNED_COLOR_INT = 0xff4d4d

/** `#rrggbb` for a 24-bit colour, for the DOM surfaces (CSS can't take an int). */
export const hexColor = (c: number): string => `#${c.toString(16).padStart(6, '0')}`

/** Slot index folded into the palette. Negative and out-of-range slots wrap
 * rather than throwing — a marker must never be the thing that crashes a run. */
export const slotIndex = (playerId: number): number => {
  const n = SLOT_COLORS.length
  return (((playerId | 0) % n) + n) % n
}

/** Stable identity colour (0xRRGGBB) for a player slot. */
export const playerColorInt = (playerId: number): number => SLOT_COLORS[slotIndex(playerId)]

/** Stable identity colour as CSS `#rrggbb`, for DOM markers. */
export const playerColor = (playerId: number): string => hexColor(playerColorInt(playerId))

/** Downed red as CSS, for DOM markers. */
export const DOWNED_COLOR = hexColor(DOWNED_COLOR_INT)

/** Short stable label for a player slot: P1, P2, … (1-based, human-facing).
 * Deliberately NOT wrapped like the colour is: past the palette two players
 * share a hue, and the numeral is then the only thing telling them apart, so it
 * must stay unique. */
export const playerLabel = (playerId: number): string => `P${(playerId | 0) + 1}`

/** What the LOCAL player's own marker says. Deliberately not `P1`: the whole
 * point is that your marker is not one of the numbered ones you must read. */
export const SELF_LABEL = 'YOU'
