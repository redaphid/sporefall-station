import type { Rect } from './rooms'

export const Tile = {
  Street: 0,
  Sidewalk: 1,
  Floor: 2,
  Wall: 3,
  Grass: 4,
  Exit: 5,
} as const
export type TileId = (typeof Tile)[keyof typeof Tile]

export type BuildingRole = 'shop' | 'apartment' | 'office' | 'warehouse' | 'clinic'

/** Layout set-piece a building can carry (beyond a plain box of rooms). */
export type BuildingPoi = 'courtyard' | 'vault'

export interface Building {
  rect: Rect
  rooms: Rect[]
  /** All door tile positions (exterior + interior). */
  doors: { x: number; y: number }[]
  role: BuildingRole
  /** Optional set-piece tag for populate/missions and variety tests. */
  poi?: BuildingPoi
}

/** A floor's district flavour — drives density, footprints and role palette. */
export type ThemeName = 'downtown' | 'slums' | 'industrial' | 'park'

export interface Theme {
  name: ThemeName
  /** Lot subdivisions per axis (density): fewer = bigger blocks. */
  minLots: number
  maxLots: number
  /** Base probability a lot grows a building (vs open ground). */
  buildingChance: number
  /** Ground tile for open lots and setback yards. */
  yard: TileId
  /** Chance a large building is a ring around an open courtyard. */
  courtyardChance: number
  /** Chance a building's footprint shrinks + offsets inside its lot. */
  setbackChance: number
  /** Chance a large building hides a sealed vault room. */
  vaultChance: number
  /** Role palette (repeats bias the weighting). */
  roles: readonly BuildingRole[]
}

/**
 * District themes cycle by floor so consecutive floors read differently.
 * Index 0 (floor 1) is intentionally dense so early floors feel like a city.
 */
export const THEMES: readonly Theme[] = [
  {
    name: 'downtown',
    minLots: 3,
    maxLots: 4,
    buildingChance: 0.85,
    yard: Tile.Sidewalk,
    courtyardChance: 0.35,
    setbackChance: 0.15,
    vaultChance: 0.2,
    roles: ['office', 'office', 'shop', 'apartment'],
  },
  {
    name: 'slums',
    minLots: 4,
    maxLots: 5,
    buildingChance: 0.8,
    yard: Tile.Grass,
    courtyardChance: 0.05,
    setbackChance: 0.4,
    vaultChance: 0.05,
    roles: ['apartment', 'apartment', 'shop', 'warehouse'],
  },
  {
    name: 'industrial',
    minLots: 3,
    maxLots: 3,
    buildingChance: 0.82,
    yard: Tile.Sidewalk,
    courtyardChance: 0.45,
    setbackChance: 0.25,
    vaultChance: 0.15,
    roles: ['warehouse', 'warehouse', 'office', 'shop'],
  },
  {
    name: 'park',
    minLots: 4,
    maxLots: 5,
    buildingChance: 0.55,
    yard: Tile.Grass,
    courtyardChance: 0.3,
    setbackChance: 0.45,
    vaultChance: 0.05,
    roles: ['clinic', 'apartment', 'shop', 'clinic'],
  },
]

/** Deterministic theme for a floor (1-based); consecutive floors always differ. */
export const themeForFloor = (floor: number): Theme => THEMES[(floor - 1) % THEMES.length]

export interface Level {
  w: number
  h: number
  /** Visual tile layer, row-major. */
  tiles: Uint8Array
  /** Collision layer: 1 = solid. Derived from tiles (walls). */
  solid: Uint8Array
  buildings: Building[]
  /** Player spawn, tile-center world coords. */
  spawn: { x: number; y: number }
  /** Exit tile. */
  exit: { x: number; y: number }
  /** District theme this floor was generated with. */
  theme?: ThemeName
}

/** Mutable view over a tile buffer during generation. */
export class TileGrid {
  constructor(
    readonly w: number,
    readonly h: number,
    readonly tiles: Uint8Array,
  ) {}

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h
  }

  get(x: number, y: number): number {
    return this.inBounds(x, y) ? this.tiles[y * this.w + x] : Tile.Wall
  }

  set(x: number, y: number, t: TileId): void {
    if (this.inBounds(x, y)) this.tiles[y * this.w + x] = t
  }

  fillRect(x: number, y: number, w: number, h: number, t: TileId): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, t)
    }
  }
}

export const tileAt = (level: Level, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return Tile.Wall
  return level.tiles[y * level.w + x]
}

export const isSolidTile = (level: Level, x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return true
  return level.solid[y * level.w + x] === 1
}

/** FNV-1a over both layers — the cross-device determinism check. */
export const levelChecksum = (level: Level): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < level.tiles.length; i++) {
    h ^= level.tiles[i]
    h = Math.imul(h, 0x01000193)
    h ^= level.solid[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
