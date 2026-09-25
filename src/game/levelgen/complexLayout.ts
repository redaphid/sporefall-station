import type { Rng } from '../rng'
import type { BuildingRole, Corridor } from './level'
import type { Rect } from './rooms'

/**
 * FLOORPLAN geometry for the indoor complex (complex.ts owns roles, decks,
 * doors and dressing; this file owns the SHAPE of the station).
 *
 * Floors are planned like big buildings people actually built — a mansion, a
 * monastery, a hospital, a ship — turned into a space station
 * (docs/design/floorplan-principles.md, cited below as P1..P14):
 *
 *   1. An ARCHETYPE lays the primary circulation (section 2 of the spec):
 *        - palladian: a grand axis from the gatehouse to a great hall, wings
 *          mirrored across it, a private suite behind the hall (P4);
 *        - cloister: four ranges round a court and its cloister walk, one
 *          purpose per range, like the Plan of St Gall (P8);
 *        - pavilion: a hospital spine with a comb of long wards separated by
 *          open light courts (Lariboisiere);
 *        - ship: an off-centre side passage and transverse bulkheads whose
 *          hatches line up down the hull (a fleet submarine);
 *        - spine / tee / ladder / ring: the generic fallback (~25%).
 *      Every archetype enters through a GATEHOUSE (P3): an airlock, an inner
 *      door, guard booths flanking the passage, and sometimes a bent entry.
 *      A random dihedral transform (flip / transpose) orients the whole thing.
 *   2. Each strip of floor beside a corridor is a BAND, cut along its length
 *      into ZONES (the lights-out wings). Between zones: a shared wall, a
 *      2-wide secondary corridor, a bulkhead (ship) or an open court (comb).
 *      Zones take ragged depths, end zones may be left out, and a band end may
 *      carry a corner TOWER that projects past its neighbours (P9).
 *   3. Each zone is partitioned into TIERS parallel to its corridor: a great
 *      HALL (pillared, chamfered, a galley annex off a serving arch), a row of
 *      bunk SUITES, or a row of ROOMS — sometimes an ENFILADE (P5), a row of
 *      rooms whose doors line up with only the first opening on the corridor.
 *      A servants' passage may run behind the front tier (P6), the hull wall
 *      may be thick with niches carved into it (P7), and rooms keep Palladian
 *      proportions (P13).
 *
 * Everything is in band-LOCAL coordinates (u along the corridor, v away from
 * it), mapped to the grid by a `Frame`, so one set of recipes serves every
 * orientation. Pure function of the rng: bit-exact from seed+floor.
 */

export type ZoneKind = 'entry' | 'commons' | 'engineering' | 'habitation' | 'science' | 'stores' | 'ward'
export type RoomStyle = 'room' | 'hall' | 'annex' | 'bunk' | 'closet' | 'booth' | 'tower'
export type Palette = readonly (readonly [BuildingRole, number])[]
export type Archetype = 'palladian' | 'cloister' | 'pavilion' | 'ship' | 'spine' | 'tee' | 'ladder' | 'ring'

export interface Vec {
  x: number
  y: number
}

/** A rect in zone-local coordinates: u along the front, v away from it. */
export interface LRect {
  u: number
  v: number
  w: number
  h: number
}

/** Maps a band's local (u, v) to grid tiles. `face` points from the band to
 * the corridor it hangs off; v = 0 is the row nearest that corridor. */
export interface Frame {
  rect: Rect
  face: Vec
  len: number
  depth: number
}

export const frameOf = (rect: Rect, face: Vec): Frame =>
  face.y !== 0 ? { rect, face, len: rect.w, depth: rect.h } : { rect, face, len: rect.h, depth: rect.w }

export const toGrid = (f: Frame, u: number, v: number): Vec => {
  const r = f.rect
  if (f.face.y > 0) return { x: r.x + u, y: r.y + r.h - 1 - v }
  if (f.face.y < 0) return { x: r.x + u, y: r.y + v }
  if (f.face.x > 0) return { x: r.x + r.w - 1 - v, y: r.y + u }
  return { x: r.x + v, y: r.y + u }
}

export const lrectToGrid = (f: Frame, l: LRect): Rect => {
  const a = toGrid(f, l.u, l.v)
  const b = toGrid(f, l.u + l.w - 1, l.v + l.h - 1)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 }
}

// ── Archetypes (canonical orientation, then a dihedral transform) ───────────

export interface BandSpec {
  rect: Rect
  face: Vec
  /** Rng label — two bands with the same label get the same local layout,
   * which (their frames being mirror images) is what makes a symmetric plan. */
  label: string
  /** Zones span the whole depth (a band between two corridors); separators
   * that are corridors become rungs joining them. */
  full: boolean
  /** May leave an end zone out (notches the hull outline). */
  voidEnds: boolean
  /** This end of the band abuts a corridor (a tee): its end zone stays
   * full-depth and is never left out, so the corridor always has a wing. */
  keepStart?: boolean
  keepEnd?: boolean
  /** Zones keep the full depth (no ragged outline) — for bands whose back
   * faces the entrance stub rather than open hull. */
  flat?: boolean
  /** A corner tower at this end of the band (P9). */
  towerStart?: boolean
  towerEnd?: boolean
  /** This end is anchored to the gatehouse: its end zone is never left out,
   * so the spine never runs past a missing wing. */
  anchorStart?: boolean
  anchorEnd?: boolean
  /** The hull steps in toward this end (a ship's bow). */
  taperStart?: boolean
  taperEnd?: boolean
  /** How zones are separated: the default (walls / secondary corridors), a
   * comb of pavilions with open courts between them, or ship bulkheads. */
  sep?: 'comb' | 'bulkhead'
  /** The band's front is a room's or a court's wall, not a corridor: no
   * secondary corridors may hang off it. */
  noBranch?: boolean
  /** Bulkhead hatches line up down the band (P5 at deck scale). */
  hatch?: boolean
  /** Every zone of the band has this purpose (P8 ranges, pavilion wards). */
  kind?: ZoneKind
  /** Most zones of the band have this purpose (P14 institutions). */
  prefer?: ZoneKind
  /** Chance a row of 3-5 rooms is laid out as an enfilade suite (P5). */
  suiteP?: number
}

export type CoreType = 'hall' | 'atrium' | 'booth' | 'cloister'

export interface CoreSpec {
  rect: Rect
  face: Vec
  label: string
  /** hall: a great hall zone; atrium: the ring's open court; booth: a
   * gatehouse guard booth; cloister: a court ringed by its cloister walk. */
  type: CoreType
}

export interface Skeleton {
  template: Archetype
  symmetric: boolean
  /** The entrance turns 90 degrees before it meets the spine (P3). */
  bent: boolean
  corridors: Corridor[]
  bands: BandSpec[]
  cores: CoreSpec[]
  /** Solid walls stamped after the zones (the gatehouse's inner wall). */
  walls: Rect[]
  /** Deck tiles opened after the zones (the inner door, court gates). */
  openings: Vec[]
  /** Spawn tile: the middle of the airlock. */
  spawn: Vec
  /** The grand axis (P4): the spawn row / column through the landmark. */
  axis?: { horizontal: boolean; at: number }
}

