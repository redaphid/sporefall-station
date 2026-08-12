/**
 * Room LAYOUT — the arrangement half of furnishing.
 *
 * Picking the right props for a room type (a bunk for the bedroom, a locker for
 * the armory) was never the problem: `ROOM_FURNISH` already did that, and rooms
 * still read as scattered junk. The reason is that every prop was drawn
 * INDEPENDENTLY and dropped on an independently-chosen tile, so a room came out
 * evenly sprinkled — polka dots with a two-tile gap between every object. Real
 * rooms are lumpy: furniture forms RANKS along a wall, CLUMPS in a corner, and
 * clusters AROUND something (chairs round a table, a seat facing a screen),
 * leaving the middle of the floor conspicuously empty to walk through.
 *
 * So this module plans a room as a short sequence of GROUPS, each placed as one
 * coherent unit, instead of N unrelated singles:
 *
 *   run   — a rank of one prop along a single stretch of one wall (shelving down
 *           the stockroom, bunks along the barracks wall, desks in an office
 *           row), optionally with a seat pulled up to each one.
 *   block — a contiguous clump, seeded in the most cornered tile available and
 *           grown outward, so cargo stacks like cargo instead of spraying.
 *   set   — an anchor out on the open floor with seats on its free orthogonal
 *           neighbours, every seat turned to face it: the table-and-chairs.
 *   view  — a focus backed against a wall with seating a couple of tiles out in
 *           front of it, facing back: the screen and the thing you watch it from.
 *   one   — a single prop placed by its own standing preference (a planter
 *           tucked in a corner, the bathroom's toilet).
 *
 * Everything is a pure function of the room's free tiles, a wall test and an
 * `Rng`, so it draws no ambient state and stays byte-identical per seed.
 *
 * PLACEMENT IS NOT ART. Nothing here draws anything; it decides WHERE a prop
 * stands and WHICH WAY IT POINTS. `facing` is a real, serialized entity field
 * the renderer already applies, so orientation costs nothing and is what makes a
 * rank of desks read as a row of workstations rather than a row of boxes.
 */

import type { Rng } from '../rng'
import type { RoomType } from './level'

/** Compass steps in the order the renderer's `facing` radians run: 0 = +x
 * (east), 1 = +y (south), 2 = -x (west), 3 = -y (north). A prop's `facing` is
 * `dir * π/2` — the same convention the character sprites use ("eyes looking +x
 * at rotation 0"), so a facing of 0 is exactly today's unrotated behaviour. */
export const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]

/** Radians for a compass step. */
export const dirFacing = (d: number): number => (d * Math.PI) / 2

const opposite = (d: number): number => (d + 2) % 4

/** A candidate tile: room-owned, walkable, not reserved. `walls` is how many of
 * its 4 orthogonal neighbours are wall tiles — 0 is open mid-floor, 1 backs onto
 * a wall, 2+ is tucked into a corner. */
export interface FreeTile {
  x: number
  y: number
  walls: number
}

/** One decided prop: what, where, which way it points, and whether it backs onto
 * a wall (the renderer nudges a backed prop toward its wall so it kisses the
 * wall instead of floating a half-tile off it — see `mounted`). */
export interface Placement {
  prop: string
  x: number
  y: number
  /** Radians. The direction the prop faces; for a wall-backed prop, away from
   * its wall, so the wall is at `facing + π`. */
  facing: number
  /** This prop stands against a wall, facing out of it. */
  mounted?: boolean
}

/** A coherent arrangement placed as one unit. See the module header. */
export type FurnishGroup =
  | { g: 'run'; prop: string; min: number; max: number; seat?: string }
  | { g: 'block'; prop: string; min: number; max: number }
  | { g: 'set'; anchor: string; seat: string; min: number; max: number }
  | { g: 'view'; focus: string; seat: string; seats: number }
  | { g: 'one'; prop: string; pref?: 'wall' | 'corner' | 'center' | 'any' }

/** Every distinct prop a group can place, in first-mention order — the derived
 * palette that keeps `ROOM_FURNISH` true by construction rather than by hand. */
