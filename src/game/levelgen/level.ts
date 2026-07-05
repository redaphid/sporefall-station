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

export interface Building {
  rect: Rect
  rooms: Rect[]
  /** All door tile positions (exterior + interior). */
  doors: { x: number; y: number }[]
  role: BuildingRole
}

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
