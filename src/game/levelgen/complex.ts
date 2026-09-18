import type { Rng } from '../rng'
import { vlen } from '../simMath'
import { buildAccessGraph, regionDistances, type AccessGraph } from './complexGraph'
import {
  frameOf,
  layoutBand,
  layoutSkeleton,
  layoutZone,
  lrectToGrid,
  toGrid,
  type Archetype,
  type Frame,
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
 * out like a real building's floorplan (docs/design/floorplan-principles.md,
 * cited as P1..P14).
 *
 * Construction, in order (every stage on its OWN named rng fork, so tuning one
 * stage never reshuffles another):
 *   1. SKELETON (complexLayout.ts): an archetype — Palladian axis, cloister,
 *      pavilion hospital, ship deck, or a generic spine / tee / ladder / ring —
 *      entered through a gatehouse, oriented by a random flip/transpose.
 *   2. BANDS → ZONES: the strips beside each corridor are cut into zones (the
 *      lights-out wings), with corner towers, pavilion courts or bulkheads.
 *   3. ZONING: the gate booths are the entry; ranges and wards have a fixed
 *      purpose; the biggest free zone is the commons (the mess hall with its
 *      galley), reactor floors get engineering halls, the rest are weighted by
 *      biome (a ladder's bands each keep one institution, P14).
 *   4. ZONE INTERIORS (complexLayout.layoutZone): halls, bunk suites, rooms
 *      merged into L/T shapes, enfilades (P5), servants' passages (P6), thick
 *      hull walls with niches (P7).
 *   5. DOORS: recipe links, a door onto the corridor per room, interior doors
 *      for rooms with no frontage, bulkhead hatches, then a BFS repair pass
 *      that punches through until every room is reachable. Servants'
 *      passages open last, so they are a loop and never a lifeline.
 *   6. LOOPS (P10): doors punched between rooms that touch on the map but are
 *      far apart in the room graph, and at the tips of long dead ends.
 *   7. ROLES: mess + galley, then the OBJECTIVE — the deepest module by doors
 *      crossed from the spawn (P2), behind an antechamber, on a cycle — the
 *      security post in a gate booth, the rest from each zone's palette with
 *      wet rooms clustered (P11) and reactors kept off beds (P12).
 *   8. Per-role deck tiles; vents and biome dressing.
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
  /** Deck of open courts (the ring's atrium, a cloister garth, light courts). */
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

/** What a zone is: a band of rooms, a core hall, a guard booth, or an open
 * (walkable, room-less) court. */
type ZoneType = 'band' | 'hall' | 'booth' | 'atrium' | 'cloister' | 'court'

/** A zone as the generator reasons about it: a wing of the station. */
interface Zone {
  /** Grid rect, walls included (neighbours sharing a wall overlap by one). */
  rect: Rect
  /** Inner-local (u, v) → grid. */
  at: (u: number, v: number) => Vec
  iw: number
  id: number
  label: string
  type: ZoneType
  kind: ZoneKind
  /** The purpose is fixed by the archetype (ranges, wards, booths, courts). */
  forced: boolean
  prefer?: ZoneKind
  tower: boolean
  /** Band index and band-local placement (band zones only). */
  band: number
  u0: number
  w: number
  d: number
  full: boolean
  suiteP?: number
}

const isOpen = (z: Zone): boolean => z.type === 'atrium' || z.type === 'cloister' || z.type === 'court'

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
  /** Member of an enfilade suite (P5). */
  suite: boolean
  /** Has a back door onto a servants' passage (P6). */
  service: boolean
}

/** Structure of the floor that tests (and debug renders) inspect. Not part
 * of the Level. */
export interface ComplexMeta {
  archetype: Archetype
  bent: boolean
  /** P4: the spawn's row (horizontal) or column through the landmark. */
  axis?: { horizontal: boolean; at: number }
  /** P4: the landmark room (the great hall closing the axis), if any. */
  landmark: number
  /** Doors crossed from the spawn to each building (P2). */
  depth: number[]
  /** P5: enfilade suites, building indices from antechamber to cabinet. */
  suites: number[][]
  /** P9: corner-tower rooms, and how far each projects past its neighbour. */
  towers: { building: number; projection: number }[]
  /** P3: the gatehouse guard booths. */
  booths: number[]
  /** P6: servants' passage tiles, and the buildings with a door onto one. */
  service: { tiles: number[]; buildings: number[] }
  /** P10: doors punched to close loops. */
  loops: number
  /** Ship bulkhead hatches (door tiles). */
  hatches: { x: number; y: number }[]
  /** The purpose of every zone, per band label (P8 ranges, P14 institutions). */
  bandKinds: Record<string, ZoneKind[]>
}

export interface ComplexPlan {
  buildings: Building[]
  spawn: { x: number; y: number }
  exit: { x: number; y: number }
  complex: ComplexInfo
  meta: ComplexMeta
}

/** Biggest room a security post takes (bigger ones are stores). */
const POST_MAX = 48

/** Must match systems/complexDirector LIGHTS_WING_REACH: every corridor tile
 * lies within this many tiles of a wing (asserted by its sweep test). */
const WING_REACH = 4

/** Rooms that must never share a wall with a reactor (P12). */
const QUIET: ReadonlySet<BuildingRole> = new Set(['quarters', 'medbay', 'mess'])
/** Wet rooms cluster on shared walls (P11). */
const WET: ReadonlySet<BuildingRole> = new Set(['washroom', 'galley', 'medbay'])

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

const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h

