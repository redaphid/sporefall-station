import { mulberry32, type Rng } from '../rng'
import { LEVEL_H, LEVEL_W } from '../types'
import { Tile, TileGrid, themeForFloor, type Building, type BuildingRole, type Level, type Theme } from './level'
import { BORDER, cutLots } from './lots'
import { splitRooms, type Rect } from './rooms'

const CLASSIC_ROLES: readonly BuildingRole[] = ['shop', 'apartment', 'office', 'warehouse', 'clinic']

export const generateLevel = (seed: number, floor: number): Level => {
  const rng = mulberry32(seed).fork(`levelgen:${floor}`)
  const w = LEVEL_W
  const h = LEVEL_H
  const tiles = new Uint8Array(w * h).fill(Tile.Street)
  const grid = new TileGrid(w, h, tiles)
  const theme = themeForFloor(floor)

  // Floor 1 is the familiar surface city, kept byte-for-byte with the original
  // generator so the scripted-demo regression guards (which replay fixed inputs
  // on a specific seed/floor-1 map) stay valid. Deeper floors mutate by theme.
  const buildings = floor === 1 ? buildClassicCity(rng, grid, w, h) : buildThemedCity(rng, grid, w, h, theme, floor)

  const { spawn, exit } =
    floor === 1
      ? { spawn: { x: 1.5, y: 1.5 }, exit: { x: w - 2, y: h - 2 } }
      : varyEndpoints(rng.fork('spawnExit'), w, h)
  grid.set(exit.x, exit.y, Tile.Exit)

  const level: Level = { w, h, tiles, solid: buildSolid(tiles), buildings, spawn, exit, theme: theme.name }

  // Connectivity safety net: every building interior must be reachable on foot.
  repairConnectivity(rng.fork('repair'), grid, level)
  level.solid = buildSolid(tiles)
  return level
}

/** The original uniform grid-of-boxes city. Kept intact for floor 1. */
const buildClassicCity = (rng: Rng, grid: TileGrid, w: number, h: number): Building[] => {
  const colSegs = cutLots(rng.fork('cols'), w)
  const rowSegs = cutLots(rng.fork('rows'), h)
  const lots: Rect[] = []
  for (const rs of rowSegs) {
    for (const cs of colSegs) {
      lots.push({ x: cs.start, y: rs.start, w: cs.size, h: rs.size })
      grid.fillRect(cs.start, rs.start, cs.size, rs.size, Tile.Sidewalk)
    }
  }
  const buildings: Building[] = []
  const brng = rng.fork('buildings')
  for (const lot of lots) {
    const rect: Rect = { x: lot.x + 1, y: lot.y + 1, w: lot.w - 2, h: lot.h - 2 }
    if (rect.w < 7 || rect.h < 7 || !brng.chance(0.8)) {
      grid.fillRect(rect.x, rect.y, rect.w, rect.h, Tile.Grass)
      continue
    }
    grid.fillRect(rect.x, rect.y, rect.w, rect.h, Tile.Wall)
    grid.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, Tile.Floor)
    const interior: Rect = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 }
    const rooms: Rect[] = []
    const doors = splitRooms(brng, grid, interior, rooms)
    doors.push(...punchExteriorDoors(brng, grid, rect))
    buildings.push({ rect, rooms, doors, role: brng.pick(CLASSIC_ROLES) })
  }
  return buildings
}

/**
 * Themed district for floors >= 2. Density, footprints, role palette and
 * set-pieces (courtyards, vaults, setbacks) all vary by theme so consecutive
 * floors read differently. Each lot forks its own RNG stream (by position) so
 * generation is order-independent and stays deterministic.
 */
