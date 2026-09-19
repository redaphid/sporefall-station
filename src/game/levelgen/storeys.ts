import type { Rng } from '../rng'
import type { ComplexMeta } from './complex'
import {
  isFloorTile,
  isWallTile,
  STOREY_GUTTER,
  STOREY_SIZE,
  STOREY_STRIDE,
  Tile,
  type Building,
  type Level,
  type StairDir,
  type StairLink,
  type Storey,
  type TileId,
} from './level'

/**
 * STOREYS — upper floors that stand on the structure below them
 * (docs/design/stairs-and-storeys.md §2-§3, Phase 1).
 *
 * The owner's rule: "floors above must make sense given the supporting
 * structure below. But towers are fine." Concretely, an upper storey is only
 * allowed where a wall below can carry it:
 *
 *   F  walkable tiles of the chosen room (ground storey)
 *   H  = dilate(F, 1)             the room plus its enclosing walls — its hull
 *   B  = H ∩ wall-family          the bearing walls (outer, partitions, poché)
 *   D  = Chebyshev distance to B  (two-pass chamfer)
 *   C  = erode(H, e) − dilate(courts, 1)   the candidate slab, setback e
 *   prune to a fixed point:  D > SPAN anywhere  → no slab (unsupported span)
 *                            D > N on the edge  → no wall (walls stand on walls)
 *   keep the largest component that fits a 5x5; its edge is the upper wall.
 *
 * Every upper wall therefore stands within N tiles of a wall below, no slab
 * spans more than SPAN tiles, and nothing hangs over an open-sky court. Phase 1
 * builds ONE loft over one tower or large room per complex floor, reached by one
 * stair pair, and holds loot only.
 *
 * The atlas (level.ts STOREY_*): the loft is laid into slot 1 of the same Level
 * grid (x 80..143) behind a 16-tile Hull gutter, so a storey is a pure function
 * of position and nothing in the sim needs a storey field.
 *
 * Determinism: this stage draws only from its own `rng.fork('storeys')` forks
 * and runs after `carveComplex`, so the ground storey's streams never move. The
 * ground tiles change only at the stair shaft (the StairUp tile and, where a
 * room corner is used, its niche walls).
 */

/** Longest unsupported slab: every walkable upper tile is at most this far
 * (Chebyshev) from a bearing wall below. */
export const SPAN = 6
/** An upper wall must stand on, or within this many tiles of, a wall below. */
export const BEAR_N = 1
/** A kept upper component must contain a MIN_SQUARE x MIN_SQUARE block (a 3x3
 * room plus its walls). */
export const MIN_SQUARE = 5
/** A non-tower room qualifies for a loft when its main rect is at least this
 * big on both axes. */
export const LOFT_MIN_ROOM = 7
/** Chance an interior partition copied up from below is dropped to merge rooms. */
export const MERGE_P = 0.35
/** Stair clearance: spawn, exit and other stairs keep at least this Chebyshev
 * distance from a stair tile and its landing. */
export const STAIR_KEEP_OFF = 3

const S = STOREY_SIZE
const N8 = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const
const N4 = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const

export const DIR_VEC: Record<StairDir, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
}
const DIRS: readonly StairDir[] = ['n', 'e', 's', 'w']

/** A local 64x64 view of one storey slot: `get` answers Hull out of bounds. */
export type TileView = (x: number, y: number) => number

const inS = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < S && y < S

export const dilate8 = (m: Uint8Array): Uint8Array => {
  const out = new Uint8Array(S * S)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (!m[y * S + x]) continue
      out[y * S + x] = 1
      for (const [dx, dy] of N8) if (inS(x + dx, y + dy)) out[(y + dy) * S + x + dx] = 1
    }
  return out
}

export const erode8 = (m: Uint8Array, times: number): Uint8Array => {
  let cur = m
  for (let i = 0; i < times; i++) {
    const out = new Uint8Array(S * S)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        if (!cur[y * S + x]) continue
        let keep = true
        for (const [dx, dy] of N8) {
          if (!inS(x + dx, y + dy) || !cur[(y + dy) * S + x + dx]) {
            keep = false
            break
          }
        }
        if (keep) out[y * S + x] = 1
      }
    cur = out
  }
  return cur === m ? m.slice() : cur
}

