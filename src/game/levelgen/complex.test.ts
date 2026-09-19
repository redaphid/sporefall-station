// Indoor complex generator (floors 3, 5, 7…) — strict, adversarial property tests.
// Every invariant runs over MANY seeds x every biome, because a generator bug
// is a needle: one seed in fifty strands a bunk room behind a solid wall.

import { describe, expect, it } from 'vitest'
import { populateWorld } from '../populate'
import { mulberry32 } from '../rng'
import { setupFloor } from '../systems/missions'
import { LEVEL_H, LEVEL_W } from '../types'
import { createCityWorld } from '../testkit'
import { floodLinked } from '../stairs'
import { createWorld } from '../world'
import { BIOME_DEFS, BIOMES, biomeForFloor, carveComplex, cityFloorOrdinal, COMPLEX_MIN_FLOOR, isComplexFloor } from './complex'
import { generateComplexLevel, generateLevel } from './generate'
import { isFloorTile, isStairTile, isWallTile, levelChecksum, Tile, TileGrid, type Level } from './level'
import { COMPLEX_ROOM_TYPE } from './roomTypes'
import type { Rect } from './rooms'

/** Reachable on foot from spawn — taking the stairs, so a loft counts. */
const spawnReach = (level: Level): Uint8Array => floodLinked(level, Math.floor(level.spawn.y) * level.w + Math.floor(level.spawn.x))

const tile = (level: Level, x: number, y: number): number => level.tiles[y * level.w + x]

const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h

/** Index of the mission objective: the deepest module by doors crossed from
 * the spawn (floorplan spec P2), named by the generator and targeted by
 * missions.farthestBuilding. */
const objectiveModule = (level: Level): number => level.complex!.objective!

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

/** Index of the module whose room contains the tile, or -1. */
const inAnyRoom = (level: Level, x: number, y: number): number => level.buildings.findIndex((b) => b.rooms.some((r) => inRect(r, x, y)))

/** Total deck area of a module (all its rects). */
const roomArea = (b: Level['buildings'][number]): number => b.rooms.reduce((s, r) => s + r.w * r.h, 0)

/** Open archway tiles of module `bi`: walkable wall-line tiles (in no room, not
 * a door) with this module's deck on one side and another module's on the other. */
