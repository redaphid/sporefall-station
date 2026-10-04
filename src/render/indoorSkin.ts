/**
 * The indoor-complex look: which theme art a complex floor (floors 3+) draws
 * in place of the first biome's. The single home of the indoor keys. Pure (no
 * pixi), so every rule here is unit-testable against an authored level.
 *
 * Tiles: a complex floor's `Floor` draws as the `deck` skin, its interior
 * `Wall` as `bulkhead`, and a lone `Wall` standing in open ground as `pillar`.
 * Props: door/generator/barrel/bunk/crate/shelf draw their INDOOR_PROP_ART.
 * Every skin and prop falls back to today's art when a pack ships none
 * (ArtRegistry.tile / wallCap / entity).
 */

import { isWallTile, Tile, type Level } from '../game/levelgen/level'
import type { PROP_NAMES, TILE_NAMES } from './theme'

type TileName = (typeof TILE_NAMES)[number]
type PropName = (typeof PROP_NAMES)[number]

/** Whether a level draws the indoor look. */
export const isIndoorLevel = (level: Level): boolean => level.complex !== undefined

/** Plain tile name -> the skin it draws as on an indoor level. */
export const INDOOR_TILE_SKIN = { wall: 'bulkhead', floor: 'deck' } as const satisfies Partial<Record<TileName, TileName>>

/** The skin of a `Tile.Wall` with open ground on all four sides. */
export const INDOOR_PILLAR = 'pillar' satisfies TileName

/** A skin with no art in the pack tries this one next, before the plain tile. */
export const INDOOR_SKIN_FALLBACK: Readonly<Partial<Record<string, TileName>>> = { pillar: 'bulkhead' }

/** The `tile.<family>.cap` pair a skinned wall wears. */
export const INDOOR_CAP_FAMILY: Readonly<Partial<Record<string, TileName>>> = { bulkhead: 'bulkhead', pillar: 'bulkhead' }

const SKIN_BY_TILE: ReadonlyMap<number, TileName> = new Map([
  [Tile.Wall, INDOOR_TILE_SKIN.wall],
  [Tile.Floor, INDOOR_TILE_SKIN.floor],
])

/** Off-map counts as wall, as in wallCaps.ts: a wall on the map edge is part
 * of the boundary, never a free-standing pillar. */
const solidAt = (level: Level, x: number, y: number): boolean =>
  x < 0 || y < 0 || x >= level.w || y >= level.h || isWallTile(level.tiles[y * level.w + x])

/** The skin tile name the tile at (tx,ty) draws as, or undefined to draw the
 * plain tile (off indoor levels, off the map, and for unskinned tiles). */
export const indoorTileSkin = (level: Level, tx: number, ty: number): TileName | undefined => {
  if (!isIndoorLevel(level) || tx < 0 || ty < 0 || tx >= level.w || ty >= level.h) return undefined
  const tileId = level.tiles[ty * level.w + tx]
  if (
    tileId === Tile.Wall &&
    !solidAt(level, tx, ty - 1) &&
    !solidAt(level, tx + 1, ty) &&
    !solidAt(level, tx, ty + 1) &&
    !solidAt(level, tx - 1, ty)
  )
    return INDOOR_PILLAR
  return SKIN_BY_TILE.get(tileId)
}

/** Entity art key (EntityViews' artKey) -> the prop art it draws indoors. */
export const INDOOR_PROP_ART = {
  door: 'bulkhead-door',
  'door.open': 'bulkhead-door-open',
  'door.locked': 'bulkhead-door-locked',
  generator: 'generator',
  barrel: 'coolant-tank',
  bunk: 'cryo-bunk',
  crate: 'freight-case',
  shelf: 'parts-rack',
} as const satisfies Record<string, PropName>

const INDOOR_PREFIX = 'indoor:'

/** The art key an entity draws with: `indoor:<artKey>` on an indoor level for
 * a key with indoor art, else `artKey` unchanged. */
export const indoorArtKey = (artKey: string, indoor: boolean): string =>
  indoor && Object.hasOwn(INDOOR_PROP_ART, artKey) ? INDOOR_PREFIX + artKey : artKey

/** Split an `indoor:<artKey>` key into the plain key (the fallback) and the
 * indoor prop art; undefined for any other key. */
export const parseIndoorArtKey = (key: string): { base: string; prop: PropName } | undefined => {
  if (!key.startsWith(INDOOR_PREFIX)) return undefined
  const base = key.slice(INDOOR_PREFIX.length)
  return Object.hasOwn(INDOOR_PROP_ART, base) ? { base, prop: INDOOR_PROP_ART[base as keyof typeof INDOOR_PROP_ART] } : undefined
}