/** Chebyshev distance to the nearest set tile of `b` (two-pass chamfer,
 * O(64²)). Tiles with no bearing anywhere get a large value. */
export const chebDistance = (b: Uint8Array): Uint16Array => {
  const INF = 0xffff
  const d = new Uint16Array(S * S).fill(INF)
  for (let i = 0; i < S * S; i++) if (b[i]) d[i] = 0
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x
      if (d[i] === 0) continue
      let v = d[i]
      if (x > 0) v = Math.min(v, d[i - 1] + 1)
      if (y > 0) {
        v = Math.min(v, d[i - S] + 1)
        if (x > 0) v = Math.min(v, d[i - S - 1] + 1)
        if (x < S - 1) v = Math.min(v, d[i - S + 1] + 1)
      }
      d[i] = Math.min(v, INF)
    }
  for (let y = S - 1; y >= 0; y--)
    for (let x = S - 1; x >= 0; x--) {
      const i = y * S + x
      if (d[i] === 0) continue
      let v = d[i]
      if (x < S - 1) v = Math.min(v, d[i + 1] + 1)
      if (y < S - 1) {
        v = Math.min(v, d[i + S] + 1)
        if (x < S - 1) v = Math.min(v, d[i + S + 1] + 1)
        if (x > 0) v = Math.min(v, d[i + S - 1] + 1)
      }
      d[i] = Math.min(v, INF)
    }
  return d
}

/** Does mask `m` contain a k x k all-set block? (Summed-area table.) */
export const fitsSquare = (m: Uint8Array, k: number): boolean => {
  const W = S + 1
  const sat = new Int32Array(W * W)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++)
      sat[(y + 1) * W + x + 1] = m[y * S + x] + sat[y * W + x + 1] + sat[(y + 1) * W + x] - sat[y * W + x]
  for (let y = k; y <= S; y++)
    for (let x = k; x <= S; x++) {
      const sum = sat[y * W + x] - sat[(y - k) * W + x] - sat[y * W + x - k] + sat[(y - k) * W + x - k]
      if (sum === k * k) return true
    }
  return false
}

/** 4-connected components of `m`, each as a sorted tile-index list, ordered
 * largest first with ties broken by the top-left tile (deterministic). */
export const components4 = (m: Uint8Array): number[][] => {
  const seen = new Uint8Array(S * S)
  const out: number[][] = []
  for (let i = 0; i < S * S; i++) {
    if (!m[i] || seen[i]) continue
    const comp: number[] = []
    const stack = [i]
    seen[i] = 1
    while (stack.length > 0) {
      const k = stack.pop()!
      comp.push(k)
      const x = k % S
      const y = (k - x) / S
      for (const [dx, dy] of N4) {
        const nx = x + dx
        const ny = y + dy
        if (!inS(nx, ny)) continue
        const nk = ny * S + nx
        if (!m[nk] || seen[nk]) continue
        seen[nk] = 1
        stack.push(nk)
      }
    }
    comp.sort((a, b) => a - b)
    out.push(comp)
  }
  out.sort((a, b) => b.length - a.length || a[0] - b[0])
  return out
}

/** The structural masks of the storey an upper storey bears on. */
export interface BearingMasks {
  /** The hull: walkable area plus its enclosing walls. */
  H: Uint8Array
  /** Bearing walls (wall-family tiles of H, courts excluded). */
  B: Uint8Array
  /** Chebyshev distance to B. */
  D: Uint16Array
}

/** H, B and D over the walkable seed `F` of the storey below. */
export const bearingMasks = (below: TileView, F: Uint8Array, courts: Uint8Array): BearingMasks => {
  const H = dilate8(F)
  const B = new Uint8Array(S * S)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x
      if (H[i] && !courts[i] && isWallTile(below(x, y))) B[i] = 1
    }
  return { H, B, D: chebDistance(B) }
}

/**
 * The structural rule (§2 steps 5-7): the slab an upper storey may occupy over
 * walkable seed `F`, with setback `e`. Returns the kept component as a mask
 * (walls included — its 8-edge is where the upper walls go), or null when the
 * rule prunes everything. Pure; never throws on degenerate input.
 */
