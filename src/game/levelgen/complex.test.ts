// Indoor complex generator (floors 3+) — strict, adversarial property tests.
// Every invariant runs over MANY seeds x every biome, because a generator bug
// is a needle: one seed in fifty strands a bunk room behind a solid wall.

import { describe, expect, it } from 'vitest'
import { populateWorld } from '../populate'
import { mulberry32 } from '../rng'
import { setupFloor } from '../systems/missions'
import { LEVEL_H, LEVEL_W } from '../types'
import { createWorld } from '../world'
import { BIOME_DEFS, BIOMES, biomeForFloor, carveComplex, COMPLEX_MIN_FLOOR, isComplexFloor } from './complex'
import { generateComplexLevel, generateLevel } from './generate'
import { isFloorTile, isWallTile, levelChecksum, Tile, TileGrid, type Level } from './level'
import { COMPLEX_ROOM_TYPE } from './roomTypes'
import type { Rect } from './rooms'

const reachFrom = (level: Level, sx: number, sy: number): Uint8Array => {
  const { w, h } = level
  const reach = new Uint8Array(w * h)
  const queue = [sy * w + sx]
  reach[queue[0]] = 1
  while (queue.length > 0) {
    const i = queue.pop()!
    const x = i % w
    const y = (i / w) | 0
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const n = ny * w + nx
      if (reach[n] || level.solid[n]) continue
      reach[n] = 1
      queue.push(n)
    }
  }
  return reach
}

const spawnReach = (level: Level): Uint8Array => reachFrom(level, Math.floor(level.spawn.x), Math.floor(level.spawn.y))

const tile = (level: Level, x: number, y: number): number => level.tiles[y * level.w + x]

const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h

/** Index of the module farthest from spawn — the mission objective (same
 * metric + first-wins tie-break as the generator and missions.farthestBuilding). */
