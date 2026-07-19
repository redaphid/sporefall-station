import { describe, expect, it } from 'vitest'
import { Tile } from '../game/levelgen/level'
import { coordHash, pickTileVariant, planTileOverlays, type OverlayLevelView } from './tileSelect'

// ---------------------------------------------------------------------------
// pickTileVariant — variant selection, including macro slice-coherence.

describe('pickTileVariant (no macro — the historical pure-hash pick)', () => {
  it('matches the pre-macro formula exactly (city regression: bit-identical ground)', () => {
    for (let tx = -3; tx < 9; tx++) {
      for (let ty = -3; ty < 9; ty++) {
        const h = coordHash(tx, ty)
        for (const n of [1, 3, 4, 7, 8]) {
          expect(pickTileVariant(n, undefined, tx, ty, h)).toBe((h >>> 2) % n)
        }
      }
    }
  })

  it('an empty pool degrades to index 0 (caller guards, but never NaN/negative)', () => {
    expect(pickTileVariant(0, undefined, 5, 5, coordHash(5, 5))).toBe(0)
    expect(pickTileVariant(0, 2, 5, 5, coordHash(5, 5))).toBe(0)
  })
})

describe('pickTileVariant (macro slicing)', () => {
  it('adjacent tiles inside one macro cell get the row-major quadrants in order', () => {
    // macro 2, one 2×2 macro sliced into pool [0..3]
    expect(pickTileVariant(4, 2, 0, 0, coordHash(0, 0))).toBe(0)
    expect(pickTileVariant(4, 2, 1, 0, coordHash(1, 0))).toBe(1)
    expect(pickTileVariant(4, 2, 0, 1, coordHash(0, 1))).toBe(2)
    expect(pickTileVariant(4, 2, 1, 1, coordHash(1, 1))).toBe(3)
  })

  it('the pattern repeats with period N (the next cell starts at quadrant 0 again)', () => {
    expect(pickTileVariant(4, 2, 2, 0, coordHash(2, 0))).toBe(0)
    expect(pickTileVariant(4, 2, 0, 2, coordHash(0, 2))).toBe(0)
    expect(pickTileVariant(4, 2, 3, 3, coordHash(3, 3))).toBe(3)
  })

  it('with several macros, all N² slices of one cell come from the SAME macro', () => {
    // pool of 8 = two 2×2 macros
    for (let cx = -4; cx < 5; cx++) {
      for (let cy = -4; cy < 5; cy++) {
        const picks = [
          pickTileVariant(8, 2, cx * 2, cy * 2, coordHash(cx * 2, cy * 2)),
          pickTileVariant(8, 2, cx * 2 + 1, cy * 2, coordHash(cx * 2 + 1, cy * 2)),
          pickTileVariant(8, 2, cx * 2, cy * 2 + 1, coordHash(cx * 2, cy * 2 + 1)),
          pickTileVariant(8, 2, cx * 2 + 1, cy * 2 + 1, coordHash(cx * 2 + 1, cy * 2 + 1)),
        ]
        const macroOf = picks.map((p) => Math.floor(p / 4))
        expect(new Set(macroOf).size, `cell ${cx},${cy} mixes macros`).toBe(1)
        expect(picks.map((p) => p % 4)).toEqual([0, 1, 2, 3])
      }
    }
  })

  it('both macros actually appear across cells (the cell hash varies)', () => {
    const macros = new Set<number>()
    for (let cx = 0; cx < 8; cx++)
      for (let cy = 0; cy < 8; cy++)
        macros.add(Math.floor(pickTileVariant(8, 2, cx * 2, cy * 2, coordHash(cx * 2, cy * 2)) / 4))
    expect(macros).toEqual(new Set([0, 1]))
  })

  it('negative coordinates stay coherent (no negative-modulo seam at the origin)', () => {
    // cell covering tx,ty in [-2,-1]
    expect(pickTileVariant(4, 2, -2, -2, coordHash(-2, -2))).toBe(0)
    expect(pickTileVariant(4, 2, -1, -2, coordHash(-1, -2))).toBe(1)
    expect(pickTileVariant(4, 2, -2, -1, coordHash(-2, -1))).toBe(2)
    expect(pickTileVariant(4, 2, -1, -1, coordHash(-1, -1))).toBe(3)
  })

  it('a pool with a partial trailing macro ignores the leftover slices', () => {
    // 7 slices with macro 2 → only macro 0 (slices 0..3) is complete
    for (let tx = 0; tx < 10; tx++)
      for (let ty = 0; ty < 10; ty++) {
        const p = pickTileVariant(7, 2, tx, ty, coordHash(tx, ty))
        expect(p).toBeLessThan(4)
      }
  })

  it('a pool smaller than one macro falls back to the hash pick', () => {
    const h = coordHash(3, 4)
    expect(pickTileVariant(3, 2, 3, 4, h)).toBe((h >>> 2) % 3)
  })
})

