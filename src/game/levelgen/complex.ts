import type { Rng } from '../rng'
import { vlen } from '../simMath'
import {
  frameOf,
  layoutBand,
  layoutSkeleton,
  layoutZone,
  lrectToGrid,
  toGrid,
  type LRect,
  type Palette,
  type RoomStyle,
  type Skeleton,
  type Vec,
  type ZoneKind,
} from './complexLayout'
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
 * INDOOR COMPLEX generator — floors 3, 5, 7… leave the sunken streets and dive into
 * the station ring itself: a pressure hull packed with modules (mess hall,
 * bunk rooms, galley, labs, infirmary, reactor hall, stores, security) laid
 * out like a real facility floorplan.
 *
 * Construction, in order (every stage on its OWN named rng fork, so tuning one
 * stage never reshuffles another):
 *   1. SKELETON (complexLayout.ts): the primary circulation — a main spine, a
 *      tee/cross, a ladder of two spines, or a ring round a central core —
 *      oriented by a random flip/transpose, with the spawn at an airlock stub.
 *   2. BANDS → ZONES: the strips beside each spine are cut into zones (the
 *      lights-out wings) separated by shared walls or 2-wide secondary
 *      corridors (dead-end service halls, or rungs between spines). Zone
 *      depths are ragged and end zones may be left out, so the hull outline
 *      steps and notches.
 *   3. ZONING: the zone nearest the airlock is the entry (security post), the
 *      biggest is the commons (the mess hall with its galley), reactor floors
 *      get engineering halls, the rest are weighted by biome.
 *   4. ZONE INTERIORS (complexLayout.layoutZone): pillared great halls with an
 *      annex off a serving arch, bunk suites wrapped round wash closets, and
 *      staggered tiers of rooms merged into L/T shapes, with the odd chamfered
 *      corner or duct notch. A module may therefore be several rects.
 *   5. DOORS: recipe links (closet doors, serving arches) first, then a door
 *      onto the corridor at a sensible spot along the wall (halls get a second
 *      door or double doors), then an interior door for any room with no
 *      corridor frontage, then a BFS repair pass that punches through until
 *      every room is reachable — reachability is guaranteed.
 *   6. Exit at the hall tile farthest from the spawn; roles (objective
 *      deepest, mess + galley, security by the entrance, the rest from each
 *      zone's palette); per-role deck tiles; vents and biome dressing.
 *
 * A pure function of (rng, floor): the layout regenerates bit-exact from
 * seed+floor on every peer, like every other level.
 */

/** First floor built as an indoor complex. Floors below keep the city. */
export const COMPLEX_MIN_FLOOR = 3

/**
 * Does this floor use the indoor-complex generator? From floor 3 the run
 * ALTERNATES station complex and sunken city: 3, 5, 7… are complexes, 4, 6, 8…
 * stay city (so bunkers, courtyards, vaults and every district theme keep
 * turning up deep into a run).
 */
export const isComplexFloor = (floor: number): boolean =>
  floor >= COMPLEX_MIN_FLOOR && (floor - COMPLEX_MIN_FLOOR) % 2 === 0

/** 0-based position of a complex floor among complex floors (3 -> 0, 5 -> 1, …). */
const complexOrdinal = (floor: number): number => Math.floor((floor - COMPLEX_MIN_FLOOR) / 2)

/**
 * 1-based position of a city floor among CITY floors only (1 -> 1, 2 -> 2,
 * 4 -> 3, 6 -> 4, …). The city's district theme cycles on this, so the
 * alternation never starves a theme (cycling on the raw floor would only ever
 * land city floors on half of the themes).
 */
export const cityFloorOrdinal = (floor: number): number => (floor < COMPLEX_MIN_FLOOR ? floor : Math.floor(floor / 2) + 1)

/** Biomes cycle across COMPLEX floors, so consecutive complex floors never match. */
export const BIOMES: readonly BiomeName[] = ['habitation', 'flooded', 'reactor', 'overgrown']

export const biomeForFloor = (floor: number): BiomeName =>
  BIOMES[((complexOrdinal(floor) % BIOMES.length) + BIOMES.length) % BIOMES.length]

interface BiomeDef {
  /** Weights for the purpose of an ordinary zone (after entry and commons). */
  zones: readonly [ZoneKind, number][]
  /** Engineering halls this biome always gets (beyond the chance of one more). */
  engineering: number
  /** What the deepest module (the mission's target) can be. */
  objective: readonly BuildingRole[]
  /** Per-role deck tile; roles absent use `Tile.Floor`. */
  deck: Partial<Record<BuildingRole, TileId>>
  /** Deck of the ring template's open atrium, when the core is one. */
  atrium: TileId
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
  // The crew ring: bunk suites, wash blocks and the infirmary; scrubbed decks.
  habitation: {
    zones: [
      ['habitation', 5],
      ['science', 2],
      ['stores', 2],
    ],
    engineering: 0,
    objective: ['security', 'medbay', 'lab'],
    deck: TILED,
    atrium: Tile.Tiled,
    ventChance: 0.35,
    puddles: [0, 1],
    moss: [0, 0],
  },
  // The low ring the swamp is reclaiming: bog water pools across the deck.
  flooded: {
    zones: [
      ['stores', 3],
      ['habitation', 3],
      ['science', 2],
    ],
    engineering: 0,
    objective: ['lab', 'reactor'],
    deck: TILED,
    atrium: Tile.Bog,
    ventChance: 0.4,
    puddles: [9, 14],
    moss: [0, 2],
  },
  // Engineering: plated decks, stores and the humming reactor halls.
  reactor: {
    zones: [
      ['stores', 3],
      ['habitation', 2],
      ['engineering', 1],
      ['science', 1],
    ],
    engineering: 1,
    objective: ['reactor'],
    deck: { ...TILED, lab: Tile.Plating, security: Tile.Plating, quarters: Tile.Plating },
    atrium: Tile.Plating,
    ventChance: 0.45,
    puddles: [0, 2],
    moss: [0, 0],
  },
  // Where the sporefall got in: vents everywhere, moss over the plating.
  overgrown: {
    zones: [
      ['science', 4],
      ['habitation', 2],
      ['stores', 1],
    ],
    engineering: 0,
    objective: ['lab', 'medbay'],
    deck: TILED,
    atrium: Tile.Grass,
    ventChance: 0.7,
    puddles: [2, 4],
    moss: [8, 13],
  },
}

/** A zone as the generator reasons about it: a wing of the station. */
interface Zone {
  /** Grid rect, walls included (neighbours sharing a wall overlap by one). */
  rect: Rect
  /** Inner-local (u, v) → grid. */
  at: (u: number, v: number) => Vec
  iw: number
  id: number
  label: string
  core: boolean
  atrium: boolean
  kind: ZoneKind
}

/** A room as the generator reasons about it before it becomes a Building. */
interface RoomPlan {
  rects: Rect[]
  zone: number
  style: RoomStyle
  palette: Palette
  noCorridor: boolean
  doors: { x: number; y: number }[]
  /** Open archways onto another room: each is the other room + its tiles. */
  arches: { other: number; tiles: { x: number; y: number }[] }[]
  role: BuildingRole
}

export interface ComplexPlan {
  buildings: Building[]
  spawn: { x: number; y: number }
  exit: { x: number; y: number }
  complex: ComplexInfo
}

/** Biggest room a security post takes (bigger ones are stores). */
const POST_MAX = 48

/** Must match systems/complexDirector LIGHTS_WING_REACH: every corridor tile
 * lies within this many tiles of a wing (asserted by its sweep test). */
const WING_REACH = 4

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

const area = (p: RoomPlan): number => p.rects.reduce((s, r) => s + r.w * r.h, 0)

/** Bounding box of a room's rects plus its 1-tile wall ring. */
const ringRect = (rects: Rect[]): Rect => {
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 }
}