interface Dihedral {
  t: boolean
  fx: boolean
  fy: boolean
  n: number
}

const tPoint = (d: Dihedral, p: Vec): Vec => {
  let { x, y } = d.t ? { x: p.y, y: p.x } : p
  if (d.fx) x = d.n - 1 - x
  if (d.fy) y = d.n - 1 - y
  return { x, y }
}

const tRect = (d: Dihedral, r: Rect): Rect => {
  const a = tPoint(d, { x: r.x, y: r.y })
  const b = tPoint(d, { x: r.x + r.w - 1, y: r.y + r.h - 1 })
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 }
}

const tDir = (d: Dihedral, v: Vec): Vec => {
  let { x, y } = d.t ? { x: v.y, y: v.x } : v
  if (d.fx) x = -x
  if (d.fy) y = -y
  return { x, y }
}

const DOWN: Vec = { x: 0, y: 1 }
const UP: Vec = { x: 0, y: -1 }
const LEFT: Vec = { x: -1, y: 0 }
const RIGHT: Vec = { x: 1, y: 0 }

/** Where bands next to the gatehouse start (the gate owns columns 1..8). */
const GATE_X = 9

/**
 * Lay the primary circulation for an `n` x `n` map (1-tile hull ring). All
 * coordinates below are canonical — main spines horizontal, entrance at the
 * west — before the dihedral transform.
 */