/** Carve the whole indoor complex into `grid` (which it overwrites entirely). */
export const carveComplex = (rng: Rng, grid: TileGrid, floor: number): ComplexPlan => {
  const w = grid.w
  const h = grid.h
  const biome = biomeForFloor(floor)
  const def = BIOME_DEFS[biome]
  grid.fillRect(0, 0, w, h, Tile.Hull)

  // ── 1. Skeleton: the archetype's primary circulation. ─────────────────────
  const sk: Skeleton = layoutSkeleton(rng.fork('skeleton'), Math.min(w, h))
  const corridors: Corridor[] = [...sk.corridors]

  // ── 2. Bands → zones + secondary corridors. ───────────────────────────────
  const zones: Zone[] = []
  const frames: Frame[] = []
  sk.bands.forEach((band, bi) => {
    const f = frameOf(band.rect, band.face)
    frames.push(f)
    const lay = layoutBand(rng.fork(`band:${band.label}`), f.len, f.depth, band.full, band.voidEnds, {
      start: band.keepStart,
      end: band.keepEnd,
      flat: band.flat,
      towerStart: band.towerStart,
      towerEnd: band.towerEnd,
      taperStart: band.taperStart,
      taperEnd: band.taperEnd,
      anchorStart: band.anchorStart,
      anchorEnd: band.anchorEnd,
      noBranch: band.noBranch,
      sep: band.sep,
    })
    for (const b of lay.branches) {
      if (b.len < 2) continue
      corridors.push({ axis: band.face.y !== 0 ? 'v' : 'h', rect: lrectToGrid(f, { u: b.u0, v: 0, w: 2, h: b.len }) })
    }
    const base = { forced: band.kind !== undefined, prefer: band.prefer, band: bi, full: band.full, suiteP: band.suiteP }
    lay.zones.forEach((z, zi) => {
      zones.push({
        ...base,
        rect: lrectToGrid(f, { u: z.u0, v: 0, w: z.w, h: z.d }),
        at: (u, v) => toGrid(f, z.u0 + 1 + u, 1 + v),
        iw: z.w - 2,
        id: z.d - 2,
        label: `${band.label}:${zi}`,
        type: 'band',
        kind: band.kind ?? 'stores',
        tower: !!z.tower,
        u0: z.u0,
        w: z.w,
        d: z.d,
      })
    })
    lay.courts.forEach((c, ci) => {
      zones.push({
        ...base,
        forced: true,
        rect: lrectToGrid(f, { u: c.u0, v: 0, w: c.w, h: c.d }),
        at: (u, v) => toGrid(f, c.u0 + 1 + u, 1 + v),
        iw: c.w - 2,
        id: c.d - 2,
        label: `${band.label}:court${ci}`,
        type: 'court',
        kind: 'stores',
        tower: false,
        u0: c.u0,
        w: c.w,
        d: c.d,
      })
    })
  })
  for (const c of sk.cores) {
    const f = frameOf(c.rect, c.face)
    zones.push({
      rect: c.rect,
      at: (u, v) => toGrid(f, 1 + u, 1 + v),
      iw: f.len - 2,
      id: f.depth - 2,
      label: c.label,
      type: c.type,
      kind: c.type === 'booth' ? 'entry' : c.type === 'hall' ? 'commons' : 'stores',
      forced: c.type !== 'hall',
      tower: false,
      band: -1,
      u0: 0,
      w: f.len,
      d: f.depth,
      full: true,
    })
  }

  // ── 3. Zoning. ─────────────────────────────────────────────────────────────
  const zrng = rng.fork('zoning')
  const zcenter = (z: Zone): Vec => ({ x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 })
  const zdist = (z: Zone): number => vlen(zcenter(z).x - sk.spawn.x, zcenter(z).y - sk.spawn.y)
  const assigned = new Set<number>()
  zones.forEach((z, i) => {
    if (z.forced) assigned.add(i)
  })
  const hallable = (z: Zone): boolean => z.iw >= 8 && z.id >= 6 && (z.type === 'band' || z.type === 'hall') && !z.tower
  const biggest = (ok: (z: Zone) => boolean): number => {
    let best = -1
    zones.forEach((z, i) => {
      if (assigned.has(i) || !ok(z)) return
      if (best < 0 || z.iw * z.id > zones[best].iw * zones[best].id) best = i
    })
    return best
  }
  if (!zones.some((z) => z.type === 'booth')) {
    let entry = -1
    zones.forEach((z, i) => {
      if (z.type !== 'band' || assigned.has(i)) return
      if (entry < 0 || zdist(z) < zdist(zones[entry])) entry = i
    })
    if (entry >= 0) {
      zones[entry].kind = 'entry'
      assigned.add(entry)
    }
  }
  zones.forEach((z, i) => {
    if (z.type !== 'hall') return
    assigned.add(i)
    z.kind = biome === 'reactor' && zrng.chance(0.5) ? 'engineering' : 'commons'
  })
  // Ship: engineering aft by the airlock, control (science) at the bow.
  if (sk.template === 'ship') {
    const hull = zones.map((z, i) => ({ z, i })).filter(({ z, i }) => z.type === 'band' && !assigned.has(i))
    hull.sort((a, b) => zdist(a.z) - zdist(b.z))
    hull.forEach(({ z, i }, k) => {
      if (k < 2 && hallable(z)) z.kind = 'engineering'
      else if (k >= hull.length - 2) z.kind = 'science'
      else return
      assigned.add(i)
    })
  }
  if (!zones.some((z) => z.kind === 'commons' && (z.type === 'band' || z.type === 'hall'))) {
    const c = biggest(hallable)
    if (c >= 0) {
      zones[c].kind = 'commons'
      assigned.add(c)
    }
  }
  if (sk.template !== 'ship') {
    const engineering = def.engineering + (zrng.chance(biome === 'reactor' ? 0.4 : 0.3) ? 1 : 0)
    for (let i = 0; i < engineering; i++) {
      const e = biggest(hallable)
      if (e < 0) break
      zones[e].kind = 'engineering'
      assigned.add(e)
    }
  }
  zones.forEach((z, i) => {
    if (assigned.has(i)) return
    // P14: a ladder's band is one institution, most of the time.
    z.kind = z.prefer && zrng.chance(0.8) ? z.prefer : pickWeighted(zrng, def.zones)
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
    if (!z.forced && !unique(z.kind) && !unique(zones[twin].kind)) z.kind = zones[twin].kind
  })
  // Everyone sleeps somewhere.
  if (!zones.some((z) => z.kind === 'habitation' || z.kind === 'ward')) {
    const spare = zones.findIndex((z) => (z.kind === 'stores' || z.kind === 'science') && z.type === 'band' && !z.forced)
    if (spare >= 0) zones[spare].kind = 'habitation'
  }

  // ── 4. Carve corridors, then zone interiors. ──────────────────────────────
  // A corridor tail left beside a missing end zone would be out of every
  // wing's reach (lights-out keys off the wing the lead player is near), so
  // spine and hall ends are trimmed back until each end cross-section is
  // within WING_REACH of a wing.
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
  // What the skeleton occupies: a zone whose back row looks out on none of
  // it backs onto open hull (where a thick wall cannot cut a room off).
  const occupied = new Uint8Array(w * h)
  for (const r of [...zones.map((z) => z.rect), ...corridors.map((c) => c.rect)]) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (grid.inBounds(x, y)) occupied[y * w + x] = 1
  }
  const hullBacked = (z: Zone): boolean => {
    for (let u = 0; u < z.iw; u++) {
      const p = z.at(u, z.id + 1)
      if (grid.inBounds(p.x, p.y) && occupied[p.y * w + p.x]) return false
    }
    return true
  }
  const plans: RoomPlan[] = []
  const pendingLinks: { a: number; b: number; tiles: { x: number; y: number }[]; arch: boolean }[] = []
  const openTiles: { x: number; y: number }[] = []
  const suitesPlan: number[][] = []
  const towersPlan: { plan: number; zone: number }[] = []
  const passages: { tiles: Vec[]; ends: { wall: Vec; beyond: Vec }[]; doors: { plan: number; tile: Vec }[] }[] = []
  zones.forEach((z, zi) => {
    grid.fillRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h, Tile.Wall)
    if (z.type === 'atrium') {
      carveAtrium(grid, z, def.atrium, openTiles)
      return
    }
    if (z.type === 'cloister') {
      carveCloister(grid, z, def.atrium)
      return
    }
    if (z.type === 'court') {
      carveCourt(grid, z, def.atrium, openTiles)
      return
    }
    // P7: the hull wall behind a band zone grows thick now and then.
    const prng = rng.fork(`poche:${z.label}`)
    const thick = z.type === 'band' && !z.full && !z.tower && hullBacked(z) && prng.chance(0.5) ? prng.int(1, 2) : 0
    // P6: a servants' passage in a deep band (never through the dormitory).
    const srng = rng.fork(`service:${z.label}`)
    const service = z.type === 'band' && !z.tower && z.d > 14 && !['habitation', 'ward', 'entry'].includes(z.kind) && srng.chance(0.5)
    const lay = layoutZone(rng.fork(`zone:${z.label}`), z.kind, z.iw, z.id, {
      core: z.type === 'hall',
      booth: z.type === 'booth',
      tower: z.tower,
      service,
      thick,
      suiteP: z.suiteP,
    })
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
    const inSuite = new Set(lay.suites.flat())
    lay.rooms.forEach((r, ri) => {
      plans.push({
        rects: r.rects.map(toRect),
        zone: zi,
        style: r.style,
        palette: r.palette,
        noCorridor: r.noCorridor ?? false,
        doors: [],
        arches: [],
        role: r.palette[0][0],
        suite: inSuite.has(ri),
        service: false,
      })
    })
    for (const l of lay.links) pendingLinks.push({ a: base + l.a, b: base + l.b, tiles: l.tiles.map((t) => z.at(t.u, t.v)), arch: l.arch })
    for (const s of lay.suites) suitesPlan.push(s.map((r) => base + r))
    if (lay.tower !== undefined) towersPlan.push({ plan: base + lay.tower, zone: zi })
    if (lay.service) {
      const { v0, h: ph } = lay.service
      const tiles: Vec[] = []
      const ends: { wall: Vec; beyond: Vec }[] = []
      for (let v = v0; v < v0 + ph; v++) {
        for (let u = 0; u < z.iw; u++) tiles.push(z.at(u, v))
        ends.push({ wall: z.at(-1, v), beyond: z.at(-2, v) }, { wall: z.at(z.iw, v), beyond: z.at(z.iw + 1, v) })
      }
      passages.push({ tiles, ends, doors: lay.serviceDoors.map((s) => ({ plan: base + s.room, tile: z.at(s.u, s.v) })) })
    }
  })
  // The gatehouse's inner wall and its door, the gate into the cloister.
  for (const r of sk.walls) grid.fillRect(r.x, r.y, r.w, r.h, Tile.Wall)
  for (const p of sk.openings) {
    grid.set(p.x, p.y, Tile.Hall)
    openTiles.push(p)
  }

  // ── 5. Doors. ──────────────────────────────────────────────────────────────
  const drng = rng.fork('doors')
  const roomAt = new Int32Array(w * h).fill(-1)
  const claim = (pi: number): void => {
    for (const r of plans[pi].rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) roomAt[y * w + x] = pi
  }
  plans.forEach((_, pi) => claim(pi))
  const walkable = (x: number, y: number): boolean => grid.inBounds(x, y) && !isWallTile(grid.get(x, y))
  const doorOwners = new Map<number, number[]>() // tile key → plan indices sharing it
  /** Service doors onto passages from corridors: barriers, but no room's door. */
  const circDoors = new Set<number>()
  const addDoor = (pi: number, x: number, y: number): void => {
    const key = y * w + x
    grid.set(x, y, Tile.Floor)
    const owners = doorOwners.get(key) ?? []
    if (!owners.includes(pi)) owners.push(pi)
    doorOwners.set(key, owners)
  }
  const link = (a: number, b: number, x: number, y: number): void => {
    addDoor(a, x, y)
    if (b >= 0) addDoor(b, x, y)
  }
  for (const l of pendingLinks) {
    if (l.arch) {
      for (const t of l.tiles) grid.set(t.x, t.y, Tile.Floor)
      plans[l.a].arches.push({ other: l.b, tiles: l.tiles })
      plans[l.b].arches.push({ other: l.a, tiles: l.tiles })
    } else {
      for (const t of l.tiles) link(l.a, l.b, t.x, t.y)
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
  // P5: a suite's antechamber is whichever end room has corridor frontage.
  const inner = new Set<number>()
  for (const s of suitesPlan) {
    const last = s[s.length - 1]
    if (doorRuns(s[0], isCorridor).length === 0 && doorRuns(last, isCorridor).length > 0) {
      s.reverse()
      plans[s[0]].noCorridor = false
      plans[last].noCorridor = true
    }
    for (const r of s.slice(1)) inner.add(r)
  }
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
    // A second corridor door — never for a booth, a tower or an antechamber.
    if (p.style !== 'booth' && !p.suite && order.length > 1 && drng.chance(hall ? 0.75 : 0.15)) {
      const second = runs[order[1]]
      const i1 = spot(second)
      addDoor(pi, second[i1].x, second[i1].y)
    }
  })
  const accessSet = (): Set<number> => {
    const s = new Set<number>()
    for (const o of doorOwners.values()) for (const pi of o) s.add(pi)
    plans.forEach((p, pi) => {
      if (p.arches.length > 0) s.add(pi)
    })
    return s
  }
  const withAccess = accessSet()
  // A suite whose rooms only open into each other has no way in yet: its
  // antechamber takes the interior door below.
  for (const su of suitesPlan) {
    const members = new Set(su)
    const outside = [...doorOwners.values()].some((o) => o.some((pi) => members.has(pi)) && (o.length === 1 || o.some((pi) => !members.has(pi))))
    if (!outside) withAccess.delete(su[0])
  }
  plans.forEach((_, pi) => {
    if (withAccess.has(pi)) return
    // No corridor frontage: open into a neighbour, preferring one that
    // already has a way out (a back office through the front office).
    // Never through the inner rooms of a suite (their doors stay on one line).
    let runs = doorRuns(pi, (ox, oy) => roomAt[oy * w + ox] >= 0 && !inner.has(roomAt[oy * w + ox]))
    if (runs.length === 0) runs = doorRuns(pi, (ox, oy) => roomAt[oy * w + ox] >= 0)
    if (runs.length === 0) return
    const score = (run: Cand[]): number => (withAccess.has(roomAt[run[0].oy * w + run[0].ox]) ? 1 : 0)
    const best = Math.max(...runs.map(score))
    const pool = runs.filter((r) => score(r) === best)
    const run = pool[drng.int(0, pool.length - 1)]
    const c = run[Math.floor(run.length / 2)]
    link(pi, roomAt[c.oy * w + c.ox], c.x, c.y)
    if (withAccess.has(roomAt[c.oy * w + c.ox])) withAccess.add(pi)
  })

  // Ship bulkheads: a hatch through every bulkhead, all on one line (P5).
  const hatches: Vec[] = []
  sk.bands.forEach((band, bi) => {
    if (!band.hatch) return
    const f = frames[bi]
    const bz = zones.filter((z) => z.band === bi && z.type === 'band').sort((a, b) => a.u0 - b.u0)
    if (bz.length < 2) return
    const dmin = Math.min(...bz.map((z) => z.d))
    const hv = rng.fork(`hatch:${band.label}`).int(2, Math.max(2, dmin - 3))
    for (let i = 0; i + 1 < bz.length; i++) {
      const u = bz[i].u0 + bz[i].w - 1
      for (const dv of [0, 1, -1, 2, -2, 3, -3]) {
        const v = hv + dv
        if (v < 1 || v > dmin - 2) continue
        const t = toGrid(f, u, v)
        const l = toGrid(f, u - 1, v)
        const r = toGrid(f, u + 1, v)
        const a = toGrid(f, u, v - 1)
        const b = toGrid(f, u, v + 1)
        const ra = roomAt[l.y * w + l.x]
        const rb = roomAt[r.y * w + r.x]
        if (grid.get(t.x, t.y) !== Tile.Wall || ra < 0 || rb < 0 || ra === rb || !walkable(l.x, l.y) || !walkable(r.x, r.y)) continue
        if (walkable(a.x, a.y) || walkable(b.x, b.y)) continue
        link(ra, rb, t.x, t.y)
        hatches.push(t)
        break
      }
    }
  })

  // ── Spawn at the airlock; exit at the farthest corridor deck. ─────────────
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
    const pockets = zones.some((z) => isOpen(z) && !reach[z.at(0, 0).y * w + z.at(0, 0).x])
    if (stranded.length === 0 && !pockets) break
    let punched = false
    for (const { i } of stranded) {
      const runs = doorRuns(i, (ox, oy) => reach[oy * w + ox] === 1)
      if (runs.length === 0) continue
      const c = runs[0][Math.floor(runs[0].length / 2)]
      link(i, roomAt[c.oy * w + c.ox], c.x, c.y)
      punched = true
    }
    if (!punched) break
  }

  // ── P6: open the servants' passages — last, so each is a loop, not a
  // lifeline: every room already has its own way in. ───────────────────────
  const passageKeys = new Set<number>()
  for (const ps of passages) for (const t of ps.tiles) if (grid.get(t.x, t.y) === Tile.Floor) passageKeys.add(t.y * w + t.x)
  const serviceTiles: number[] = []
  const passageOf = new Map<number, number>()
  passages.forEach((ps, i) => {
    for (const t of ps.tiles) if (passageKeys.has(t.y * w + t.x)) passageOf.set(t.y * w + t.x, i)
  })
  const opens = passages.map((ps) => ({
    doors: ps.doors.filter((d) => grid.get(d.tile.x, d.tile.y) === Tile.Wall),
    ends: ps.ends
      .filter((e) => grid.get(e.wall.x, e.wall.y) === Tile.Wall && roomAt[e.wall.y * w + e.wall.x] < 0)
      .map((e) => ({ wall: e.wall, into: grid.get(e.beyond.x, e.beyond.y) === Tile.Hall ? -1 : (passageOf.get(e.beyond.y * w + e.beyond.x) ?? -2) }))
      .filter((e) => e.into !== -2),
  }))
  // A passage with fewer than two ways out is a dead end, not a loop: it is
  // walled up — and so is any end that led only into one.
  // Passages joined end to end form one run; a run lives on its doors and
  // its ends onto corridors.
  const group = passages.map((_, i) => i)
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])))
  opens.forEach((o, i) => {
    for (const e of o.ends) if (e.into >= 0) group[root(i)] = root(e.into)
  })
  const exits = new Map<number, number>()
  opens.forEach((o, i) => exits.set(root(i), (exits.get(root(i)) ?? 0) + o.doors.length + o.ends.filter((e) => e.into === -1).length))
  const live = passages.map((_, i) => (exits.get(root(i)) ?? 0) >= 2)
  passages.forEach((ps, i) => {
    const on = live[i]
    if (on) {
      for (const d of opens[i].doors) {
        addDoor(d.plan, d.tile.x, d.tile.y)
        plans[d.plan].service = true
      }
      for (const e of opens[i].ends) {
        if (e.into >= 0 && !live[e.into]) continue
        grid.set(e.wall.x, e.wall.y, Tile.Plating)
        circDoors.add(e.wall.y * w + e.wall.x)
      }
    }
    for (const t of ps.tiles) {
      if (!passageKeys.has(t.y * w + t.x)) continue
      grid.set(t.x, t.y, on ? Tile.Plating : Tile.Wall)
      if (on) serviceTiles.push(t.y * w + t.x)
    }
  })

  // ── 6. Loops (P10) — on the justified access graph. ───────────────────────
  const barriers = (): Set<number> => {
    const s = new Set<number>(doorOwners.keys())
    for (const p of plans) for (const a of p.arches) for (const t of a.tiles) s.add(t.y * w + t.x)
    for (const k of circDoors) s.add(k)
    return s
  }
  const spawnKey = spawnTile.y * w + spawnTile.x
  let g: AccessGraph = buildAccessGraph(grid, barriers(), spawnKey)
  const regionOf = (pi: number): number => {
    for (const r of plans[pi].rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const reg = g.region[y * w + x]
          if (reg >= 0) return reg
        }
      }
    }
    return -1
  }
  const depthOf = (pi: number): number => {
    const r = regionOf(pi)
    return r < 0 ? -1 : g.depth[r]
  }
  const loopable = (pi: number): boolean => {
    const p = plans[pi]
    return p.style !== 'closet' && p.style !== 'booth' && p.style !== 'tower' && !p.suite
  }
  const lrng = rng.fork('loops')
  const cands: { a: number; b: number; run: Cand[] }[] = []
  plans.forEach((_, a) => {
    if (!loopable(a)) return
    const byOther = new Map<number, Cand[]>()
    for (const run of doorRuns(a, (ox, oy) => {
      const o = roomAt[oy * w + ox]
      return o > a && loopable(o)
    })) {
      // One wall line may face several rooms: split it per room beyond.
      const per = new Map<number, Cand[]>()
      for (const t of run) {
        const o = roomAt[t.oy * w + t.ox]
        per.set(o, [...(per.get(o) ?? []), t])
      }
      for (const [o, part] of per) {
        const had = byOther.get(o)
        if (!had || part.length > had.length) byOther.set(o, part)
      }
    }
    for (const [b, run] of byOther) if (run.length >= 3) cands.push({ a, b, run })
  })
  for (let i = cands.length - 1; i > 0; i--) {
    const j = lrng.int(0, i)
    ;[cands[i], cands[j]] = [cands[j], cands[i]]
  }
  const roomZones = zones.filter((z) => !isOpen(z) && z.type !== 'booth').length
  const maxLoops = 2 + Math.floor(roomZones / 2)
  let loops = 0
  const used = new Set<number>()
  for (const threshold of [4, 3]) {
    for (let ci = 0; ci < cands.length && loops < maxLoops; ci++) {
      if (used.has(ci)) continue
      const { a, b, run } = cands[ci]
      const ra = regionOf(a)
      const rb = regionOf(b)
      if (ra < 0 || rb < 0) continue
      const dist = regionDistances(g, ra)[rb]
      if (dist >= 0 && dist < threshold) continue
      if (threshold === 4 && !lrng.chance(0.5)) continue
      const c = run[Math.floor(run.length / 2)]
      link(a, b, c.x, c.y)
      g.adj[ra].add(rb)
      g.adj[rb].add(ra)
      used.add(ci)
      loops++
    }
    if (loops >= 2) break
  }
  // Long dead-end halls get a door at the tip into the room beyond (60%).
  for (const c of corridors) {
    const r = c.rect
    const across = c.axis === 'h' ? r.h : r.w
    const length = c.axis === 'h' ? r.w : r.h
    if (across !== 2 || length <= 10) continue
    for (const [e, dir] of [
      [c.axis === 'h' ? r.x - 1 : r.y - 1, -1],
      [c.axis === 'h' ? r.x + r.w : r.y + r.h, 1],
    ] as const) {
      const cap = Array.from({ length: across }, (_, k) => (c.axis === 'h' ? { x: e, y: r.y + k } : { x: r.x + k, y: e }))
      if (cap.some((t) => walkable(t.x, t.y)) || !lrng.chance(0.6)) continue
      const t = cap[lrng.int(0, across - 1)]
      const bx = c.axis === 'h' ? t.x + dir : t.x
      const by = c.axis === 'h' ? t.y : t.y + dir
      const o = roomAt[by * w + bx]
      if (o < 0 || !walkable(bx, by) || !loopable(o) || roomAt[t.y * w + t.x] >= 0 || grid.get(t.x, t.y) !== Tile.Wall) continue
      addDoor(o, t.x, t.y)
      loops++
    }
  }
  g = buildAccessGraph(grid, barriers(), spawnKey)

  // ── 7. Roles. ──────────────────────────────────────────────────────────────
  const orng = rng.fork('roles')
  const roleSet = new Set<number>()
  let mess = plans.findIndex((p) => p.style === 'hall' && zones[p.zone].kind === 'commons')
  if (mess < 0) {
    plans.forEach((p, i) => {
      if (area(p) < 30 || p.style === 'tower') return
      if (mess < 0 || area(p) > area(plans[mess])) mess = i
    })
  }
  if (mess >= 0) {
    plans[mess].role = 'mess'
    roleSet.add(mess)
    let galley = plans[mess].arches.map((a) => a.other).find((o) => !roleSet.has(o)) ?? -1
    if (galley < 0) {
      galley = plans.findIndex(
        (p, i) =>
          !roleSet.has(i) && p.style !== 'booth' && p.zone === plans[mess].zone && p.rects.some((a) => plans[mess].rects.some((b) => sharesWall(a, b))),
      )
    }
    if (galley >= 0) {
      plans[galley].role = 'galley'
      roleSet.add(galley)
    }
  }
  const touches = (i: number, j: number): boolean => plans[i].rects.some((a) => plans[j].rects.some((b) => sharesWall(a, b)))

  // P2: the objective is the DEEPEST module by doors crossed from the spawn
  // (ties to the farthest), among the far half of the floor; if nothing there
  // is 3 doors deep, a far room is split so it gains an antechamber.
  const objRole = orng.pick(def.objective)
  const distOf = (pi: number): number => {
    const r = ringRect(plans[pi].rects)
    return vlen(r.x + r.w / 2 - (spawnTile.x + 0.5), r.y + r.h / 2 - (spawnTile.y + 0.5))
  }
  let maxDist = 0
  plans.forEach((_, i) => (maxDist = Math.max(maxDist, distOf(i))))
  const eligible = (pi: number, frac: number): boolean => {
    const p = plans[pi]
    if (roleSet.has(pi) || area(p) < 16 || p.style === 'closet' || p.style === 'booth' || distOf(pi) < frac * maxDist) return false
    // A reactor objective never shares a wall with the mess hall (P12).
    return !(objRole === 'reactor' && mess >= 0 && touches(pi, mess))
  }
  const better = (a: number, b: number): boolean => b < 0 || depthOf(a) > depthOf(b) || (depthOf(a) === depthOf(b) && distOf(a) > distOf(b))
  let objective = -1
  // Widen the search toward the spawn only when the far rooms cannot be
  // made 3 deep.
  for (const frac of [0.55, 0.4, 0.25, 0]) {
    let best = -1
    plans.forEach((_, i) => {
      if (eligible(i, frac) && better(i, best)) best = i
    })
    if (best >= 0 && depthOf(best) < 3) {
      const order = plans.map((_, i) => i).filter((i) => eligible(i, frac))
      order.sort((x, y) => depthOf(y) - depthOf(x) || distOf(y) - distOf(x))
      for (const c of order.slice(0, 20)) {
        if (depthOf(c) < 1) continue
        if (rewire(c)) {
          g = buildAccessGraph(grid, barriers(), spawnKey)
          if (better(c, best)) best = c
          if (depthOf(best) >= 3) break
        }
        let cab = splitRoom(c)
        if (cab < 0) continue
        g = buildAccessGraph(grid, barriers(), spawnKey)
        if (depthOf(cab) < 3) {
          const cab2 = splitRoom(cab)
          if (cab2 >= 0) {
            cab = cab2
            g = buildAccessGraph(grid, barriers(), spawnKey)
          }
        }
        if (better(cab, best)) best = cab
        if (depthOf(best) >= 3) break
      }
    }
    if (best >= 0 && (objective < 0 || depthOf(best) > depthOf(objective))) objective = best
    if (objective >= 0 && depthOf(objective) >= 3) break
  }
  if (objective < 0) {
    plans.forEach((p, i) => {
      if (!roleSet.has(i) && p.style !== 'closet' && better(i, objective)) objective = i
    })
  }

  /** P2: move a room's way in behind a neighbour — wall up its corridor
   * doors and door it through the deepest room beside it instead, so the
   * neighbour becomes its antechamber. Reachability holds: the neighbour is
   * reachable, and so is everything that was reached through this room. */
  function rewire(pi: number): boolean {
    const p = plans[pi]
    if (p.arches.length > 0 || (p.style !== 'room' && p.style !== 'tower') || p.suite) return false
    const onHall = (k: number): boolean =>
      ORTHO.some(([dx, dy]) => {
        const t = grid.get((k % w) + dx, ((k / w) | 0) + dy)
        return t === Tile.Hall || t === Tile.Grate
      })
    const front = [...doorOwners].filter(([k, o]) => o.length === 1 && o[0] === pi && onHall(k)).map(([k]) => k)
    if (front.length === 0) return false
    // Depths with this room taken out: the new antechamber must not itself
    // be reached through this room.
    // ...nor through a servants' passage, which must never become a lifeline.
    const skip = new Set<number>([regionOf(pi), ...serviceTiles.map((k) => g.region[k])])
    const start = g.region[spawnKey]
    const alt = new Array<number>(g.adj.length).fill(-1)
    alt[start] = 0
    const queue = [start]
    for (let qi = 0; qi < queue.length; qi++) {
      for (const s2 of g.adj[queue[qi]]) {
        if (alt[s2] >= 0 || skip.has(s2)) continue
        alt[s2] = alt[queue[qi]] + 1
        queue.push(s2)
      }
    }
    let bestRun: Cand[] | undefined
    let bestD = 0
    for (const run of doorRuns(pi, (ox, oy) => {
      const o = roomAt[oy * w + ox]
      return o >= 0 && o !== pi && loopable(o) && plans[o].style !== 'closet' && o !== mess
    })) {
      const d = alt[regionOf(roomAt[run[0].oy * w + run[0].ox])] ?? -1
      if (d > bestD) {
        bestD = d
        bestRun = run
      }
    }
    if (!bestRun || bestD + 1 <= depthOf(pi)) return false
    for (const k of front) {
      doorOwners.delete(k)
      grid.set(k % w, (k / w) | 0, Tile.Wall)
    }
    const c = bestRun[Math.floor(bestRun.length / 2)]
    link(pi, roomAt[c.oy * w + c.ox], c.x, c.y)
    return true
  }

  /** P2/P12 antechamber: wall a far room in two, all its doors on one side;
   * the other side becomes a new room reached only through it. Returns the
   * new room, or -1 when the room cannot be split. */
  function splitRoom(pi: number): number {
    const p = plans[pi]
    if (p.arches.length > 0 || (p.style !== 'room' && p.style !== 'tower')) return -1
    let mi = 0
    p.rects.forEach((r, i) => {
      if (r.w * r.h > p.rects[mi].w * p.rects[mi].h) mi = i
    })
    const m = p.rects[mi]
    const others = p.rects.filter((_, i) => i !== mi)
    // Only niches (1x1, 1x2) may ride along; an L or T room is never split.
    if (others.some((r) => Math.min(r.w, r.h) > 1 || Math.max(r.w, r.h) > 2)) return -1
    const vert = m.w >= m.h // a wall column across a wide room
    const len = vert ? m.w : m.h
    if (len < 8) return -1
    const lo = vert ? m.x : m.y
    const hi = lo + len - 1
    const access: number[] = []
    for (const [k, owners] of doorOwners) {
      if (!owners.includes(pi)) continue
      const x = k % w
      const y = (k / w) | 0
      for (const [dx, dy] of ORTHO) if (inRect(m, x + dx, y + dy)) access.push(vert ? x + dx : y + dy)
    }
    if (access.length === 0) return -1
    const aMin = Math.min(...access)
    const aMax = Math.max(...access)
    const mid = lo + Math.floor(len / 2)
    const tries: { c: number; high: boolean }[] = []
    for (let c = Math.max(aMax + 1, lo + 3); c <= hi - 4; c++) tries.push({ c, high: true })
    for (let c = lo + 4; c <= Math.min(aMin - 1, hi - 3); c++) tries.push({ c, high: false })
    tries.sort((a, b) => Math.abs(a.c - mid) - Math.abs(b.c - mid))
    const at = (a: number, b: number): Vec => (vert ? { x: a, y: b } : { x: b, y: a })
    const b0 = vert ? m.y : m.x
    const b1 = b0 + (vert ? m.h : m.w) - 1
    for (const { c, high } of tries) {
      const e0 = at(c, b0 - 1)
      const e1 = at(c, b1 + 1)
      if (walkable(e0.x, e0.y) || walkable(e1.x, e1.y)) continue
      let door = -1
      for (let t = b0; t <= b1; t++) {
        const s0 = at(c - 1, t)
        const s1 = at(c + 1, t)
        if (!walkable(s0.x, s0.y) || !walkable(s1.x, s1.y)) continue
        if (door < 0 || Math.abs(t - (b0 + b1) / 2) < Math.abs(door - (b0 + b1) / 2)) door = t
      }
      if (door < 0) continue
      const part = (from: number, to: number): Rect =>
        vert ? { x: from, y: m.y, w: to - from + 1, h: m.h } : { x: m.x, y: from, w: m.w, h: to - from + 1 }
      const cabRect = high ? part(c + 1, hi) : part(lo, c - 1)
      const anteRect = high ? part(lo, c - 1) : part(c + 1, hi)
      const side = (r: Rect): boolean => ((vert ? r.x : r.y) > c) === high
      const cab: RoomPlan = {
        rects: [cabRect, ...others.filter(side)],
        zone: p.zone,
        style: 'room',
        palette: p.palette,
        noCorridor: true,
        doors: [],
        arches: [],
        role: p.role,
        suite: false,
        service: false,
      }
      p.rects = [anteRect, ...others.filter((r) => !side(r))]
      for (let t = b0; t <= b1; t++) {
        const q = at(c, t)
        grid.set(q.x, q.y, Tile.Wall)
        roomAt[q.y * w + q.x] = -1
      }
      plans.push(cab)
      const ci = plans.length - 1
      claim(ci)
      const d = at(c, door)
      link(pi, ci, d.x, d.y)
      return ci
    }
    return -1
  }

  if (objective >= 0) {
    plans[objective].role = objRole
    roleSet.add(objective)
    // The target is behind a LOCKED door: an open arch into it would bypass the
    // lock, so its arches close down to a single door.
    for (const a of plans[objective].arches) {
      const mid = a.tiles[Math.floor(a.tiles.length / 2)]
      for (const t of a.tiles) if (t !== mid) grid.set(t.x, t.y, Tile.Wall)
      link(objective, a.other, mid.x, mid.y)
      plans[a.other].arches = plans[a.other].arches.filter((b) => b.other !== objective)
    }
    plans[objective].arches = []
    // P10: the objective lies on a cycle — a second way in from a room that
    // is itself 2+ doors deep, so the objective stays 3 deep.
    g = buildAccessGraph(grid, barriers(), spawnKey)
    const ro = regionOf(objective)
    const runs = doorRuns(objective, (ox, oy) => {
      const o = roomAt[oy * w + ox]
      if (o < 0 || o === objective || !loopable(o) || plans[o].style === 'closet') return false
      const r = regionOf(o)
      return r >= 0 && !g.adj[ro]?.has(r) && depthOf(o) >= 2
    })
    if (runs.length > 0 && rng.fork('cycle').chance(0.8)) {
      const run = runs[0]
      const c = run[Math.floor(run.length / 2)]
      link(objective, roomAt[c.oy * w + c.ox], c.x, c.y)
      loops++
    }
  }
  g = buildAccessGraph(grid, barriers(), spawnKey)

  // P3: the security post is a gatehouse booth (else the booth-sized module
  // nearest the airlock).
  let guard = -1
  let guardD = Infinity
  const booths = plans.map((p, i) => (p.style === 'booth' ? i : -1)).filter((i) => i >= 0)
  plans.forEach((p, i) => {
    if (roleSet.has(i) || area(p) > POST_MAX || (booths.length > 0 && p.style !== 'booth')) return
    const r = ringRect(p.rects)
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
  const neighbours: number[][] = plans.map(() => [])
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      if (!touches(i, j)) continue
      neighbours[i].push(j)
      neighbours[j].push(i)
    }
  }
  const rolled = new Set<number>(roleSet)
  plans.forEach((p, i) => {
    if (roleSet.has(i)) return
    // P11: wet rooms gather on shared walls (weight x3 beside one).
    const wetNear = neighbours[i].some((j) => rolled.has(j) && (WET.has(plans[j].role) || plans[j].role === 'quarters'))
    const pal = wetNear ? p.palette.map(([r, wt]) => [r, WET.has(r) ? wt * 3 : wt] as const) : p.palette
    let role = pickWeighted(orng, pal)
    // A second mess hall is never a thing: extra great halls are stores.
    if (role === 'mess') role = 'depot'
    // ...and a kitchen serves the one mess hall: other annexes are stores.
    if (role === 'galley') role = 'depot'
    // A wash block is a closet, never a hall.
    if (role === 'washroom' && area(p) > 24) role = zones[p.zone].kind === 'habitation' ? 'quarters' : 'depot'
    // A guard post is a booth, not a barracks hall.
    if (role === 'security' && area(p) > POST_MAX) role = 'depot'
    p.role = role
    rolled.add(i)
  })
  // P2: private rooms are never the first rooms you meet at the airlock.
  const nearGate = (i: number): boolean => depthOf(i) <= 1 && distOf(i) < 10
  plans.forEach((p, i) => {
    if (p.role === 'quarters' && !roleSet.has(i) && nearGate(i)) p.role = 'depot'
  })
  // P12: a reactor never shares a wall with beds, the infirmary or the mess.
  plans.forEach((p, i) => {
    if (p.role !== 'reactor') return
    for (const j of neighbours[i]) {
      if (!QUIET.has(plans[j].role)) continue
      if (i !== objective) {
        p.role = 'depot'
        return
      }
      plans[j].role = 'depot'
    }
  })
  // Everyone sleeps somewhere: failing a bunk room, the roomiest quiet store becomes one.
  if (!plans.some((p) => p.role === 'quarters')) {
    let dorm = -1
    const ok = (i: number, strict: boolean): boolean =>
      !roleSet.has(i) &&
      plans[i].role === 'depot' &&
      !plans[i].service &&
      !neighbours[i].some((j) => plans[j].role === 'reactor') &&
      (!strict || !nearGate(i))
    for (const strict of [true, false]) {
      plans.forEach((p, i) => {
        if (!ok(i, strict)) return
        if (dorm < 0 || area(p) > area(plans[dorm])) dorm = i
      })
      if (dorm >= 0) break
    }
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
  for (const key of circDoors) reserve(key % w, Math.floor(key / w))
  for (const p of plans) for (const a of p.arches) for (const t of a.tiles) reserve(t.x, t.y)
  for (const t of openTiles) reserve(t.x, t.y)
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
  // Open courts are wings too (lights-out can black out the court), listed last.
  const wings: Wing[] = []
  const wingOf = (zi: number): Wing => ({ rect: zones[zi].rect, buildings: plans.flatMap((p, i) => (p.zone === zi ? [i] : [])) })
  zones.forEach((z, zi) => {
    if (!isOpen(z)) wings.push(wingOf(zi))
  })
  zones.forEach((z, zi) => {
    if (isOpen(z)) wings.push(wingOf(zi))
  })
  const landmarkZone = zones.findIndex((z) => z.type === 'hall')
  const meta: ComplexMeta = {
    archetype: sk.template,
    bent: sk.bent,
    axis: sk.axis,
    landmark: landmarkZone >= 0 ? plans.findIndex((p) => p.zone === landmarkZone && p.style === 'hall') : -1,
    depth: plans.map((_, i) => depthOf(i)),
    suites: suitesPlan,
    towers: towersPlan.map(({ plan, zone }) => {
      const z = zones[zone]
      const nb = zones.filter((o) => o.band === z.band && o.type === 'band' && !o.tower && (o.u0 === z.u0 + z.w - 1 || o.u0 + o.w - 1 === z.u0))
      return { building: plan, projection: nb.length > 0 ? z.d - Math.max(...nb.map((o) => o.d)) : 0 }
    }),
    booths,
    service: { tiles: serviceTiles, buildings: plans.flatMap((p, i) => (p.service ? [i] : [])) },
    loops,
    hatches,
    bandKinds: {},
  }
  zones.forEach((z) => {
    if (z.type !== 'band') return
    const label = sk.bands[z.band].label
    ;(meta.bandKinds[label] ??= []).push(z.kind)
  })
  return {
    buildings,
    spawn: { x: spawnTile.x + 0.5, y: spawnTile.y + 0.5 },
    exit,
    complex: { biome, corridors, vents, wings, archetype: sk.template, objective },
    meta,
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
 * the edge) opening onto every corridor round it through wide gaps. Not a
 * module — circulation space, like the corridors. */
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

/** P8: the cloister — a 2-wide walk just inside the court walls (every range
 * opens onto it), a colonnade on the garth's edge, and a well at its heart. */
const carveCloister = (grid: TileGrid, z: Zone, deck: TileId): void => {
  for (let v = 0; v < z.id; v++) {
    for (let u = 0; u < z.iw; u++) {
      const p = z.at(u, v)
      const walk = u < 2 || v < 2 || u >= z.iw - 2 || v >= z.id - 2
      grid.set(p.x, p.y, walk ? Tile.Hall : deck)
    }
  }
  const pillar = (u: number, v: number): void => {
    const p = z.at(u, v)
    grid.set(p.x, p.y, Tile.Wall)
  }
  for (let u = 3; u <= z.iw - 4; u += 3) {
    pillar(u, 2)
    pillar(u, z.id - 3)
  }
  for (let v = 5; v <= z.id - 6; v += 3) {
    pillar(2, v)
    pillar(z.iw - 3, v)
  }
  const cu = Math.floor(z.iw / 2) - 1
  const cv = Math.floor(z.id / 2) - 1
  for (let du = 0; du < 3; du++) for (let dv = 0; dv < 3; dv++) pillar(cu + du, cv + dv)
}

/** A pavilion's light court: open deck between two wards, open to the spine
 * along its whole front, with a line of planters down the middle. */
const carveCourt = (grid: TileGrid, z: Zone, deck: TileId, openings: { x: number; y: number }[]): void => {
  for (let v = -1; v < z.id; v++) {
    for (let u = 0; u < z.iw; u++) {
      const p = z.at(u, v)
      grid.set(p.x, p.y, deck)
      if (v === -1) openings.push(p)
    }
  }
  if (z.iw >= 5) {
    const pu = Math.floor(z.iw / 2)
    for (let v = 3; v <= z.id - 3; v += 4) {
      const p = z.at(pu, v)
      grid.set(p.x, p.y, Tile.Wall)
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