export const groupProps = (groups: readonly FurnishGroup[]): string[] => {
  const out: string[] = []
  const add = (p: string | undefined): void => {
    if (p && !out.includes(p)) out.push(p)
  }
  for (const g of groups) {
    if (g.g === 'run') {
      add(g.prop)
      add(g.seat)
    } else if (g.g === 'block' || g.g === 'one') add(g.prop)
    else if (g.g === 'set') {
      add(g.anchor)
      add(g.seat)
    } else {
      add(g.focus)
      add(g.seat)
    }
  }
  return out
}

/**
 * How each room type is ARRANGED — the recipe, read in order and then cycled.
 *
 * The props are the same cast the flat palettes already used (plus the chair the
 * table always wanted); what changed is that they now arrive in related groups.
 * Read a line as a sentence about the room: a bedroom is "a rank of bunks along
 * a wall, a cabinet, a plant in the corner"; a living room is "a screen with
 * seats facing it, a table with chairs round it, a plant"; a stockroom is
 * "shelving down one wall, a heap of crates in the corner, a barrel".
 *
 * ORDER MATTERS. The big wall-hungry group leads, so the rank gets the good wall
 * before the singles nibble at it; loose fill trails.
 */
export const ROOM_LAYOUT: Record<RoomType, readonly FurnishGroup[]> = {
  // Front of house: shelving ranked along a wall for customers to walk, the
  // machines against the wall, a delivery still boxed up by the door.
  shopfloor: [
    { g: 'run', prop: 'shelf', min: 2, max: 4 },
    { g: 'one', prop: 'vending' },
    { g: 'one', prop: 'atm' },
    { g: 'block', prop: 'crate', min: 1, max: 2 },
  ],
  // Back of house: racking down one wall, stock heaped in the corner.
  stockroom: [
    { g: 'run', prop: 'shelf', min: 2, max: 3 },
    { g: 'block', prop: 'crate', min: 2, max: 4 },
    { g: 'one', prop: 'barrel' },
  ],
  // Somebody LIVES here: a screen with seating drawn up facing it, and a table
  // with chairs round it. The floor between screen and seats stays empty.
  living: [
    { g: 'view', focus: 'tv', seat: 'chair', seats: 2 },
    { g: 'set', anchor: 'table', seat: 'chair', min: 2, max: 3 },
    { g: 'one', prop: 'plant' },
  ],
  bedroom: [
    { g: 'run', prop: 'bunk', min: 2, max: 3 },
    { g: 'one', prop: 'cabinet' },
    { g: 'one', prop: 'plant' },
  ],
  bathroom: [
    { g: 'one', prop: 'toilet' },
    { g: 'one', prop: 'cabinet' },
  ],
  // Reception desk with its chair behind it, benches ranked for people waiting.
  lobby: [
    { g: 'run', prop: 'desk', min: 1, max: 2, seat: 'chair' },
    { g: 'run', prop: 'bench', min: 1, max: 2 },
    { g: 'one', prop: 'vending' },
    { g: 'one', prop: 'plant' },
  ],
  // A row of workstations — the desks ranked along a wall, each with its chair
  // pulled up. This is the clearest case of arrangement beating art: the same
  // desk sprite reads as an office the moment it stops standing alone.
  office: [
    { g: 'run', prop: 'desk', min: 2, max: 3, seat: 'chair' },
    { g: 'run', prop: 'cabinet', min: 1, max: 2 },
    { g: 'one', prop: 'plant' },
  ],
  storage: [
    { g: 'run', prop: 'shelf', min: 1, max: 3 },
    { g: 'block', prop: 'crate', min: 2, max: 3 },
    { g: 'one', prop: 'cabinet' },
    { g: 'one', prop: 'barrel' },
  ],
  // A waiting room is benches in ranks and a screen nobody is watching.
  waiting: [
    { g: 'view', focus: 'tv', seat: 'chair', seats: 2 },
    { g: 'run', prop: 'bench', min: 2, max: 3 },
    { g: 'one', prop: 'vending' },
    { g: 'one', prop: 'plant' },
  ],
  ward: [
    { g: 'run', prop: 'bunk', min: 2, max: 3 },
    { g: 'run', prop: 'cabinet', min: 1, max: 2 },
    { g: 'one', prop: 'bench' },
  ],
  supply: [
    { g: 'run', prop: 'cabinet', min: 2, max: 3 },
    { g: 'run', prop: 'shelf', min: 1, max: 2 },
    { g: 'block', prop: 'crate', min: 1, max: 2 },
  ],
  // Somebody sits watch here: lockers ranked, a table they play cards at.
  guardpost: [
    { g: 'run', prop: 'locker', min: 1, max: 2 },
    { g: 'set', anchor: 'table', seat: 'chair', min: 1, max: 2 },
    { g: 'block', prop: 'crate', min: 1, max: 2 },
    { g: 'one', prop: 'barrel' },
  ],
  armory: [
    { g: 'run', prop: 'locker', min: 2, max: 4 },
    { g: 'block', prop: 'crate', min: 1, max: 2 },
    { g: 'one', prop: 'barrel' },
  ],
  barracks: [
    { g: 'run', prop: 'bunk', min: 2, max: 3 },
    { g: 'run', prop: 'locker', min: 1, max: 2 },
    { g: 'set', anchor: 'table', seat: 'chair', min: 1, max: 2 },
  ],
  vault: [
    { g: 'one', prop: 'locker' },
    { g: 'block', prop: 'crate', min: 1, max: 2 },
  ],
}