const pickWeighted = <T>(rng: Rng, items: readonly (readonly [T, number])[]): T => {
  const total = items.reduce((s, [, wt]) => s + wt, 0)
  let roll = rng.next() * total
  for (const [item, wt] of items) {
    roll -= wt
    if (roll < 0) return item
  }
  return items[items.length - 1][0]
}

/** Carve the whole indoor complex into `grid` (which it overwrites entirely). */
export const carveComplex = (rng: Rng, grid: TileGrid, floor: number): ComplexPlan => {
  const w = grid.w
  const h = grid.h
  const biome = biomeForFloor(floor)
  const def = BIOME_DEFS[biome]
  grid.fillRect(0, 0, w, h, Tile.Hull)

  // ── 1. Skeleton: the main spines. ─────────────────────────────────────────
  const sk: Skeleton = layoutSkeleton(rng.fork('skeleton'), Math.min(w, h))
  const corridors: Corridor[] = [...sk.corridors]

  // ── 2. Bands → zones + secondary corridors. ───────────────────────────────
  const zones: Zone[] = []
  for (const band of sk.bands) {
    const f = frameOf(band.rect, band.face)
    const lay = layoutBand(rng.fork(`band:${band.label}`), f.len, f.depth, band.full, band.voidEnds, {
      start: band.keepStart,
      end: band.keepEnd,
      flat: band.flat,
    })
    for (const b of lay.branches) {
      if (b.len < 2) continue
      corridors.push({ axis: band.face.y !== 0 ? 'v' : 'h', rect: lrectToGrid(f, { u: b.u0, v: 0, w: 2, h: b.len }) })
    }
    lay.zones.forEach((z, zi) => {
      zones.push({
        rect: lrectToGrid(f, { u: z.u0, v: 0, w: z.w, h: z.d }),
        at: (u, v) => toGrid(f, z.u0 + 1 + u, 1 + v),
        iw: z.w - 2,
        id: z.d - 2,
        label: `${band.label}:${zi}`,
        core: false,
        atrium: false,
        kind: 'stores',
      })
    })
  }
  for (const c of sk.cores) {
    const f = frameOf(c.rect, c.face)
    zones.push({
      rect: c.rect,
      at: (u, v) => toGrid(f, 1 + u, 1 + v),
      iw: f.len - 2,
      id: f.depth - 2,
      label: c.label,
      core: true,
      atrium: c.atrium,
      kind: 'commons',
    })
  }

  // ── 3. Zoning. ─────────────────────────────────────────────────────────────
  const zrng = rng.fork('zoning')
  const zcenter = (z: Zone): Vec => ({ x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 })
  const zdist = (z: Zone): number => vlen(zcenter(z).x - sk.spawn.x, zcenter(z).y - sk.spawn.y)
  const assigned = new Set<number>()
  const hallable = (z: Zone): boolean => z.iw >= 8 && z.id >= 6 && !z.atrium
  const biggest = (ok: (z: Zone) => boolean): number => {
    let best = -1
    zones.forEach((z, i) => {
      if (assigned.has(i) || !ok(z)) return
      if (best < 0 || z.iw * z.id > zones[best].iw * zones[best].id) best = i
    })
    return best
  }
  let entry = -1
  zones.forEach((z, i) => {
    if (z.core) return
    if (entry < 0 || zdist(z) < zdist(zones[entry])) entry = i
  })
  if (entry >= 0) {
    zones[entry].kind = 'entry'
    assigned.add(entry)
  }
  const coreIdx = zones.findIndex((z) => z.core)
  if (coreIdx >= 0) {
    assigned.add(coreIdx)
    zones[coreIdx].kind = zones[coreIdx].atrium ? 'stores' : biome === 'reactor' && zrng.chance(0.5) ? 'engineering' : 'commons'
  }
  if (!zones.some((z) => z.kind === 'commons' && !z.atrium && assigned.has(zones.indexOf(z)))) {
    const c = biggest(hallable)
    if (c >= 0) {
      zones[c].kind = 'commons'
      assigned.add(c)
    }
  }
  const engineering = def.engineering + (zrng.chance(biome === 'reactor' ? 0.4 : 0.3) ? 1 : 0)
  for (let i = 0; i < engineering; i++) {
    const e = biggest(hallable)
    if (e < 0) break
    zones[e].kind = 'engineering'
    assigned.add(e)
  }
  zones.forEach((z, i) => {
    if (assigned.has(i)) return
    z.kind = pickWeighted(zrng, def.zones)
  })
  // Symmetric plans: a mirrored zone takes its twin's purpose (not the one-offs).
  const firstByLabel = new Map<string, number>()
  zones.forEach((z, i) => {
    const twin = firstByLabel.get(z.label)
    if (twin === undefined) {
      firstByLabel.set(z.label, i)
      return
    }
    const unique = (k: ZoneKind): boolean => k === 'entry' || k === 'commons'
    if (!unique(z.kind) && !unique(zones[twin].kind)) z.kind = zones[twin].kind
  })
  // Everyone sleeps somewhere.
  if (!zones.some((z) => z.kind === 'habitation')) {
    const spare = zones.findIndex((z) => (z.kind === 'stores' || z.kind === 'science') && !z.atrium)
    if (spare >= 0) zones[spare].kind = 'habitation'
  }

  // ── 4. Carve corridors, then zone interiors. ──────────────────────────────
  // A corridor tail left beside a missing end zone would be out of every
  // wing's reach (lights-out keys off the wing the lead player is near), so
  // spine and hall ends are trimmed back until each end cross-section is
  // within WING_REACH of a wing. The airlock stub simply comes out shorter.
  const wingRects = zones.map((z) => z.rect)
  const nearWing = (x: number, y: number): boolean =>
    wingRects.some((r) => vlen(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h))) <= WING_REACH)
  for (const c of corridors) {
    const r = c.rect
    const v = c.axis === 'v'
    const len = (): number => (v ? r.h : r.w)
    const sectionOk = (i: number): boolean => {
      for (let k = 0; k < (v ? r.w : r.h); k++) {
        const x = v ? r.x + k : r.x + i
        const y = v ? r.y + i : r.y + k
        if (!nearWing(x + 0.5, y + 0.5)) return false
      }
      return true
    }
    while (len() > 3 && !sectionOk(0)) {
      if (v) {
        r.y++
        r.h--
      } else {
        r.x++
        r.w--
      }
    }
    while (len() > 3 && !sectionOk(len() - 1)) {
      if (v) r.h--
      else r.w--
    }
  }
  for (const c of corridors) grid.fillRect(c.rect.x, c.rect.y, c.rect.w, c.rect.h, Tile.Hall)
  const plans: RoomPlan[] = []
  const pendingLinks: { a: number; b: number; tiles: { x: number; y: number }[]; arch: boolean }[] = []
  const atriumOpenings: { x: number; y: number }[] = []
  zones.forEach((z, zi) => {
    grid.fillRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h, Tile.Wall)
    if (z.atrium) {
      carveAtrium(grid, z, def.atrium, atriumOpenings)
      return
    }
    const lay = layoutZone(rng.fork(`zone:${z.label}`), z.kind, z.iw, z.id, z.core)
    for (let v = 0; v < z.id; v++) {
      for (let u = 0; u < z.iw; u++) {
        const p = z.at(u, v)
        grid.set(p.x, p.y, lay.wall[v * z.iw + u] ? Tile.Wall : Tile.Floor)
      }
    }
    const base = plans.length
    const toRect = (l: LRect): Rect => {
      const a = z.at(l.u, l.v)
      const b = z.at(l.u + l.w - 1, l.v + l.h - 1)
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 }
    }
    for (const r of lay.rooms) {
      plans.push({
        rects: r.rects.map(toRect),
        zone: zi,
        style: r.style,
        palette: r.palette,
        noCorridor: r.noCorridor ?? false,
        doors: [],
        arches: [],
        role: r.palette[0][0],
      })
    }
    for (const l of lay.links) pendingLinks.push({ a: base + l.a, b: base + l.b, tiles: l.tiles.map((t) => z.at(t.u, t.v)), arch: l.arch })
  })

  // ── 5. Doors. ──────────────────────────────────────────────────────────────
  const drng = rng.fork('doors')
  const roomAt = new Int32Array(w * h).fill(-1)
  plans.forEach((p, pi) => {
    for (const r of p.rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) roomAt[y * w + x] = pi
  })
  const walkable = (x: number, y: number): boolean => grid.inBounds(x, y) && !isWallTile(grid.get(x, y))
  const doorOwners = new Map<number, number[]>() // tile key → plan indices sharing it
  const addDoor = (pi: number, x: number, y: number): void => {
    const key = y * w + x
    grid.set(x, y, Tile.Floor)
    const owners = doorOwners.get(key) ?? []
    if (!owners.includes(pi)) owners.push(pi)
    doorOwners.set(key, owners)
  }
  for (const l of pendingLinks) {
    if (l.arch) {
      for (const t of l.tiles) grid.set(t.x, t.y, Tile.Floor)
      plans[l.a].arches.push({ other: l.b, tiles: l.tiles })
      plans[l.b].arches.push({ other: l.a, tiles: l.tiles })
    } else {
      for (const t of l.tiles) {
        addDoor(l.a, t.x, t.y)
        addDoor(l.b, t.x, t.y)
      }
    }
  }

  /** Wall tiles a door could go in: a straight stretch of wall line (not a
   * junction, not inside any room) with walkable room deck on the inside and
   * walkable ground beyond. Grouped into runs along one wall line. */
  const doorRuns = (pi: number, accept: (ox: number, oy: number) => boolean): Cand[][] => {
    const seen = new Set<number>()
    const runs = new Map<string, Cand[]>()
    for (const r of plans[pi].rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (!walkable(x, y)) continue
          for (const [dx, dy] of ORTHO) {
            const wx = x + dx
            const wy = y + dy
            const key = wy * w + wx
            if (seen.has(key) || !grid.inBounds(wx, wy) || roomAt[key] >= 0 || grid.get(wx, wy) !== Tile.Wall) continue
            const ox = wx + dx
            const oy = wy + dy
            if (!walkable(ox, oy) || !accept(ox, oy)) continue
            // Straight wall: both side neighbours of the door tile are wall.
            if (walkable(wx + dy, wy + dx) || walkable(wx - dy, wy - dx)) continue
            seen.add(key)
            const line = `${dx},${dy}:${dx !== 0 ? wx : wy}`
            const run = runs.get(line) ?? []
            run.push({ x: wx, y: wy, ox, oy, along: dx !== 0 ? wy : wx })
            runs.set(line, run)
          }
        }
      }
    }
    return [...runs.values()].map((run) => run.sort((a, b) => a.along - b.along))
  }
  /** A door position a builder would pick: mid-wall, or tucked one in from an end. */
  const spot = (run: Cand[]): number => {
    if (run.length <= 2) return 0
    const choice = drng.int(0, 2)
    return choice === 0 ? Math.floor(run.length / 2) : choice === 1 ? 1 : run.length - 2
  }
  const isCorridor = (x: number, y: number): boolean => grid.get(x, y) === Tile.Hall
  plans.forEach((p, pi) => {
    if (p.noCorridor) return
    const runs = doorRuns(pi, isCorridor)
    if (runs.length === 0) return
    const order = runs.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = drng.int(0, i)
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    const first = runs[order[0]]
    const i0 = spot(first)
    addDoor(pi, first[i0].x, first[i0].y)
    const hall = p.style === 'hall'
    // Great halls take double doors now and then (a wide opening).
    if (hall && drng.chance(0.4) && i0 + 1 < first.length && first[i0 + 1].along === first[i0].along + 1) {
      addDoor(pi, first[i0 + 1].x, first[i0 + 1].y)
    }
    if (order.length > 1 && drng.chance(hall ? 0.75 : 0.15)) {
      const second = runs[order[1]]
      const i1 = spot(second)
      addDoor(pi, second[i1].x, second[i1].y)
    }
  })
  const hasAccess = (pi: number): boolean => plans[pi].arches.length > 0 || [...doorOwners.values()].some((o) => o.includes(pi))
  plans.forEach((_, pi) => {
    if (hasAccess(pi)) return
    // No corridor frontage: open into a neighbour, preferring one that
    // already has a way out (a back office through the front office).
    const runs = doorRuns(pi, (ox, oy) => roomAt[oy * w + ox] >= 0)
    if (runs.length === 0) return
    const score = (run: Cand[]): number => (hasAccess(roomAt[run[0].oy * w + run[0].ox]) ? 1 : 0)
    const best = Math.max(...runs.map(score))
    const pool = runs.filter((r) => score(r) === best)
    const run = pool[drng.int(0, pool.length - 1)]
    const c = run[Math.floor(run.length / 2)]
    addDoor(pi, c.x, c.y)
    addDoor(roomAt[c.oy * w + c.ox], c.x, c.y)
  })

  // ── Spawn at the airlock; exit at the farthest corridor deck. ─────────────
  // The airlock is the spine's end — wherever the trim above left it.
  let spawnTile = sk.spawn
  if (grid.get(spawnTile.x, spawnTile.y) !== Tile.Hall) {
    let best = Infinity
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (grid.get(x, y) !== Tile.Hall) continue
        const d = vlen(x - sk.spawn.x, y - sk.spawn.y)
        if (d < best) {
          best = d
          spawnTile = { x, y }
        }
      }
    }
  }
  let exit = { x: spawnTile.x, y: spawnTile.y }
  let exitD = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid.get(x, y) !== Tile.Hall) continue
      const d = vlen(x - spawnTile.x, y - spawnTile.y)
      if (d > exitD) {
        exitD = d
        exit = { x, y }
      }
    }
  }

  // ── Connectivity repair: punch through until every room is reachable. ──────
  for (let pass = 0; pass < plans.length + 1; pass++) {
    const reach = bfs(grid, spawnTile.x, spawnTile.y)
    const stranded = plans.map((p, i) => ({ p, i })).filter(({ p }) => !reached(p, reach, w))
    const pockets = zones.some((z) => z.atrium && !reach[z.at(0, 0).y * w + z.at(0, 0).x])
    if (stranded.length === 0 && !pockets) break
    let punched = false
    for (const { i } of stranded) {
      const runs = doorRuns(i, (ox, oy) => reach[oy * w + ox] === 1)
      if (runs.length === 0) continue
      const c = runs[0][Math.floor(runs[0].length / 2)]
      addDoor(i, c.x, c.y)
      const other = roomAt[c.oy * w + c.ox]
      if (other >= 0) addDoor(other, c.x, c.y)
      punched = true
    }
    if (!punched) break
  }

  // ── 6. Roles: objective deepest, mess + galley, security at the airlock. ───
  const orng = rng.fork('roles')
  const planRect = (p: RoomPlan): Rect => ringRect(p.rects)
  // Same metric + tie-break as missions.farthestBuilding, so the module named
  // as the objective IS the one the mission targets.
  let objective = -1
  let bestDist = -1
  plans.forEach((p, i) => {
    const r = planRect(p)
    const d = vlen(r.x + r.w / 2 - (spawnTile.x + 0.5), r.y + r.h / 2 - (spawnTile.y + 0.5))
    if (d > bestDist) {
      bestDist = d
      objective = i
    }
  })
  const roleSet = new Set<number>()
  if (objective >= 0) {
    plans[objective].role = orng.pick(def.objective)
    roleSet.add(objective)
    // The target is behind a LOCKED door: an open arch into it would bypass the
    // lock, so its arches close down to a single door.
    for (const a of plans[objective].arches) {
      const mid = a.tiles[Math.floor(a.tiles.length / 2)]
      for (const t of a.tiles) if (t !== mid) grid.set(t.x, t.y, Tile.Wall)
      addDoor(objective, mid.x, mid.y)
      addDoor(a.other, mid.x, mid.y)
      plans[a.other].arches = plans[a.other].arches.filter((b) => b.other !== objective)
    }
    plans[objective].arches = []
  }
  let mess = plans.findIndex((p, i) => !roleSet.has(i) && p.style === 'hall' && zones[p.zone].kind === 'commons')
  if (mess < 0) {
    plans.forEach((p, i) => {
      if (roleSet.has(i) || area(p) < 30) return
      if (mess < 0 || area(p) > area(plans[mess])) mess = i
    })
  }
  if (mess >= 0) {
    plans[mess].role = 'mess'
    roleSet.add(mess)
    let galley = plans[mess].arches.map((a) => a.other).find((o) => !roleSet.has(o)) ?? -1
    if (galley < 0) {
      galley = plans.findIndex(
        (p, i) => !roleSet.has(i) && p.zone === plans[mess].zone && p.rects.some((a) => plans[mess].rects.some((b) => sharesWall(a, b))),
      )
    }
    if (galley >= 0) {
      plans[galley].role = 'galley'
      roleSet.add(galley)
    }
  }
  // The security post is the booth-sized module nearest the airlock.
  let guard = -1
  let guardD = Infinity
  plans.forEach((p, i) => {
    if (roleSet.has(i) || area(p) > POST_MAX) return
    const r = planRect(p)
    const d = vlen(r.x + r.w / 2 - spawnTile.x, r.y + r.h / 2 - spawnTile.y)
    if (d < guardD) {
      guardD = d
      guard = i
    }
  })
  if (guard >= 0) {
    plans[guard].role = 'security'
    roleSet.add(guard)
  }
  plans.forEach((p, i) => {
    if (roleSet.has(i)) return
    let role = pickWeighted(orng, p.palette)
    // A second mess hall is never a thing: extra great halls are stores.
    if (role === 'mess') role = 'depot'
    // A wash block is a closet, never a hall.
    if (role === 'washroom' && area(p) > 24) role = zones[p.zone].kind === 'habitation' ? 'quarters' : 'depot'
    // A guard post is a booth, not a barracks hall.
    if (role === 'security' && area(p) > POST_MAX) role = 'depot'
    p.role = role
  })
  // Everyone sleeps somewhere: failing a bunk room, the roomiest store becomes one.
  if (!plans.some((p) => p.role === 'quarters')) {
    let dorm = -1
    plans.forEach((p, i) => {
      if (roleSet.has(i) || p.role !== 'depot') return
      if (dorm < 0 || area(p) > area(plans[dorm])) dorm = i
    })
    if (dorm >= 0) plans[dorm].role = 'quarters'
  }

  // ── Deck tiles per role (doors and arches keep the plain threshold). ───────
  for (const p of plans) {
    const deck = def.deck[p.role]
    if (deck === undefined) continue
    for (const r of p.rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) if (grid.get(x, y) === Tile.Floor) grid.set(x, y, deck)
      }
    }
  }

  // ── Dressing: vents, bog seeps, moss — never on a door, spawn or exit. ─────
  const xrng = rng.fork('decor')
  const reserved = new Set<number>([spawnTile.y * w + spawnTile.x, exit.y * w + exit.x])
  const reserve = (x: number, y: number): void => {
    reserved.add(y * w + x)
    for (const [ox, oy] of ORTHO) reserved.add((y + oy) * w + x + ox)
  }
  for (const key of doorOwners.keys()) reserve(key % w, Math.floor(key / w))
  for (const p of plans) for (const a of p.arches) for (const t of a.tiles) reserve(t.x, t.y)
  for (const t of atriumOpenings) reserve(t.x, t.y)
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
      if (vlen(vx - spawnTile.x, vy - spawnTile.y) < 8) continue // no swarm at the landing
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

  // ── Emit buildings (one module per room) and wings (one per zone). ────────
  for (const [key, owners] of doorOwners) {
    for (const pi of owners) plans[pi].doors.push({ x: key % w, y: Math.floor(key / w) })
  }
  const buildings: Building[] = plans.map((p) => {
    let main = p.rects[0]
    for (const r of p.rects) if (r.w * r.h > main.w * main.h) main = r
    return {
      rect: ringRect(p.rects),
      rooms: p.rects,
      doors: p.doors,
      role: p.role,
      poi: 'module',
      objectiveRoom: main,
    }
  })
  // The atrium is a wing too (lights-out can black out the court), listed last.
  const wings: Wing[] = []
  const wingOf = (zi: number): Wing => ({ rect: zones[zi].rect, buildings: plans.flatMap((p, i) => (p.zone === zi ? [i] : [])) })
  zones.forEach((z, zi) => {
    if (!z.atrium) wings.push(wingOf(zi))
  })
  zones.forEach((z, zi) => {
    if (z.atrium) wings.push(wingOf(zi))
  })
  return {
    buildings,
    spawn: { x: spawnTile.x + 0.5, y: spawnTile.y + 0.5 },
    exit,
    complex: { biome, corridors, vents, wings },
  }
}

