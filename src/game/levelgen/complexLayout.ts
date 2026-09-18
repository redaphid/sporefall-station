import type { Rng } from '../rng'
import type { BuildingRole, Corridor } from './level'
import type { Rect } from './rooms'

/**
 * FLOORPLAN geometry for the indoor complex (complex.ts owns roles, decks,
 * doors and dressing; this file owns the SHAPE of the station).
 *
 * The first complex generator cut the map into a regular grid of blocks and
 * filled each block with a strip of boxes: every floor read as graph paper.
 * Real facilities (and the good player-built bases in RimWorld) are organised
 * by a HIERARCHY of circulation and by PURPOSE, so this builds a floor the way
 * an architect would:
 *
 *   1. A TEMPLATE lays the primary circulation — one 3-wide main spine, a
 *      spine with a tee / cross, a ladder of two spines joined by rungs, or a
 *      ring of spines and rungs round a central core (a great hall or an open
 *      atrium). The spawn is an airlock stub at the end of a spine. A random
 *      dihedral transform (flip / transpose) orients the whole thing, and the
 *      spine template is mirror-SYMMETRIC about its spine a third of the time.
 *   2. Each strip of floor beside a spine is a BAND, cut along its length into
 *      ZONES (the lights-out wings). Between zones: a shared wall, or a 2-wide
 *      secondary corridor running back from the spine — a dead-end service
 *      hall, or a rung joining two spines. Zones take ragged depths, and a band
 *      may leave an end zone out entirely, so the hull outline steps and notches
 *      instead of filling the square.
 *   3. Each zone is ZONED by purpose (entry / commons / engineering /
 *      habitation / science / stores) and partitioned into TIERS parallel to its
 *      spine, each tier a style: a great HALL (pillared, chamfered, with an
 *      annex — the galley — opening off it through a wide serving arch), a row
 *      of bunk SUITES (an L-shaped bunk room wrapped round its own wash closet,
 *      mirrored in pairs so closets share a wet wall), or a row of ROOMS cut at
 *      different points per tier so walls stagger into T-junctions. Rooms in
 *      neighbouring tiers are then MERGED into L/T shapes, and plain rooms get
 *      the odd chamfered corner or duct notch.
 *
 * Everything is in band-LOCAL coordinates (u along the spine, v away from
 * it), mapped to the grid by a `Frame`, so one set of recipes serves every
 * orientation. Pure function of the rng: bit-exact from seed+floor.
 */

export type ZoneKind = 'entry' | 'commons' | 'engineering' | 'habitation' | 'science' | 'stores'
export type RoomStyle = 'room' | 'hall' | 'annex' | 'bunk' | 'closet'
export type Palette = readonly (readonly [BuildingRole, number])[]

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

// ── Templates (canonical orientation, then a dihedral transform) ─────────────

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
}

export interface CoreSpec {
  rect: Rect
  face: Vec
  label: string
  atrium: boolean
}

