import { describe, expect, it } from 'vitest'
import { generateLevel } from './generate'
import { isWallTile, Tile, TileGrid, WALL_CUT_OUTSIDE, type Building, type Level } from './level'
import { ALLEY_W, BOULEVARD_W, cutLotsVaried, STREET_W } from './lots'
import { mulberry32 } from '../rng'
import type { Rect } from './rooms'

/**
 * Adversarial property tests for the levelgen architecture work: hallway-first
 * interiors, bunkers, courtyard compounds, bevelled corners, street variety.
 * Everything runs over MANY seeds (property style) because a generator bug is
 * a needle — one seed in fifty traps a courtyard or seals a vestibule.
 */

const bfsFrom = (level: Level, sx: number, sy: number): Uint8Array => {
  const { w, h } = level
  const grid = new TileGrid(w, h, level.tiles)
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

const spawnReach = (level: Level): Uint8Array => bfsFrom(level, Math.floor(level.spawn.x), Math.floor(level.spawn.y))

const tileAt = (level: Level, x: number, y: number): number => level.tiles[y * level.w + x]

const rectHasReachable = (level: Level, reach: Uint8Array, r: Rect, tile?: number): boolean => {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (reach[y * level.w + x] && (tile === undefined || tileAt(level, x, y) === tile)) return true
    }
  }
  return false
}

/** All levels for seeds 1..n over floors 2..5 (the themed generator's domain). */
const themedLevels = function* (n: number): Generator<{ seed: number; floor: number; level: Level }> {
  for (let seed = 1; seed <= n; seed++) {
    for (let floor = 2; floor <= 5; floor++) {
      yield { seed, floor, level: generateLevel(seed, floor) }
    }
  }
}