export const layoutSkeleton = (rng: Rng, n: number): Skeleton => {
  const last = n - 2 // last interior row/col
  const roll = rng.int(0, 99)
  const template: Archetype =
    roll < 20
      ? 'palladian'
      : roll < 40
        ? 'cloister'
        : roll < 55
          ? 'pavilion'
          : roll < 75
            ? 'ship'
            : roll < 83
              ? 'spine'
              : roll < 90
                ? 'tee'
                : roll < 96
                  ? 'ladder'
                  : 'ring'
  const corridors: Corridor[] = []
  const bands: BandSpec[] = []
  const cores: CoreSpec[] = []
  const walls: Rect[] = []
  const openings: Vec[] = []
  let spawn: Vec = { x: 2, y: 2 }
  let axis: Skeleton['axis']
  const hspine = (x: number, y: number, x1 = n - 2): void => {
    corridors.push({ axis: 'h', rect: { x, y, w: x1 - x + 1, h: 3 } })
  }
  const vcorr = (x: number, y0: number, y1: number): void => {
    corridors.push({ axis: 'v', rect: { x, y: y0, w: 3, h: y1 - y0 + 1 } })
  }
  const band = (x: number, y: number, w: number, h: number, face: Vec, label: string, extra: Partial<BandSpec> = {}): void => {
    bands.push({ rect: { x, y, w, h }, face, label, full: false, voidEnds: false, anchorStart: x === GATE_X, ...extra })
  }
  /** Bands clear of the gatehouse rows may reach further west. */
  const freeX = 1 + rng.int(1, 4)
  const b = rng.int(0, 3)
  const x1 = last - b

  /**
   * P3. The gatehouse at the west end of the spine whose top row is `sy`:
   * a 3x3 airlock, an inner wall with a 1-tile door (the choke point), and
   * 3x3 guard booths flanking the passage beyond it. A BENT entry puts the
   * airlock north of the spine and turns 90 degrees, so the landing never
   * looks straight down the station (Krak des Chevaliers). Returns the x the
   * spine starts at.
   */
  let bent = false
  const gatehouse = (sy: number, allowBent: boolean, south: boolean): number => {
    bent = allowBent && rng.chance(0.4)
    if (!bent) {
      corridors.push({ axis: 'h', rect: { x: 1, y: sy, w: 3, h: 3 } })
      walls.push({ x: 4, y: sy, w: 1, h: 3 })
      openings.push({ x: 4, y: sy + 1 })
      cores.push({ rect: { x: 5, y: sy - 5, w: 5, h: 5 }, face: DOWN, label: 'boothN', type: 'booth' })
      if (south) cores.push({ rect: { x: 5, y: sy + 3, w: 5, h: 5 }, face: UP, label: 'boothS', type: 'booth' })
      spawn = { x: 2, y: sy + 1 }
      return 5
    }
    corridors.push({ axis: 'v', rect: { x: 1, y: sy - 8, w: 3, h: 3 } })
    corridors.push({ axis: 'v', rect: { x: 1, y: sy - 4, w: 3, h: 4 } })
    walls.push({ x: 1, y: sy - 5, w: 3, h: 1 })
    openings.push({ x: 2, y: sy - 5 })
    cores.push({ rect: { x: 4, y: sy - 5, w: 6, h: 5 }, face: LEFT, label: 'boothE', type: 'booth' })
    if (south) cores.push({ rect: { x: 4, y: sy + 3, w: 6, h: 5 }, face: UP, label: 'boothS', type: 'booth' })
    spawn = { x: 2, y: sy - 7 }
    return 1
  }
  let symmetric = false

  if (template === 'palladian') {
    // P4: the spine IS the axis — gatehouse, spine and great hall on one
    // line, the wings either side mirror images (shared band labels).
    symmetric = true
    const sy = (n - 4) / 2
    const k = rng.int(6, 8)
    const xc = x1 - rng.int(15, 19) + 1
    const sx = gatehouse(sy, false, true)
    hspine(sx, sy, xc - 1)
    // The great hall (corps de logis) closes the axis.
    cores.push({ rect: { x: xc, y: sy - k, w: x1 - xc + 1, h: 2 * k + 3 }, face: LEFT, label: 'saloon', type: 'hall' })
    band(GATE_X, 1, xc - GATE_X + 1, sy - 1, DOWN, 'wing', { voidEnds: true, keepEnd: true })
    band(GATE_X, sy + 3, xc - GATE_X + 1, last - 1 - (sy + 3) + 1, UP, 'wing', { voidEnds: true, keepEnd: true })
    // The private apartments behind the hall: no corridor, only the hall.
    band(xc, 1, x1 - xc + 1, sy - k, DOWN, 'apartment', { suiteP: 0.6, noBranch: true })
    band(xc, sy + 2 + k, x1 - xc + 1, last - 1 - (sy + 2 + k) + 1, UP, 'apartment', { suiteP: 0.6, noBranch: true })
    axis = { horizontal: true, at: sy + 1 }
  } else if (template === 'cloister') {
    // P8, the Plan of St Gall: four ranges round a court; the gate range by
    // the airlock, the science range (the church) opposite, dormitory and
    // refectory on the flanks. Every range opens onto the cloister walk.
    const dn = rng.int(17, 20)
    const ds = rng.int(17, 20)
    const dw = rng.int(16, 18)
    const de = rng.int(17, 20)
    const top = dn // court's top wall row (shared with the north range)
    const bot = last - ds + 1 // court's bottom wall row
    const lft = dw // court's west wall column
    const rgt = last - de + 1 // court's east wall column
    const gy = Math.floor((top + bot) / 2) - 1
    const flip = rng.chance(0.5)
    gatehouse(gy, false, true)
    // The gate passage runs through the gate range into the court.
    corridors.push({ axis: 'h', rect: { x: 5, y: gy, w: lft - 5, h: 3 } })
    for (let k = 0; k < 3; k++) openings.push({ x: lft, y: gy + k })
    band(GATE_X, top, lft - GATE_X + 1, gy - top, DOWN, 'gateN', { kind: 'stores', flat: true })
    band(GATE_X, gy + 3, lft - GATE_X + 1, bot - (gy + 3) + 1, UP, 'gateS', { kind: 'stores', flat: true })
    band(4, 1, last - 4 + 1, dn, DOWN, 'rangeN', { kind: flip ? 'commons' : 'habitation', noBranch: true })
    band(4, bot, last - 4 + 1, last - bot + 1, UP, 'rangeS', { kind: flip ? 'habitation' : 'commons', noBranch: true })
    band(rgt, top, de, bot - top + 1, LEFT, 'rangeE', { kind: 'science', flat: true, suiteP: 0.5, noBranch: true })
    cores.push({ rect: { x: lft, y: top, w: rgt - lft + 1, h: bot - top + 1 }, face: DOWN, label: 'court', type: 'cloister' })
    // The cloister walk: a 2-wide deck just inside the court walls.
    corridors.push({ axis: 'h', rect: { x: lft + 1, y: top + 1, w: rgt - lft - 1, h: 2 } })
    corridors.push({ axis: 'h', rect: { x: lft + 1, y: bot - 2, w: rgt - lft - 1, h: 2 } })
    corridors.push({ axis: 'v', rect: { x: lft + 1, y: top + 1, w: 2, h: bot - top - 1 } })
    corridors.push({ axis: 'v', rect: { x: rgt - 2, y: top + 1, w: 2, h: bot - top - 1 } })
  } else if (template === 'pavilion') {
    // Lariboisiere: one straight spine; a comb of long wards on one side
    // with open light courts between them, a flat service range opposite.
    const sy = rng.int(26, 31)
    const sx = gatehouse(sy, true, true)
    hspine(sx, sy, x1)
    const d = Math.min(sy - 1, rng.int(20, 24))
    band(GATE_X, sy - d, x1 - GATE_X + 1, d, DOWN, 'comb', { sep: 'comb', kind: 'ward' })
    const ds = Math.min(last - sy - 2, rng.int(18, 26))
    band(GATE_X, sy + 3, x1 - GATE_X + 1, ds, UP, 'service', { voidEnds: true, suiteP: 0.5 })
  } else if (template === 'ship') {
    // A fleet submarine: the side passage pushed off-centre, compartments cut
    // at a regular rhythm, their bulkhead hatches on one line down the keel;
    // the hull steps in toward the bow (the far end from the airlock).
    const sy = rng.int(19, 24)
    const sx = gatehouse(sy, true, true)
    hspine(sx, sy, x1)
    const dn = Math.min(sy - 1, rng.int(17, 22))
    band(GATE_X, sy - dn, x1 - GATE_X + 1, dn, DOWN, 'port', { sep: 'bulkhead', hatch: true, taperEnd: true, suiteP: 0.45 })
    const ds = Math.min(last - sy - 2, rng.int(19, 26))
    band(GATE_X, sy + 3, x1 - GATE_X + 1, ds, UP, 'starboard', { sep: 'bulkhead', hatch: true, taperEnd: true, suiteP: 0.45 })
  } else if (template === 'spine' || template === 'tee') {
    symmetric = rng.chance(0.35)
    const sy = symmetric ? (n - 4) / 2 : rng.int(Math.floor(n * 0.34), Math.floor(n * 0.6))
    const sx = gatehouse(sy, !symmetric, true)
    hspine(sx, sy)
    const northH = sy - 1
    const southY = sy + 3
    const southH = (symmetric ? last - 1 : last) - southY + 1
    const splitNorth = template === 'tee'
    const splitSouth = template === 'tee' && (symmetric || rng.chance(0.5))
    const cx = rng.int(GATE_X + 15, Math.floor(n * 0.62))
    const half = (y: number, h: number, face: Vec, label: string, split: boolean, voidEnds: boolean): void => {
      if (!split) {
        band(GATE_X, y, x1 - GATE_X + 1, h, face, label, { voidEnds })
        return
      }
      vcorr(cx, y, y + h - 1)
      band(GATE_X, y, cx - GATE_X, h, face, `${label}W`, { voidEnds, keepEnd: true })
      band(cx + 3, y, x1 - cx - 2, h, face, `${label}E`, { voidEnds, keepStart: true })
    }
    half(1, northH, DOWN, 'north', splitNorth, true)
    half(southY, southH, UP, symmetric ? 'north' : 'south', splitSouth, false)
    if (symmetric) axis = { horizontal: true, at: sy + 1 }
  } else {
    // Two main spines. Ladder: the band between them hangs rungs across, and
    // each band is one institution (P14). Ring: two 3-wide rungs box in a
    // central core (a great hall or atrium).
    const ring = template === 'ring'
    const s1 = ring ? rng.int(11, 16) : rng.int(13, 20)
    const mid = ring ? rng.int(15, 21) : rng.int(10, 15)
    const s2 = s1 + 3 + mid
    const sx = gatehouse(s1, true, true)
    hspine(sx, s1)
    hspine(freeX, s2)
    const inst = (k: ZoneKind): Partial<BandSpec> => (ring ? {} : { prefer: k })
    band(GATE_X, 1, x1 - GATE_X + 1, s1 - 1, DOWN, 'north', { voidEnds: true, ...inst('habitation') })
    band(freeX, s2 + 3, x1 - freeX + 1, last - (s2 + 3) + 1, UP, 'south', inst(rng.chance(0.5) ? 'stores' : 'commons'))
    const my = s1 + 3
    if (!ring) {
      band(GATE_X, my, x1 - GATE_X + 1, mid, UP, 'mid', { full: true, prefer: 'science' })
    } else {
      const r1 = rng.int(16, 20)
      const r2 = n - 3 - rng.int(12, 17)
      vcorr(r1, my, my + mid - 1)
      vcorr(r2, my, my + mid - 1)
      band(GATE_X, my, r1 - GATE_X, mid, RIGHT, 'west', { flat: true })
      band(r2 + 3, my, x1 - r2 - 2, mid, LEFT, 'east', { flat: true })
      cores.push({ rect: { x: r1 + 3, y: my, w: r2 - r1 - 3, h: mid }, face: UP, label: 'core', type: rng.chance(0.4) ? 'atrium' : 'hall' })
    }
  }

  // P9: corner towers at the band ends that are hull corners. Decided per
  // band LABEL, so mirrored wings get mirrored towers.
  const towerEnds: Record<string, ('start' | 'end')[]> = {
    wing: ['start'],
    apartment: ['end'],
    rangeN: ['start', 'end'],
    rangeS: ['start', 'end'],
    service: ['start', 'end'],
    north: ['start', 'end'],
    south: ['start', 'end'],
    northW: ['start'],
    northE: ['end'],
    southW: ['start'],
    southE: ['end'],
  }
  for (const bd of bands) {
    const trng = rng.fork(`tower:${bd.label}`)
    for (const e of towerEnds[bd.label] ?? []) {
      if (!trng.chance(0.55)) continue
      if (e === 'start' && !bd.keepStart) bd.towerStart = true
      if (e === 'end' && !bd.keepEnd) bd.towerEnd = true
    }
  }

  const d: Dihedral = { t: rng.chance(0.5), fx: rng.chance(0.5), fy: rng.chance(0.5), n }
  const sp = tPoint(d, spawn)
  return {
    template,
    symmetric,
    bent,
    corridors: corridors.map((c) => {
      const rect = tRect(d, c.rect)
      return { axis: d.t ? (c.axis === 'h' ? 'v' : 'h') : c.axis, rect }
    }),
    bands: bands.map((bd) => {
      // The grid frame runs u along +x / +y; when the transform reversed the
      // band's canonical u, its start and end swap.
      const along = tDir(d, bd.face.y !== 0 ? RIGHT : DOWN)
      const flip = along.x + along.y < 0
      const pick = <T>(s: T, e: T): [T, T] => (flip ? [e, s] : [s, e])
      const [keepStart, keepEnd] = pick(bd.keepStart, bd.keepEnd)
      const [towerStart, towerEnd] = pick(bd.towerStart, bd.towerEnd)
      const [taperStart, taperEnd] = pick(bd.taperStart, bd.taperEnd)
      const [anchorStart, anchorEnd] = pick(bd.anchorStart, bd.anchorEnd)
      return { ...bd, rect: tRect(d, bd.rect), face: tDir(d, bd.face), keepStart, keepEnd, towerStart, towerEnd, taperStart, taperEnd, anchorStart, anchorEnd }
    }),
    cores: cores.map((c) => ({ ...c, rect: tRect(d, c.rect), face: tDir(d, c.face) })),
    walls: walls.map((r) => tRect(d, r)),
    openings: openings.map((p) => tPoint(d, p)),
    spawn: sp,
    axis: axis ? transformAxis(d, axis, sp) : undefined,
  }
}

