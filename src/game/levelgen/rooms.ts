import type { Rng } from '../rng'
import { Tile, type TileGrid } from './level'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface WallSeg {
  axis: 'v' | 'h'
  /** For 'v': the wall column; for 'h': the wall row. */
  line: number
  /** Span along the wall (rows for 'v', cols for 'h'), inclusive. */
  from: number
  to: number
}

/**
 * Recursively split a building's interior floor region into rooms with 1-tile
 * walls. Walls are all drawn first; doors are punched afterwards at positions
 * where both sides are floor, so a door can never open into a later wall.
 * Returns interior door positions.
 */
export const splitRooms = (
  rng: Rng,
  grid: TileGrid,
  interior: Rect,
  rooms: Rect[],
): { x: number; y: number }[] => {
  const walls: WallSeg[] = []
  split(rng, grid, interior, rooms, walls, 0)

  const doors: { x: number; y: number }[] = []
  for (const w of walls) {
    const candidates: { x: number; y: number }[] = []
    for (let i = w.from; i <= w.to; i++) {
      const [x, y] = w.axis === 'v' ? [w.line, i] : [i, w.line]
      const [ax, ay, bx, by] = w.axis === 'v' ? [x - 1, y, x + 1, y] : [x, y - 1, x, y + 1]
      if (grid.get(ax, ay) === Tile.Floor && grid.get(bx, by) === Tile.Floor) {
        candidates.push({ x, y })
      }
    }
    if (candidates.length > 0) {
      const door = candidates[Math.floor(rng.next() * candidates.length)]
      grid.set(door.x, door.y, Tile.Floor)
      doors.push(door)
    }
  }
  return doors
}

const split = (
  rng: Rng,
  grid: TileGrid,
  rect: Rect,
  rooms: Rect[],
  walls: WallSeg[],
  depth: number,
): void => {
  const canSplitX = rect.w >= 9
  const canSplitY = rect.h >= 9
  if (depth >= 2 || (!canSplitX && !canSplitY)) {
    rooms.push(rect)
    return
  }
  const splitX = canSplitX && (!canSplitY || rect.w >= rect.h)
  if (splitX) {
    const c = rect.x + rng.int(3, rect.w - 5)
    for (let y = rect.y; y < rect.y + rect.h; y++) grid.set(c, y, Tile.Wall)
    walls.push({ axis: 'v', line: c, from: rect.y, to: rect.y + rect.h - 1 })
    split(rng, grid, { x: rect.x, y: rect.y, w: c - rect.x, h: rect.h }, rooms, walls, depth + 1)
    split(rng, grid, { x: c + 1, y: rect.y, w: rect.x + rect.w - c - 1, h: rect.h }, rooms, walls, depth + 1)
  } else {
    const c = rect.y + rng.int(3, rect.h - 5)
    for (let x = rect.x; x < rect.x + rect.w; x++) grid.set(x, c, Tile.Wall)
    walls.push({ axis: 'h', line: c, from: rect.x, to: rect.x + rect.w - 1 })
    split(rng, grid, { x: rect.x, y: rect.y, w: rect.w, h: c - rect.y }, rooms, walls, depth + 1)
    split(rng, grid, { x: rect.x, y: c + 1, w: rect.w, h: rect.y + rect.h - c - 1 }, rooms, walls, depth + 1)
  }
}