const archways = (level: Level, bi: number): { x: number; y: number }[] => {
  const doors = new Set(level.buildings.flatMap((b) => b.doors.map((d) => d.y * level.w + d.x)))
  const out: { x: number; y: number }[] = []
  const b = level.buildings[bi]
  for (let y = b.rect.y; y < b.rect.y + b.rect.h; y++) {
    for (let x = b.rect.x; x < b.rect.x + b.rect.w; x++) {
      if (level.solid[y * level.w + x] || doors.has(y * level.w + x) || inAnyRoom(level, x, y) >= 0) continue
      for (const [dx, dy] of ORTHO) {
        const a = inAnyRoom(level, x + dx, y + dy)
        const c = inAnyRoom(level, x - dx, y - dy)
        if (a === bi && c >= 0 && c !== bi) out.push({ x, y })
      }
    }
  }
  return out
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** seeds x complex floors 3, 5, 7, 9 — one full lap of the four biomes. */
const sweep = function* (seeds: number): Generator<{ seed: number; floor: number; level: Level; tag: string }> {
  for (let seed = 1; seed <= seeds; seed++) {
    for (let floor = 3; floor <= 9; floor += 2) {
      yield { seed, floor, level: generateLevel(seed, floor), tag: `seed ${seed} floor ${floor}` }
    }
  }
}

describe('complex floor switch + biomes', () => {
  it('floors 1-2 stay city; from floor 3 complex and city alternate (3, 5, 7… complex; 4, 6, 8… city)', () => {
    expect(COMPLEX_MIN_FLOOR).toBe(3)
    for (const f of [-3, 0, 1, 2]) expect(isComplexFloor(f), `floor ${f}`).toBe(false)
    for (const f of [3, 5, 7, 9, 51, 999]) expect(isComplexFloor(f), `floor ${f}`).toBe(true)
    for (const f of [4, 6, 8, 50, 1000]) expect(isComplexFloor(f), `floor ${f}`).toBe(false)
    // Strict alternation: no two adjacent floors from 3 up share a generator.
    for (let f = 3; f < 60; f++) expect(isComplexFloor(f + 1)).toBe(!isComplexFloor(f))
    for (let seed = 1; seed <= 10; seed++) {
      for (let f = 1; f <= 8; f++) {
        const level = generateLevel(seed, f)
        if (isComplexFloor(f)) expect(level.complex, `seed ${seed} floor ${f}`).toBeDefined()
        else expect(level.complex, `seed ${seed} floor ${f}`).toBeUndefined()
      }
    }
  })

  it('city floors between complexes cycle every district theme, never repeating back to back', () => {
    const cityFloors = [1, 2, 4, 6, 8, 10, 12]
    expect(cityFloors.map(cityFloorOrdinal)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const themes = cityFloors.map((f) => generateLevel(7, f).theme)
    for (let i = 1; i < themes.length; i++) expect(themes[i], `city floor ${cityFloors[i]}`).not.toBe(themes[i - 1])
    expect(new Set(themes).size).toBe(4)
  })

  it('biomes cycle across complex floors so consecutive complex floors never share one, and every biome shows up', () => {
    const seen = new Set<string>()
    const complexFloors = Array.from({ length: 20 }, (_, i) => 3 + 2 * i)
    expect(complexFloors.slice(0, 4).map(biomeForFloor)).toEqual([...BIOMES])
    for (const f of complexFloors) {
      expect(biomeForFloor(f)).not.toBe(biomeForFloor(f + 2))
      seen.add(biomeForFloor(f))
      expect(generateLevel(7, f).complex!.biome).toBe(biomeForFloor(f))
    }
    expect([...seen].sort()).toEqual([...BIOMES].sort())
  })

  it('biomeForFloor never returns undefined, even for degenerate floors', () => {
    for (const f of [-7, 0, 1, 2, 1e6]) expect(BIOMES).toContain(biomeForFloor(f))
  })
})

describe('complex generator: determinism', () => {
  it('is bit-exact for the same seed+floor (tiles, buildings, corridors, vents, wings)', () => {
    for (const [seed, floor] of [
      [1, 3],
      [0xdeadbeef, 5],
      [42, 9],
    ]) {
      const a = generateLevel(seed, floor)
      const b = generateLevel(seed, floor)
      expect(levelChecksum(a)).toBe(levelChecksum(b))
      expect(JSON.stringify(a.buildings)).toBe(JSON.stringify(b.buildings))
      expect(JSON.stringify(a.complex)).toBe(JSON.stringify(b.complex))
      expect(a.spawn).toEqual(b.spawn)
      expect(a.exit).toEqual(b.exit)
    }
  })

  it('different seeds and different floors produce different layouts', () => {
    const sums = new Set<number>()
    for (let seed = 1; seed <= 20; seed++) sums.add(levelChecksum(generateLevel(seed, 3)))
    expect(sums.size).toBe(20)
    expect(levelChecksum(generateLevel(5, 3))).not.toBe(levelChecksum(generateLevel(5, 5)))
  })

  it('generateLevel on a complex floor IS generateComplexLevel', () => {
    expect(levelChecksum(generateLevel(3, 5))).toBe(levelChecksum(generateComplexLevel(3, 5)))
  })
})

describe('complex generator: structural invariants (60 seeds x 4 biomes)', () => {
  it('the map edge is sealed pressure hull', () => {
    for (const { level, tag } of sweep(60)) {
      for (let x = 0; x < level.w; x++) {
        expect(tile(level, x, 0), tag).toBe(Tile.Hull)
        expect(tile(level, x, level.h - 1), tag).toBe(Tile.Hull)
      }
      for (let y = 0; y < level.h; y++) {
        expect(tile(level, 0, y), tag).toBe(Tile.Hull)
        expect(tile(level, level.w - 1, y), tag).toBe(Tile.Hull)
      }
    }
  })

  it('never lays a city tile: no street, sidewalk or bevelled corner indoors', () => {
    for (const { level, tag } of sweep(60)) {
      for (const t of level.tiles) {
        expect([Tile.Street, Tile.Sidewalk, Tile.WallCutNW, Tile.WallCutNE, Tile.WallCutSE, Tile.WallCutSW], tag).not.toContain(t)
      }
    }
  })

  it('solid layer agrees with the tiles (Hull is solid, every deck tile walkable)', () => {
    for (const { level, tag } of sweep(20)) {
      for (let i = 0; i < level.tiles.length; i++) {
        expect(level.solid[i], `${tag} tile ${i}`).toBe(isWallTile(level.tiles[i]) ? 1 : 0)
      }
    }
  })

  it('spawn sits on corridor deck, the exit is marked, and the two are far apart', () => {
    for (const { level, tag } of sweep(60)) {
      const sx = Math.floor(level.spawn.x)
      const sy = Math.floor(level.spawn.y)
      expect(tile(level, sx, sy), `${tag}: spawn tile`).toBe(Tile.Hall)
      expect(level.spawn.x - sx, tag).toBe(0.5)
      expect(tile(level, level.exit.x, level.exit.y), `${tag}: exit tile`).toBe(Tile.Exit)
      expect(Math.hypot(level.exit.x - sx, level.exit.y - sy), `${tag}: spawn/exit too close`).toBeGreaterThan(LEVEL_W / 2)
    }
  })

  it('EVERY walkable tile is reachable from spawn — no sealed pockets anywhere', () => {
    for (const { level, tag } of sweep(60)) {
      const reach = spawnReach(level)
      for (let i = 0; i < level.tiles.length; i++) {
        if (level.solid[i]) continue
        expect(reach[i], `${tag}: tile ${i % level.w},${(i / level.w) | 0} sealed off`).toBe(1)
      }
    }
  })

  it('corridors are open deck along their whole rect, inside the hull', () => {
    for (const { level, tag } of sweep(60)) {
      const { corridors } = level.complex!
      // At least the airlock and a spine (a ship or a hospital has no more).
      expect(corridors.length, tag).toBeGreaterThanOrEqual(2)
      for (const c of corridors) {
        expect(c.rect.x, tag).toBeGreaterThanOrEqual(1)
        expect(c.rect.y, tag).toBeGreaterThanOrEqual(1)
        expect(c.rect.x + c.rect.w, tag).toBeLessThanOrEqual(level.w - 1)
        expect(c.rect.y + c.rect.h, tag).toBeLessThanOrEqual(level.h - 1)
        const across = c.axis === 'h' ? c.rect.h : c.rect.w
        expect(across, `${tag}: corridor width`).toBeGreaterThanOrEqual(2)
        expect(across, `${tag}: corridor width`).toBeLessThanOrEqual(3)
        for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++) {
          for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) {
            expect(isWallTile(tile(level, x, y)), `${tag}: wall inside corridor at ${x},${y}`).toBe(false)
          }
        }
      }
    }
  })

  it('vents are grate tiles in corridors, never at the landing zone', () => {
    let total = 0
    for (const { level, tag } of sweep(60)) {
      for (const v of level.complex!.vents) {
        total++
        expect(tile(level, v.x, v.y), tag).toBe(Tile.Grate)
        expect(level.complex!.corridors.some((c) => inRect(c.rect, v.x, v.y)), `${tag}: vent off-corridor`).toBe(true)
        expect(Math.hypot(v.x - level.spawn.x + 0.5, v.y - level.spawn.y + 0.5), tag).toBeGreaterThanOrEqual(8)
      }
      // Grates exist ONLY where a vent is registered (the director's source list).
      let grates = 0
      for (const t of level.tiles) if (t === Tile.Grate) grates++
      expect(grates, tag).toBe(level.complex!.vents.length)
    }
    expect(total).toBeGreaterThan(200)
  })

  it('every module is a sane room (one or more rects) with a way in, typed by its role', () => {
    for (const { level, tag } of sweep(60)) {
      expect(level.buildings.length, tag).toBeGreaterThanOrEqual(15)
      const objective = objectiveModule(level)
      level.buildings.forEach((b, bi) => {
        expect(b.poi, tag).toBe('module')
        expect(b.rooms.length, tag).toBeGreaterThanOrEqual(1)
        // The objective room is the module's biggest rect and a real room.
        const main = b.objectiveRoom!
        expect(b.rooms, tag).toContainEqual(main)
        for (const r of b.rooms) expect(r.w * r.h, tag).toBeLessThanOrEqual(main.w * main.h)
        expect(Math.min(main.w, main.h), `${tag}: room too thin`).toBeGreaterThanOrEqual(3)
        // The building rect is the rooms' bounding box plus its 1-tile wall ring.
        const x0 = Math.min(...b.rooms.map((r) => r.x))
        const y0 = Math.min(...b.rooms.map((r) => r.y))
        const x1 = Math.max(...b.rooms.map((r) => r.x + r.w))
        const y1 = Math.max(...b.rooms.map((r) => r.y + r.h))
        expect(b.rect, tag).toEqual({ x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 })
        expect(b.roomTypes, tag).toEqual(b.rooms.map(() => COMPLEX_ROOM_TYPE[b.role]))
        // A way in: a door, or an open archway onto a neighbour (a galley off
        // its mess hall). The objective is ALWAYS behind a real (lockable) door.
        expect(b.doors.length + archways(level, bi).length, `${tag}: sealed ${b.role}`).toBeGreaterThanOrEqual(1)
        if (bi === objective) {
          expect(b.doors.length, `${tag}: objective has no door`).toBeGreaterThanOrEqual(1)
          expect(archways(level, bi), `${tag}: an open arch bypasses the objective lock`).toEqual([])
        }
        for (const d of b.doors) {
          expect(isWallTile(tile(level, d.x, d.y)), `${tag}: door in wall`).toBe(false)
          expect(inAnyRoom(level, d.x, d.y), `${tag}: door ${d.x},${d.y} inside a room`).toBe(-1)
          // A door sits in the wall line, orthogonally against its own room's deck.
          const touches = ORTHO.some(([dx, dy]) => b.rooms.some((r) => inRect(r, d.x + dx, d.y + dy)) && !isWallTile(tile(level, d.x + dx, d.y + dy)))
          expect(touches, `${tag}: door ${d.x},${d.y} not on its room's wall`).toBe(true)
        }
        // Deck: interior tiles are floor-family (or the rare exit pad); the only
        // walls inside a room are features (pillars, chamfers, duct notches),
        // and they never eat more than a fifth of it.
        let walls = 0
        let tiles = 0
        for (const r of b.rooms) {
          for (let y = r.y; y < r.y + r.h; y++) {
            for (let x = r.x; x < r.x + r.w; x++) {
              const t = tile(level, x, y)
              tiles++
              if (isWallTile(t)) walls++
              else expect(isFloorTile(t) || t === Tile.Grass || t === Tile.Exit || isStairTile(t), `${tag}: bad deck ${t} at ${x},${y}`).toBe(true)
            }
          }
        }
        expect(walls / tiles, `${tag}: ${b.role} mostly wall`).toBeLessThanOrEqual(0.2)
      })
    }
  })

  it('rooms never overlap and every module belongs to exactly one wing', () => {
    for (const { level, tag } of sweep(40)) {
      const rooms = level.buildings.flatMap((b) => b.rooms)
      for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) expect(overlaps(rooms[i], rooms[j]), `${tag}: rooms ${i}/${j}`).toBe(false)
      }
      const owners = new Array(level.buildings.length).fill(0)
      for (const wing of level.complex!.wings) {
        for (const bi of wing.buildings) {
          owners[bi]++
          const r = level.buildings[bi].rect
          expect(r.x >= wing.rect.x && r.y >= wing.rect.y, tag).toBe(true)
          expect(r.x + r.w <= wing.rect.x + wing.rect.w && r.y + r.h <= wing.rect.y + wing.rect.h, tag).toBe(true)
        }
      }
      expect(owners.every((n) => n === 1), tag).toBe(true)
    }
  })
})