export const planSlab = (m: BearingMasks, courts: Uint8Array, e: number): Uint8Array | null => {
  const C = erode8(m.H, e)
  const courtHalo = dilate8(courts)
  for (let i = 0; i < S * S; i++) if (courtHalo[i]) C[i] = 0
  // Bearing prune to a fixed point. The edge test is 8-neighbour (stricter
  // than the spec's 4) so EVERY tile that becomes an upper wall — inner
  // corners included — provably stands within BEAR_N of a wall below.
  for (;;) {
    let changed = false
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x
        if (!C[i]) continue
        if (m.D[i] > SPAN) {
          C[i] = 0
          changed = true
          continue
        }
        if (m.D[i] <= BEAR_N) continue
        for (const [dx, dy] of N8) {
          if (!inS(x + dx, y + dy) || !C[(y + dy) * S + x + dx]) {
            C[i] = 0
            changed = true
            break
          }
        }
      }
    if (!changed) break
  }
  for (const comp of components4(C)) {
    const mask = new Uint8Array(S * S)
    for (const k of comp) mask[k] = 1
    if (fitsSquare(mask, MIN_SQUARE)) return mask
  }
  return null
}

/** Split a slab into its upper walls (tiles with an 8-neighbour outside) and
 * interior. */
export const slabWalls = (C: Uint8Array): { W: Uint8Array; I: Uint8Array } => {
  const W = new Uint8Array(S * S)
  const I = new Uint8Array(S * S)
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x
      if (!C[i]) continue
      let edge = false
      for (const [dx, dy] of N8) {
        if (!inS(x + dx, y + dy) || !C[(y + dy) * S + x + dx]) {
          edge = true
          break
        }
      }
      if (edge) W[i] = 1
      else I[i] = 1
    }
  return { W, I }
}

/** One stair shaft in LOCAL storey coords: `p` is the stair tile (same on both
 * storeys), `dir` its open side, `carveBelow`/`carveAbove` the niche tiles that
 * must be turned to wall on each storey. */
export interface ShaftPlan {
  p: { x: number; y: number }
  dir: StairDir
  carveBelow: { x: number; y: number }[]
  carveAbove: { x: number; y: number }[]
  /** 0: the niche was already wall below (poché); higher = more carving. */
  cost: number
}

/** The six clearance tiles around a landing: the 3x3 centred on it, minus the
 * stair tile and the two niche sides beside it (§3.1). */
export const clearanceTiles = (p: { x: number; y: number }, dir: StairDir): { x: number; y: number }[] => {
  const d = DIR_VEC[dir]
  const L = { x: p.x + d.x, y: p.y + d.y }
  const out: { x: number; y: number }[] = []
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const t = { x: L.x + dx, y: L.y + dy }
      // The row through p (perpendicular to dir) is the stair and its niche.
      if ((t.x - p.x) * d.x + (t.y - p.y) * d.y === 0) continue
      out.push(t)
    }
  return out
}

/** The three niche tiles of a stair at `p` opening toward `dir`: its back and
 * both sides. */
export const nicheTiles = (p: { x: number; y: number }, dir: StairDir): { x: number; y: number }[] => {
  const d = DIR_VEC[dir]
  return [
    { x: p.x - d.x, y: p.y - d.y },
    { x: p.x + d.y, y: p.y + d.x },
    { x: p.x - d.y, y: p.y - d.x },
  ]
}

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

interface ShaftCtx {
  below: TileView
  above: TileView
  /** The room's walkable seed on the storey below. */
  F: Uint8Array
  D: Uint16Array
  /** Upper walkable tiles (deck) after carving. */
  upperDeck: Uint8Array
  /** Tiles no clearance may include: door tiles, vents. */
  forbidden: Set<number>
  /** Points the shaft keeps STAIR_KEEP_OFF from (spawn, exit). */
  keepOff: { x: number; y: number }[]
}

/** Every legal stair shaft for a loft, cheapest (least carving) first, then
 * row-major (deterministic). */
