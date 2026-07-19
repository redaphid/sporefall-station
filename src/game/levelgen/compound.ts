import type { Rng } from '../rng'
import { Tile, type TileGrid, type TileId } from './level'
import type { Rect } from './rooms'

/**
 * Courtyard compound: a ring of rooms around an open courtyard "pit". A gated
 * passage runs from the street straight into the courtyard (double doors,
 * flanked by walls), every edge room doors onto the courtyard, and corner
 * rooms join their neighbouring edge rooms — so fights funnel into the pit
 * and patrols can circle it. Replaces the old plain ring-of-floor courtyard
 * on themed floors.
 */
export interface CompoundPlan {
  rooms: Rect[]
  doors: { x: number; y: number }[]
  /** The open pit (ground tiles, not Floor). */
  courtyard: Rect
}

/** Requires interior >= 11x11. `rect` is the footprint incl. building walls. */
export const carveCompound = (
  rng: Rng,
  grid: TileGrid,
  rect: Rect,
  interior: Rect,
  ground: TileId,
): CompoundPlan => {
  const d = Math.min(interior.w, interior.h) >= 15 ? 3 : 2 // room band depth
  const x0 = interior.x
  const y0 = interior.y
  const x1 = interior.x + interior.w - 1
  const y1 = interior.y + interior.h - 1

  // Full-span wall lines at inset d box the ring of rooms.
  grid.fillRect(x0, y0 + d, interior.w, 1, Tile.Wall)
  grid.fillRect(x0, y1 - d, interior.w, 1, Tile.Wall)
  grid.fillRect(x0 + d, y0, 1, interior.h, Tile.Wall)
  grid.fillRect(x1 - d, y0, 1, interior.h, Tile.Wall)

  // The pit: open ground (theme yard/grass), not interior floor.
  const courtyard: Rect = {
    x: x0 + d + 1,
    y: y0 + d + 1,
    w: interior.w - 2 * (d + 1),
    h: interior.h - 2 * (d + 1),
  }
  grid.fillRect(courtyard.x, courtyard.y, courtyard.w, courtyard.h, ground)

  const rooms: Rect[] = []
  const doors: { x: number; y: number }[] = []

  // Gate side: exterior door through the building wall, aligned with a second
  // door through the inset wall, walls flanking the passage between them.
  const gateSide = rng.int(0, 3) // 0=top 1=right 2=bottom 3=left

  // Edge rooms (split in two by the gate passage on the gated side).
  const edges: { side: number; room: Rect; wallLine: number; horizontal: boolean }[] = [
    { side: 0, room: { x: x0 + d + 1, y: y0, w: interior.w - 2 * (d + 1), h: d }, wallLine: y0 + d, horizontal: true },
    { side: 2, room: { x: x0 + d + 1, y: y1 - d + 1, w: interior.w - 2 * (d + 1), h: d }, wallLine: y1 - d, horizontal: true },
    { side: 3, room: { x: x0, y: y0 + d + 1, w: d, h: interior.h - 2 * (d + 1) }, wallLine: x0 + d, horizontal: false },
    { side: 1, room: { x: x1 - d + 1, y: y0 + d + 1, w: d, h: interior.h - 2 * (d + 1) }, wallLine: x1 - d, horizontal: false },
  ]

  for (const e of edges) {
    if (e.side === gateSide) {
      carveGate(rng, grid, rect, e, rooms, doors)
      continue
    }
    rooms.push(e.room)
    // Door onto the courtyard through the inset wall.
    if (e.horizontal) {
      const dx = rng.int(e.room.x, e.room.x + e.room.w - 1)
      grid.set(dx, e.wallLine, Tile.Floor)
      doors.push({ x: dx, y: e.wallLine })
    } else {
      const dy = rng.int(e.room.y, e.room.y + e.room.h - 1)
      grid.set(e.wallLine, dy, Tile.Floor)
      doors.push({ x: e.wallLine, y: dy })
    }
  }

  // Corner rooms join a neighbouring edge room through the inset lines.
  const cornerDoors: { room: Rect; door: { x: number; y: number } }[] = [
    { room: { x: x0, y: y0, w: d, h: d }, door: { x: x0 + d, y: rng.int(y0, y0 + d - 1) } },
    { room: { x: x1 - d + 1, y: y0, w: d, h: d }, door: { x: x1 - d, y: rng.int(y0, y0 + d - 1) } },
    { room: { x: x0, y: y1 - d + 1, w: d, h: d }, door: { x: x0 + d, y: rng.int(y1 - d + 1, y1) } },
    { room: { x: x1 - d + 1, y: y1 - d + 1, w: d, h: d }, door: { x: x1 - d, y: rng.int(y1 - d + 1, y1) } },
  ]
  for (const c of cornerDoors) {
    grid.set(c.door.x, c.door.y, Tile.Floor)
    rooms.push(c.room)
    doors.push(c.door)
  }

  return { rooms, doors, courtyard }
}

