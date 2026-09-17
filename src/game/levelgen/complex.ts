import type { Rng } from '../rng'
import {
  isWallTile,
  Tile,
  TileGrid,
  type BiomeName,
  type Building,
  type BuildingRole,
  type ComplexInfo,
  type Corridor,
  type TileId,
  type Wing,
} from './level'
import type { Rect } from './rooms'

/**
 * INDOOR COMPLEX generator — floors 3+ leave the sunken streets and dive into
 * the station ring itself: a pressure hull packed with modules (mess hall,
 * bunk rooms, galley, labs, infirmary, reactor hall, stores, security) hung
 * off a network of corridors.
 *
 * Construction, in order (every stage on its OWN named rng fork, so tuning one
 * stage never reshuffles another):
 *   1. Cut each axis into blocks separated by 2-3 wide corridor lines.
 *   2. Build the corridor graph (intersections + segments). A random spanning
 *      tree over the intersections is ALWAYS kept, so the corridor network is
 *      connected by construction; spare loops and dead-end stubs may be
 *      dropped, and a dropped segment MERGES its two blocks into one big wing
 *      (that is where the long mess halls come from).
 *   3. Partition each wing into a strip (or back-to-back pair of strips) of
 *      rooms with 1-tile walls; each room is its own `Building` (a module).
 *   4. Doors: every room gets a door onto an adjacent corridor where one
 *      exists, else an interior door into a neighbour; a BFS repair pass then
 *      punches through any room still unreachable — reachability is guaranteed.
 *   5. Spawn/exit near opposite hull corners (their corridor stubs are pinned
 *      so the two are always far apart), then roles by distance/size/biome,
 *      per-role deck tiles, vents and biome dressing.
 *
 * A pure function of (rng, floor): the layout regenerates bit-exact from
 * seed+floor on every peer, like every other level.
 */

/** First floor built as an indoor complex. Floors below keep the city. */
export const COMPLEX_MIN_FLOOR = 3

/** Does this floor use the indoor-complex generator? */
export const isComplexFloor = (floor: number): boolean => floor >= COMPLEX_MIN_FLOOR

/** Biomes cycle floor by floor, so consecutive complex floors never match. */
export const BIOMES: readonly BiomeName[] = ['habitation', 'flooded', 'reactor', 'overgrown']

export const biomeForFloor = (floor: number): BiomeName =>
  BIOMES[(((floor - COMPLEX_MIN_FLOOR) % BIOMES.length) + BIOMES.length) % BIOMES.length]

interface BiomeDef {
  /** Role weights for ordinary (non-mess, non-objective) modules. */
  roles: readonly [BuildingRole, number][]
  /** What the deepest module (the mission's target) can be. */
  objective: readonly BuildingRole[]
  /** Per-role deck tile; roles absent use `Tile.Floor`. */
  deck: Partial<Record<BuildingRole, TileId>>
  /** Chance each corridor run carries a vent grate (per ~8 tiles of run). */
  ventChance: number
  /** Bog-seep puddles laid over the deck. */
  puddles: [number, number]
  /** Moss (grass) patches creeping over the deck. */
  moss: [number, number]
}

const TILED: Partial<Record<BuildingRole, TileId>> = {
  mess: Tile.Tiled,
  galley: Tile.Tiled,
  washroom: Tile.Tiled,
  medbay: Tile.Tiled,
  lab: Tile.Tiled,
  reactor: Tile.Plating,
  depot: Tile.Plating,
}