/** The axis after the transform: it passes through the (transformed) spawn. */
const transformAxis = (d: Dihedral, axis: { horizontal: boolean; at: number }, sp: Vec): { horizontal: boolean; at: number } => {
  const horizontal = d.t ? !axis.horizontal : axis.horizontal
  return { horizontal, at: horizontal ? sp.y : sp.x }
}

// ── Bands → zones + secondary corridors ─────────────────────────────────────

/** Narrowest / widest zone, walls included. */
const ZONE_MIN = 7
const ZONE_MAX = 18
/** Shallowest zone, walls included (a 5-deep interior). */
const DEPTH_MIN = 7
/** Shallowest band that can carry a corner tower (tower + a front room). */
const TOWER_DEPTH = 16

export interface BandZone {
  /** Band-local start (the zone's own wall column) and width, walls included. */
  u0: number
  w: number
  /** Depth from the band front, walls included. */
  d: number
  /** A corner tower (P9). */
  tower?: boolean
}

export interface BandLayout {
  zones: BandZone[]
  /** 2-wide secondary corridors: band-local start column and length. */
  branches: { u0: number; len: number }[]
  /** Open light courts between pavilions: start column (the left pavilion's
   * wall), width (both pavilion walls included) and depth. */
  courts: { u0: number; w: number; d: number }[]
}

export interface BandOpts {
  start?: boolean
  end?: boolean
  flat?: boolean
  towerStart?: boolean
  towerEnd?: boolean
  taperStart?: boolean
  taperEnd?: boolean
  anchorStart?: boolean
  anchorEnd?: boolean
  noBranch?: boolean
  sep?: 'comb' | 'bulkhead'
}

export const layoutBand = (rng: Rng, len: number, depth: number, full: boolean, voidEnds: boolean, keep: BandOpts = {}): BandLayout => {
  if (keep.sep === 'comb') return layoutComb(rng, len, depth)
  if (keep.sep === 'bulkhead') return layoutBulkheads(rng, len, depth, keep)
  const zones: BandZone[] = []
  const seps: ('branch' | 'wall')[] = []
  const deep = depth > 12
  const towers = !full && depth >= TOWER_DEPTH
  // P9: a tower is a narrow full-depth end zone (a 5-7 square room at the
  // back) — only where the band keeps a real zone beside it.
  let tStart = towers && keep.towerStart ? rng.int(7, 9) : 0
  let tEnd = towers && keep.towerEnd ? rng.int(7, 9) : 0
  if (len - tStart - tEnd < ZONE_MIN + 2) tEnd = 0
  if (len - tStart - tEnd < ZONE_MIN + 2) tStart = 0
  let u = 0
  if (tStart) {
    zones.push({ u0: 0, w: tStart, d: depth, tower: true })
    seps.push('wall')
    u = tStart - 1
  }
  const stop = tEnd ? len - tEnd + 1 : len
  for (;;) {
    const rem = stop - u
    if (rem <= ZONE_MAX || rem < 2 * ZONE_MIN + 2) {
      zones.push({ u0: u, w: rem, d: depth })
      break
    }
    const w = rng.int(ZONE_MIN, Math.min(ZONE_MAX, rem - ZONE_MIN - 2))
    zones.push({ u0: u, w, d: depth })
    const branch = rng.chance(full ? 0.55 : deep ? 0.72 : 0.3) && !keep.noBranch
    seps.push(branch ? 'branch' : 'wall')
    u += branch ? w + 2 : w - 1
  }
  if (tEnd) {
    seps.push('wall')
    zones.push({ u0: len - tEnd, w: tEnd, d: depth, tower: true })
  }
  // A full band must be crossable (at least one rung), and a deep band needs
  // at least one service hall so its back rooms are not a chain of
  // pass-throughs. Either is cut from the back of a zone wide enough to lose
  // 3 columns (the hall + its own wall).
  if ((full || deep) && !keep.noBranch && zones.length > 1 && !seps.includes('branch')) {
    const k = zones.findIndex((z, i) => i < zones.length - 1 && !z.tower && !zones[i + 1].tower && z.w >= ZONE_MIN + 3)
    if (k >= 0) {
      seps[k] = 'branch'
      zones[k].w -= 3
    }
  }
  if (!full && !keep.flat) {
    // Ragged depths: the building's outline steps in and out.
    for (const z of zones) if (!z.tower && depth > DEPTH_MIN && !rng.chance(0.5)) z.d = rng.int(Math.max(DEPTH_MIN, Math.ceil(depth * 0.55)), depth)
    if (keep.start && !tStart) zones[0].d = depth
    if (keep.end && !tEnd) zones[zones.length - 1].d = depth
  }
  // A tower projects: its neighbour steps back at least 3 tiles.
  zones.forEach((z, i) => {
    if (!z.tower) return
    const nb = zones[i === 0 ? 1 : i - 1]
    if (nb && !nb.tower) nb.d = Math.min(nb.d, Math.max(DEPTH_MIN, depth - rng.int(3, 5)))
  })
  const voided = new Set<number>()
  if (voidEnds && zones.length >= 3) {
    if (rng.chance(0.3) && !keep.start && !keep.anchorStart && !tStart) voided.add(0)
    if (rng.chance(0.3) && !keep.end && !keep.anchorEnd && !tEnd) voided.add(zones.length - 1)
  }
  const branches: BandLayout['branches'] = []
  seps.forEach((s, i) => {
    if (s !== 'branch') return
    const l = zones[i]
    const r = zones[i + 1]
    const dl = voided.has(i) ? 0 : l.d
    const dr = voided.has(i + 1) ? 0 : r.d
    branches.push({ u0: l.u0 + l.w, len: full ? depth : Math.max(dl, dr) - 1 })
  })
  return { zones: zones.filter((_, i) => !voided.has(i)), branches, courts: [] }
}