export const shaftCandidates = (ctx: ShaftCtx): ShaftPlan[] => {
  const out: ShaftPlan[] = []
  const wallBelow = (x: number, y: number): boolean => isWallTile(ctx.below(x, y))
  const upperOpen = (x: number, y: number): boolean => inS(x, y) && ctx.upperDeck[y * S + x] === 1
  for (let y = 1; y < S - 1; y++)
    for (let x = 1; x < S - 1; x++) {
      const p = { x, y }
      const pi = y * S + x
      const belowP = ctx.below(x, y)
      const pInRoom = ctx.F[pi] === 1 && isFloorTile(belowP) && belowP !== Tile.Hall && belowP !== Tile.Grate
      // p below: a wall of the room's ring (a niche cut into poché) or a floor tile of the room.
      const pOnRing = wallBelow(x, y) && ctx.D[pi] === 0
      if (!pInRoom && !pOnRing) continue
      for (const dir of DIRS) {
        const d = DIR_VEC[dir]
        const L = { x: x + d.x, y: y + d.y }
        if (!inS(L.x, L.y)) continue
        if (ctx.keepOff.some((k) => cheb(k, p) < STAIR_KEEP_OFF || cheb(k, L) < STAIR_KEEP_OFF)) continue
        // Landing + clearance: room deck below, upper deck above, nothing forbidden.
        const clear = clearanceTiles(p, dir)
        let ok = true
        for (const t of clear) {
          const tb = ctx.below(t.x, t.y)
          if (
            !inS(t.x, t.y) ||
            !ctx.F[t.y * S + t.x] ||
            !isFloorTile(tb) ||
            tb === Tile.Grate ||
            ctx.forbidden.has(t.y * S + t.x) ||
            !upperOpen(t.x, t.y)
          ) {
            ok = false
            break
          }
        }
        if (!ok) continue
        // Niche below: already wall, or room floor we may wall off (a free
        // corner of a large room). The back must be solid below if p is on the ring.
        const carveBelow: { x: number; y: number }[] = []
        for (const n of nicheTiles(p, dir)) {
          if (wallBelow(n.x, n.y)) continue
          const nb = ctx.below(n.x, n.y)
          if (!pInRoom || !ctx.F[n.y * S + n.x] || !isFloorTile(nb) || nb === Tile.Hall || ctx.forbidden.has(n.y * S + n.x)) {
            ok = false
            break
          }
          carveBelow.push(n)
        }
        if (!ok) continue
        // Above: the landing is upper deck, so p (its neighbour) is inside the
        // slab — deck, or a slab wall that bears (D ≤ N). The niche must be
        // wall/hull above, or deck we wall off where a wall below carries it.
        if (!upperOpen(x, y) && (!isWallTile(ctx.above(x, y)) || ctx.D[pi] > BEAR_N)) continue
        const carveAbove: { x: number; y: number }[] = []
        for (const n of nicheTiles(p, dir)) {
          if (!upperOpen(n.x, n.y)) continue
          if (ctx.D[n.y * S + n.x] > BEAR_N) {
            ok = false
            break
          }
          carveAbove.push(n)
        }
        if (!ok) continue
        out.push({ p, dir, carveBelow, carveAbove, cost: carveBelow.length + carveAbove.length })
      }
    }
  out.sort((a, b) => a.cost - b.cost || a.p.y * S + a.p.x - (b.p.y * S + b.p.x) || DIRS.indexOf(a.dir) - DIRS.indexOf(b.dir))
  return out
}

/** Options for the storey stage (tests use them; play uses the defaults). */
export interface StoreyOpts {
  /** Force a setback for non-tower rooms (default: drawn per floor, 0-1). */
  setback?: number
}

/** What the loft stage decided — for tests and debug renders. Not part of the
 * Level (which carries only `storeys` and `stairs`). */
export interface LoftReport {
  building: number
  tower: boolean
  setback: number
  shaft: ShaftPlan
}

/** Tile rects (inclusive) → mask of the open courts (wings that own no module). */
const courtMask = (level: Level): Uint8Array => {
  const m = new Uint8Array(S * S)
  for (const wg of level.complex?.wings ?? []) {
    if (wg.buildings.length > 0) continue
    for (let y = wg.rect.y; y < wg.rect.y + wg.rect.h; y++)
      for (let x = wg.rect.x; x < wg.rect.x + wg.rect.w; x++) if (inS(x, y) && !isWallTile(level.tiles[y * level.w + x])) m[y * S + x] = 1
  }
  return m
}

