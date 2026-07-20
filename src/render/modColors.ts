// The mod-pickup diamond palette — the SINGLE SOURCE OF TRUTH mapping each
// weapon-mod TYPE to a unique, distinctive gem colour, so a kid can tell at a
// glance which mod a diamond is from across a room. Colour is a RENDER concern
// (it never crosses the wire and never touches the sim), so it lives here and is
// keyed off the mod id declared in `src/game/data/mods.ts`.
//
// Palette design: hues are spread around the wheel for maximum mutual
// separation (drawn from a curated glasbey-style distinct set), with a few
// SEMANTIC anchors so the elemental mods read intuitively — frost=cyan,
// incendiary=fire-orange, shock=electric-yellow, lifesteal=blood-maroon,
// explosive=red. Every colour is distinct from every other AND from the
// fallback (enforced by test in `modColors.test.ts`). Lightness is varied
// between neighbours so adjacent-hue pairs stay separable.

import { MODS } from '../game/data/mods'

/** Neutral slate used for any mod id with no explicit colour (a brand-new mod
 * added to the registry before its swatch is chosen). Deliberately a desaturated
 * grey so it (a) never collides with a real mod's saturated hue and (b) reads as
 * "unclassified" rather than masquerading as a specific mod. */
export const MOD_PICKUP_FALLBACK = 0x9aa0b0

/** mod id -> diamond fill colour (0xRRGGBB). One entry per mod in `MODS`. */
export const MOD_PICKUP_COLORS: Record<string, number> = {
  // ---- STAT ----------------------------------------------------------------
  overload: 0x4363d8, // blue      — big damage
  bulk: 0xbfef45, //     lime      — extra pellets
  rapid: 0x469990, //    teal      — fast fire
  heavy: 0x9a6324, //    brown     — heavy / rocky rounds (semantic)
  choke: 0x808000, //    olive     — tight spread
  velocity: 0x3cb44b, // green     — projectile speed
  glassCannon: 0x911eb4, // purple — arcane legendary (🔮)
  // ---- BEHAVIOR: elements (semantic anchors) -------------------------------
  frost: 0x42d4f4, //    cyan      — ice (semantic)
  incendiary: 0xf58231, // orange  — fire (semantic)
  shock: 0xffe119, //    yellow    — electricity (semantic)
  // ---- BEHAVIOR: bullet mechanics ------------------------------------------
  bounce: 0xaaffc3, //   mint      — ricochet
  pierce: 0x000075, //   navy      — punch-through
  homing: 0xdcbeff, //   lavender  — curve toward target
  explosive: 0xe6194b, // red      — blast (semantic)
  split: 0xffd8b1, //    apricot   — shards
  lifesteal: 0x800000, // maroon   — blood (semantic)
  // ---- TRIGGER -------------------------------------------------------------
  detonator: 0xf032e6, // magenta  — chain-explosion legendary
}

/** Pure mod-id -> colour. Returns the mod's unique gem colour, or the neutral
 * fallback for any id absent from the table (e.g. a newly-registered mod). */
export const modPickupColor = (id: string): number => MOD_PICKUP_COLORS[id] ?? MOD_PICKUP_FALLBACK

/** The set of registered mod ids the palette must cover — exported so a test can
 * assert full coverage without re-importing the sim registry there. */
export const modIds = (): string[] => Object.keys(MODS)