/** The live tile pool for one room being planned. Tiles are consumed as props
 * take them, so nothing ever stacks and the caller's density cap is exact. */
class Pool {
  private readonly byKey = new Map<number, FreeTile>()
  constructor(
    tiles: readonly FreeTile[],
    private readonly stride: number,
    readonly isWall: (x: number, y: number) => boolean,
  ) {
    // Insertion order is the caller's row-major scan, so every iteration below
    // is deterministic without needing a sort.
    for (const t of tiles) this.byKey.set(t.y * stride + t.x, t)
  }
  get size(): number {
    return this.byKey.size
  }
  at(x: number, y: number): FreeTile | undefined {
    return this.byKey.get(y * this.stride + x)
  }
  all(): FreeTile[] {
    return [...this.byKey.values()]
  }
  take(t: FreeTile): void {
    this.byKey.delete(t.y * this.stride + t.x)
  }
  /** Compass steps from `t` whose neighbour is a wall tile, ascending. */
  wallDirs(t: FreeTile): number[] {
    const out: number[] = []
    for (let d = 0; d < 4; d++) if (this.isWall(t.x + DIRS[d][0], t.y + DIRS[d][1])) out.push(d)
    return out
  }
}

/** Uniform pick over a non-empty list — one draw, so the stream cost of a
 * decision never depends on how many candidates there happened to be. */
const pickOne = <T>(rng: Rng, items: readonly T[]): T => items[rng.int(0, items.length - 1)]

/** A prop's standing preference. Kept here (not in populate) so the planner is
 * self-contained; populate re-exports it for the existing callers/tests. */
export const PROP_PLACEMENT: Record<string, 'wall' | 'corner' | 'center' | 'any'> = {
  shelf: 'wall',
  cabinet: 'wall',
  locker: 'wall',
  bunk: 'wall',
  tv: 'wall',
  vending: 'wall',
  atm: 'wall',
  bench: 'wall',
  desk: 'wall',
  toilet: 'corner',
  plant: 'corner',
  barrel: 'corner',
  table: 'center',
  chair: 'any',
  crate: 'any',
}

/** Free tiles matching a preference, degrading gracefully: corner → any wall →
 * anywhere; wall → anywhere; center → anywhere. Never empty while the pool is. */
