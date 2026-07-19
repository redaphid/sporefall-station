import type { Rng } from '../rng'
import { Tile, type TileGrid, type TileId } from './level'
import type { Rect } from './rooms'

/**
 * Hallway-first interiors: instead of BSP-splitting a building into boxes, a
 * corridor SPINE is carved first (straight, L, T or loop — RNG-chosen by size)
 * and rooms hang off it, each with a door onto the spine. The spine always
 * punches its own exterior door(s) where it meets the building wall, so the
 * front door of an office opens into a hallway — sightlines and chokepoints,
 * not a warren of boxes. Interior room-to-room doors still appear, but as
 * OPTIONAL extras (chance-rolled), never the primary topology.
 *
 * All geometry is carved in a "corridor runs along +x" view; vertical spines
 * reuse the same code through a transposed grid view. Everything is a pure
 * function of the passed rng — bit-exact deterministic.
 */

export interface CarvedPlan {
  rooms: Rect[]
  doors: { x: number; y: number }[]
  /** Corridor floor rects (level coords) — patrol/waypoint friendly. */
  corridors: Rect[]
}

/** Minimal grid surface the carvers need; lets a transposed adapter reuse them. */
interface GridView {
  get(x: number, y: number): number
  set(x: number, y: number, t: TileId): void
}

const transposedView = (g: GridView): GridView => ({
  get: (x, y) => g.get(y, x),
  set: (x, y, t) => g.set(y, x, t),
})

const tRect = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w })
const tPoint = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.y, y: p.x })

const fillView = (g: GridView, x: number, y: number, w: number, h: number, t: TileId): void => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) g.set(xx, yy, t)
}

/**
 * Carve a corridor-spine interior for a medium/large building. Returns null if
 * the interior is too small for a hallway (caller falls back to direct splits).
 * `rect` is the full building footprint (walls included) — corridor ends punch
 * their exterior doors through it.
 */
export const carveHallways = (rng: Rng, grid: TileGrid, rect: Rect, interior: Rect): CarvedPlan | null => {
  if (Math.min(interior.w, interior.h) < 9) return null
  const horizontal = interior.w >= interior.h
  const view: GridView = horizontal ? grid : transposedView(grid)
  const vRect = horizontal ? rect : tRect(rect)
  const vInterior = horizontal ? interior : tRect(interior)
  const plan = carveInView(rng, view, vRect, vInterior)
  if (horizontal) return plan
  return {
    rooms: plan.rooms.map(tRect),
    doors: plan.doors.map(tPoint),
    corridors: plan.corridors.map(tRect),
  }
}

/** In view space the corridor axis is +x and interior.w >= interior.h. */
const carveInView = (rng: Rng, g: GridView, rect: Rect, interior: Rect): CarvedPlan => {
  const options: ('straight' | 'L' | 'T' | 'loop')[] = ['straight']
  if (interior.w >= 12 && interior.h >= 12) options.push('L', 'T')
  if (interior.w >= 15 && interior.h >= 15) options.push('loop')
  const topo = rng.pick(options)
  if (topo === 'loop') return carveLoop(rng, g, interior)
  if (topo === 'straight') return carveStraight(rng, g, rect, interior)
  return carveBranch(rng, g, rect, interior, topo === 'T')
}

/** One straight spine across the full interior, rooms above and below. */
const carveStraight = (rng: Rng, g: GridView, rect: Rect, interior: Rect): CarvedPlan => {
  const cwid = interior.h >= 13 && rng.chance(0.5) ? 2 : 1
  const ky = rng.int(interior.y + 4, interior.y + interior.h - 4 - cwid)
  fillView(g, interior.x, ky - 1, interior.w, 1, Tile.Wall)
  fillView(g, interior.x, ky + cwid, interior.w, 1, Tile.Wall)
  const corridor: Rect = { x: interior.x, y: ky, w: interior.w, h: cwid }
  const rooms: Rect[] = [corridor]
  const doors: { x: number; y: number }[] = []
  splitSlabAlongX(rng, g, { x: interior.x, y: interior.y, w: interior.w, h: ky - 1 - interior.y }, ky - 1, rooms, doors)
  const botY = ky + cwid + 1
  splitSlabAlongX(rng, g, { x: interior.x, y: botY, w: interior.w, h: interior.y + interior.h - botY }, ky + cwid, rooms, doors)
  punchSpineEnds(rng, g, rect, ky, cwid, doors)
  return { rooms, doors, corridors: [corridor] }
}

/** Straight spine plus a perpendicular spur to the far wall (L: spur near an
 * end; T: spur near the middle). The spur meets the exterior in its own door. */