const mainRect = (b: Building): { x: number; y: number; w: number; h: number } => {
  let main = b.rooms[0] ?? b.rect
  for (const r of b.rooms) if (r.w * r.h > main.w * main.h) main = r
  return main
}

/** How many sides of the room's main rect have a wall ring 2+ thick (P7). */
const thickSides = (level: Level, b: Building): number => {
  const r = mainRect(b)
  const wall = (x: number, y: number): boolean => !inS(x, y) || isWallTile(level.tiles[y * level.w + x])
  const side = (len: number, at: (i: number, depth: number) => [number, number]): boolean => {
    for (let i = 0; i < len; i++) for (const depth of [1, 2]) if (!wall(...at(i, depth))) return false
    return true
  }
  let n = 0
  if (side(r.w, (i, k) => [r.x + i, r.y - k])) n++
  if (side(r.w, (i, k) => [r.x + i, r.y + r.h - 1 + k])) n++
  if (side(r.h, (i, k) => [r.x - k, r.y + i])) n++
  if (side(r.h, (i, k) => [r.x + r.w - 1 + k, r.y + i])) n++
  return n
}

/** The rooms a Phase 1 loft may stand over, in preference order: P9 towers,
 * then rooms of LOFT_MIN_ROOM² or more, thickest-walled and largest first.
 * Never the objective, the gatehouse booths, or the spawn/exit rooms. */
export const loftCandidates = (level: Level, meta?: Pick<ComplexMeta, 'towers' | 'booths'>): { building: number; tower: boolean }[] => {
  const skip = new Set<number>(meta?.booths ?? [])
  if (level.complex?.objective !== undefined) skip.add(level.complex.objective)
  const contains = (b: Building, x: number, y: number): boolean =>
    x >= b.rect.x && y >= b.rect.y && x < b.rect.x + b.rect.w && y < b.rect.y + b.rect.h
  level.buildings.forEach((b, i) => {
    if (contains(b, Math.floor(level.spawn.x), Math.floor(level.spawn.y)) || contains(b, level.exit.x, level.exit.y)) skip.add(i)
  })
  const towers = [...new Set((meta?.towers ?? []).map((t) => t.building))].filter((i) => i >= 0 && i < level.buildings.length && !skip.has(i)).sort((a, b) => a - b)
  const rooms = level.buildings
    .map((b, i) => ({ i, r: mainRect(b), thick: thickSides(level, b) }))
    .filter(({ i, r }) => !skip.has(i) && !towers.includes(i) && r.w >= LOFT_MIN_ROOM && r.h >= LOFT_MIN_ROOM)
    .sort((a, b) => b.thick - a.thick || b.r.w * b.r.h - a.r.w * a.r.h || a.i - b.i)
  return [...towers.map((i) => ({ building: i, tower: true })), ...rooms.map(({ i }) => ({ building: i, tower: false }))]
}

/** Most common floor tile of the room — the loft is decked to match. */
const roomDeck = (below: TileView, F: Uint8Array): TileId => {
  const count = new Map<number, number>()
  for (let i = 0; i < S * S; i++) {
    if (!F[i]) continue
    const t = below(i % S, (i / S) | 0)
    if (isFloorTile(t)) count.set(t, (count.get(t) ?? 0) + 1)
  }
  let best: number = Tile.Floor
  let n = -1
  for (const [t, c] of [...count.entries()].sort((a, b) => a[0] - b[0])) {
    if (c > n) {
      best = t
      n = c
    }
  }
  return (best === Tile.Grate || best === Tile.Bog ? Tile.Floor : best) as TileId
}

/** The walkable seed of a room: every non-wall tile of its rects. */
const roomSeed = (level: Level, b: Building): Uint8Array => {
  const F = new Uint8Array(S * S)
  for (const r of b.rooms)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) if (inS(x, y) && !isWallTile(level.tiles[y * level.w + x])) F[y * S + x] = 1
  return F
}

/**
 * Build the upper tiles of a loft over slab `C` (slot-local), copying bearing
 * partitions up and merging some away. Returns the 64x64 tile block, or null
 * when the interior can't be made connected.
 */