describe('complex generator: the station reads like a station', () => {
  it('ships a mess hall with a galley next door, bunk rooms, and a mix of modules', () => {
    const roles = new Map<string, number>()
    let messes = 0
    let galleys = 0
    for (const { level, tag } of sweep(40)) {
      const counts = new Map<string, number>()
      for (const b of level.buildings) counts.set(b.role, (counts.get(b.role) ?? 0) + 1)
      for (const [r, n] of counts) roles.set(r, (roles.get(r) ?? 0) + n)
      expect(counts.get('mess') ?? 0, `${tag}: more than one mess hall`).toBeLessThanOrEqual(1)
      expect(counts.get('quarters') ?? 0, `${tag}: nowhere to sleep`).toBeGreaterThanOrEqual(1)
      const mess = level.buildings.find((b) => b.role === 'mess')
      if (mess) {
        messes++
        expect(roomArea(mess), tag).toBeGreaterThanOrEqual(30)
        // The dining hall is a HALL: well over the typical module, and bigger
        // than its galley, every wash closet and every security post (a reactor
        // hall, a big lab or a dormitory may rival it).
        const sizes = level.buildings.map(roomArea).sort((a, b) => a - b)
        expect(roomArea(mess), `${tag}: a pokey mess hall`).toBeGreaterThanOrEqual(1.4 * sizes[Math.floor(sizes.length / 2)])
        const objective = level.buildings[objectiveModule(level)]
        for (const b of level.buildings) {
          if (b !== objective && ['washroom', 'galley', 'security'].includes(b.role)) {
            expect(roomArea(b), `${tag}: a ${b.role} outsizes the mess hall`).toBeLessThanOrEqual(roomArea(mess))
          }
        }
        if (level.buildings.some((b) => b.role === 'galley')) galleys++
      }
      // Washrooms are closets, never halls.
      for (const b of level.buildings) if (b.role === 'washroom') expect(roomArea(b), tag).toBeLessThanOrEqual(24)
    }
    expect(messes).toBeGreaterThan(150) // nearly every floor has its dining hall
    expect(galleys).toBeGreaterThan(messes * 0.8)
    for (const r of ['mess', 'galley', 'quarters', 'washroom', 'lab', 'medbay', 'reactor', 'depot', 'security']) {
      expect(roles.get(r) ?? 0, `role ${r} never generated`).toBeGreaterThan(0)
    }
  })

  it('biomes look different: flooded floors pool bog water, overgrown floors grow moss, habitation stays dry', () => {
    const count = (level: Level, t: number): number => level.tiles.filter((x) => x === t).length
    let flooded = 0
    let overgrown = 0
    let habitationMoss = 0
    for (let seed = 1; seed <= 30; seed++) {
      flooded += count(generateLevel(seed, 5), Tile.Bog)
      overgrown += count(generateLevel(seed, 9), Tile.Grass)
      habitationMoss += count(generateLevel(seed, 3), Tile.Grass)
      expect(generateLevel(seed, 5).complex!.biome).toBe('flooded')
      expect(generateLevel(seed, 9).complex!.biome).toBe('overgrown')
    }
    expect(flooded / 30).toBeGreaterThan(40)
    expect(overgrown / 30).toBeGreaterThan(40)
    expect(habitationMoss).toBe(0)
    // Reactor floors plate their engineering decks.
    expect(generateLevel(1, 7).tiles.filter((x) => x === Tile.Plating).length).toBeGreaterThan(100)
  })

  it('the objective module (deepest from the spawn) takes a biome objective role', () => {
    for (const { level, tag } of sweep(40)) {
      expect(BIOME_DEFS[level.complex!.biome].objective, tag).toContain(level.buildings[objectiveModule(level)].role)
    }
  })
})