const preferred = (pool: Pool, pref: 'wall' | 'corner' | 'center' | 'any'): FreeTile[] => {
  const free = pool.all()
  if (pref === 'corner') {
    const corners = free.filter((t) => t.walls >= 2)
    if (corners.length > 0) return corners
  }
  if (pref === 'corner' || pref === 'wall') {
    const walls = free.filter((t) => t.walls >= 1)
    if (walls.length > 0) return walls
  }
  if (pref === 'center') {
    const open = free.filter((t) => t.walls === 0)
    if (open.length > 0) return open
  }
  return free
}

/** Commit one tile as `prop`, pointing `facing` (radians). */
const put = (pool: Pool, out: Placement[], t: FreeTile, prop: string, facing: number, mounted?: boolean): void => {
  pool.take(t)
  out.push(mounted ? { prop, x: t.x, y: t.y, facing, mounted } : { prop, x: t.x, y: t.y, facing })
}

/** Place a tile backed onto a wall if it has one (facing out of that wall),
 * otherwise unrotated. The default for anything without a stronger opinion. */
const putBacked = (pool: Pool, out: Placement[], t: FreeTile, prop: string): void => {
  const walls = pool.wallDirs(t)
  if (walls.length === 0) return put(pool, out, t, prop, 0)
  put(pool, out, t, prop, dirFacing(opposite(walls[0])), true)
}

/** Maximal straight stretches of free tiles that all back onto the SAME wall —
 * the candidate ranks. Built in a fixed scan (direction, then row-major) so the
 * list is deterministic without sorting. */
const wallRuns = (pool: Pool): { d: number; tiles: FreeTile[] }[] => {
  const runs: { d: number; tiles: FreeTile[] }[] = []
  const free = pool.all()
  for (let d = 0; d < 4; d++) {
    const [dx, dy] = DIRS[d]
    const hugging = free.filter((t) => pool.isWall(t.x + dx, t.y + dy))
    if (hugging.length === 0) continue
    // A vertical wall (east/west of the tile) supports a rank running along y;
    // a horizontal one supports a rank running along x.
    const vertical = dx !== 0
    const lanes = new Map<number, FreeTile[]>()
    for (const t of hugging) {
      const lane = vertical ? t.x : t.y
      const bucket = lanes.get(lane)
      if (bucket) bucket.push(t)
      else lanes.set(lane, [t])
    }
    const laneKeys = [...lanes.keys()].sort((a, b) => a - b)
    for (const k of laneKeys) {
      const tiles = lanes.get(k)!.sort((a, b) => (vertical ? a.y - b.y : a.x - b.x))
      let seg: FreeTile[] = [tiles[0]]
      for (let i = 1; i < tiles.length; i++) {
        const step = vertical ? tiles[i].y - tiles[i - 1].y : tiles[i].x - tiles[i - 1].x
        if (step === 1) seg.push(tiles[i])
        else {
          runs.push({ d, tiles: seg })
          seg = [tiles[i]]
        }
      }
      runs.push({ d, tiles: seg })
    }
  }
  return runs
}

/** A rank of `prop` along one stretch of one wall, every piece facing out of it
 * — the single strongest "someone arranged this" signal a room can carry. With
 * `seat`, a chair is pulled up in front of each piece (an office row, a mess
 * table), which is what turns a line of desks into workstations. */
const placeRun = (pool: Pool, out: Placement[], rng: Rng, g: Extract<FurnishGroup, { g: 'run' }>, budget: number): void => {
  const runs = wallRuns(pool)
  if (runs.length === 0 || budget < 1) return
  // Favour the longest stretch: a rank wants room to read as a rank.
  const longest = Math.max(...runs.map((r) => r.tiles.length))
  const best = runs.filter((r) => r.tiles.length === longest)
  const run = pickOne(rng, best)
  const want = rng.int(g.min, g.max)
  // A seated run spends two of the budget per piece.
  const per = g.seat ? 2 : 1
  const n = Math.max(1, Math.min(want, run.tiles.length, Math.floor(budget / per) || 1))
  const start = rng.int(0, run.tiles.length - n)
  const face = dirFacing(opposite(run.d))
  const [ax, ay] = DIRS[opposite(run.d)]
  let spent = 0
  for (let i = 0; i < n && spent < budget; i++) {
    const t = run.tiles[start + i]
    // A tile can have been taken by this run's own seats; skip rather than stack.
    if (!pool.at(t.x, t.y)) continue
    put(pool, out, t, g.prop, face, true)
    spent++
    if (!g.seat || spent >= budget) continue
    const seat = pool.at(t.x + ax, t.y + ay)
    if (!seat) continue
    put(pool, out, seat, g.seat, dirFacing(run.d)) // turned back toward the piece
    spent++
  }
}