export const BIOME_DEFS: Record<BiomeName, BiomeDef> = {
  // The crew ring: bunks, wash blocks and the infirmary; scrubbed tile decks.
  habitation: {
    roles: [
      ['quarters', 6],
      ['washroom', 2],
      ['medbay', 2],
      ['depot', 2],
      ['lab', 1],
      ['security', 1],
    ],
    objective: ['security', 'medbay', 'lab'],
    deck: TILED,
    ventChance: 0.35,
    puddles: [0, 1],
    moss: [0, 0],
  },
  // The low ring the swamp is reclaiming: bog water pools across the deck.
  flooded: {
    roles: [
      ['depot', 3],
      ['quarters', 3],
      ['washroom', 2],
      ['lab', 2],
      ['medbay', 1],
      ['security', 1],
    ],
    objective: ['lab', 'reactor'],
    deck: TILED,
    ventChance: 0.4,
    puddles: [9, 14],
    moss: [0, 2],
  },
  // Engineering: plated decks, stores and the humming reactor hall.
  reactor: {
    roles: [
      ['depot', 3],
      ['reactor', 2],
      ['security', 2],
      ['quarters', 2],
      ['lab', 1],
      ['washroom', 1],
    ],
    objective: ['reactor'],
    deck: { ...TILED, lab: Tile.Plating, security: Tile.Plating, quarters: Tile.Plating },
    ventChance: 0.45,
    puddles: [0, 2],
    moss: [0, 0],
  },
  // Where the sporefall got in: vents everywhere, moss over the plating.
  overgrown: {
    roles: [
      ['lab', 3],
      ['medbay', 2],
      ['quarters', 2],
      ['depot', 2],
      ['washroom', 1],
    ],
    objective: ['lab', 'medbay'],
    deck: TILED,
    ventChance: 0.7,
    puddles: [2, 4],
    moss: [8, 13],
  },
}

/** Smallest block edge (walls included) — keeps every room at least 3 wide. */
const MIN_BLOCK = 9
/** Hull thickness at the map edge. */
const HULL = 1

interface Band {
  start: number
  size: number
}

/** Cut one axis into alternating blocks and corridor lines (block first/last). */
const cutAxis = (rng: Rng, total: number): { blocks: Band[]; corridors: Band[] } => {
  const len = total - 2 * HULL
  const k = rng.int(2, 3)
  const widths = Array.from({ length: k }, () => rng.int(2, 3))
  const space = len - widths.reduce((a, b) => a + b, 0)
  const n = k + 1
  const base = Math.floor(space / n)
  const sizes = Array.from({ length: n }, (_, i) => base + (i < space - base * n ? 1 : 0))
  for (let i = 0; i < n - 1; i++) {
    const d = rng.int(-3, 3)
    if (sizes[i] + d >= MIN_BLOCK && sizes[i + 1] - d >= MIN_BLOCK) {
      sizes[i] += d
      sizes[i + 1] -= d
    }
  }
  const blocks: Band[] = []
  const corridors: Band[] = []
  let pos = HULL
  for (let i = 0; i < n; i++) {
    blocks.push({ start: pos, size: sizes[i] })
    pos += sizes[i]
    if (i < k) {
      corridors.push({ start: pos, size: widths[i] })
      pos += widths[i]
    }
  }
  return { blocks, corridors }
}

/** A corridor segment: part of corridor line `line` spanning block band `span`. */
interface Segment {
  axis: 'v' | 'h'
  line: number
  span: number
  kept: boolean
}

const segKey = (s: { axis: 'v' | 'h'; line: number; span: number }): string => `${s.axis}${s.line}:${s.span}`

const find = (parent: number[], i: number): number => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]]
    i = parent[i]
  }
  return i
}

const shuffle = <T>(rng: Rng, items: T[]): T[] => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    const t = items[i]
    items[i] = items[j]
    items[j] = t
  }
  return items
}

/** A room as the generator reasons about it before it becomes a Building. */
interface RoomPlan {
  rect: Rect
  wing: number
  doors: { x: number; y: number }[]
  role: BuildingRole
}

export interface ComplexPlan {
  buildings: Building[]
  spawn: { x: number; y: number }
  exit: { x: number; y: number }
  complex: ComplexInfo
}