/** Is this module something other than one plain box? (several rects — an L,
 * T or wrap-round — or feature walls inside it: pillars, chamfers, notches.) */
const nonRectangular = (level: Level, b: Level['buildings'][number]): boolean =>
  b.rooms.length > 1 || b.rooms.some((r) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (level.solid[y * level.w + x]) return true
    return false
  })

/** Best mirror match of the solid layer about any horizontal or vertical axis
 * (fraction of mirrored tile pairs that agree, over a mostly-overlapping span). */
const mirrorScore = (level: Level): number => {
  let best = 0
  for (const vert of [false, true]) {
    for (let a2 = 20; a2 <= 2 * level.w - 22; a2++) {
      let same = 0
      let n = 0
      for (let y = 0; y < level.h; y++) {
        for (let x = 0; x < level.w; x++) {
          const mx = vert ? a2 - x : x
          const my = vert ? y : a2 - y
          if (mx < 0 || my < 0 || mx >= level.w || my >= level.h) continue
          n++
          if (level.solid[y * level.w + x] === level.solid[my * level.w + mx]) same++
        }
      }
      if (n > level.w * level.h * 0.6) best = Math.max(best, same / n)
    }
  }
  return best
}

describe('complex generator: floorplans, not graph paper', () => {
  it('a real share of modules are not plain boxes, on every floor', () => {
    let odd = 0
    let total = 0
    let multi = 0
    for (const { level, tag } of sweep(40)) {
      const n = level.buildings.filter((b) => nonRectangular(level, b)).length
      expect(n, `${tag}: every room a box`).toBeGreaterThanOrEqual(4)
      odd += n
      total += level.buildings.length
      multi += level.buildings.filter((b) => b.rooms.length > 1).length
    }
    expect(odd / total, 'non-rectangular share').toBeGreaterThan(0.25)
    expect(multi / total, 'L / T / wrap-round share').toBeGreaterThan(0.12)
  })

  it('circulation is a hierarchy: 3-wide main spines, 2-wide secondary halls, dead ends', () => {
    let secondary = 0
    let branched = 0
    let deadEnds = 0
    const floors = [...sweep(40)]
    for (const { level, tag } of floors) {
      const { corridors } = level.complex!
      const across = (c: (typeof corridors)[number]): number => (c.axis === 'h' ? c.rect.h : c.rect.w)
      expect(corridors.some((c) => across(c) === 3), `${tag}: no main spine`).toBe(true)
      // A ship's second route is its hatch line and a hospital's is its
      // courts: those two archetypes have no secondary corridors by design.
      if (level.complex!.archetype !== 'ship' && level.complex!.archetype !== 'pavilion') {
        branched++
        if (corridors.some((c) => across(c) === 2)) secondary++
      }
      // A dead end: a corridor whose far end-cap is solid all the way across.
      const capped = corridors.some((c) => {
        const r = c.rect
        const ends = c.axis === 'v' ? [r.y - 1, r.y + r.h] : [r.x - 1, r.x + r.w]
        return ends.some((e) => {
          for (let k = 0; k < across(c); k++) {
            const x = c.axis === 'v' ? r.x + k : e
            const y = c.axis === 'v' ? e : r.y + k
            if (!level.solid[y * level.w + x]) return false
          }
          return true
        })
      })
      if (capped) deadEnds++
    }
    expect(secondary / branched).toBeGreaterThan(0.9)
    expect(deadEnds / floors.length).toBeGreaterThan(0.6)
  })

  it('the hull is not a square: wings step in and out, some leave notches', () => {
    let ragged = 0
    const floors = [...sweep(40)]
    for (const { level } of floors) {
      // Hull tiles off the map edge = outside space inside the footprint.
      let outside = 0
      for (let y = 1; y < level.h - 1; y++) for (let x = 1; x < level.w - 1; x++) if (level.tiles[y * level.w + x] === Tile.Hull) outside++
      if (outside > 60) ragged++
    }
    expect(ragged / floors.length).toBeGreaterThan(0.85)
  })

  it('layouts vary in kind: several spine arrangements, symmetric sometimes, asymmetric mostly', () => {
    const mains = new Set<number>()
    let symmetric = 0
    for (let seed = 1; seed <= 40; seed++) {
      // The ground plan's symmetry — the loft slot beside it is not part of it.
      const level = generateComplexLevel(seed, 3, { storeys: false })
      mains.add(level.complex!.corridors.filter((c) => (c.axis === 'h' ? c.rect.h : c.rect.w) === 3).length)
      if (mirrorScore(level) > 0.87) symmetric++
    }
    expect(mains.size, 'every floor has the same spine count').toBeGreaterThanOrEqual(3)
    expect(symmetric, 'never symmetric').toBeGreaterThanOrEqual(2)
    expect(symmetric, 'always symmetric').toBeLessThanOrEqual(20)
  })

  it('rooms open into rooms: galleys off the mess through an arch, wash closets inside bunk suites, back rooms through front rooms', () => {
    let arches = 0
    let suites = 0
    let passThrough = 0
    for (const { level } of sweep(40)) {
      const mess = level.buildings.findIndex((b) => b.role === 'mess')
      if (mess >= 0 && archways(level, mess).some((t) => ORTHO.some(([dx, dy]) => level.buildings[inAnyRoom(level, t.x + dx, t.y + dy)]?.role === 'galley'))) arches++
      for (const b of level.buildings) {
        if (b.role !== 'washroom' || b.doors.length !== 1) continue
        const d = b.doors[0]
        if (ORTHO.some(([dx, dy]) => level.buildings[inAnyRoom(level, d.x + dx, d.y + dy)]?.role === 'quarters')) suites++
      }
      // A module none of whose doors touch a corridor: reached through another room.
      for (const b of level.buildings) {
        const onHall = b.doors.some((d) => ORTHO.some(([dx, dy]) => [Tile.Hall, Tile.Grate].includes(tile(level, d.x + dx, d.y + dy) as 10 | 11)))
        if (!onHall) passThrough++
      }
    }
    expect(arches, 'no serving arches').toBeGreaterThan(60)
    expect(suites, 'no en-suite wash closets').toBeGreaterThan(100)
    expect(passThrough, 'every room opens on a corridor').toBeGreaterThan(160)
  })

  it('big halls stand on pillars', () => {
    let pillared = 0
    for (const { level } of sweep(40)) {
      const pillar = level.buildings.some((b) =>
        b.rooms.some((r) => {
          for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
            for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
              if (!level.solid[y * level.w + x]) continue
              if (ORTHO.every(([dx, dy]) => !level.solid[(y + dy) * level.w + x + dx])) return true
            }
          }
          return false
        }),
      )
      if (pillar) pillared++
    }
    expect(pillared).toBeGreaterThan(50)
  })

  it('zoning: the security post stands by the airlock', () => {
    let guarded = 0
    const floors = [...sweep(40)]
    for (const { level } of floors) {
      // A security post within a short walk of the landing.
      const near = level.buildings.some(
        (b) => b.role === 'security' && Math.hypot(b.rect.x + b.rect.w / 2 - level.spawn.x, b.rect.y + b.rect.h / 2 - level.spawn.y) < 16,
      )
      if (near) guarded++
    }
    expect(guarded / floors.length).toBeGreaterThan(0.85)
  })

  it('generation stays cheap (a phone pays it at every floor change)', () => {
    const t0 = performance.now()
    for (let seed = 1; seed <= 40; seed++) generateLevel(seed, 3 + 2 * (seed % 4))
    expect((performance.now() - t0) / 40).toBeLessThan(25)
  })
})

