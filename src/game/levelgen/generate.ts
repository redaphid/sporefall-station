import { mulberry32, type Rng } from '../rng'
import { LEVEL_H, LEVEL_W } from '../types'
import { Tile, TileGrid, type Building, type BuildingRole, type Level } from './level'
import { cutLots } from './lots'
import { splitRooms, type Rect } from './rooms'

const ROLES: readonly BuildingRole[] = ['shop', 'apartment', 'office', 'warehouse', 'clinic']

export const generateLevel = (seed: number, floor: number): Level => {
  const rng = mulberry32(seed).fork(`levelgen:${floor}`)
  const w = LEVEL_W
  const h = LEVEL_H
  const tiles = new Uint8Array(w * h).fill(Tile.Street)
  const grid = new TileGrid(w, h, tiles)

  // Streets + lots
  const colSegs = cutLots(rng.fork('cols'), w)
  const rowSegs = cutLots(rng.fork('rows'), h)
  const lots: Rect[] = []
  for (const rs of rowSegs) {
    for (const cs of colSegs) {
      lots.push({ x: cs.start, y: rs.start, w: cs.size, h: rs.size })
      grid.fillRect(cs.start, rs.start, cs.size, rs.size, Tile.Sidewalk)
    }
  }

  // Buildings (iterate lots in fixed row-major order for determinism)
  const buildings: Building[] = []
  const brng = rng.fork('buildings')
  for (const lot of lots) {
    const rect: Rect = { x: lot.x + 1, y: lot.y + 1, w: lot.w - 2, h: lot.h - 2 }
    if (rect.w < 7 || rect.h < 7 || !brng.chance(0.8)) {
      // Park / empty lot
      grid.fillRect(rect.x, rect.y, rect.w, rect.h, Tile.Grass)
      continue
    }
    grid.fillRect(rect.x, rect.y, rect.w, rect.h, Tile.Wall)
    grid.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, Tile.Floor)

    const interior: Rect = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 }
    const rooms: Rect[] = []
    const doors = splitRooms(brng, grid, interior, rooms)
    doors.push(...punchExteriorDoors(brng, grid, rect))
    buildings.push({ rect, rooms, doors, role: brng.pick(ROLES) })
  }

  // Spawn on the top-left border road; exit on the bottom-right.
  const spawn = { x: 1.5, y: 1.5 }
  const exit = { x: w - 2, y: h - 2 }
  grid.set(exit.x, exit.y, Tile.Exit)

  const level: Level = { w, h, tiles, solid: buildSolid(tiles), buildings, spawn, exit }

  // Connectivity safety net: every building interior must be reachable on foot.
  repairConnectivity(rng.fork('repair'), grid, level)
  level.solid = buildSolid(tiles)
  return level
}

const buildSolid = (tiles: Uint8Array): Uint8Array => {
  const solid = new Uint8Array(tiles.length)
  for (let i = 0; i < tiles.length; i++) solid[i] = tiles[i] === Tile.Wall ? 1 : 0
  return solid
}

/** Punch 1-2 door gaps in the building's exterior wall, facing the sidewalk. */
const punchExteriorDoors = (rng: Rng, grid: TileGrid, rect: Rect): { x: number; y: number }[] => {
  const doors: { x: number; y: number }[] = []
  const sides = ['top', 'bottom', 'left', 'right'] as const
  const count = rng.int(1, 2)
  const firstSide = rng.int(0, 3)
  for (let i = 0; i < count; i++) {
    const side = sides[(firstSide + i * 2) % 4]
    const door = doorOnSide(rng, grid, rect, side)
    if (door) doors.push(door)
  }
  return doors
}

const doorOnSide = (
  rng: Rng,
  grid: TileGrid,
  rect: Rect,
  side: 'top' | 'bottom' | 'left' | 'right',
): { x: number; y: number } | null => {
  // Candidate wall tiles on this side, excluding corners, that have floor inside.
  const candidates: { x: number; y: number }[] = []
  if (side === 'top' || side === 'bottom') {
    const y = side === 'top' ? rect.y : rect.y + rect.h - 1
    const inner = side === 'top' ? y + 1 : y - 1
    for (let x = rect.x + 1; x < rect.x + rect.w - 1; x++) {
      if (grid.get(x, inner) === Tile.Floor) candidates.push({ x, y })
    }
  } else {
    const x = side === 'left' ? rect.x : rect.x + rect.w - 1
    const inner = side === 'left' ? x + 1 : x - 1
    for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
      if (grid.get(inner, y) === Tile.Floor) candidates.push({ x, y })
    }
  }
  if (candidates.length === 0) return null
  const door = candidates[Math.floor(rng.next() * candidates.length)]
  grid.set(door.x, door.y, Tile.Floor)
  return door
}

/** BFS from spawn over walkable tiles; punch extra exterior doors for any unreachable building. */
const repairConnectivity = (rng: Rng, grid: TileGrid, level: Level): void => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const reachable = bfsReachable(level, grid)
    const unreachable = level.buildings.filter((b) => {
      const cx = b.rect.x + 1
      const cy = b.rect.y + 1
      return !reachable[cy * level.w + cx]
    })
    if (unreachable.length === 0) return
    for (const b of unreachable) {
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const door = doorOnSide(rng, grid, b.rect, side)
        if (door) {
          b.doors.push(door)
          break
        }
      }
    }
    level.solid = buildSolid(level.tiles)
  }
}

const bfsReachable = (level: Level, grid: TileGrid): Uint8Array => {
  const { w, h } = level
  const reachable = new Uint8Array(w * h)
  const startX = Math.floor(level.spawn.x)
  const startY = Math.floor(level.spawn.y)
  const queue: number[] = [startY * w + startX]
  reachable[queue[0]] = 1
  while (queue.length > 0) {
    const idx = queue.pop()!
    const x = idx % w
    const y = (idx / w) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (!grid.inBounds(nx, ny)) continue
      const nidx = ny * w + nx
      if (reachable[nidx] || grid.get(nx, ny) === Tile.Wall) continue
      reachable[nidx] = 1
      queue.push(nidx)
    }
  }
  return reachable
}