const farthestModule = (level: Level): number => {
  let best = -1
  let bestD = -1
  level.buildings.forEach((b, i) => {
    const d = Math.hypot(b.rect.x + b.rect.w / 2 - level.spawn.x, b.rect.y + b.rect.h / 2 - level.spawn.y)
    if (d > bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** seeds x floors 3..6 — one full lap of the four biomes. */
const sweep = function* (seeds: number): Generator<{ seed: number; floor: number; level: Level; tag: string }> {
  for (let seed = 1; seed <= seeds; seed++) {
    for (let floor = 3; floor <= 6; floor++) {
      yield { seed, floor, level: generateLevel(seed, floor), tag: `seed ${seed} floor ${floor}` }
    }
  }
}

describe('complex floor switch + biomes', () => {
  it('floors 1-2 stay city; every floor from 3 up is a complex', () => {
    expect(COMPLEX_MIN_FLOOR).toBe(3)
    expect(isComplexFloor(1)).toBe(false)
    expect(isComplexFloor(2)).toBe(false)
    for (const f of [3, 4, 5, 9, 50, 999]) expect(isComplexFloor(f)).toBe(true)
    for (let seed = 1; seed <= 10; seed++) {
      expect(generateLevel(seed, 1).complex).toBeUndefined()
      expect(generateLevel(seed, 2).complex).toBeUndefined()
      expect(generateLevel(seed, 3).complex).toBeDefined()
    }
  })

  it('biomes cycle so consecutive complex floors never share one, and every biome shows up', () => {
    const seen = new Set<string>()
    for (let f = 3; f < 40; f++) {
      expect(biomeForFloor(f)).not.toBe(biomeForFloor(f + 1))
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
      [0xdeadbeef, 4],
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
    expect(levelChecksum(generateLevel(5, 3))).not.toBe(levelChecksum(generateLevel(5, 4)))
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
      expect(corridors.length, tag).toBeGreaterThanOrEqual(4)
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

  it('every module is one sane room with a door, typed by its role', () => {
    for (const { level, tag } of sweep(60)) {
      expect(level.buildings.length, tag).toBeGreaterThanOrEqual(15)
      for (const b of level.buildings) {
        expect(b.poi, tag).toBe('module')
        expect(b.rooms.length, tag).toBe(1)
        const room = b.rooms[0]
        expect(Math.min(room.w, room.h), `${tag}: room too thin`).toBeGreaterThanOrEqual(3)
        expect(b.objectiveRoom, tag).toEqual(room)
        // The building rect is the room plus its 1-tile wall ring.
        expect(b.rect, tag).toEqual({ x: room.x - 1, y: room.y - 1, w: room.w + 2, h: room.h + 2 })
        expect(b.roomTypes, tag).toEqual([COMPLEX_ROOM_TYPE[b.role]])
        expect(b.doors.length, `${tag}: doorless module`).toBeGreaterThanOrEqual(1)
        for (const d of b.doors) {
          expect(isWallTile(tile(level, d.x, d.y)), `${tag}: door in wall`).toBe(false)
          // A door sits in the wall ring (not a corner): orthogonally adjacent to the room.
          const onRing = inRect(b.rect, d.x, d.y) && !inRect(room, d.x, d.y)
          const corner = (d.x === b.rect.x || d.x === b.rect.x + b.rect.w - 1) && (d.y === b.rect.y || d.y === b.rect.y + b.rect.h - 1)
          expect(onRing && !corner, `${tag}: door ${d.x},${d.y} not on the wall ring`).toBe(true)
        }
        // Deck: every interior tile is floor-family (or the rare exit pad).
        for (let y = room.y; y < room.y + room.h; y++) {
          for (let x = room.x; x < room.x + room.w; x++) {
            const t = tile(level, x, y)
            expect(isFloorTile(t) || t === Tile.Grass || t === Tile.Exit, `${tag}: bad deck ${t} at ${x},${y}`).toBe(true)
          }
        }
      }
    }
  })

  it('rooms never overlap and every module belongs to exactly one wing', () => {
    for (const { level, tag } of sweep(40)) {
      const rooms = level.buildings.map((b) => b.rooms[0])
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
  it('ships a mess hall (the biggest room) with a galley next door, bunk rooms, and a mix of modules', () => {
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
        const area = (r: Rect): number => r.w * r.h
        expect(area(mess.rooms[0]), tag).toBeGreaterThanOrEqual(30)
        const objective = level.buildings[farthestModule(level)]
        for (const b of level.buildings) {
          if (b === mess || b === objective) continue
          expect(area(b.rooms[0]), `${tag}: a ${b.role} outsizes the mess hall`).toBeLessThanOrEqual(area(mess.rooms[0]))
        }
        const galley = level.buildings.find((b) => b.role === 'galley')
        if (galley) galleys++
      }
      // Washrooms are closets, never halls.
      for (const b of level.buildings) if (b.role === 'washroom') expect(b.rooms[0].w * b.rooms[0].h, tag).toBeLessThanOrEqual(24)
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
      flooded += count(generateLevel(seed, 4), Tile.Bog)
      overgrown += count(generateLevel(seed, 6), Tile.Grass)
      habitationMoss += count(generateLevel(seed, 3), Tile.Grass)
      expect(generateLevel(seed, 4).complex!.biome).toBe('flooded')
      expect(generateLevel(seed, 6).complex!.biome).toBe('overgrown')
    }
    expect(flooded / 30).toBeGreaterThan(40)
    expect(overgrown / 30).toBeGreaterThan(40)
    expect(habitationMoss).toBe(0)
    // Reactor floors plate their engineering decks.
    expect(generateLevel(1, 5).tiles.filter((x) => x === Tile.Plating).length).toBeGreaterThan(100)
  })

  it('the objective module (farthest from spawn) takes a biome objective role', () => {
    for (const { level, tag } of sweep(40)) {
      expect(BIOME_DEFS[level.complex!.biome].objective, tag).toContain(level.buildings[farthestModule(level)].role)
    }
  })
})

describe('complex generator: adversarial inputs', () => {
  it('extreme seeds and very deep floors still build a fully connected complex', () => {
    for (const seed of [0, -1, 1, 0x7fffffff, 0xffffffff, 2 ** 31, 123456789]) {
      for (const floor of [3, 7, 64, 999]) {
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
      for (const floor of [3, 4, 5, 6]) {
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

  it('the mission targets a real module on every complex floor', () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const floor of [3, 4, 5, 6]) {
        const w = world(seed, floor)
        if (w.mission.targetBuilding === undefined) continue
        const b = w.level.buildings[w.mission.targetBuilding]
        expect(b.poi).toBe('module')
      }
    }
  })
})