describe('complex generator: adversarial inputs', () => {
  it('extreme seeds and very deep floors still build a fully connected complex', () => {
    for (const seed of [0, -1, 1, 0x7fffffff, 0xffffffff, 2 ** 31, 123456789]) {
      for (const floor of [3, 7, 65, 999]) {
        const level = generateLevel(seed, floor)
        const reach = spawnReach(level)
        expect(reach[level.exit.y * level.w + level.exit.x], `seed ${seed} floor ${floor}`).toBe(1)
        for (const b of level.buildings) {
          const r = b.rooms[0]
          let ok = false
          for (let y = r.y; y < r.y + r.h && !ok; y++) for (let x = r.x; x < r.x + r.w && !ok; x++) ok = reach[y * level.w + x] === 1
          expect(ok, `seed ${seed} floor ${floor}: stranded ${b.role}`).toBe(true)
        }
      }
    }
  })

  it('overwrites whatever was in the grid (a dirty buffer cannot leak through)', () => {
    const tilesA = new Uint8Array(LEVEL_W * LEVEL_H).fill(Tile.Street)
    const tilesB = new Uint8Array(LEVEL_W * LEVEL_H)
    for (let i = 0; i < tilesB.length; i++) tilesB[i] = i % 10
    carveComplex(mulberry32(9).fork('x'), new TileGrid(LEVEL_W, LEVEL_H, tilesA), 3)
    carveComplex(mulberry32(9).fork('x'), new TileGrid(LEVEL_W, LEVEL_H, tilesB), 3)
    expect(Array.from(tilesB)).toEqual(Array.from(tilesA))
  })
})