/** The gated edge: a straight walled passage from street to courtyard, double
 * doors at both ends, splitting that edge's room band in two. */
const carveGate = (
  rng: Rng,
  grid: TileGrid,
  rect: Rect,
  e: { side: number; room: Rect; wallLine: number; horizontal: boolean },
  rooms: Rect[],
  doors: { x: number; y: number }[],
): void => {
  if (e.horizontal) {
    const gx = rng.int(e.room.x + 2, e.room.x + e.room.w - 3)
    const outerY = e.side === 0 ? rect.y : rect.y + rect.h - 1
    // Passage floor from building wall through the band to the inset wall.
    const top = Math.min(outerY, e.wallLine)
    for (let y = top; y <= Math.max(outerY, e.wallLine); y++) grid.set(gx, y, Tile.Floor)
    // Flank walls through the band rows only (not the wall lines).
    for (let y = e.room.y; y < e.room.y + e.room.h; y++) {
      grid.set(gx - 1, y, Tile.Wall)
      grid.set(gx + 1, y, Tile.Wall)
    }
    doors.push({ x: gx, y: outerY }, { x: gx, y: e.wallLine })
    rooms.push({ x: e.room.x, y: e.room.y, w: gx - 1 - e.room.x, h: e.room.h })
    rooms.push({ x: gx + 2, y: e.room.y, w: e.room.x + e.room.w - (gx + 2), h: e.room.h })
    // Each half still needs its own way into the courtyard.
    for (const r of rooms.slice(-2)) {
      const dx = rng.int(r.x, r.x + r.w - 1)
      grid.set(dx, e.wallLine, Tile.Floor)
      doors.push({ x: dx, y: e.wallLine })
    }
  } else {
    const gy = rng.int(e.room.y + 2, e.room.y + e.room.h - 3)
    const outerX = e.side === 3 ? rect.x : rect.x + rect.w - 1
    const left = Math.min(outerX, e.wallLine)
    for (let x = left; x <= Math.max(outerX, e.wallLine); x++) grid.set(x, gy, Tile.Floor)
    for (let x = e.room.x; x < e.room.x + e.room.w; x++) {
      grid.set(x, gy - 1, Tile.Wall)
      grid.set(x, gy + 1, Tile.Wall)
    }
    doors.push({ x: outerX, y: gy }, { x: e.wallLine, y: gy })
    rooms.push({ x: e.room.x, y: e.room.y, w: e.room.w, h: gy - 1 - e.room.y })
    rooms.push({ x: e.room.x, y: gy + 2, w: e.room.w, h: e.room.y + e.room.h - (gy + 2) })
    for (const r of rooms.slice(-2)) {
      const dy = rng.int(r.y, r.y + r.h - 1)
      grid.set(e.wallLine, dy, Tile.Floor)
      doors.push({ x: e.wallLine, y: dy })
    }
  }
}
