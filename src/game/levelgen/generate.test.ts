import { describe, expect, it } from 'vitest'
import { generateLevel } from './generate'
import { isWallTile, levelChecksum, Tile, TileGrid } from './level'

describe('generateLevel', () => {
  it('is bit-exact deterministic for the same seed and floor', () => {
    const a = generateLevel(0xdeadbeef, 1)
    const b = generateLevel(0xdeadbeef, 1)
    expect(a.tiles).toEqual(b.tiles)
    expect(a.solid).toEqual(b.solid)
    expect(levelChecksum(a)).toBe(levelChecksum(b))
    expect(a.buildings.length).toBe(b.buildings.length)
  })

  it('differs across seeds and floors', () => {
    const a = generateLevel(1, 1)
    const b = generateLevel(2, 1)
    const c = generateLevel(1, 2)
    expect(levelChecksum(a)).not.toBe(levelChecksum(b))
    expect(levelChecksum(a)).not.toBe(levelChecksum(c))
  })

  it('cycles themes so consecutive floors look different', () => {
    const themes = Array.from({ length: 5 }, (_, i) => generateLevel(7, i + 1).theme)
    // Every adjacent floor pair uses a different district theme.
    for (let i = 1; i < themes.length; i++) {
      expect(themes[i]).not.toBe(themes[i - 1])
    }
    expect(new Set(themes).size).toBeGreaterThanOrEqual(4)
  })

  it('varies spawn and exit placement across floors (not always TL->BR)', () => {
    const spawns = new Set<string>()
    const exits = new Set<string>()
    for (let floor = 1; floor <= 12; floor++) {
      const level = generateLevel(9, floor)
      spawns.add(`${level.spawn.x},${level.spawn.y}`)
      exits.add(`${level.exit.x},${level.exit.y}`)
      // Spawn/exit always sit on opposite sides of the map.
      const far = Math.hypot(level.spawn.x - level.exit.x, level.spawn.y - level.exit.y)
      expect(far).toBeGreaterThan(level.w / 2)
    }
    expect(spawns.size).toBeGreaterThan(1)
    expect(exits.size).toBeGreaterThan(1)
  })

  it('produces set-piece variety: courtyards and vaults appear across floors', () => {
    const pois = new Set<string>()
    for (let seed = 1; seed <= 30; seed++) {
      for (let floor = 1; floor <= 4; floor++) {
        for (const b of generateLevel(seed, floor).buildings) {
          if (b.poi) pois.add(b.poi)
        }
      }
    }
    expect(pois.has('courtyard')).toBe(true)
    expect(pois.has('vault')).toBe(true)
  })

  it('generates a playable map: buildings exist, spawn and exit are walkable', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const level = generateLevel(seed, 1)
      expect(level.buildings.length).toBeGreaterThanOrEqual(4)
      const spawnTile = level.tiles[Math.floor(level.spawn.y) * level.w + Math.floor(level.spawn.x)]
      expect(spawnTile).not.toBe(Tile.Wall)
      expect(level.tiles[level.exit.y * level.w + level.exit.x]).toBe(Tile.Exit)
    }
  })

  it('every building interior and the exit are reachable from spawn (all themes)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (let floor = 1; floor <= 4; floor++) {
        const level = generateLevel(seed, floor)
        const grid = new TileGrid(level.w, level.h, level.tiles)
        const reachable = bfs(level.w, level.h, grid, Math.floor(level.spawn.x), Math.floor(level.spawn.y))
        for (const b of level.buildings) {
          // Probe the first interior floor tile (bunkers have 2-thick walls, so
          // rect.x+1/y+1 may itself be wall).
          const probe = firstFloorTile(grid, b.rect)
          expect(probe, `no floor in building at ${b.rect.x},${b.rect.y} seed ${seed} floor ${floor}`).not.toBeNull()
          expect(reachable[probe!.y * level.w + probe!.x], `building at ${b.rect.x},${b.rect.y} seed ${seed} floor ${floor}`).toBe(1)
        }
        expect(reachable[level.exit.y * level.w + level.exit.x], `exit seed ${seed} floor ${floor}`).toBe(1)
      }
    }
  })

  it('every room of every building is reachable (interior doors work, all themes)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (let floor = 1; floor <= 4; floor++) {
        const level = generateLevel(seed, floor)
        const grid = new TileGrid(level.w, level.h, level.tiles)
        const reachable = bfs(level.w, level.h, grid, Math.floor(level.spawn.x), Math.floor(level.spawn.y))
        for (const b of level.buildings) {
          for (const room of b.rooms) {
            let anyReachable = false
            for (let y = room.y; y < room.y + room.h && !anyReachable; y++) {
              for (let x = room.x; x < room.x + room.w && !anyReachable; x++) {
                if (grid.get(x, y) === Tile.Floor && reachable[y * level.w + x]) anyReachable = true
              }
            }
            expect(anyReachable, `room ${room.x},${room.y} in building ${b.rect.x},${b.rect.y} seed ${seed} floor ${floor}`).toBe(true)
          }
        }
      }
    }
  })
})

const bfs = (w: number, h: number, grid: TileGrid, sx: number, sy: number): Uint8Array => {
  const reachable = new Uint8Array(w * h)
  const queue = [sy * w + sx]
  reachable[queue[0]] = 1
  while (queue.length > 0) {
    const idx = queue.pop()!
    const x = idx % w
    const y = (idx / w) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nidx = ny * w + nx
      if (reachable[nidx] || isWallTile(grid.get(nx, ny))) continue
      reachable[nidx] = 1
      queue.push(nidx)
    }
  }
  return reachable
}

const firstFloorTile = (grid: TileGrid, rect: { x: number; y: number; w: number; h: number }): { x: number; y: number } | null => {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (grid.get(x, y) === Tile.Floor) return { x, y }
    }
  }
  return null
}