describe('complex floors populate like a station', () => {
  const world = (seed: number, floor: number) => {
    const w = createWorld(seed, floor)
    populateWorld(w)
    setupFloor(w)
    return w
  }

  it('corridors stay clear of furniture (patrols and swarms can always run them)', () => {
    let props = 0
    for (let seed = 1; seed <= 25; seed++) {
      for (const floor of [3, 5, 7, 9]) {
        const w = world(seed, floor)
        for (const e of w.entities) {
          if (e.kind !== 'interactable') continue
          props++
          const t = tile(w.level, Math.floor(e.pos.x), Math.floor(e.pos.y))
          expect([Tile.Hall, Tile.Grate], `seed ${seed} floor ${floor}: ${e.archetype} in a corridor`).not.toContain(t)
        }
      }
    }
    expect(props).toBeGreaterThan(1000) // the modules really are furnished
  })

  it('bunk-room sleepers are dormant thugs zoned to crew quarters, and they do appear', () => {
    let sleepers = 0
    for (let seed = 1; seed <= 30; seed++) {
      const w = world(seed, 5)
      for (const e of w.entities) {
        if (e.kind !== 'npc' || !e.ai?.dormant || e.archetype !== 'thug') continue
        sleepers++
        const zone = e.ai.zone!
        expect(zone.role).toBe('quarters')
        expect(w.level.buildings[zone.building].role).toBe('quarters')
        expect(inRect(w.level.buildings[zone.building].rooms[0], Math.floor(e.pos.x), Math.floor(e.pos.y))).toBe(true)
        expect(e.ai.wakeOn).toEqual(['damage', 'noise'])
      }
    }
    expect(sleepers).toBeGreaterThan(20)
  })

  it('station security walks corridor beats that never cross the landing zone', () => {
    let patrols = 0
    for (let seed = 1; seed <= 30; seed++) {
      const w = world(seed, 3)
      for (const e of w.entities) {
        if (e.archetype !== 'cop' || e.ai?.behavior !== 'patrol') continue
        patrols++
        for (const p of e.ai.params!.waypoints!) {
          expect(isWallTile(tile(w.level, Math.floor(p.x), Math.floor(p.y)))).toBe(false)
        }
      }
    }
    expect(patrols).toBeGreaterThan(30)
  })

  it('keeps the floor population in the city band (many modules must not mean many more bodies)', () => {
    for (const floor of [3, 5]) {
      let complex = 0
      let city = 0
      for (let seed = 1; seed <= 10; seed++) {
        const a = createWorld(seed, floor)
        populateWorld(a)
        complex += a.entities.filter((e) => e.kind === 'npc').length
        const b = createCityWorld(seed, floor)
        populateWorld(b)
        city += b.entities.filter((e) => e.kind === 'npc').length
      }
      expect(complex, `floor ${floor}: complex ${complex / 10} vs city ${city / 10} npcs/floor`).toBeLessThanOrEqual(city * 1.25)
      expect(complex, `floor ${floor}: complex floors feel empty`).toBeGreaterThanOrEqual(city * 0.75)
    }
  })

  it('the mission targets a real module on every complex floor', () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const floor of [3, 5, 7, 9]) {
        const w = world(seed, floor)
        if (w.mission.targetBuilding === undefined) continue
        const b = w.level.buildings[w.mission.targetBuilding]
        expect(b.poi).toBe('module')
        // missions.farthestBuilding and the generator agree on the target.
        expect(w.mission.targetBuilding).toBe(w.level.complex!.objective)
      }
    }
  })
})