const buildThemedCity = (rng: Rng, grid: TileGrid, w: number, h: number, theme: Theme, floor: number): Building[] => {
  // Deeper floors pack in a little tighter (capped) — a gentle difficulty ramp.
  const buildChance = Math.min(0.95, theme.buildingChance + 0.02 * (floor - 1))
  const colSegs = cutLots(rng.fork('cols'), w, theme.minLots, theme.maxLots)
  const rowSegs = cutLots(rng.fork('rows'), h, theme.minLots, theme.maxLots)
  const lots: Rect[] = []
  for (const rs of rowSegs) {
    for (const cs of colSegs) {
      lots.push({ x: cs.start, y: rs.start, w: cs.size, h: rs.size })
      grid.fillRect(cs.start, rs.start, cs.size, rs.size, Tile.Sidewalk)
    }
  }

  const buildings: Building[] = []
  const brng = rng.fork('buildings')
  for (const lot of lots) {
    const lrng = brng.fork(`${lot.x}:${lot.y}`)
    const inset: Rect = { x: lot.x + 1, y: lot.y + 1, w: lot.w - 2, h: lot.h - 2 }
    if (inset.w < 7 || inset.h < 7 || !lrng.chance(buildChance)) {
      grid.fillRect(inset.x, inset.y, inset.w, inset.h, theme.yard)
      continue
    }

    // Setback: sometimes the building shrinks + offsets, leaving a yard around it.
    let rect = inset
    if (inset.w >= 9 && inset.h >= 9 && lrng.chance(theme.setbackChance)) {
      grid.fillRect(inset.x, inset.y, inset.w, inset.h, theme.yard)
      const dw = lrng.int(2, 3)
      const dh = lrng.int(2, 3)
      rect = { x: inset.x + lrng.int(0, dw), y: inset.y + lrng.int(0, dh), w: inset.w - dw, h: inset.h - dh }
    }

    grid.fillRect(rect.x, rect.y, rect.w, rect.h, Tile.Wall)
    grid.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, Tile.Floor)
    const interior: Rect = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 }

    const rooms: Rect[] = []
    const doors: { x: number; y: number }[] = []
    let poi: Building['poi']
    const large = interior.w >= 11 && interior.h >= 11
    if (large && lrng.chance(theme.courtyardChance)) {
      // Ring building: an open courtyard leaves a connected loop of floor.
      carveCourtyard(grid, interior)
      rooms.push(interior)
      poi = 'courtyard'
    } else if (interior.w >= 12 && interior.h >= 12 && lrng.chance(theme.vaultChance)) {
      // Open hall with a single sealed reward chamber — no split walls to break.
      const vault = carveVault(lrng, grid, interior)
      rooms.push(interior)
      if (vault) {
        rooms.push(vault.rect)
        doors.push(vault.door)
        poi = 'vault'
      }
    } else {
      doors.push(...splitRooms(lrng, grid, interior, rooms))
    }
    doors.push(...punchExteriorDoors(lrng, grid, rect))
    buildings.push({ rect, rooms, doors, role: lrng.pick(theme.roles), poi })
  }
  return buildings
}

/** Spawn + exit on opposite border edges (varied, not the fixed TL->BR diagonal). */
const varyEndpoints = (
  se: Rng,
  w: number,
  h: number,
): { spawn: { x: number; y: number }; exit: { x: number; y: number } } => {
  const edge = se.int(0, 3)
  const s = edgeTile(se, edge, w, h)
  const e = edgeTile(se, (edge + 2) % 4, w, h)
  return { spawn: { x: s.x + 0.5, y: s.y + 0.5 }, exit: { x: e.x, y: e.y } }
}

/** Carve a central open courtyard, leaving a 2-wide connected floor ring around it. */
const carveCourtyard = (grid: TileGrid, interior: Rect): void => {
  grid.fillRect(interior.x + 2, interior.y + 2, interior.w - 4, interior.h - 4, Tile.Grass)
}

/** A sealed reward room tucked in an interior corner, with one door onto the floor. */
const carveVault = (
  rng: Rng,
  grid: TileGrid,
  interior: Rect,
): { rect: Rect; door: { x: number; y: number } } | null => {
  const vs = 4
  if (interior.w < vs + 3 || interior.h < vs + 3) return null
  // Bottom-right corner, so the building's top-left probe tile stays open floor.
  const vx = interior.x + interior.w - vs
  const vy = interior.y + interior.h - vs
  grid.fillRect(vx, vy, vs, vs, Tile.Wall)
  grid.fillRect(vx + 1, vy + 1, vs - 2, vs - 2, Tile.Floor)
  // Door on the top side, opening up into the open hall (guaranteed floor).
  const doorX = vx + rng.int(1, vs - 2)
  const doorY = vy
  grid.set(doorX, doorY, Tile.Floor)
  grid.set(doorX, doorY - 1, Tile.Floor)
  return { rect: { x: vx + 1, y: vy + 1, w: vs - 2, h: vs - 2 }, door: { x: doorX, y: doorY } }
}

/** A walkable tile on one border edge (0=top,1=right,2=bottom,3=left), off the corners. */
const edgeTile = (rng: Rng, edge: number, w: number, h: number): { x: number; y: number } => {
  const near = 1
  const far = BORDER
  switch (edge) {
    case 0:
      return { x: rng.int(far, w - 1 - far), y: near }
    case 1:
      return { x: w - 1 - near, y: rng.int(far, h - 1 - far) }
    case 2:
      return { x: rng.int(far, w - 1 - far), y: h - 1 - near }
    default:
      return { x: near, y: rng.int(far, h - 1 - far) }
  }
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
