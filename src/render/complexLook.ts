import type { BiomeName, Level } from '../game/levelgen/level'
import type { SimEvent } from '../game/types'

/**
 * Presentation for indoor-complex floors (3+): a per-biome floor grade and the
 * lights-out darkness model. Pure (no pixi) so it is unit-testable; the
 * renderer only draws what these return.
 */

/** Multiplicative floor tint per biome — the "look" of each station ring. */
export const BIOME_TINT: Record<BiomeName, number> = {
  habitation: 0xf2ecde, // warm, lived-in
  flooded: 0xbfe0cf, // damp swamp-green cast
  reactor: 0xf0d2b4, // sodium-lamp amber
  overgrown: 0xc9e6b0, // spore-lit green
}

/** Channel-wise multiply of two 0xRRGGBB tints. */
export const mulTint = (a: number, b: number): number => {
  const ch = (s: number): number => Math.round((((a >> s) & 0xff) * ((b >> s) & 0xff)) / 255)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** The tint the tile layer should wear: theme floor tint, graded by biome. */
export const floorTintFor = (level: Level | undefined, themeTint: number): number => {
  const biome = level?.complex?.biome
  return biome ? mulTint(themeTint, BIOME_TINT[biome]) : themeTint
}

/** Darkness overlay alpha for a blacked-out wing. */
export const DARK_ALPHA = 0.62

export interface DarkWing {
  wing: number
  rect: { x: number; y: number; w: number; h: number }
  until: number
}

/** Fold one tick's events into the dark-wing state; expire it past `until`. */
export const updateDarkWing = (prev: DarkWing | null, events: readonly SimEvent[], tick: number): DarkWing | null => {
  let cur = prev
  for (const ev of events) {
    if (ev.type === 'lightsOut') cur = { wing: ev.wing, rect: { x: ev.x, y: ev.y, w: ev.w, h: ev.h }, until: ev.until }
    else if (ev.type === 'lightsOn' && cur?.wing === ev.wing) cur = null
  }
  if (cur && tick >= cur.until) cur = null
  return cur
}