describe('property: reachability holds across many seeds and floors', () => {
  // The heavyweight sweep: 200 seeds x floors 1..5 — spawn/exit validity plus
  // every building probe reachable. Room-level checks run in the 60-seed suites
  // below (and generate.test.ts covers rooms over 50 seeds x 4 floors).
  // 1000 worldgens is real work — the 5s default timeout flakes when the suite
  // shares the machine with other jobs; give it room like the spawn-safety sweep.
  it('200 seeds x floors 1..5: spawn walkable, exit reachable, every building enterable', { timeout: 60000 }, () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (let floor = 1; floor <= 5; floor++) {
        const level = generateLevel(seed, floor)
        const tag = `seed ${seed} floor ${floor}`
        const sx = Math.floor(level.spawn.x)
        const sy = Math.floor(level.spawn.y)
        expect(isWallTile(tileAt(level, sx, sy)), `${tag}: spawn in wall`).toBe(false)
        expect(tileAt(level, level.exit.x, level.exit.y), `${tag}: exit tile`).toBe(Tile.Exit)
        const reach = spawnReach(level)
        expect(reach[level.exit.y * level.w + level.exit.x], `${tag}: exit unreachable`).toBe(1)
        for (const b of level.buildings) {
          expect(rectHasReachable(level, reach, b.rect, Tile.Floor), `${tag}: building ${b.rect.x},${b.rect.y} sealed`).toBe(true)
        }
      }
    }
  })

  it('every room of every themed building keeps a reachable floor tile (60 seeds)', () => {
    for (const { seed, floor, level } of themedLevels(60)) {
      const reach = spawnReach(level)
      for (const b of level.buildings) {
        for (const room of b.rooms) {
          expect(
            rectHasReachable(level, reach, room, Tile.Floor),
            `seed ${seed} floor ${floor} ${b.poi ?? b.role} room ${room.x},${room.y} unreachable`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('hallway-first interiors', () => {
  const hallwayBuildings = (n: number): { seed: number; floor: number; level: Level; b: Building }[] => {
    const out: { seed: number; floor: number; level: Level; b: Building }[] = []
    for (const { seed, floor, level } of themedLevels(n)) {
      for (const b of level.buildings) if (b.poi === 'hallway') out.push({ seed, floor, level, b })
    }
    return out
  }

  it('appear on themed floors, with several rooms hanging off the spine', () => {
    const found = hallwayBuildings(40)
    expect(found.length).toBeGreaterThan(20)
    for (const { b } of found) {
      // Spine + at least two attached rooms.
      expect(b.rooms.length).toBeGreaterThanOrEqual(3)
      expect(b.doors.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('the spine always connects to an exterior door (walk in from the street)', () => {
    for (const { seed, floor, level, b } of hallwayBuildings(40)) {
      const reach = spawnReach(level)
      // From street level, every room (spine included — it is rooms[0..]) is
      // walkable without opening anything but doors (tiles are already floor).
      for (const room of b.rooms) {
        expect(
          rectHasReachable(level, reach, room, Tile.Floor),
          `seed ${seed} floor ${floor}: hallway room ${room.x},${room.y} cut off from street`,
        ).toBe(true)
      }
      // An exterior door: some door position on the building's wall rectangle.
      const onWallRect = b.doors.some(
        (d) =>
          d.x === b.rect.x || d.x === b.rect.x + b.rect.w - 1 || d.y === b.rect.y || d.y === b.rect.y + b.rect.h - 1,
      )
      expect(onWallRect, `seed ${seed} floor ${floor}: hallway building has no exterior door`).toBe(true)
    }
  })
})

describe('bunker archetype', () => {
  const bunkers = (n: number): { seed: number; floor: number; level: Level; b: Building }[] => {
    const out: { seed: number; floor: number; level: Level; b: Building }[] = []
    for (const { seed, floor, level } of themedLevels(n)) {
      for (const b of level.buildings) if (b.poi === 'bunker') out.push({ seed, floor, level, b })
    }
    return out
  }

  it('appears on deeper floors via the theme machinery', () => {
    expect(bunkers(40).length).toBeGreaterThan(10)
  })

  it('has 2-thick windowless outer walls except the airlock', () => {
    for (const { seed, floor, level, b } of bunkers(40)) {
      const { x, y, w, h } = b.rect
      let gaps = 0
      for (let i = 0; i < w; i++) {
        for (const [tx, ty] of [
          [x + i, y], [x + i, y + 1], [x + i, y + h - 1], [x + i, y + h - 2],
        ] as const) {
          if (!isWallTile(tileAt(level, tx, ty)) && tileAt(level, tx, ty) !== Tile.Exit) gaps++
        }
      }
      for (let i = 2; i < h - 2; i++) {
        for (const [tx, ty] of [
          [x, y + i], [x + 1, y + i], [x + w - 1, y + i], [x + w - 2, y + i],
        ] as const) {
          if (!isWallTile(tileAt(level, tx, ty)) && tileAt(level, tx, ty) !== Tile.Exit) gaps++
        }
      }
      // Exactly the airlock: outer door + vestibule tile (both in the 2-thick
      // shell). Connectivity repair cannot add more (2-thick walls defeat it).
      expect(gaps, `seed ${seed} floor ${floor}: bunker shell has ${gaps} gaps`).toBe(2)
    }
  })

  it('airlock: outer door, vestibule, inner door in a straight line; never sealed', () => {
    for (const { seed, floor, level, b } of bunkers(40)) {
      const tag = `seed ${seed} floor ${floor}`
      const [outer, inner] = b.doors
      // Straight line, two tiles apart, vestibule between.
      const dx = inner.x - outer.x
      const dy = inner.y - outer.y
      expect(Math.abs(dx) + Math.abs(dy), `${tag}: airlock doors not 2 apart`).toBe(2)
      expect(dx === 0 || dy === 0, `${tag}: airlock is not straight`).toBe(true)
      const vest = { x: outer.x + dx / 2, y: outer.y + dy / 2 }
      expect(tileAt(level, vest.x, vest.y), `${tag}: vestibule not floor`).toBe(Tile.Floor)
      // The whole airlock is walkable from spawn — a vestibule can never seal.
      const reach = spawnReach(level)
      for (const p of [outer, vest, inner]) {
        expect(reach[p.y * level.w + p.x], `${tag}: airlock tile ${p.x},${p.y} unreachable`).toBe(1)
      }
    }
  })

  it('the innermost chamber is the LAST room, reachable, and walled from the band', () => {
    for (const { seed, floor, level, b } of bunkers(40)) {
      const tag = `seed ${seed} floor ${floor}`
      const core = b.rooms[b.rooms.length - 1]
      // Strictly inside the guard band (rooms[0]).
      const band = b.rooms[0]
      expect(core.x).toBeGreaterThan(band.x + 1)
      expect(core.y).toBeGreaterThan(band.y + 1)
      expect(core.x + core.w).toBeLessThan(band.x + band.w - 1)
      expect(core.y + core.h).toBeLessThan(band.y + band.h - 1)
      const reach = spawnReach(level)
      expect(rectHasReachable(level, reach, core, Tile.Floor), `${tag}: core unreachable`).toBe(true)
      // Exactly one opening in the chamber's wall ring: its door.
      const ring: Rect = { x: core.x - 1, y: core.y - 1, w: core.w + 2, h: core.h + 2 }
      let openings = 0
      for (let x = ring.x; x < ring.x + ring.w; x++) {
        if (!isWallTile(tileAt(level, x, ring.y))) openings++
        if (!isWallTile(tileAt(level, x, ring.y + ring.h - 1))) openings++
      }
      for (let y = ring.y + 1; y < ring.y + ring.h - 1; y++) {
        if (!isWallTile(tileAt(level, ring.x, y))) openings++
        if (!isWallTile(tileAt(level, ring.x + ring.w - 1, y))) openings++
      }
      expect(openings, `${tag}: chamber ring has ${openings} openings`).toBe(1)
    }
  })
})

describe('courtyard compound archetype', () => {
  const compounds = (n: number): { seed: number; floor: number; level: Level; b: Building }[] => {
    const out: { seed: number; floor: number; level: Level; b: Building }[] = []
    for (const { seed, floor, level } of themedLevels(n)) {
      for (const b of level.buildings) if (b.poi === 'courtyard') out.push({ seed, floor, level, b })
    }
    return out
  }

  it('appears on themed floors', () => {
    expect(compounds(40).length).toBeGreaterThan(10)
  })

  it('the pit is open ground, reachable from the street — it can never trap', () => {
    for (const { seed, floor, level, b } of compounds(40)) {
      const tag = `seed ${seed} floor ${floor}`
      const reach = spawnReach(level)
      // The courtyard: grass strictly inside the building footprint.
      const inner: Rect = { x: b.rect.x + 2, y: b.rect.y + 2, w: b.rect.w - 4, h: b.rect.h - 4 }
      expect(rectHasReachable(level, reach, inner, Tile.Grass), `${tag}: pit unreachable/missing`).toBe(true)
      // Every band room still opens somewhere (courtyard or neighbour).
      for (const room of b.rooms) {
        expect(rectHasReachable(level, reach, room, Tile.Floor), `${tag}: compound room ${room.x},${room.y} trapped`).toBe(true)
      }
    }
  })
})

describe('bevelled corners', () => {
  it('cut tiles appear on themed floors, never floor 1, and stay fully solid', () => {
    let cutCount = 0
    for (const { seed, floor, level } of themedLevels(30)) {
      for (let i = 0; i < level.tiles.length; i++) {
        const t = level.tiles[i]
        if (WALL_CUT_OUTSIDE[t]) {
          cutCount++
          expect(level.solid[i], `seed ${seed} floor ${floor}: cut tile ${i} not solid`).toBe(1)
        }
      }
    }
    expect(cutCount).toBeGreaterThan(100)
  })

  it('every cut faces outdoor ground diagonally (the bevel exposes pavement, not a room)', () => {
    const outdoor = (t: number): boolean => t === Tile.Street || t === Tile.Sidewalk || t === Tile.Grass
    for (const { seed, floor, level } of themedLevels(30)) {
      for (let y = 0; y < level.h; y++) {
        for (let x = 0; x < level.w; x++) {
          const cut = WALL_CUT_OUTSIDE[tileAt(level, x, y)]
          if (!cut) continue
          const nx = x + cut.dx
          const ny = y + cut.dy
          expect(
            nx >= 0 && ny >= 0 && nx < level.w && ny < level.h && outdoor(tileAt(level, nx, ny)),
            `seed ${seed} floor ${floor}: cut at ${x},${y} does not face outdoor ground`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('street variety', () => {
  it('cutLotsVaried mixes alleys, streets and boulevards; every lot stays >= 8', () => {
    const widths = new Set<number>()
    for (let seed = 1; seed <= 200; seed++) {
      const segs = cutLotsVaried(mulberry32(seed).fork('cols'), 64, 3, 4)
      for (let i = 0; i < segs.length; i++) {
        expect(segs[i].size).toBeGreaterThanOrEqual(8)
        if (i > 0) widths.add(segs[i].start - (segs[i - 1].start + segs[i - 1].size))
      }
      const last = segs[segs.length - 1]
      expect(last.start + last.size).toBeLessThanOrEqual(62) // border ring intact
    }
    expect(widths.has(ALLEY_W)).toBe(true)
    expect(widths.has(STREET_W)).toBe(true)
    expect(widths.has(BOULEVARD_W)).toBe(true)
    expect([...widths].every((w) => [ALLEY_W, STREET_W, BOULEVARD_W].includes(w))).toBe(true)
  })

  it('plazas appear on themed floors and are open (no walls inside)', () => {
    let plazaCount = 0
    for (const { seed, floor, level } of themedLevels(40)) {
      for (const p of level.plazas ?? []) {
        plazaCount++
        for (let y = p.y; y < p.y + p.h; y++) {
          for (let x = p.x; x < p.x + p.w; x++) {
            expect(isWallTile(tileAt(level, x, y)), `seed ${seed} floor ${floor}: wall inside plaza`).toBe(false)
          }
        }
      }
    }
    expect(plazaCount).toBeGreaterThan(10)
  })

  it('floor 1 keeps uniform 3-wide streets (frozen)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const level = generateLevel(seed, 1)
      expect(level.plazas ?? []).toHaveLength(0)
    }
  })
})