interface Cand {
  x: number
  y: number
  ox: number
  oy: number
  along: number
}

/** The ring template's open core: an atrium court (biome deck, pillars round
 * the edge, a planter/pool heart) opening onto every corridor round it through
 * wide gaps. Not a module — circulation space, like the corridors. */
const carveAtrium = (grid: TileGrid, z: Zone, deck: TileId, openings: { x: number; y: number }[]): void => {
  for (let v = 0; v < z.id; v++) {
    for (let u = 0; u < z.iw; u++) {
      const p = z.at(u, v)
      const edge = u < 2 || v < 2 || u >= z.iw - 2 || v >= z.id - 2
      grid.set(p.x, p.y, edge ? Tile.Hall : deck)
    }
  }
  // Pillars ring the court, two in from the walls.
  for (let u = 1; u < z.iw - 1; u += 3) {
    for (const v of [1, z.id - 2]) {
      const p = z.at(u, v)
      grid.set(p.x, p.y, Tile.Wall)
    }
  }
  for (let v = 4; v < z.id - 2; v += 3) {
    for (const u of [1, z.iw - 2]) {
      const p = z.at(u, v)
      grid.set(p.x, p.y, Tile.Wall)
    }
  }
  // A 3-wide opening mid-way along each wall (where a corridor lies beyond).
  const open = (u: number, v: number, du: number, dv: number): void => {
    for (let k = -1; k <= 1; k++) {
      const p = z.at(u + du * k, v + dv * k)
      grid.set(p.x, p.y, Tile.Hall)
      openings.push(p)
    }
  }
  const mu = Math.floor(z.iw / 2)
  const mv = Math.floor(z.id / 2)
  // The wall ring sits at local -1 / iw / id; clear the pillars beside each gap.
  for (const [u, v, du, dv, pu, pv] of [
    [mu, -1, 1, 0, mu, 1],
    [mu, z.id, 1, 0, mu, z.id - 2],
    [-1, mv, 0, 1, 1, mv],
    [z.iw, mv, 0, 1, z.iw - 2, mv],
  ] as const) {
    open(u, v, du, dv)
    for (let k = -1; k <= 1; k++) {
      const p = z.at(pu + du * k, pv + dv * k)
      if (grid.get(p.x, p.y) === Tile.Wall) grid.set(p.x, p.y, Tile.Hall)
    }
  }
}

/** Two room interiors separated by exactly one shared wall line. */
const sharesWall = (a: Rect, b: Rect): boolean => {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  const gapX = a.x + a.w + 1 === b.x || b.x + b.w + 1 === a.x
  const gapY = a.y + a.h + 1 === b.y || b.y + b.h + 1 === a.y
  return (gapX && overlapY > 0) || (gapY && overlapX > 0)
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

/** Does the flood reach any tile of this room? */
const reached = (p: RoomPlan, reach: Uint8Array, w: number): boolean =>
  p.rects.some((r) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (reach[y * w + x]) return true
    return false
  })
