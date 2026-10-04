import type { BiomeName, Level, ThemeName } from '../game/levelgen/level'
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

/** Multiplicative floor tint per city district: the Concourse is station
 * white gone yellow, the Moorings sit in teal mist, Still Row burns under
 * sodium and brass, the Culture Beds glow spore-olive. */
export const DISTRICT_TINT: Record<ThemeName, number> = {
  concourse: 0xf6eccc, // yellowed station white under old signage
  moorings: 0xc6e2e2, // teal swamp mist over the jetties
  stillworks: 0xf4d8b0, // brass and ember over the settling ponds
  culturebeds: 0xcfe8b4, // olive grow-light over the moss
}

/** Channel-wise multiply of two 0xRRGGBB tints. */
export const mulTint = (a: number, b: number): number => {
  const ch = (s: number): number => Math.round((((a >> s) & 0xff) * ((b >> s) & 0xff)) / 255)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** The tint the tile layer should wear: theme floor tint, graded by the
 * station biome or the city district. */
export const floorTintFor = (level: Level | undefined, themeTint: number): number => {
  const biome = level?.complex?.biome
  if (biome) return mulTint(themeTint, BIOME_TINT[biome])
  return level?.theme ? mulTint(themeTint, DISTRICT_TINT[level.theme]) : themeTint
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
