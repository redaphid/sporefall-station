/**
 * Pure, deterministic tile-art selection: variant picking (including sliced
 * macro-tile coherence) and the context-keyed overlay-decal planner.
 *
 * Everything here is a pure function of the tile grid + integer coordinates —
 * no rng, no pixi — so ground art bakes byte-identically on every device and
 * every replay, and the rules are unit-testable without a renderer.
 */

import { isWallTile } from '../game/levelgen/level'

/** Deterministic 32-bit coordinate hash — variant/accent/decal selection must
 * be a pure function of (tx,ty) so every device (and every replay) bakes the
 * exact same ground. NOT the sim rng: this is render-only. */
export const coordHash = (tx: number, ty: number): number => {
  let h = Math.imul(tx ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(ty ^ 0xc2b2ae35, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  return h >>> 0
}

const mod = (v: number, m: number): number => ((v % m) + m) % m

/**
 * Index into a tile-variant pool for the tile at (tx,ty).
 *
 * Plain pools (no macro): the historical pure-hash pick — `(hash >>> 2) % n`
 * — kept bit-identical so existing themes (city) render exactly as before.
 *
 * Macro pools (`macro` = N ≥ 2): the pool is sliced from N×N-tile macro
 * images, row-major — variants [m*N² .. m*N²+N²-1] are macro m's slices. The
 * quadrant is chosen by POSITION (tx mod N, ty mod N) so adjacent slices land
 * adjacently and plate seams / large features span tiles coherently; which
 * macro fills an N×N cell is hashed per CELL, so different macro authorings
 * alternate across the floor and the visible repeat period becomes N tiles.
 */
export const pickTileVariant = (
  poolLen: number,
  macro: number | undefined,
  tx: number,
  ty: number,
  hash: number,
): number => {
  if (poolLen <= 0) return 0
  if (macro !== undefined && macro >= 2 && poolLen >= macro * macro) {
    const per = macro * macro
    const quadrant = mod(ty, macro) * macro + mod(tx, macro)
    const nMacros = Math.floor(poolLen / per)
    const cellHash = coordHash(Math.floor(tx / macro), Math.floor(ty / macro))
    const m = nMacros > 1 ? cellHash % nMacros : 0
    return m * per + quadrant
  }
  return (hash >>> 2) % poolLen
}

// ---------------------------------------------------------------------------
// Context-keyed overlay decals ("moss as placement, not texture").
//
// Overgrowth in the fiction pools where structure lets it: at wall bases,
// in room corners (two wall sides → two overlapping decals), across door
// thresholds, along plate seams — with only a rare freestanding clump in open
// floor. Decal art comes from the theme's `tile.<name>.overlay` pool: RGBA
// clumps authored with their mass biased toward the TOP edge of the tile; the
// renderer rotates them toward whatever context edge earned them.

/** rot is quarter-turns clockwise: 0 = decal mass at the tile's north edge,
 * 1 = east, 2 = south, 3 = west. */
export interface OverlayPlacement {
  tx: number
  ty: number
  rot: 0 | 1 | 2 | 3
  /** Index into the surface's overlay pool. */
  idx: number
}

/** The slice of Level the planner reads — structural so tests can hand-build
 * tiny worlds without the full levelgen. */
export interface OverlayLevelView {
  w: number
  h: number
  tiles: ArrayLike<number>
  buildings?: readonly { doors: readonly { x: number; y: number }[] }[]
}

/** Max decals a single tile may carry (a 3-wall alcove would otherwise stack
 * three and read as a solid green square). */
const MAX_PER_TILE = 2

// Density gates, in percent. Tuned so overgrowth clearly clusters at
// structure (walls/doors) while open floor stays quiet.
const WALL_EDGE_PCT = 62
const DOOR_PCT = 85
const SEAM_PCT = 18
const OPEN_PCT = 5

const SIDES: readonly { rot: 0 | 1 | 2 | 3; dx: number; dy: number; shift: number }[] = [
  { rot: 0, dx: 0, dy: -1, shift: 0 }, // wall to the north
  { rot: 1, dx: 1, dy: 0, shift: 7 }, // east
  { rot: 2, dx: 0, dy: 1, shift: 14 }, // south
  { rot: 3, dx: -1, dy: 0, shift: 21 }, // west
]

/**
 * Plan every overlay decal for one surface (`targetTileId`) across a level.
 * Pure function of the grid: same level + pool size + macro → same plan, on
 * every device. `poolSize` is the number of decals the theme shipped for this
 * surface (0 → empty plan).
 */
export const planTileOverlays = (
  level: OverlayLevelView,
  targetTileId: number,
  poolSize: number,
  macro?: number,
): OverlayPlacement[] => {
  if (poolSize <= 0) return []
  const { w, h, tiles } = level
  const tileAt = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < w && y < h ? Number(tiles[y * w + x]) : -1

  // Door tiles (building doors sit in wall lines; their thresholds are the
  // walkable tiles beside them). Chebyshev-1 adjacency marks thresholds.
  const doorSet = new Set<number>()
  for (const b of level.buildings ?? []) for (const d of b.doors) doorSet.add(d.y * w + d.x)
  const nearDoor = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && doorSet.has(ny * w + nx)) return true
      }
    return false
  }

  const out: OverlayPlacement[] = []
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (tileAt(tx, ty) !== targetTileId) continue
      // Decorrelated from the variant/accent hash so decal placement doesn't
      // echo the variant checkerboard.
      const oh = coordHash(tx ^ 0x55aa, ty ^ 0x33cc)
      let placed = 0
      const place = (rot: 0 | 1 | 2 | 3, salt: number): void => {
        if (placed >= MAX_PER_TILE) return
        out.push({ tx, ty, rot, idx: coordHash(oh ^ salt, salt) % poolSize })
        placed++
      }
      // 1. Overgrowth pools at wall bases (and corners, via two sides).
      for (const s of SIDES) {
        if (isWallTile(tileAt(tx + s.dx, ty + s.dy)) && ((oh >>> s.shift) & 0x7f) % 100 < WALL_EDGE_PCT) {
          place(s.rot, 0x11 + s.shift)
        }
      }
      // 2. Worn, mossy door thresholds.
      if (placed === 0 && nearDoor(tx, ty) && ((oh >>> 9) & 0x7f) % 100 < DOOR_PCT) {
        place((((oh >>> 3) & 3) as 0 | 1 | 2 | 3), 0x77)
      }
      // 3. Moss creeping along plate seams (macro-cell borders — the art
      // carries a seam line around each macro's edge).
      if (placed === 0 && macro !== undefined && macro >= 2) {
        if (mod(ty, macro) === 0 && ((oh >>> 11) & 0x7f) % 100 < SEAM_PCT) place(0, 0x2b)
        else if (mod(tx, macro) === 0 && ((oh >>> 18) & 0x7f) % 100 < SEAM_PCT) place(3, 0x2d)
      }
      // 4. Rare freestanding clump so open floor isn't sterile.
      if (placed === 0 && ((oh >>> 25) & 0x7f) % 100 < OPEN_PCT) {
        place((((oh >>> 13) & 3) as 0 | 1 | 2 | 3), 0x5e)
      }
    }
  }
  return out
}