/** Pavilion comb: 3-5 long wards (9-11 wide) with open courts between them,
 * filling the band exactly so no stretch of spine is left without a wing. */
const layoutComb = (rng: Rng, len: number, depth: number): BandLayout => {
  let k = Math.max(2, Math.min(5, Math.floor((len - 10) / 16) + 1))
  let widths: number[] = []
  let gaps: number[] = []
  for (; k >= 2; k--) {
    widths = Array.from({ length: k }, () => rng.int(9, 11))
    // Courts (interior widths) take what is left, evenly.
    let spare = len - widths.reduce((s, w) => s + w, 0)
    // Too much court: widen the wards up to 13.
    for (let i = 0; spare > (k - 1) * 8 && i < 4 * k; i++) {
      const j = i % k
      if (widths[j] < 13) {
        widths[j]++
        spare--
      }
    }
    if (spare < (k - 1) * 4) continue
    const base = Math.floor(spare / (k - 1))
    gaps = Array.from({ length: k - 1 }, (_, i) => base + (i < spare - base * (k - 1) ? 1 : 0))
    break
  }
  const zones: BandZone[] = []
  const courts: BandLayout['courts'] = []
  let u = 0
  widths.forEach((w, i) => {
    zones.push({ u0: u, w, d: depth - rng.int(0, 2) })
    u += w
    if (i < gaps.length) {
      courts.push({ u0: u - 1, w: gaps[i] + 2, d: 0 })
      u += gaps[i]
    }
  })
  // The last ward absorbs any rounding so the band is filled end to end.
  const lastZ = zones[zones.length - 1]
  lastZ.w = len - lastZ.u0
  courts.forEach((c, i) => (c.d = Math.max(zones[i].d, zones[i + 1].d)))
  return { zones, branches: [], courts }
}

/** Ship compartments: a steady rhythm of 9-12 wide bulkheaded zones, no
 * secondary corridors; the hull steps in over the last compartments. */
const layoutBulkheads = (rng: Rng, len: number, depth: number, keep: BandOpts): BandLayout => {
  const zones: BandZone[] = []
  let u = 0
  for (;;) {
    const rem = len - u
    if (rem <= 14) {
      zones.push({ u0: u, w: rem, d: depth })
      break
    }
    const w = rng.int(Math.min(9, rem - 8), Math.min(12, rem - 8))
    zones.push({ u0: u, w, d: depth })
    u += w - 1
  }
  const taper = (i: number, lo: number, hi: number): void => {
    if (i >= 0 && i < zones.length) zones[i].d = Math.max(DEPTH_MIN + 2, depth - rng.int(lo, hi))
  }
  const k = zones.length
  if (keep.taperEnd) {
    taper(k - 1, 4, 6)
    if (k >= 4) taper(k - 2, 1, 3)
  }
  if (keep.taperStart) {
    taper(0, 4, 6)
    if (k >= 4) taper(1, 1, 3)
  }
  return { zones, branches: [], courts: [] }
}

// ── Zone interiors ──────────────────────────────────────────────────────────

export interface ZoneRoom {
  rects: LRect[]
  style: RoomStyle
  palette: Palette
  /** Reached only through its parent room (a suite's wash closet). */
  noCorridor?: boolean
}

export interface ZoneLink {
  a: number
  b: number
  tiles: { u: number; v: number }[]
  /** An open archway (not a door entity) rather than a door. */
  arch: boolean
}

export interface ZoneLayout {
  iw: number
  id: number
  /** 1 = wall, row-major over iw x id. */
  wall: Uint8Array
  rooms: ZoneRoom[]
  links: ZoneLink[]
  /** P6: the servants' passage, `h` rows from `v0`, the full zone width. */
  service?: { v0: number; h: number }
  /** P6: back doors from rooms onto the servants' passage (the wall tile). */
  serviceDoors: { room: number; u: number; v: number }[]
  /** P5: enfilade suites, room indices from the antechamber to the cabinet. */
  suites: number[][]
  /** P9: the tower room, when this zone is a corner tower. */
  tower?: number
}

export interface ZoneOpts {
  /** A core zone (a great hall between two corridors). */
  core?: boolean
  /** A corner tower (P9). */
  tower?: boolean
  /** A gatehouse guard booth (P3). */
  booth?: boolean
  /** Run a servants' passage behind the front tier (P6). */
  service?: boolean
  /** Extra rows of solid wall against the hull, with niches (P7). */
  thick?: number
  /** Chance a row of 3-5 rooms becomes an enfilade suite (P5). */
  suiteP?: number
}

const PAL: Record<ZoneKind, Palette> = {
  entry: [
    ['security', 1],
    ['depot', 3],
  ],
  commons: [
    ['depot', 2],
    ['washroom', 1],
  ],
  engineering: [
    ['depot', 4],
    ['reactor', 1],
  ],
  habitation: [
    ['quarters', 3],
    ['washroom', 1],
    ['medbay', 1],
  ],
  science: [
    ['lab', 3],
    ['medbay', 2],
    ['depot', 1],
  ],
  stores: [
    ['depot', 6],
    ['security', 1],
    ['washroom', 2],
  ],
  ward: [
    ['medbay', 2],
    ['quarters', 2],
  ],
}

const HALL_PAL: Partial<Record<ZoneKind, Palette>> = {
  commons: [['mess', 1]],
  engineering: [['reactor', 1]],
  science: [['lab', 1]],
}
const ANNEX_PAL: Partial<Record<ZoneKind, Palette>> = {
  commons: [['galley', 1]],
  engineering: [['depot', 1]],
  science: [
    ['depot', 1],
    ['medbay', 1],
  ],
}
const TOWER_PAL: Palette = [
  ['depot', 2],
  ['security', 1],
  ['reactor', 1],
]
const ISOLATION_PAL: Palette = [
  ['medbay', 2],
  ['lab', 1],
]
const STATION_PAL: Palette = [
  ['security', 1],
  ['medbay', 1],
]

/** Roles that use the back-of-house (P6: galley, stores, wash, reactor). */
const SERVANT_ROLES = new Set<BuildingRole>(['galley', 'depot', 'washroom', 'reactor'])

/** Cut `len` into pieces of [lo, hi] separated by 1-tile walls. A remainder
 * that cannot split into two legal pieces stays whole. */
export const cutStrip = (rng: Rng, len: number, lo: number, hi: number): number[] => {
  const out: number[] = []
  let pos = 0
  while (pos < len) {
    const rem = len - pos
    const top = Math.min(hi, rem - lo - 1)
    if (rem <= hi || top < lo) {
      out.push(rem)
      break
    }
    const piece = rng.int(lo, top)
    out.push(piece)
    pos += piece + 1
  }
  return out
}