const carveBranch = (rng: Rng, g: GridView, rect: Rect, interior: Rect, tee: boolean): CarvedPlan => {
  const cwid = 1
  const ky = rng.int(interior.y + 4, interior.y + interior.h - 4 - cwid)
  const yEnd = interior.y + interior.h - 1
  const lo = interior.x + 4
  const hi = interior.x + interior.w - 4 - cwid
  const third = Math.max(0, Math.floor((hi - lo) / 3))
  const kx = tee
    ? rng.int(lo + third, hi - third)
    : rng.chance(0.5)
      ? rng.int(lo, lo + third)
      : rng.int(hi - third, hi)

  // Walls first, corridor floor carved through them after.
  fillView(g, interior.x, ky - 1, interior.w, 1, Tile.Wall)
  fillView(g, interior.x, ky + cwid, interior.w, 1, Tile.Wall)
  fillView(g, kx - 1, ky + cwid, 1, yEnd - (ky + cwid) + 1, Tile.Wall)
  fillView(g, kx + cwid, ky + cwid, 1, yEnd - (ky + cwid) + 1, Tile.Wall)
  const main: Rect = { x: interior.x, y: ky, w: interior.w, h: cwid }
  const spur: Rect = { x: kx, y: ky + cwid, w: cwid, h: yEnd - (ky + cwid) + 1 }
  fillView(g, main.x, main.y, main.w, main.h, Tile.Floor)
  fillView(g, spur.x, spur.y, spur.w, spur.h, Tile.Floor)

  const rooms: Rect[] = [main, spur]
  const doors: { x: number; y: number }[] = []
  splitSlabAlongX(rng, g, { x: interior.x, y: interior.y, w: interior.w, h: ky - 1 - interior.y }, ky - 1, rooms, doors)
  const botY = ky + cwid + 1
  const botH = interior.y + interior.h - botY
  splitSlabAlongX(rng, g, { x: interior.x, y: botY, w: kx - 1 - interior.x, h: botH }, ky + cwid, rooms, doors)
  splitSlabAlongX(rng, g, { x: kx + cwid + 1, y: botY, w: interior.x + interior.w - (kx + cwid + 1), h: botH }, ky + cwid, rooms, doors)

  // Optional side doors from the spur into the flanking rooms.
  for (const wx of [kx - 1, kx + cwid]) {
    if (!rng.chance(0.5)) continue
    const dy = rng.int(botY, yEnd)
    const a = g.get(wx - 1, dy)
    const b = g.get(wx + 1, dy)
    if (a === Tile.Floor && b === Tile.Floor) {
      g.set(wx, dy, Tile.Floor)
      doors.push({ x: wx, y: dy })
    }
  }

  // Spur end always opens to the outside; the main spine adds 1-2 more.
  const spurDoor = { x: kx + rng.int(0, cwid - 1), y: rect.y + rect.h - 1 }
  g.set(spurDoor.x, spurDoor.y, Tile.Floor)
  doors.push(spurDoor)
  punchSpineEnds(rng, g, rect, ky, cwid, doors)
  return { rooms, doors, corridors: [main, spur] }
}

/** Ring corridor: outer rooms all around, a sealed core inside the loop. */
const carveLoop = (rng: Rng, g: GridView, interior: Rect): CarvedPlan => {
  const x0 = interior.x
  const y0 = interior.y
  const x1 = interior.x + interior.w - 1
  const y1 = interior.y + interior.h - 1

  // Outer wall lines at inset 3 (full span) box the ring; the inner wall ring
  // at inset 5 boxes the core. The corridor is the inset-4 band between them.
  fillView(g, x0, y0 + 3, interior.w, 1, Tile.Wall)
  fillView(g, x0, y1 - 3, interior.w, 1, Tile.Wall)
  fillView(g, x0 + 3, y0, 1, interior.h, Tile.Wall)
  fillView(g, x1 - 3, y0, 1, interior.h, Tile.Wall)
  ringWalls(g, { x: x0 + 5, y: y0 + 5, w: interior.w - 10, h: interior.h - 10 })
  const ring: Rect[] = [
    { x: x0 + 4, y: y0 + 4, w: interior.w - 8, h: 1 },
    { x: x0 + 4, y: y1 - 4, w: interior.w - 8, h: 1 },
    { x: x0 + 4, y: y0 + 4, w: 1, h: interior.h - 8 },
    { x: x1 - 4, y: y0 + 4, w: 1, h: interior.h - 8 },
  ]
  for (const r of ring) fillView(g, r.x, r.y, r.w, r.h, Tile.Floor)

  const rooms: Rect[] = [...ring]
  const doors: { x: number; y: number }[] = []

  // Edge rooms (may be long — split along their length), doored onto the ring.
  splitSlabAlongX(rng, g, { x: x0 + 4, y: y0, w: interior.w - 8, h: 3 }, y0 + 3, rooms, doors)
  splitSlabAlongX(rng, g, { x: x0 + 4, y: y1 - 2, w: interior.w - 8, h: 3 }, y1 - 3, rooms, doors)
  for (const left of [true, false]) {
    const sub: Rect[] = []
    const subDoors: { x: number; y: number }[] = []
    const tv = transposedView(g)
    const slab: Rect = left ? { x: x0, y: y0 + 4, w: 3, h: interior.h - 8 } : { x: x1 - 2, y: y0 + 4, w: 3, h: interior.h - 8 }
    splitSlabAlongX(rng, tv, tRect(slab), left ? x0 + 3 : x1 - 3, sub, subDoors)
    rooms.push(...sub.map(tRect))
    doors.push(...subDoors.map(tPoint))
  }

  // Corner rooms join an adjacent edge room through the inset-3 lines.
  const corners: { room: Rect; door: { x: number; y: number } }[] = [
    { room: { x: x0, y: y0, w: 3, h: 3 }, door: { x: x0 + 3, y: rng.int(y0, y0 + 2) } },
    { room: { x: x1 - 2, y: y0, w: 3, h: 3 }, door: { x: x1 - 3, y: rng.int(y0, y0 + 2) } },
    { room: { x: x0, y: y1 - 2, w: 3, h: 3 }, door: { x: x0 + 3, y: rng.int(y1 - 2, y1) } },
    { room: { x: x1 - 2, y: y1 - 2, w: 3, h: 3 }, door: { x: x1 - 3, y: rng.int(y1 - 2, y1) } },
  ]
  for (const c of corners) {
    g.set(c.door.x, c.door.y, Tile.Floor)
    rooms.push(c.room)
    doors.push(c.door)
  }

  // The core: one door onto the ring, on an rng-chosen side.
  const core: Rect = { x: x0 + 6, y: y0 + 6, w: interior.w - 12, h: interior.h - 12 }
  const side = rng.int(0, 3)
  const coreDoor =
    side === 0
      ? { x: rng.int(core.x, core.x + core.w - 1), y: y0 + 5 }
      : side === 1
        ? { x: x1 - 5, y: rng.int(core.y, core.y + core.h - 1) }
        : side === 2
          ? { x: rng.int(core.x, core.x + core.w - 1), y: y1 - 5 }
          : { x: x0 + 5, y: rng.int(core.y, core.y + core.h - 1) }
  g.set(coreDoor.x, coreDoor.y, Tile.Floor)
  doors.push(coreDoor)
  rooms.push(core)
  return { rooms, doors, corridors: ring }
}