export interface Skeleton {
  template: 'spine' | 'tee' | 'ladder' | 'ring'
  symmetric: boolean
  corridors: Corridor[]
  bands: BandSpec[]
  cores: CoreSpec[]
  /** Spawn tile: the airlock stub at a spine's end. */
  spawn: Vec
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

/**
 * Lay the primary circulation for an `n` x `n` map (1-tile hull ring). All
 * coordinates below are canonical — main spines horizontal, entrance at the
 * west — before the dihedral transform.
 */
export const layoutSkeleton = (rng: Rng, n: number): Skeleton => {
  const last = n - 2 // last interior row/col
  const roll = rng.int(0, 99)
  const template: Skeleton['template'] = roll < 30 ? 'spine' : roll < 55 ? 'tee' : roll < 78 ? 'ladder' : 'ring'
  const corridors: Corridor[] = []
  const bands: BandSpec[] = []
  const cores: CoreSpec[] = []
  const hspine = (y: number): void => {
    corridors.push({ axis: 'h', rect: { x: 1, y, w: n - 2, h: 3 } })
  }
  const vcorr = (x: number, y0: number, y1: number): void => {
    corridors.push({ axis: 'v', rect: { x, y: y0, w: 3, h: y1 - y0 + 1 } })
  }
  // Airlock stubs: the spine runs past the modules at the entrance (west) and
  // sometimes at the far end, so it reads as a docking arm, not a map edge.
  const a = rng.int(1, 4)
  const b = rng.int(0, 3)
  const x0 = 1 + a
  const x1 = last - b
  const band = (x: number, y: number, w: number, h: number, face: Vec, label: string, full = false, voidEnds = false): void => {
    bands.push({ rect: { x, y, w, h }, face, label, full, voidEnds })
  }
  let symmetric = false
  let spawnY: number

  if (template === 'spine' || template === 'tee') {
    symmetric = rng.chance(0.35)
    const sy = symmetric ? (n - 4) / 2 : rng.int(Math.floor(n * 0.34), Math.floor(n * 0.6))
    hspine(sy)
    spawnY = sy + 1
    const northH = sy - 1
    const southY = sy + 3
    const southH = (symmetric ? last - 1 : last) - southY + 1
    const splitNorth = template === 'tee'
    const splitSouth = template === 'tee' && (symmetric || rng.chance(0.5))
    const cx = rng.int(Math.floor(n * 0.3), Math.floor(n * 0.62))
    const half = (y: number, h: number, face: Vec, label: string, split: boolean, voidEnds: boolean): void => {
      if (!split) {
        band(x0, y, x1 - x0 + 1, h, face, label, false, voidEnds)
        return
      }
      vcorr(cx, y, y + h - 1)
      bands.push({ rect: { x: x0, y, w: cx - x0, h }, face, label: `${label}W`, full: false, voidEnds, keepEnd: true })
      bands.push({ rect: { x: cx + 3, y, w: x1 - cx - 2, h }, face, label: `${label}E`, full: false, voidEnds, keepStart: true })
    }
    half(1, northH, DOWN, 'north', splitNorth, true)
    half(southY, southH, UP, symmetric ? 'north' : 'south', splitSouth, false)
  } else {
    // Two main spines. Ladder: the band between them hangs rungs across.
    // Ring: two 3-wide rungs box in a central core (a great hall or atrium).
    const ring = template === 'ring'
    const s1 = ring ? rng.int(11, 16) : rng.int(13, 20)
    const mid = ring ? rng.int(15, 21) : rng.int(10, 15)
    const s2 = s1 + 3 + mid
    hspine(s1)
    hspine(s2)
    spawnY = s1 + 1
    band(x0, 1, x1 - x0 + 1, s1 - 1, DOWN, 'north', false, true)
    band(x0, s2 + 3, x1 - x0 + 1, last - (s2 + 3) + 1, UP, 'south')
    const my = s1 + 3
    if (!ring) {
      band(x0, my, x1 - x0 + 1, mid, UP, 'mid', true)
    } else {
      const r1 = rng.int(12, 17)
      const r2 = n - 3 - rng.int(12, 17)
      vcorr(r1, my, my + mid - 1)
      vcorr(r2, my, my + mid - 1)
      bands.push({ rect: { x: x0, y: my, w: r1 - x0, h: mid }, face: RIGHT, label: 'west', full: false, voidEnds: false, flat: true })
      bands.push({ rect: { x: r2 + 3, y: my, w: x1 - r2 - 2, h: mid }, face: LEFT, label: 'east', full: false, voidEnds: false, flat: true })
      cores.push({ rect: { x: r1 + 3, y: my, w: r2 - r1 - 3, h: mid }, face: UP, label: 'core', atrium: rng.chance(0.4) })
    }
  }

  const d: Dihedral = { t: rng.chance(0.5), fx: rng.chance(0.5), fy: rng.chance(0.5), n }
  return {
    template,
    symmetric,
    corridors: corridors.map((c) => {
      const rect = tRect(d, c.rect)
      return { axis: d.t ? (c.axis === 'h' ? 'v' : 'h') : c.axis, rect }
    }),
    bands: bands.map((bd) => {
      // The grid frame runs u along +x / +y; when the transform reversed the
      // band's canonical u, its start and end swap.
      const along = tDir(d, bd.face.y !== 0 ? RIGHT : DOWN)
      const flip = along.x + along.y < 0
      return {
        ...bd,
        rect: tRect(d, bd.rect),
        face: tDir(d, bd.face),
        keepStart: flip ? bd.keepEnd : bd.keepStart,
        keepEnd: flip ? bd.keepStart : bd.keepEnd,
      }
    }),
    cores: cores.map((c) => ({ ...c, rect: tRect(d, c.rect), face: tDir(d, c.face) })),
    spawn: tPoint(d, { x: 1, y: spawnY }),
  }
}

// ── Bands → zones + secondary corridors ─────────────────────────────────────

/** Narrowest / widest zone, walls included. */
const ZONE_MIN = 7
const ZONE_MAX = 18
/** Shallowest zone, walls included (a 5-deep interior). */
const DEPTH_MIN = 7

export interface BandZone {
  /** Band-local start (the zone's own wall column) and width, walls included. */
  u0: number
  w: number
  /** Depth from the band front, walls included. */
  d: number
}

export interface BandLayout {
  zones: BandZone[]
  /** 2-wide secondary corridors: band-local start column and length. */
  branches: { u0: number; len: number }[]
}

export const layoutBand = (
  rng: Rng,
  len: number,
  depth: number,
  full: boolean,
  voidEnds: boolean,
  keep: { start?: boolean; end?: boolean; flat?: boolean } = {},
): BandLayout => {
  const zones: BandZone[] = []
  const seps: ('branch' | 'wall')[] = []
  const deep = depth > 12
  let u = 0
  for (;;) {
    const rem = len - u
    if (rem <= ZONE_MAX || rem < 2 * ZONE_MIN + 2) {
      zones.push({ u0: u, w: rem, d: depth })
      break
    }
    const w = rng.int(ZONE_MIN, Math.min(ZONE_MAX, rem - ZONE_MIN - 2))
    zones.push({ u0: u, w, d: depth })
    const branch = rng.chance(full ? 0.55 : deep ? 0.72 : 0.3)
    seps.push(branch ? 'branch' : 'wall')
    u += branch ? w + 2 : w - 1
  }
  // A full band must be crossable (at least one rung), and a deep band needs
  // at least one service hall so its back rooms are not a chain of
  // pass-throughs. Either is cut from the
  // back of a zone wide enough to lose 3 columns (the hall + its own wall).
  if ((full || deep) && zones.length > 1 && !seps.includes('branch')) {
    const k = zones.findIndex((z, i) => i < zones.length - 1 && z.w >= ZONE_MIN + 3)
    if (k >= 0) {
      seps[k] = 'branch'
      zones[k].w -= 3
    }
  }
  if (!full && !keep.flat) {
    // Ragged depths: the building's outline steps in and out.
    for (const z of zones) if (depth > DEPTH_MIN && !rng.chance(0.5)) z.d = rng.int(Math.max(DEPTH_MIN, Math.ceil(depth * 0.55)), depth)
    if (keep.start) zones[0].d = depth
    if (keep.end) zones[zones.length - 1].d = depth
  }
  const voided = new Set<number>()
  if (voidEnds && zones.length >= 3) {
    if (rng.chance(0.3) && !keep.start) voided.add(0)
    if (rng.chance(0.3) && !keep.end) voided.add(zones.length - 1)
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
  return { zones: zones.filter((_, i) => !voided.has(i)), branches }
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
export const layoutZone = (rng: Rng, kind: ZoneKind, iw: number, id: number, core: boolean): ZoneLayout => {
  const wall = new Uint8Array(iw * id)
  const setWall = (u: number, v: number, on = true): void => {
    if (u >= 0 && v >= 0 && u < iw && v < id) wall[v * iw + u] = on ? 1 : 0
  }
  const rooms: ZoneRoom[] = []
  const links: ZoneLink[] = []
  const tierOf: number[] = []

  // ── Tiers parallel to the front. ──────────────────────────────────────────
  const tiers: { v0: number; d: number; style: TierStyle }[] = []
  const hallFirst = kind === 'commons' || kind === 'engineering' || (kind === 'science' && iw >= 10 && rng.chance(0.3))
  let v = 0
  if (hallFirst && iw >= 7 && id >= 5) {
    const want = core ? Math.round(id * 0.6) : kind === 'engineering' ? rng.int(7, 11) : rng.int(8, 11)
    const d = id - want - 1 < 3 ? id : Math.min(want, id)
    tiers.push({ v0: 0, d, style: 'hall' })
    v = d + 1
  }
  if (v < id) {
    const [lo, hi] = kind === 'habitation' ? [7, 9] : kind === 'stores' ? [4, 7] : kind === 'science' ? [5, 9] : [4, 8]
    for (const d of cutStrip(rng, id - v, lo, hi)) {
      const style: TierStyle = kind === 'habitation' && d >= 5 ? 'suites' : 'rooms'
      tiers.push({ v0: v, d, style })
      v += d + 1
    }
  }
  tiers.forEach((t, ti) => {
    if (ti > 0) for (let u = 0; u < iw; u++) setWall(u, t.v0 - 1)
  })

  const add = (r: ZoneRoom, ti: number): number => {
    rooms.push(r)
    tierOf.push(ti)
    return rooms.length - 1
  }

  tiers.forEach((t, ti) => {
    if (t.style === 'hall') {
      layoutHall(rng, kind, iw, t, ti, setWall, add, links)
      return
    }
    const [lo, hi] = t.style === 'suites' ? [5, 8] : kind === 'stores' ? [4, 8] : kind === 'science' ? [5, 10] : [4, 9]
    let u = 0
    cutStrip(rng, iw, lo, hi).forEach((w, si) => {
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
        add({ rects: [{ u, v: t.v0, w, h: t.d }], style: 'room', palette: PAL[kind] }, ti)
      }
      u += w + 1
    })
  })

  // ── Merge rooms across a tier wall into L / T shapes. ─────────────────────
  const mergeP = kind === 'science' ? 0.5 : kind === 'habitation' ? 0.25 : 0.35
  const merged = new Set<number>()
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i]
    if (a.style !== 'room' || merged.has(i) || a.rects.length !== 1) continue
    for (let j = 0; j < rooms.length; j++) {
      const b = rooms[j]
      if (j === i || b.style !== 'room' || merged.has(j) || b.rects.length !== 1 || tierOf[j] !== tierOf[i] + 1) continue
      const ra = a.rects[0]
      const rb = b.rects[0]
      const lo = Math.max(ra.u, rb.u)
      const hi = Math.min(ra.u + ra.w, rb.u + rb.w)
      // Only a partial overlap makes a real L/T (a full one is just a bigger box).
      if (hi - lo < 3 || (ra.u === rb.u && ra.w === rb.w)) continue
      if (!rng.chance(mergeP)) continue
      const wv = ra.v + ra.h
      for (let u = lo; u < hi; u++) setWall(u, wv, false)
      a.rects.push(rb, { u: lo, v: wv, w: hi - lo, h: 1 })
      b.rects = []
      merged.add(i)
      merged.add(j)
      break
    }
  }
  // Drop the rooms that were merged away, remapping link indices.
  const keep = rooms.map((r) => r.rects.length > 0)
  const remap: number[] = []
  let k = 0
  for (let i = 0; i < rooms.length; i++) remap.push(keep[i] ? k++ : -1)
  const outRooms = rooms.filter((_, i) => keep[i])
  const outLinks = links.map((l) => ({ ...l, a: remap[l.a], b: remap[l.b] }))

  // ── Plain rooms: the odd chamfered corner or duct notch. ──────────────────
  for (const r of outRooms) {
    if (r.style !== 'room' || r.rects.length !== 1) continue
    const q = r.rects[0]
    if (q.w < 5 || q.h < 5) continue
    const roll = rng.next()
    if (roll > 0.35) continue
    const cu = rng.chance(0.5) ? q.u : q.u + q.w - 1
    const cv = rng.chance(0.5) ? q.v : q.v + q.h - 1
    const su = cu === q.u ? 1 : -1
    const sv = cv === q.v ? 1 : -1
    if (roll < 0.2) chamfer(setWall, cu, cv, su, sv, q.w >= 7 && q.h >= 7 ? 2 : 1)
    else for (let du = 0; du < 2; du++) for (let dv = 0; dv < 2; dv++) setWall(cu + su * du, cv + sv * dv) // duct notch
  }
  return { iw, id, wall, rooms: outRooms, links: outLinks }
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