const carveLoftTiles = (C: Uint8Array, m: BearingMasks, deck: TileId, rng: Rng): { tiles: Uint8Array; deckMask: Uint8Array } | null => {
  const { W, I } = slabWalls(C)
  const tiles = new Uint8Array(S * S).fill(Tile.Hull)
  const deckMask = new Uint8Array(S * S)
  for (let i = 0; i < S * S; i++) {
    if (W[i]) tiles[i] = Tile.Wall
    else if (I[i]) {
      tiles[i] = deck
      deckMask[i] = 1
    }
  }
  // Partitions come from the storey below: B inside the interior, as segments.
  const part = new Uint8Array(S * S)
  for (let i = 0; i < S * S; i++) if (I[i] && m.B[i]) part[i] = 1
  const merge = rng.fork('merge')
  for (const seg of components4(part)) {
    if (merge.chance(MERGE_P)) continue // removing a wall above a wall is always sound
    for (const k of seg) {
      tiles[k] = Tile.Wall
      deckMask[k] = 0
    }
  }
  const comps = components4(deckMask)
  if (comps.length === 0) return null
  if (comps.length > 1) {
    // Connectivity repair within the storey: drop partition walls (always
    // sound) until the deck is one piece.
    for (let i = 0; i < S * S; i++) {
      if (I[i] && m.B[i]) {
        tiles[i] = deck
        deckMask[i] = 1
      }
    }
    if (components4(deckMask).length !== 1) return null
  }
  return { tiles, deckMask }
}

/**
 * Add Phase 1 storeys to a freshly carved complex level, in place: widen the
 * Level into a two-slot atlas and lay one loft plus one stair pair, or leave
 * the level untouched when the structural rule allows no loft anywhere.
 * Returns what it built (for tests), or null.
 */