// ---------------------------------------------------------------------------
// planTileOverlays — context-keyed moss placement.

const makeLevel = (
  w: number,
  h: number,
  fill: (x: number, y: number) => number,
  doors: { x: number; y: number }[] = [],
): OverlayLevelView => {
  const tiles = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles[y * w + x] = fill(x, y)
  return { w, h, tiles, buildings: doors.length > 0 ? [{ doors }] : [] }
}

/** Floor room with a wall ring border. */
const walledRoom = (w = 14, h = 14): OverlayLevelView =>
  makeLevel(w, h, (x, y) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? Tile.Wall : Tile.Floor))

describe('planTileOverlays', () => {
  it('an empty pool plans nothing', () => {
    expect(planTileOverlays(walledRoom(), Tile.Floor, 0)).toEqual([])
  })

  it('is deterministic: same grid → identical plan', () => {
    const level = walledRoom()
    expect(planTileOverlays(level, Tile.Floor, 4, 2)).toEqual(planTileOverlays(level, Tile.Floor, 4, 2))
  })

  it('every placement is on-target, in-pool, and a valid rotation', () => {
    const level = walledRoom(20, 16)
    for (const p of planTileOverlays(level, Tile.Floor, 5, 2)) {
      expect(Number(level.tiles[p.ty * level.w + p.tx])).toBe(Tile.Floor)
      expect(p.idx).toBeGreaterThanOrEqual(0)
      expect(p.idx).toBeLessThan(5)
      expect([0, 1, 2, 3]).toContain(p.rot)
    }
  })

  it('overgrowth CLUSTERS at wall bases: wall-adjacent tiles are far mossier than open floor', () => {
    const level = walledRoom(30, 30)
    const plan = planTileOverlays(level, Tile.Floor, 4) // no macro, no doors → open floor only has the rare-scatter gate
    const counts = new Map<number, number>()
    for (const p of plan) counts.set(p.ty * level.w + p.tx, (counts.get(p.ty * level.w + p.tx) ?? 0) + 1)
    let edgeTiles = 0
    let edgeWithDecal = 0
    let openTiles = 0
    let openWithDecal = 0
    for (let y = 1; y < 29; y++)
      for (let x = 1; x < 29; x++) {
        const nearWall = x === 1 || y === 1 || x === 28 || y === 28
        const has = counts.has(y * 30 + x)
        if (nearWall) {
          edgeTiles++
          if (has) edgeWithDecal++
        } else {
          openTiles++
          if (has) openWithDecal++
        }
      }
    expect(edgeWithDecal / edgeTiles).toBeGreaterThan(0.4)
    expect(openWithDecal / openTiles).toBeLessThan(0.15)
    expect(edgeWithDecal / edgeTiles).toBeGreaterThan(3 * (openWithDecal / openTiles))
  })

  it('wall-edge decals rotate TOWARD the wall that earned them', () => {
    // A tall strip: every floor tile has a wall ONLY to its east. Wall-edge
    // placements must face east (rot 1); the only other legal source is the
    // rare open scatter (fires only when no edge decal landed), so east-facing
    // decals dominate overwhelmingly.
    const level = makeLevel(3, 120, (x) => (x === 2 ? Tile.Wall : x === 1 ? Tile.Floor : Tile.Grass))
    const plan = planTileOverlays(level, Tile.Floor, 3)
    expect(plan.length).toBeGreaterThan(40)
    const east = plan.filter((p) => p.rot === 1).length
    expect(east / plan.length).toBeGreaterThan(0.9)
  })

  it('never stacks more than 2 decals on one tile, even in a 3-wall alcove', () => {
    // 3×3 with floor centre, walls N/E/W (alcove open to the south)
    const level = makeLevel(3, 3, (x, y) => (x === 1 && y === 1 ? Tile.Floor : y === 2 ? Tile.Grass : Tile.Wall))
    const plan = planTileOverlays(level, Tile.Floor, 4)
    expect(plan.length).toBeLessThanOrEqual(2)
  })

  it('door thresholds gather moss: tiles beside a door are mossier than matched open floor', () => {
    // Open floor with a row of doors through the middle (no walls, so the
    // door rule is the only strong context in play).
    const doors = Array.from({ length: 12 }, (_, i) => ({ x: 3 + i * 5, y: 4 }))
    const level = makeLevel(64, 9, () => Tile.Floor, doors)
    const plan = planTileOverlays(level, Tile.Floor, 4)
    const has = new Set(plan.map((p) => p.ty * level.w + p.tx))
    let doorAdj = 0
    let doorAdjWith = 0
    let far = 0
    let farWith = 0
    for (let y = 0; y < 9; y++)
      for (let x = 0; x < 64; x++) {
        const nearDoor = doors.some((d) => Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1)
        if (nearDoor) {
          doorAdj++
          if (has.has(y * 64 + x)) doorAdjWith++
        } else if (Math.abs(y - 4) >= 3) {
          far++
          if (has.has(y * 64 + x)) farWith++
        }
      }
    expect(doorAdj).toBeGreaterThan(0)
    expect(doorAdjWith / doorAdj).toBeGreaterThan(0.5)
    expect(farWith / far).toBeLessThan(0.15)
  })

  it('macro seams grow moss lines: seam-edge tiles beat open floor, and seam decals face the seam', () => {
    const level = makeLevel(40, 40, () => Tile.Floor) // no walls, no doors
    const plan = planTileOverlays(level, Tile.Floor, 4, 2)
    let seam = 0
    let seamWith = 0
    let open = 0
    let openWith = 0
    const has = new Map(plan.map((p) => [p.ty * level.w + p.tx, p]))
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) {
        const onSeam = y % 2 === 0 || x % 2 === 0
        if (onSeam) {
          seam++
          if (has.has(y * 40 + x)) seamWith++
        } else {
          open++
          if (has.has(y * 40 + x)) openWith++
        }
      }
    expect(seamWith / seam).toBeGreaterThan(openWith / open)
    // Seam decals face the seam: every placement on a NON-seam tile can only
    // be the rare open scatter, so seam-facing rotations dominate on seam tiles.
    const onSeamPlacements = plan.filter((p) => p.ty % 2 === 0 || p.tx % 2 === 0)
    const facing = onSeamPlacements.filter((p) => (p.rot === 0 && p.ty % 2 === 0) || (p.rot === 3 && p.tx % 2 === 0))
    expect(facing.length / onSeamPlacements.length).toBeGreaterThan(0.7)
  })

  it('plans nothing for tiles of another surface', () => {
    const level = walledRoom()
    expect(planTileOverlays(level, Tile.Grass, 4)).toEqual([])
  })

  it('a 1×1 level is safe (out-of-bounds neighbors are not walls)', () => {
    const level = makeLevel(1, 1, () => Tile.Floor)
    const plan = planTileOverlays(level, Tile.Floor, 2)
    expect(plan.length).toBeLessThanOrEqual(1) // at most the rare open clump
  })
})