/** A contiguous clump: seed in the most cornered tile available, then grow into
 * whichever free neighbour is itself most cornered. Cargo stacks in a heap in
 * the corner; it does not spray itself across the floor one crate at a time. */
const placeBlock = (pool: Pool, out: Placement[], rng: Rng, g: Extract<FurnishGroup, { g: 'block' }>, budget: number): void => {
  if (pool.size === 0 || budget < 1) return
  const free = pool.all()
  const most = Math.max(...free.map((t) => t.walls))
  const seed = pickOne(rng, free.filter((t) => t.walls === most))
  const n = Math.max(1, Math.min(rng.int(g.min, g.max), budget))
  const placed: FreeTile[] = []
  putBacked(pool, out, seed, g.prop)
  placed.push(seed)
  while (placed.length < n) {
    const nbrs: FreeTile[] = []
    for (const p of placed) {
      for (const [dx, dy] of DIRS) {
        const t = pool.at(p.x + dx, p.y + dy)
        if (t && !nbrs.includes(t)) nbrs.push(t)
      }
    }
    if (nbrs.length === 0) break
    const top = Math.max(...nbrs.map((t) => t.walls))
    const next = pickOne(rng, nbrs.filter((t) => t.walls === top))
    putBacked(pool, out, next, g.prop)
    placed.push(next)
  }
}

/** An anchor out on the open floor with seats on its free orthogonal
 * neighbours, each turned to face it — the table and its chairs, the owner's
 * literal ask. Falls back to a less-open anchor rather than skipping the group,
 * because a chair beside a table in a cramped room still reads better than two
 * unrelated objects. */
const placeSet = (pool: Pool, out: Placement[], rng: Rng, g: Extract<FurnishGroup, { g: 'set' }>, budget: number): void => {
  if (budget < 1) return
  const seats = (t: FreeTile): number => DIRS.filter(([dx, dy]) => pool.at(t.x + dx, t.y + dy)).length
  const free = pool.all()
  // Tiers, best first. An anchor is a `center` prop, so a mid-floor tile MUST
  // win whenever one is free (tiers 1-2) — only then may a wall tile be taken.
  // That ordering is what keeps the "center props stay off walls" contract true.
  const pickFrom =
    free.filter((t) => t.walls === 0 && seats(t) >= 2).length > 0
      ? free.filter((t) => t.walls === 0 && seats(t) >= 2)
      : free.filter((t) => t.walls === 0).length > 0
        ? free.filter((t) => t.walls === 0)
        : free.filter((t) => t.walls <= 1 && seats(t) >= 1).length > 0
          ? free.filter((t) => t.walls <= 1 && seats(t) >= 1)
          : free
  if (pickFrom.length === 0) return
  const anchor = pickOne(rng, pickFrom)
  put(pool, out, anchor, g.anchor, 0)
  let spent = 1
  const want = Math.min(rng.int(g.min, g.max), budget - spent)
  for (let d = 0; d < 4 && spent - 1 < want; d++) {
    const t = pool.at(anchor.x + DIRS[d][0], anchor.y + DIRS[d][1])
    if (!t) continue
    put(pool, out, t, g.seat, dirFacing(opposite(d))) // looking back at the anchor
    spent++
  }
}

/** A focus backed against a wall with seating out in front of it, facing back:
 * the screen and the seat you watch it from. The gap between them is left EMPTY
 * on purpose — that stretch of clear floor is what makes the pair read as a
 * living room instead of two props that happen to be near each other. */