/** Carve the whole indoor complex into `grid` (which it overwrites entirely). */
export const carveComplex = (rng: Rng, grid: TileGrid, floor: number): ComplexPlan => {
  const w = grid.w
  const h = grid.h
  const biome = biomeForFloor(floor)
  const def = BIOME_DEFS[biome]
  grid.fillRect(0, 0, w, h, Tile.Hull)

  const cols = cutAxis(rng.fork('cols'), w)
  const rows = cutAxis(rng.fork('rows'), h)
  const kx = cols.corridors.length
  const ky = rows.corridors.length

  // ── Spawn/exit corners first: their corridor stubs are pinned open. ───────
  const srng = rng.fork('spawn')
  const corner = srng.int(0, 3) // 0=TL 1=TR 2=BR 3=BL
  const pinned = new Set<string>()
  for (const c of [corner, (corner + 2) % 4]) {
    const right = c === 1 || c === 2
    const bottom = c === 2 || c === 3
    pinned.add(segKey({ axis: 'v', line: right ? kx - 1 : 0, span: bottom ? ky : 0 }))
    pinned.add(segKey({ axis: 'h', line: bottom ? ky - 1 : 0, span: right ? kx : 0 }))
  }

  // ── Corridor graph: spanning tree kept, loops/stubs may drop + merge. ─────
  const nrng = rng.fork('net')
  const segments: Segment[] = []
  for (let i = 0; i < kx; i++) for (let j = 0; j <= ky; j++) segments.push({ axis: 'v', line: i, span: j, kept: true })
  for (let j = 0; j < ky; j++) for (let i = 0; i <= kx; i++) segments.push({ axis: 'h', line: j, span: i, kept: true })
  const node = (i: number, j: number): number => j * kx + i
  const parent = Array.from({ length: kx * ky }, (_, i) => i)
  const inner = segments.filter((s) => (s.axis === 'v' ? s.span > 0 && s.span < ky : s.span > 0 && s.span < kx))
  const stubs = segments.filter((s) => !inner.includes(s))
  const spare: Segment[] = []
  for (const s of shuffle(nrng, [...inner])) {
    const a = s.axis === 'v' ? node(s.line, s.span - 1) : node(s.span - 1, s.line)
    const b = s.axis === 'v' ? node(s.line, s.span) : node(s.span, s.line)
    const ra = find(parent, a)
    const rb = find(parent, b)
    if (ra !== rb) parent[ra] = rb // tree edge: always kept
    else spare.push(s)
  }
  // Blocks: (kx+1) x (ky+1); `mergedWith` pairs a block with its merge partner.
  const bw = kx + 1
  const blockIdx = (bx: number, by: number): number => by * bw + bx
  const mergedWith = new Map<number, number>()
  const tryDrop = (s: Segment, p: number): void => {
    if (pinned.has(segKey(s)) || !nrng.chance(p)) return
    // A vertical segment on line i spanning row j separates blocks (i,j)/(i+1,j).
    const a = s.axis === 'v' ? blockIdx(s.line, s.span) : blockIdx(s.span, s.line)
    const b = s.axis === 'v' ? blockIdx(s.line + 1, s.span) : blockIdx(s.span, s.line + 1)
    if (mergedWith.has(a) || mergedWith.has(b)) return // merges stay rectangular
    s.kept = false
    mergedWith.set(a, b)
    mergedWith.set(b, a)
  }
  for (const s of spare) tryDrop(s, 0.5)
  for (const s of stubs) tryDrop(s, 0.35)

  // ── Carve corridors (kept segments + every intersection). ──────────────────
  const segRect = (s: Segment): Rect =>
    s.axis === 'v'
      ? { x: cols.corridors[s.line].start, y: rows.blocks[s.span].start, w: cols.corridors[s.line].size, h: rows.blocks[s.span].size }
      : { x: cols.blocks[s.span].start, y: rows.corridors[s.line].start, w: cols.blocks[s.span].size, h: rows.corridors[s.line].size }
  for (const s of segments) {
    if (!s.kept) continue
    const r = segRect(s)
    grid.fillRect(r.x, r.y, r.w, r.h, Tile.Hall)
  }
  for (const c of cols.corridors) for (const r of rows.corridors) grid.fillRect(c.start, r.start, c.size, r.size, Tile.Hall)

  // Straight corridor runs: maximal carved stretches along each line.
  const corridors: Corridor[] = []
  const runs = (axis: 'v' | 'h', line: number, band: Band, along: { blocks: Band[]; corridors: Band[] }): void => {
    let from = -1
    let to = -1
    const flush = (): void => {
      if (from < 0) return
      corridors.push({
        axis,
        rect: axis === 'v' ? { x: band.start, y: from, w: band.size, h: to - from } : { x: from, y: band.start, w: to - from, h: band.size },
      })
      from = -1
    }
    for (let span = 0; span < along.blocks.length; span++) {
      const seg = segments.find((s) => s.axis === axis && s.line === line && s.span === span)!
      const b = along.blocks[span]
      if (seg.kept) {
        if (from < 0) from = b.start
        to = b.start + b.size
      } else flush()
      const c = along.corridors[span]
      if (c) {
        if (from < 0) from = c.start
        to = c.start + c.size
      }
    }
    flush()
  }
  cols.corridors.forEach((band, i) => runs('v', i, band, rows))
  rows.corridors.forEach((band, j) => runs('h', j, band, cols))

  // ── Wings (blocks, merged pairs as one) → rooms. ───────────────────────────
  const rrng = rng.fork('rooms')
  const wingRects: Rect[] = []
  for (let by = 0; by <= ky; by++) {
    for (let bx = 0; bx <= kx; bx++) {
      const idx = blockIdx(bx, by)
      const partner = mergedWith.get(idx)
      if (partner !== undefined && partner < idx) continue // emitted with its partner
      const r: Rect = { x: cols.blocks[bx].start, y: rows.blocks[by].start, w: cols.blocks[bx].size, h: rows.blocks[by].size }
      if (partner !== undefined) {
        const px = partner % bw
        const py = Math.floor(partner / bw)
        const x2 = cols.blocks[px].start + cols.blocks[px].size
        const y2 = rows.blocks[py].start + rows.blocks[py].size
        r.w = x2 - r.x
        r.h = y2 - r.y
      }
      wingRects.push(r)
    }
  }

  const plans: RoomPlan[] = []
  wingRects.forEach((wr, wi) => {
    grid.fillRect(wr.x, wr.y, wr.w, wr.h, Tile.Wall)
    const inner: Rect = { x: wr.x + 1, y: wr.y + 1, w: wr.w - 2, h: wr.h - 2 }
    grid.fillRect(inner.x, inner.y, inner.w, inner.h, Tile.Floor)
    for (const room of splitWing(rrng, grid, inner)) plans.push({ rect: room, wing: wi, doors: [], role: 'quarters' })
  })

  // ── Doors. ─────────────────────────────────────────────────────────────────
  const drng = rng.fork('doors')
  const walkable = (x: number, y: number): boolean => grid.inBounds(x, y) && !isWallTile(grid.get(x, y))
  const doorOwners = new Map<number, number[]>() // tile key → plan indices sharing it
  const addDoor = (pi: number, x: number, y: number): void => {
    const key = y * w + x
    grid.set(x, y, Tile.Floor)
    const owners = doorOwners.get(key) ?? []
    if (!owners.includes(pi)) owners.push(pi)
    doorOwners.set(key, owners)
  }
  const planAt = (x: number, y: number): number => plans.findIndex((p) => inRect(p.rect, x, y))
  plans.forEach((p, pi) => {
    // Corridor-facing sides: wall tile beyond the room edge with Hall beyond it.
    const sides = ringSides(p.rect)
    const corridorSides = sides
      .map((side) => side.filter((t) => grid.get(t.ox, t.oy) === Tile.Hall))
      .filter((c) => c.length > 0)
    shuffle(drng, corridorSides)
    corridorSides.forEach((cands, i) => {
      if (i === 0 || (i === 1 && drng.chance(0.35))) {
        const t = cands[drng.int(0, cands.length - 1)]
        addDoor(pi, t.x, t.y)
      }
    })
    if (corridorSides.length === 0) {
      // Interior door into a neighbour room (prefer one that has corridor access).
      const cands = sides.flat().filter((t) => walkable(t.ox, t.oy) && planAt(t.ox, t.oy) >= 0)
      if (cands.length > 0) {
        const t = cands[drng.int(0, cands.length - 1)]
        addDoor(pi, t.x, t.y)
        addDoor(planAt(t.ox, t.oy), t.x, t.y)
      }
    }
  })

  // ── Spawn/exit: Hall tiles nearest the two pinned corners. ─────────────────
  const cornerPt = (c: number): { x: number; y: number } => ({
    x: c === 1 || c === 2 ? w - 1 : 0,
    y: c === 2 || c === 3 ? h - 1 : 0,
  })
  const nearestHall = (pt: { x: number; y: number }): { x: number; y: number } => {
    let best = { x: 0, y: 0 }
    let bestD = Infinity
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (grid.get(x, y) !== Tile.Hall) continue
        const d = Math.hypot(x - pt.x, y - pt.y)
        if (d < bestD) {
          bestD = d
          best = { x, y }
        }
      }
    }
    return best
  }
  const spawnTile = nearestHall(cornerPt(corner))
  const exit = nearestHall(cornerPt((corner + 2) % 4))

  // ── Connectivity repair: punch through until every room is reachable. ──────
  for (let pass = 0; pass < plans.length + 1; pass++) {
    const reach = bfs(grid, spawnTile.x, spawnTile.y)
    const stranded = plans.map((p, i) => ({ p, i })).filter(({ p }) => !reach[p.rect.y * w + p.rect.x])
    if (stranded.length === 0) break
    let punched = false
    for (const { p, i } of stranded) {
      const cand = ringSides(p.rect)
        .flat()
        .find((t) => grid.inBounds(t.ox, t.oy) && reach[t.oy * w + t.ox] === 1)
      if (!cand) continue
      addDoor(i, cand.x, cand.y)
      const other = planAt(cand.ox, cand.oy)
      if (other >= 0) addDoor(other, cand.x, cand.y)
      punched = true
    }
    if (!punched) break
  }
  for (const [key, owners] of doorOwners) {
    for (const pi of owners) plans[pi].doors.push({ x: key % w, y: Math.floor(key / w) })
  }

  // ── Roles: objective deepest, mess hall biggest, galley beside it. ─────────
  const orng = rng.fork('roles')
  const rectOf = (p: RoomPlan): Rect => ({ x: p.rect.x - 1, y: p.rect.y - 1, w: p.rect.w + 2, h: p.rect.h + 2 })
  // Same metric + tie-break as missions.farthestBuilding, so the module named
  // as the objective IS the one the mission targets.
  let objective = -1
  let bestDist = -1
  plans.forEach((p, i) => {
    const r = rectOf(p)
    const d = Math.hypot(r.x + r.w / 2 - (spawnTile.x + 0.5), r.y + r.h / 2 - (spawnTile.y + 0.5))
    if (d > bestDist) {
      bestDist = d
      objective = i
    }
  })
  const area = (p: RoomPlan): number => p.rect.w * p.rect.h
  const assigned = new Set<number>()
  if (objective >= 0) {
    plans[objective].role = orng.pick(def.objective)
    assigned.add(objective)
  }
  let mess = -1
  plans.forEach((p, i) => {
    if (assigned.has(i) || area(p) < 30) return
    if (mess < 0 || area(p) > area(plans[mess])) mess = i
  })
  if (mess >= 0) {
    plans[mess].role = 'mess'
    assigned.add(mess)
    const galley = plans.findIndex((p, i) => !assigned.has(i) && p.wing === plans[mess].wing && sharesWall(p.rect, plans[mess].rect))
    if (galley >= 0) {
      plans[galley].role = 'galley'
      assigned.add(galley)
    }
  }
  const total = def.roles.reduce((s, [, wt]) => s + wt, 0)
  plans.forEach((p, i) => {
    if (assigned.has(i)) return
    let roll = orng.int(1, total)
    let role = def.roles[0][0]
    for (const [r, wt] of def.roles) {
      roll -= wt
      if (roll <= 0) {
        role = r
        break
      }
    }
    // A wash block is a closet, never a hall; a big room becomes quarters.
    if (role === 'washroom' && area(p) > 24) role = 'quarters'
    p.role = role
  })

  // ── Deck tiles per role (doors keep the plain threshold). ──────────────────
  for (const p of plans) {
    const deck = def.deck[p.role]
    if (deck === undefined) continue
    for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++) {
      for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++) if (grid.get(x, y) === Tile.Floor) grid.set(x, y, deck)
    }
  }

  // ── Dressing: vents, bog seeps, moss — never on a door, spawn or exit. ─────
  const xrng = rng.fork('decor')
  const reserved = new Set<number>([spawnTile.y * w + spawnTile.x, exit.y * w + exit.x])
  for (const key of doorOwners.keys()) {
    const dx = key % w
    const dy = Math.floor(key / w)
    reserved.add(key)
    for (const [ox, oy] of ORTHO) reserved.add((dy + oy) * w + dx + ox)
  }
  const vents: { x: number; y: number }[] = []
  for (const c of corridors) {
    const length = c.axis === 'v' ? c.rect.h : c.rect.w
    const slots = Math.max(1, Math.floor(length / 8))
    for (let s = 0; s < slots; s++) {
      if (!xrng.chance(def.ventChance)) continue
      const along = xrng.int(0, length - 1)
      const across = Math.floor((c.axis === 'v' ? c.rect.w : c.rect.h) / 2)
      const vx = c.axis === 'v' ? c.rect.x + across : c.rect.x + along
      const vy = c.axis === 'v' ? c.rect.y + along : c.rect.y + across
      if (grid.get(vx, vy) !== Tile.Hall || reserved.has(vy * w + vx)) continue
      if (Math.hypot(vx - spawnTile.x, vy - spawnTile.y) < 8) continue // no swarm at the landing
      grid.set(vx, vy, Tile.Grate)
      vents.push({ x: vx, y: vy })
    }
  }
  const splash = (count: [number, number], tile: TileId): void => {
    const n = xrng.int(count[0], count[1])
    for (let i = 0; i < n; i++) {
      const cx = xrng.int(1, w - 2)
      const cy = xrng.int(1, h - 2)
      const rad = xrng.int(1, 2)
      for (let y = cy - rad; y <= cy + rad; y++) {
        for (let x = cx - rad; x <= cx + rad; x++) {
          if (Math.abs(x - cx) + Math.abs(y - cy) > rad) continue
          const t = grid.get(x, y)
          if (isWallTile(t) || t === Tile.Grate || reserved.has(y * w + x)) continue
          grid.set(x, y, tile)
        }
      }
    }
  }
  splash(def.puddles, Tile.Bog)
  splash(def.moss, Tile.Grass)
  grid.set(exit.x, exit.y, Tile.Exit)

  // ── Emit buildings (one module per room) and wings. ────────────────────────
  const buildings: Building[] = plans.map((p) => ({
    rect: rectOf(p),
    rooms: [p.rect],
    doors: p.doors,
    role: p.role,
    poi: 'module',
    objectiveRoom: p.rect,
  }))
  const wings: Wing[] = wingRects.map((rect, wi) => ({
    rect,
    buildings: plans.flatMap((p, i) => (p.wing === wi ? [i] : [])),
  }))
  return {
    buildings,
    spawn: { x: spawnTile.x + 0.5, y: spawnTile.y + 0.5 },
    exit,
    complex: { biome, corridors, vents, wings },
  }
}

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h