type TierStyle = 'hall' | 'suites' | 'rooms'

/**
 * Partition one zone interior (iw x id, v = 0 against the zone's front
 * corridor) by its purpose. Pure of `rng`.
 */
export const layoutZone = (rng: Rng, kind: ZoneKind, iw: number, id: number, opts: ZoneOpts = {}): ZoneLayout => {
  const wall = new Uint8Array(iw * id)
  const setWall = (u: number, v: number, on = true): void => {
    if (u >= 0 && v >= 0 && u < iw && v < id) wall[v * iw + u] = on ? 1 : 0
  }
  const isWall = (u: number, v: number): boolean => u < 0 || v < 0 || u >= iw || v >= id || wall[v * iw + u] === 1
  const rooms: ZoneRoom[] = []
  const links: ZoneLink[] = []
  const tierOf: number[] = []
  const add = (r: ZoneRoom, ti: number): number => {
    rooms.push(r)
    tierOf.push(ti)
    return rooms.length - 1
  }
  const out = (extra: Partial<ZoneLayout> = {}): ZoneLayout => ({ iw, id, wall, rooms, links, serviceDoors: [], suites: [], ...extra })

  if (opts.booth) {
    add({ rects: [{ u: 0, v: 0, w: iw, h: id }], style: 'booth', palette: [['security', 1]] }, 0)
    return out()
  }
  if (kind === 'ward' && iw >= 7 && id >= 12) return layoutWard(rng, iw, id, setWall, add, links, out)
  if (opts.tower && iw >= 5 && id - iw - 1 >= 4) {
    // P9: the tower room is the back square (chamfered like a round tower),
    // reached only through the room(s) in front of it: a defensible pocket.
    const tv = id - iw
    for (let u = 0; u < iw; u++) setWall(u, tv - 1)
    let v = 0
    let prev = -1
    cutStrip(rng, tv - 1, 4, 7).forEach((d, i) => {
      if (i > 0) for (let u = 0; u < iw; u++) setWall(u, v - 1)
      const r = add({ rects: [{ u: 0, v, w: iw, h: d }], style: 'room', palette: PAL[kind], noCorridor: i > 0 }, i)
      if (prev >= 0) links.push({ a: r, b: prev, tiles: [{ u: rng.int(1, iw - 2), v: v - 1 }], arch: false })
      prev = r
      v += d + 1
    })
    const tower = add({ rects: [{ u: 0, v: tv, w: iw, h: iw }], style: 'tower', palette: TOWER_PAL, noCorridor: true }, 9)
    links.push({ a: tower, b: prev, tiles: [{ u: Math.floor(iw / 2), v: tv - 1 }], arch: false })
    const size = iw >= 7 ? 2 : 1
    chamfer(setWall, 0, id - 1, 1, -1, size)
    chamfer(setWall, iw - 1, id - 1, -1, -1, size)
    return out({ tower })
  }

  // P6: the servants' passage runs along the back of the zone, behind the
  // last tier — the green-baize corridor behind the state rooms. Rooms keep
  // their own ways in, so it is a second route, never the only one.
  const pw = opts.service ? (id >= 17 ? 2 : 1) : 0
  const svc = pw > 0 && id - pw - 1 >= 8
  // P7: poche — the hull wall grows thick (not behind a passage); niches are
  // carved into it below.
  const thick = !svc && opts.thick && id - opts.thick >= 9 ? opts.thick : 0
  const ide = id - thick - (svc ? pw + 1 : 0) // the tiers fill rows [0, ide)
  for (let v = ide; v < id; v++) for (let u = 0; u < iw; u++) setWall(u, v)
  const service: ZoneLayout['service'] = svc ? { v0: ide + 1, h: pw } : undefined
  if (service) for (let v = service.v0; v < id; v++) for (let u = 0; u < iw; u++) setWall(u, v, false)

  // ── Tiers parallel to the front. ──────────────────────────────────────────
  const tiers: { v0: number; d: number; style: TierStyle }[] = []
  const hallFirst = kind === 'commons' || kind === 'engineering' || (kind === 'science' && iw >= 10 && rng.chance(0.3))
  let v = 0
  if (hallFirst && iw >= 7 && ide >= 5) {
    // A narrow commons (a ship's compartment) runs its mess hall deeper.
    const want = opts.core
      ? Math.round(ide * 0.6)
      : kind === 'engineering'
        ? rng.int(7, 11)
        : kind === 'commons' && iw < 11
          ? rng.int(12, 15)
          : rng.int(8, 11)
    const d = ide - want - 1 < 3 ? ide : Math.min(want, ide)
    tiers.push({ v0: 0, d, style: 'hall' })
    v = d + 1
  }
  if (v < ide) {
    const [lo, hi] = kind === 'habitation' ? [7, 9] : kind === 'stores' ? [4, 7] : kind === 'science' ? [5, 9] : [4, 8]
    for (const d of cutStrip(rng, ide - v, lo, hi)) {
      const style: TierStyle = kind === 'habitation' && d >= 5 ? 'suites' : 'rooms'
      tiers.push({ v0: v, d, style })
      v += d + 1
    }
  }
  tiers.forEach((t, ti) => {
    if (ti > 0) for (let u = 0; u < iw; u++) setWall(u, t.v0 - 1)
  })

  const suites: number[][] = []
  const inSuite = new Set<number>()
  tiers.forEach((t, ti) => {
    if (t.style === 'hall') {
      layoutHall(rng, kind, iw, t, ti, setWall, add, links)
      return
    }
    let [lo, hi] = t.style === 'suites' ? [5, 8] : kind === 'stores' ? [4, 8] : kind === 'science' ? [5, 10] : [4, 9]
    if (t.style === 'rooms') {
      // P13: Palladian proportions — no room longer than twice its depth,
      // none narrower than half of it.
      const lo2 = Math.max(lo, Math.ceil(t.d / 2))
      const hi2 = Math.min(hi, 2 * t.d)
      if (lo2 <= hi2) [lo, hi] = [lo2, hi2]
    }
    // P5: an enfilade — a row of 3-5 rooms, one corridor door, then doors on
    // one line through every room, 1-2 tiles in from the back wall (Versailles).
    const suiteHi = Math.min(9, Math.floor((iw - 2) / 3))
    let suite = t.style === 'rooms' && t.d >= 4 && suiteHi >= 4 && rng.chance(opts.suiteP ?? 0.3)
    const widths = suite ? cutStrip(rng, iw, 4, suiteHi) : cutStrip(rng, iw, lo, hi)
    if (widths.length < 3 || widths.length > 5) suite = false
    const line = t.v0 + t.d - (t.d >= 6 ? 2 : 1)
    const row: number[] = []
    let u = 0
    widths.forEach((w, si) => {
      if (u > 0) for (let vv = t.v0; vv < t.v0 + t.d; vv++) setWall(u - 1, vv)
      if (t.style === 'suites' && w >= 5 && t.d >= 7 && rng.chance(0.6)) {
        // A bunk room wrapped round its wash closet (3x3 in a back corner).
        // Closets alternate sides so neighbouring suites share a wet wall.
        const left = si % 2 === 1
        const cu = left ? u : u + w - 3
        const cv = t.v0 + t.d - 3
        for (let k = 0; k < 4; k++) setWall(left ? u + 3 : u + w - 4, cv - 1 + k) // side wall (+ corner)
        for (let k = 0; k < 3; k++) setWall(cu + k, cv - 1) // front wall
        const bunk = add(
          {
            rects: [
              { u, v: t.v0, w, h: t.d - 4 },
              { u: left ? u + 4 : u, v: cv - 1, w: w - 4, h: 4 },
            ],
            style: 'bunk',
            palette: [['quarters', 1]],
          },
          ti,
        )
        const closet = add({ rects: [{ u: cu, v: cv, w: 3, h: 3 }], style: 'closet', palette: [['washroom', 1]], noCorridor: true }, ti)
        links.push({ a: closet, b: bunk, tiles: [{ u: cu + 1, v: cv - 1 }], arch: false })
      } else {
        const r = add({ rects: [{ u, v: t.v0, w, h: t.d }], style: 'room', palette: PAL[kind] }, ti)
        if (suite) {
          if (row.length > 0) links.push({ a: r, b: row[row.length - 1], tiles: [{ u: u - 1, v: line }], arch: false })
          row.push(r)
        }
      }
      u += w + 1
    })
    if (suite) {
      const order = rng.chance(0.5) ? row : [...row].reverse()
      order.forEach((r, i) => {
        rooms[r].noCorridor = i > 0
        inSuite.add(r)
      })
      suites.push(order)
    }
  })

  // ── Merge rooms across a tier wall into L / T shapes. ─────────────────────
  const mergeP = kind === 'science' ? 0.5 : kind === 'habitation' ? 0.25 : 0.35
  const merged = new Set<number>()
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i]
    if (a.style !== 'room' || merged.has(i) || inSuite.has(i) || a.rects.length !== 1) continue
    for (let j = 0; j < rooms.length; j++) {
      const b = rooms[j]
      if (j === i || b.style !== 'room' || merged.has(j) || inSuite.has(j) || b.rects.length !== 1 || tierOf[j] !== tierOf[i] + 1) continue
      const ra = a.rects[0]
      const rb = b.rects[0]
      const lo = Math.max(ra.u, rb.u)
      const hi = Math.min(ra.u + ra.w, rb.u + rb.w)
      // Only a partial overlap makes a real L/T (a full one is just a bigger box).
      if (hi - lo < 3 || (ra.u === rb.u && ra.w === rb.w)) continue
      if (!rng.chance(mergeP)) continue
      const wv = ra.v + ra.h
      for (let uu = lo; uu < hi; uu++) setWall(uu, wv, false)
      a.rects.push(rb, { u: lo, v: wv, w: hi - lo, h: 1 })
      b.rects = []
      merged.add(i)
      merged.add(j)
      break
    }
  }

  // ── Plain rooms: the odd chamfered corner or duct notch. ──────────────────
  rooms.forEach((r, ri) => {
    if (r.style !== 'room' || r.rects.length !== 1 || inSuite.has(ri)) return
    const q = r.rects[0]
    if (q.w < 5 || q.h < 5) return
    const roll = rng.next()
    if (roll > 0.35) return
    const cu = rng.chance(0.5) ? q.u : q.u + q.w - 1
    const cv = rng.chance(0.5) ? q.v : q.v + q.h - 1
    const su = cu === q.u ? 1 : -1
    const sv = cv === q.v ? 1 : -1
    if (roll < 0.2) chamfer(setWall, cu, cv, su, sv, q.w >= 7 && q.h >= 7 ? 2 : 1)
    else for (let du = 0; du < 2; du++) for (let dv = 0; dv < 2; dv++) setWall(cu + su * du, cv + sv * dv) // duct notch
  })

  // ── P6: back doors onto the servants' passage. ────────────────────────────
  const serviceDoors: ZoneLayout['serviceDoors'] = []
  if (service) {
    const above = service.v0 - 1 // wall row between the last tier and the passage
    const taken = new Set<number>()
    rooms.forEach((r, ri) => {
      if (r.rects.length === 0 || inSuite.has(ri) || r.style === 'bunk' || r.style === 'closet') return
      const servant = r.style === 'hall' || r.style === 'annex' || r.palette.some(([role]) => SERVANT_ROLES.has(role))
      if (!servant || (r.style === 'room' && !rng.chance(0.6))) return
      for (const q of r.rects) {
        if (q.v + q.h !== above) continue
        const wv = above
        const inside = wv - 1
        const cands: number[] = []
        for (let uu = q.u + 1; uu < q.u + q.w - 1; uu++) {
          if (!isWall(uu, inside) && !taken.has(uu - 1) && !taken.has(uu) && !taken.has(uu + 1)) cands.push(uu)
        }
        if (cands.length === 0) continue
        const uu = cands[rng.int(0, cands.length - 1)]
        taken.add(uu)
        serviceDoors.push({ room: ri, u: uu, v: wv })
        break
      }
    })
  }

  // ── P7: niches in the thick hull wall, one per 4 tiles, one room each. ────
  if (thick > 0) {
    rooms.forEach((r, ri) => {
      if (r.style === 'closet' || inSuite.has(ri)) return
      const back = r.rects.find((q) => q.v + q.h === ide && q.w >= 5)
      if (!back) return
      for (let uu = back.u + 2 + rng.int(0, 1); uu <= back.u + back.w - 3; uu += 4) {
        if (isWall(uu, ide - 1) || !rng.chance(0.6)) continue
        const h = Math.min(2, thick)
        for (let k = 0; k < h; k++) setWall(uu, ide + k, false)
        r.rects.push({ u: uu, v: ide, w: 1, h })
      }
    })
  }

  // Drop the rooms that were merged away, remapping every index.
  const keep = rooms.map((r) => r.rects.length > 0)
  const remap: number[] = []
  let k = 0
  for (let i = 0; i < rooms.length; i++) remap.push(keep[i] ? k++ : -1)
  return out({
    rooms: rooms.filter((_, i) => keep[i]),
    links: links.map((l) => ({ ...l, a: remap[l.a], b: remap[l.b] })),
    service,
    serviceDoors: serviceDoors.map((s) => ({ ...s, room: remap[s.room] })),
    suites: suites.map((s) => s.map((r) => remap[r])),
  })
}