const placeView = (pool: Pool, out: Placement[], rng: Rng, g: Extract<FurnishGroup, { g: 'view' }>, budget: number): void => {
  if (budget < 1) return
  const free = pool.all()
  // A focus needs a wall at its back AND somewhere to sit in front of it.
  const cands: { t: FreeTile; d: number }[] = []
  for (const t of free) {
    for (const wd of pool.wallDirs(t)) {
      const f = opposite(wd)
      const [fx, fy] = DIRS[f]
      if (pool.at(t.x + fx * 2, t.y + fy * 2) || pool.at(t.x + fx, t.y + fy)) cands.push({ t, d: f })
    }
  }
  if (cands.length === 0) {
    // No viewing line anywhere — stand the focus against whatever wall exists.
    const walls = preferred(pool, 'wall')
    if (walls.length > 0) putBacked(pool, out, pickOne(rng, walls), g.focus)
    return
  }
  const { t: focus, d: f } = pickOne(rng, cands)
  const [fx, fy] = DIRS[f]
  put(pool, out, focus, g.focus, dirFacing(f), true)
  let spent = 1
  // Sit back two tiles when there is room, one when there is not.
  const back = pool.at(focus.x + fx * 2, focus.y + fy * 2) ? 2 : 1
  const seatFace = dirFacing(opposite(f))
  const row = pool.at(focus.x + fx * back, focus.y + fy * back)
  if (row && spent < budget) {
    put(pool, out, row, g.seat, seatFace)
    spent++
    // Extra seats sit beside the first, along the wall's axis — a row facing the
    // screen, not a ring around it.
    const [sx, sy] = DIRS[(f + 1) % 4]
    for (let k = 1; spent - 1 < g.seats && spent < budget; k++) {
      const side = pool.at(row.x + sx * k, row.y + sy * k) ?? pool.at(row.x - sx * k, row.y - sy * k)
      if (!side) break
      put(pool, out, side, g.seat, seatFace)
      spent++
    }
  }
}

/** A single prop standing where that kind of prop belongs. */
const placeOne = (pool: Pool, out: Placement[], rng: Rng, g: Extract<FurnishGroup, { g: 'one' }>): void => {
  const cands = preferred(pool, g.pref ?? PROP_PLACEMENT[g.prop] ?? 'any')
  if (cands.length === 0) return
  putBacked(pool, out, pickOne(rng, cands), g.prop)
}

/**
 * Lay out one room: walk its recipe, placing whole groups until the prop budget
 * is spent. The starting group rotates with the rng so two same-type rooms on a
 * floor don't open with the same arrangement, and the recipe cycles so a big
 * hall gets a second rank rather than one rank and a lot of nothing.
 *
 * Never places more than `budget` props and never reuses a tile, so the caller's
 * density and no-stacking guarantees hold exactly as before.
 */
export const planRoom = (
  tiles: readonly FreeTile[],
  stride: number,
  isWall: (x: number, y: number) => boolean,
  groups: readonly FurnishGroup[],
  budget: number,
  rng: Rng,
): Placement[] => {
  const out: Placement[] = []
  if (groups.length === 0 || budget < 1 || tiles.length === 0) return out
  const pool = new Pool(tiles, stride, isWall)
  const start = rng.int(0, groups.length - 1)
  // Bounded: every pass either places something or the loop gives up, so a
  // recipe that can't fit the room can never spin.
  for (let pass = 0; pass < groups.length * 2 && out.length < budget && pool.size > 0; pass++) {
    const before = out.length
    const g = groups[(start + pass) % groups.length]
    const left = budget - out.length
    if (g.g === 'run') placeRun(pool, out, rng, g, left)
    else if (g.g === 'block') placeBlock(pool, out, rng, g, left)
    else if (g.g === 'set') placeSet(pool, out, rng, g, left)
    else if (g.g === 'view') placeView(pool, out, rng, g, left)
    else placeOne(pool, out, rng, g)
    // A group that placed nothing on a non-empty pool means this recipe step
    // simply doesn't fit here; keep walking rather than stalling.
    if (out.length === before && pool.size === 0) break
  }
  return out.slice(0, budget)
}