/** Two room interiors separated by exactly one shared wall line. */
const sharesWall = (a: Rect, b: Rect): boolean => {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  const gapX = a.x + a.w + 1 === b.x || b.x + b.w + 1 === a.x
  const gapY = a.y + a.h + 1 === b.y || b.y + b.h + 1 === a.y
  return (gapX && overlapY > 0) || (gapY && overlapX > 0)
}

/** Wall tiles one step outside each room edge (corners excluded), with the tile
 * one further out (`ox`,`oy`) — what a door there would open onto. */
const ringSides = (r: Rect): { x: number; y: number; ox: number; oy: number }[][] => {
  const top: { x: number; y: number; ox: number; oy: number }[] = []
  const bottom: typeof top = []
  const left: typeof top = []
  const right: typeof top = []
  for (let x = r.x; x < r.x + r.w; x++) {
    top.push({ x, y: r.y - 1, ox: x, oy: r.y - 2 })
    bottom.push({ x, y: r.y + r.h, ox: x, oy: r.y + r.h + 1 })
  }
  for (let y = r.y; y < r.y + r.h; y++) {
    left.push({ x: r.x - 1, y, ox: r.x - 2, oy: y })
    right.push({ x: r.x + r.w, y, ox: r.x + r.w + 1, oy: y })
  }
  return [top, bottom, left, right]
}