/**
 * A Nightingale ward (pavilion hospital): one long pillared hall, a 3x3
 * station room at its head beside the corridor door, and a wash closet at
 * the far end.
 */
const layoutWard = (
  rng: Rng,
  iw: number,
  id: number,
  setWall: (u: number, v: number, on?: boolean) => void,
  add: (r: ZoneRoom, ti: number) => number,
  links: ZoneLink[],
  out: (extra?: Partial<ZoneLayout>) => ZoneLayout,
): ZoneLayout => {
  // Station: 3x3 at the head, one side.
  for (let k = 0; k <= 3; k++) {
    setWall(3, k)
    setWall(k, 3)
  }
  const station = (): number => add({ rects: [{ u: 0, v: 0, w: 3, h: 3 }], style: 'room', palette: STATION_PAL }, 0)
  const cu = rng.chance(0.5) ? 0 : iw - 3
  const side = cu === 0 ? 3 : iw - 4
  const iso = id >= 16 && rng.chance(0.75)
  if (iso) {
    // An isolation room at the foot, through an anteroom (the barrier-nursing
    // airlock) beside the wash closet: ward, anteroom, isolation — 3 deep.
    const foot = id - 9 // wall row between the ward and the anteroom block
    for (let u = 0; u < iw; u++) {
      setWall(u, foot)
      setWall(u, id - 5)
    }
    for (let k = 0; k < 3; k++) setWall(side, id - 8 + k)
    const au = cu === 0 ? 4 : 0
    const ward = add(
      {
        rects: [
          { u: 0, v: 4, w: iw, h: foot - 4 },
          { u: 4, v: 0, w: iw - 4, h: 4 },
        ],
        style: 'hall',
        palette: PAL.ward,
      },
      0,
    )
    const st = station()
    const closet = add({ rects: [{ u: cu, v: id - 8, w: 3, h: 3 }], style: 'closet', palette: [['washroom', 1]], noCorridor: true }, 0)
    const ante = add({ rects: [{ u: au, v: id - 8, w: iw - 4, h: 3 }], style: 'room', palette: STATION_PAL, noCorridor: true }, 0)
    const iso = add({ rects: [{ u: 0, v: id - 4, w: iw, h: 4 }], style: 'room', palette: ISOLATION_PAL, noCorridor: true }, 0)
    const mid = au + Math.floor((iw - 4) / 2)
    links.push({ a: st, b: ward, tiles: [{ u: 3, v: 1 }], arch: false })
    links.push({ a: closet, b: ward, tiles: [{ u: cu + 1, v: foot }], arch: false })
    links.push({ a: ante, b: ward, tiles: [{ u: mid, v: foot }], arch: false })
    links.push({ a: iso, b: ante, tiles: [{ u: mid, v: id - 5 }], arch: false })
  } else {
    // Wash closet: 3x3 at the foot, either side.
    for (let k = 0; k < 4; k++) setWall(side, id - 4 + k)
    for (let k = 0; k < 3; k++) setWall(cu + k, id - 4)
    const ward = add(
      {
        rects: [
          { u: 0, v: 4, w: iw, h: id - 8 },
          { u: 4, v: 0, w: iw - 4, h: 4 },
          { u: cu === 0 ? 4 : 0, v: id - 4, w: iw - 4, h: 4 },
        ],
        style: 'hall',
        palette: PAL.ward,
      },
      0,
    )
    const st = station()
    const closet = add({ rects: [{ u: cu, v: id - 3, w: 3, h: 3 }], style: 'closet', palette: [['washroom', 1]], noCorridor: true }, 0)
    links.push({ a: st, b: ward, tiles: [{ u: 3, v: 1 }], arch: false })
    links.push({ a: closet, b: ward, tiles: [{ u: cu + 1, v: id - 4 }], arch: false })
  }
  // The ward's column of pillars down the middle.
  const pu = Math.floor(iw / 2)
  // ...clear of the main hall's centre, where a mission drops its target.
  const H = iso ? id - 13 : id - 8
  const centre = new Set([4 + Math.floor(H / 2), 4 + H - 1 - Math.floor(H / 2)])
  for (let pv = 7; pv <= id - 11; pv += 3) if (!centre.has(pv)) setWall(pu, pv)
  return out()
}