/** Perimeter walls of a rect (the rect itself, 1 tile thick). */
const ringWalls = (g: GridView, r: Rect): void => {
  fillView(g, r.x, r.y, r.w, 1, Tile.Wall)
  fillView(g, r.x, r.y + r.h - 1, r.w, 1, Tile.Wall)
  fillView(g, r.x, r.y, 1, r.h, Tile.Wall)
  fillView(g, r.x + r.w - 1, r.y, 1, r.h, Tile.Wall)
}

/**
 * Partition a floor slab into rooms along x with 1-tile dividing walls. Every
 * room gets a door through the corridor-side wall row (`doorWallY`); dividing
 * walls roll an OPTIONAL extra room-to-room door.
 */
const splitSlabAlongX = (
  rng: Rng,
  g: GridView,
  slab: Rect,
  doorWallY: number,
  rooms: Rect[],
  doors: { x: number; y: number }[],
): void => {
  if (slab.w < 2 || slab.h < 1) return
  const slabRooms: Rect[] = []
  const cuts: number[] = []
  let cur = slab.x
  while (slab.x + slab.w - cur >= 9) {
    const roomW = rng.int(4, Math.min(7, slab.x + slab.w - cur - 5))
    const wx = cur + roomW
    fillView(g, wx, slab.y, 1, slab.h, Tile.Wall)
    cuts.push(wx)
    slabRooms.push({ x: cur, y: slab.y, w: roomW, h: slab.h })
    cur = wx + 1
  }
  slabRooms.push({ x: cur, y: slab.y, w: slab.x + slab.w - cur, h: slab.h })

  for (const r of slabRooms) {
    const dx = rng.int(r.x, r.x + r.w - 1)
    g.set(dx, doorWallY, Tile.Floor)
    doors.push({ x: dx, y: doorWallY })
  }
  for (const wx of cuts) {
    if (!rng.chance(0.35)) continue
    const dy = rng.int(slab.y, slab.y + slab.h - 1)
    if (g.get(wx - 1, dy) === Tile.Floor && g.get(wx + 1, dy) === Tile.Floor) {
      g.set(wx, dy, Tile.Floor)
      doors.push({ x: wx, y: dy })
    }
  }
  rooms.push(...slabRooms)
}

/** Open 1-2 exterior doors where the main spine meets the building wall. */
const punchSpineEnds = (
  rng: Rng,
  g: GridView,
  rect: Rect,
  ky: number,
  cwid: number,
  doors: { x: number; y: number }[],
): void => {
  const ends = [
    { x: rect.x, y: ky + rng.int(0, cwid - 1) },
    { x: rect.x + rect.w - 1, y: ky + rng.int(0, cwid - 1) },
  ]
  const count = rng.int(1, 2)
  const first = rng.int(0, 1)
  for (let i = 0; i < count; i++) {
    const d = ends[(first + i) % 2]
    g.set(d.x, d.y, Tile.Floor)
    doors.push(d)
  }
}