/**
 * Partition a wing's interior into rooms: one strip of rooms along the wing's
 * long axis, or two back-to-back strips when the wing is deep enough. Walls are
 * 1 tile. Every room is at least 3 x 4.
 */
const splitWing = (rng: Rng, grid: TileGrid, inner: Rect): Rect[] => {
  const horizontal = inner.w >= inner.h // strips run along x
  const long = horizontal ? inner.w : inner.h
  const short = horizontal ? inner.h : inner.w
  const strips: [number, number][] = [] // [offset, depth] along the short axis
  if (short >= 11) {
    const d0 = rng.int(5, short - 6)
    strips.push([0, d0], [d0 + 1, short - d0 - 1])
    const wallAt = d0
    if (horizontal) grid.fillRect(inner.x, inner.y + wallAt, inner.w, 1, Tile.Wall)
    else grid.fillRect(inner.x + wallAt, inner.y, 1, inner.h, Tile.Wall)
  } else {
    strips.push([0, short])
  }
  const rooms: Rect[] = []
  for (const [off, depth] of strips) {
    let pos = 0
    while (pos < long) {
      const remaining = long - pos
      const len = remaining <= 12 ? remaining : rng.int(4, Math.min(12, remaining - 5))
      rooms.push(
        horizontal
          ? { x: inner.x + pos, y: inner.y + off, w: len, h: depth }
          : { x: inner.x + off, y: inner.y + pos, w: depth, h: len },
      )
      pos += len
      if (pos < long) {
        if (horizontal) grid.fillRect(inner.x + pos, inner.y + off, 1, depth, Tile.Wall)
        else grid.fillRect(inner.x + off, inner.y + pos, depth, 1, Tile.Wall)
        pos += 1
      }
    }
  }
  return rooms
}

const bfs = (grid: TileGrid, sx: number, sy: number): Uint8Array => {
  const { w, h } = grid
  const reach = new Uint8Array(w * h)
  const queue = [sy * w + sx]
  reach[queue[0]] = 1
  while (queue.length > 0) {
    const idx = queue.pop()!
    const x = idx % w
    const y = (idx / w) | 0
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx
      const ny = y + dy
      if (!grid.inBounds(nx, ny)) continue
      const n = ny * w + nx
      if (reach[n] || isWallTile(grid.get(nx, ny))) continue
      reach[n] = 1
      queue.push(n)
    }
  }
  return reach
}