export const addStoreys = (level: Level, rng: Rng, meta?: Pick<ComplexMeta, 'towers' | 'booths'>, opts: StoreyOpts = {}): LoftReport | null => {
  if (level.w !== S || level.h !== S || level.storeys) return null
  const below: TileView = (x, y) => (inS(x, y) ? level.tiles[y * S + x] : Tile.Hull)
  const courts = courtMask(level)
  const setbackRng = rng.fork('storey:1:setback')
  const drawn = opts.setback ?? setbackRng.int(0, 1)
  const forbidden = new Set<number>()
  for (const b of level.buildings) for (const d of b.doors) if (inS(d.x, d.y)) forbidden.add(d.y * S + d.x)
  for (const v of level.complex?.vents ?? []) if (inS(v.x, v.y)) forbidden.add(v.y * S + v.x)
  const keepOff = [
    { x: Math.floor(level.spawn.x), y: Math.floor(level.spawn.y) },
    { x: level.exit.x, y: level.exit.y },
  ]
  // Doors keep two tiles off the shaft, so a carved niche never plugs one.
  const doorNear = (p: { x: number; y: number }): boolean =>
    level.buildings.some((b) => b.doors.some((d) => cheb(d, p) <= 2))

  for (const cand of loftCandidates(level, meta)) {
    const b = level.buildings[cand.building]
    const F = roomSeed(level, b)
    const masks = bearingMasks(below, F, courts)
    const setbacks = cand.tower ? [0] : drawn === 0 ? [0] : [drawn, 0]
    for (const e of setbacks) {
      const C = planSlab(masks, courts, e)
      if (!C) continue
      const loft = carveLoftTiles(C, masks, roomDeck(below, F), rng.fork(`storey:1:${cand.building}:${e}`))
      if (!loft) continue
      const above: TileView = (x, y) => (inS(x, y) ? loft.tiles[y * S + x] : Tile.Hull)
      const shafts = shaftCandidates({ below, above, F, D: masks.D, upperDeck: loft.deckMask, forbidden, keepOff }).filter(
        (s) => !doorNear(s.p),
      )
      if (shafts.length === 0) continue
      // Prefer the cheapest shafts; draw among the few best.
      const best = shafts.filter((s) => s.cost === shafts[0].cost)
      const pickRng = rng.fork('storey:1:stairs')
      const order = [...best]
      for (let i = order.length - 1; i > 0; i--) {
        const j = pickRng.int(0, i)
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      for (const shaft of order.slice(0, 6)) {
        const built = tryBuild(level, loft.tiles, shaft)
        if (!built) continue
        commit(level, built, cand.tower)
        return { building: cand.building, tower: cand.tower, setback: e, shaft }
      }
    }
  }
  return null
}

interface Built {
  tiles: Uint8Array
  solid: Uint8Array
  w: number
  stairs: StairLink[]
}

const buildSolid = (tiles: Uint8Array): Uint8Array => {
  const solid = new Uint8Array(tiles.length)
  for (let i = 0; i < tiles.length; i++) solid[i] = isWallTile(tiles[i]) ? 1 : 0
  return solid
}

/** Lay the atlas for one shaft and accept it only if every tile that was
 * reachable before still is, and the whole loft is reachable through the stair. */
const tryBuild = (level: Level, loft: Uint8Array, shaft: ShaftPlan): Built | null => {
  const w = 2 * STOREY_STRIDE - STOREY_GUTTER
  const h = S
  const ox = STOREY_STRIDE
  const tiles = new Uint8Array(w * h).fill(Tile.Hull)
  for (let y = 0; y < h; y++) {
    tiles.set(level.tiles.subarray(y * S, y * S + S), y * w)
    tiles.set(loft.subarray(y * S, y * S + S), y * w + ox)
  }
  const { p, dir } = shaft
  const d = DIR_VEC[dir]
  tiles[p.y * w + p.x] = Tile.StairUp
  tiles[p.y * w + ox + p.x] = Tile.StairDown
  for (const n of shaft.carveBelow) tiles[n.y * w + n.x] = Tile.Wall
  for (const n of shaft.carveAbove) tiles[n.y * w + ox + n.x] = Tile.Wall
  const L = { x: p.x + d.x, y: p.y + d.y }
  const stairs: StairLink[] = [
    { from: { x: p.x, y: p.y }, to: { x: ox + p.x, y: p.y }, landing: { x: ox + L.x, y: L.y }, dir },
    { from: { x: ox + p.x, y: p.y }, to: { x: p.x, y: p.y }, landing: { x: L.x, y: L.y }, dir },
  ]
  const solid = buildSolid(tiles)
  // Ground reachability before (4-connected from spawn, the level as carved).
  const before = flood(level.tiles, level.solid, S, S, [], Math.floor(level.spawn.y) * S + Math.floor(level.spawn.x))
  const after = flood(tiles, solid, w, h, stairs, Math.floor(level.spawn.y) * w + Math.floor(level.spawn.x))
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (!before[y * S + x]) continue
      if (solid[y * w + x]) continue // a carved niche tile
      if (!after[y * w + x]) return null
    }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const k = y * w + ox + x
      if (!solid[k] && !after[k]) return null
    }
  return { tiles, solid, w, stairs }
}

/** 4-connected flood over non-solid tiles that also follows stair links. */
export const flood = (tiles: Uint8Array, solid: Uint8Array, w: number, h: number, stairs: readonly StairLink[], start: number): Uint8Array => {
  void tiles
  const seen = new Uint8Array(w * h)
  if (start < 0 || start >= w * h || solid[start]) return seen
  const jump = new Map<number, number>()
  for (const l of stairs) jump.set(l.from.y * w + l.from.x, l.landing.y * w + l.landing.x)
  const stack = [start]
  seen[start] = 1
  while (stack.length > 0) {
    const k = stack.pop()!
    const x = k % w
    const y = (k - x) / w
    const j = jump.get(k)
    if (j !== undefined && !seen[j] && !solid[j]) {
      seen[j] = 1
      stack.push(j)
    }
    for (const [dx, dy] of N4) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nk = ny * w + nx
      if (seen[nk] || solid[nk]) continue
      seen[nk] = 1
      stack.push(nk)
    }
  }
  return seen
}

const commit = (level: Level, built: Built, tower: boolean): void => {
  level.w = built.w
  level.tiles = built.tiles
  level.solid = built.solid
  const storeys: Storey[] = [
    { slot: 0, z: 0, kind: 'ground', ox: 0 },
    { slot: 1, z: 1, kind: tower ? 'tower' : 'upper', ox: STOREY_STRIDE },
  ]
  level.storeys = storeys
  level.stairs = built.stairs
}