/** Wall off a stair-stepped triangle of `size` tiles at a corner (u, v),
 * growing into the room along (su, sv): a chamfered corner. */
const chamfer = (setWall: (u: number, v: number) => void, u: number, v: number, su: number, sv: number, size: number): void => {
  for (let i = 0; i < size; i++) for (let j = 0; i + j < size; j++) setWall(u + su * i, v + sv * j)
}

/** One great hall spanning the tier: an annex (galley / store) in a back
 * corner opening off it through a wide arch, chamfered corners, and a
 * colonnade down a big hall. */
const layoutHall = (
  rng: Rng,
  kind: ZoneKind,
  iw: number,
  t: { v0: number; d: number },
  ti: number,
  setWall: (u: number, v: number, on?: boolean) => void,
  add: (r: ZoneRoom, ti: number) => number,
  links: ZoneLink[],
): void => {
  const hallPal = HALL_PAL[kind] ?? PAL[kind]
  const wantAnnex = iw >= 9 && t.d >= 7 && rng.chance(kind === 'commons' ? 0.92 : 0.6)
  let hallRects: LRect[] = [{ u: 0, v: t.v0, w: iw, h: t.d }]
  let annexSide = 0 // -1 left, +1 right
  let annex: LRect | undefined
  if (wantAnnex) {
    const aw = rng.int(3, Math.min(5, iw - 6))
    const ad = rng.int(3, Math.min(5, t.d - 4))
    annexSide = rng.chance(0.5) ? -1 : 1
    const au = annexSide < 0 ? 0 : iw - aw
    const av = t.v0 + t.d - ad
    annex = { u: au, v: av, w: aw, h: ad }
    const sideU = annexSide < 0 ? aw : iw - aw - 1
    for (let vv = av - 1; vv < t.v0 + t.d; vv++) setWall(sideU, vv)
    for (let uu = au; uu < au + aw; uu++) setWall(uu, av - 1)
    hallRects = [
      { u: 0, v: t.v0, w: iw, h: t.d - ad - 1 },
      { u: annexSide < 0 ? aw + 1 : 0, v: av - 1, w: iw - aw - 1, h: ad + 1 },
    ]
  }
  const hall = add({ rects: hallRects, style: 'hall', palette: hallPal }, ti)
  if (annex) {
    const a = add({ rects: [annex], style: 'annex', palette: ANNEX_PAL[kind] ?? PAL[kind] }, ti)
    // The serving arch: a 2-3 wide opening in the annex's front wall.
    const aw = Math.min(annex.w, rng.int(2, 3))
    const start = annex.u + Math.floor((annex.w - aw) / 2)
    links.push({ a, b: hall, tiles: Array.from({ length: aw }, (_, i) => ({ u: start + i, v: annex.v - 1 })), arch: true })
  }
  const main = hallRects[0]
  // Chamfer the corners that do not touch the annex.
  const size = Math.min(main.w, t.d) >= 8 ? 2 : 1
  if (Math.min(main.w, main.h) >= 5) {
    chamfer(setWall, 0, t.v0, 1, 1, size)
    chamfer(setWall, iw - 1, t.v0, -1, 1, size)
    const backV = t.v0 + t.d - 1
    if (annexSide >= 0) chamfer(setWall, 0, backV, 1, -1, size)
    if (annexSide <= 0) chamfer(setWall, iw - 1, backV, -1, -1, size)
  }
  // Colonnade: two rows of pillars down a big hall, clear of every wall.
  if (main.w >= 9 && main.h >= 7) {
    const step = main.w >= 14 ? 4 : 3
    const rows = [main.v + 2, main.v + main.h - 3]
    for (const pv of rows) for (let pu = 3; pu <= main.w - 4; pu += step) setWall(pu, pv)
  }
}
