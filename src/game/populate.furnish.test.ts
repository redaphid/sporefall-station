// feat/levelgen-fill-interiors — room INTERIORS were 100% empty (props never
// placed), so buildings read as decorative boxes. furnishInteriors now fills
// every room with role-appropriate, destructible furniture on a dedicated
// `furnish` rng fork. Strict + adversarial: builds real floors from fixed
// seeds, runs the REAL populateWorld, and asserts interiors are non-empty,
// roles are respected, placement never blocks a room, determinism holds
// per-seed, degenerate rooms (2×2 vaults, closets) neither crash nor overfill,
// and everything round-trips through serialize/deserialize.

import { describe, expect, it } from 'vitest'
import { FURNISH, FURNISH_MAX_PER_ROOM, populateWorld, roomOwningTile } from './populate'
import { OBJECTS } from './data/objects'
import type { Entity } from './entity'
import { buildingAt, Tile } from './levelgen/level'
import { deserializeWorld, serializeWorld } from './serialize'
import { createWorld, type World } from './world'

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

/** After populateWorld the ONLY interactable entities are furnishings, so this
 * uniquely identifies them. */
const furniture = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'interactable')

const populated = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  return w
}

/** Re-derive a room's free interior floor tiles exactly as furnishInteriors
 * does (walls, doorways + the tile inside them, spawn and exit excluded) so a
 * test can reason about how many props the room SHOULD hold. */
const freeTiles = (w: World, bi: number, ri: number): { x: number; y: number }[] => {
  const lw = w.level.w
  const rooms = w.level.buildings[bi].rooms
  const room = rooms[ri]
  const spawnTx = Math.floor(w.level.spawn.x)
  const spawnTy = Math.floor(w.level.spawn.y)
  const exitTx = Math.floor(w.level.exit.x)
  const exitTy = Math.floor(w.level.exit.y)
  const keepClear = new Set<number>()
  for (const d of w.level.buildings[bi].doors) {
    keepClear.add(d.y * lw + d.x)
    for (const [dx, dy] of ORTHO) keepClear.add((d.y + dy) * lw + (d.x + dx))
  }
  const free: { x: number; y: number }[] = []
  for (let ty = room.y; ty < room.y + room.h; ty++) {
    for (let tx = room.x; tx < room.x + room.w; tx++) {
      if (w.level.tiles[ty * lw + tx] !== Tile.Floor) continue
      if (keepClear.has(ty * lw + tx)) continue
      if (tx === spawnTx && ty === spawnTy) continue
      if (tx === exitTx && ty === exitTy) continue
      if (roomOwningTile(rooms, tx, ty) !== ri) continue
      free.push({ x: tx, y: ty })
    }
  }
  return free
}

/** Props owned by room `ri` of building `bi` — a tile belongs to the SMALLEST
 * room containing it (matching furnishInteriors), so a nested vault and its
 * outer hall are counted separately, never double-counted. */
const propsInRoom = (w: World, bi: number, ri: number, props: Entity[]): Entity[] => {
  const rooms = w.level.buildings[bi].rooms
  return props.filter((e) => {
    const tx = Math.floor(e.pos.x)
    const ty = Math.floor(e.pos.y)
    return buildingAt(w.level, e.pos.x, e.pos.y) === bi && roomOwningTile(rooms, tx, ty) === ri
  })
}

const seeds = [1, 2, 3, 7, 13, 22, 42, 99, 123, 424242]
const floors = [1, 2, 3, 4]

describe('furnish interiors — rooms are no longer empty boxes', () => {
  it('every populated floor places a real cohort of furnishings', () => {
    for (const s of seeds) {
      for (const f of floors) {
        expect(furniture(populated(s, f)).length, `seed ${s} floor ${f}`).toBeGreaterThan(0)
      }
    }
  })

  it('every roomy enclosed room (≥2 free tiles) gets at least one furnishing', () => {
    for (const s of seeds) {
      for (const f of floors) {
        const w = populated(s, f)
        const props = furniture(w)
        for (let bi = 0; bi < w.level.buildings.length; bi++) {
          const rooms = w.level.buildings[bi].rooms
          for (let ri = 0; ri < rooms.length; ri++) {
            if (freeTiles(w, bi, ri).length < 2) continue
            const inRoom = propsInRoom(w, bi, ri, props)
            expect(inRoom.length, `seed ${s} floor ${f} building ${bi} room ${ri}`).toBeGreaterThanOrEqual(1)
          }
        }
      }
    }
  })

  it('placed furniture is destructible and role-appropriate', () => {
    for (const s of seeds) {
      for (const f of floors) {
        const w = populated(s, f)
        for (const e of furniture(w)) {
          // A real, defined object with hp — a smashable prop, not a phantom.
          expect(OBJECTS[e.archetype], `unknown prop ${e.archetype}`).toBeDefined()
          expect(e.health!.hp).toBeGreaterThan(0)
          const bi = buildingAt(w.level, e.pos.x, e.pos.y)
          expect(bi, `prop outside any building (${e.archetype})`).toBeGreaterThanOrEqual(0)
          const role = w.level.buildings[bi].role
          expect(FURNISH[role], `${e.archetype} not in the ${role} palette`).toContain(e.archetype)
        }
      }
    }
  })
})

describe('furnish interiors — placement never breaks a room', () => {
  it('never sits on a wall, doorway, spawn or exit tile, and never stacks', () => {
    for (const s of seeds) {
      for (const f of floors) {
        const w = populated(s, f)
        const lw = w.level.w
        const spawnTx = Math.floor(w.level.spawn.x)
        const spawnTy = Math.floor(w.level.spawn.y)
        const exitTx = Math.floor(w.level.exit.x)
        const exitTy = Math.floor(w.level.exit.y)
        const doorTiles = new Set<number>()
        for (const b of w.level.buildings) for (const d of b.doors) doorTiles.add(d.y * lw + d.x)
        const occupied = new Set<string>()
        for (const e of furniture(w)) {
          const tx = Math.floor(e.pos.x)
          const ty = Math.floor(e.pos.y)
          expect(w.level.tiles[ty * lw + tx]).toBe(Tile.Floor)
          expect(doorTiles.has(ty * lw + tx), 'prop plugs a doorway').toBe(false)
          expect(tx === spawnTx && ty === spawnTy).toBe(false)
          expect(tx === exitTx && ty === exitTy).toBe(false)
          const key = `${tx},${ty}`
          expect(occupied.has(key), 'two props stacked on one tile').toBe(false)
          occupied.add(key)
        }
      }
    }
  })

  it('caps density: ≤ FURNISH_MAX_PER_ROOM per room and always leaves standing room', () => {
    for (const s of seeds) {
      for (const f of floors) {
        const w = populated(s, f)
        const props = furniture(w)
        for (let bi = 0; bi < w.level.buildings.length; bi++) {
          const rooms = w.level.buildings[bi].rooms
          for (let ri = 0; ri < rooms.length; ri++) {
            const free = freeTiles(w, bi, ri)
            const inRoom = propsInRoom(w, bi, ri, props)
            expect(inRoom.length).toBeLessThanOrEqual(FURNISH_MAX_PER_ROOM)
            // Never fill a room solid — at least one free tile stays walkable.
            if (free.length >= 1) expect(inRoom.length).toBeLessThan(free.length)
          }
        }
      }
    }
  })
})

describe('furnish interiors — determinism', () => {
  it('same seed+floor regenerates byte-identical furniture', () => {
    for (const s of [1, 7, 42, 123]) {
      for (const f of floors) {
        const a = furniture(populated(s, f)).map((e) => ({ a: e.archetype, x: e.pos.x, y: e.pos.y }))
        const b = furniture(populated(s, f)).map((e) => ({ a: e.archetype, x: e.pos.x, y: e.pos.y }))
        expect(a).toEqual(b)
      }
    }
  })

  it('different seeds diverge (not every floor is furnished identically)', () => {
    const key = (w: World) => JSON.stringify(furniture(w).map((e) => [e.archetype, e.pos.x, e.pos.y]))
    expect(key(populated(1, 3))).not.toEqual(key(populated(2, 3)))
  })

  it('round-trips byte-for-byte through serialize/deserialize', () => {
    for (const s of [3, 11, 99]) {
      for (const f of floors) {
        const w = populated(s, f)
        const json = serializeWorld(w)
        expect(serializeWorld(deserializeWorld(json))).toEqual(json)
        const restored = deserializeWorld(json)
        expect(furniture(restored).map((e) => e.archetype)).toEqual(furniture(w).map((e) => e.archetype))
      }
    }
  })
})

describe('furnish interiors — degenerate rooms (adversarial)', () => {
  it('handles tiny sealed reward vaults (2×2 interiors) without overfilling', () => {
    // Vault chambers are the smallest enclosed rooms the generator makes. Scan a
    // wide seed range on themed floors so vaults actually turn up, and prove each
    // one is either bare or holds a single prop with a free tile to spare.
    let sawVault = false
    for (let s = 1; s <= 120; s++) {
      for (const f of [2, 3, 4]) {
        const w = populated(s, f)
        const props = furniture(w)
        for (let bi = 0; bi < w.level.buildings.length; bi++) {
          const b = w.level.buildings[bi]
          if (b.poi !== 'vault' || !b.objectiveRoom) continue
          const room = b.objectiveRoom
          if (room.w > 2 || room.h > 2) continue
          const ri = b.rooms.findIndex((r) => r.x === room.x && r.y === room.y && r.w === room.w && r.h === room.h)
          if (ri < 0) continue
          sawVault = true
          const free = freeTiles(w, bi, ri)
          const inRoom = propsInRoom(w, bi, ri, props)
          expect(inRoom.length).toBeLessThanOrEqual(1)
          if (free.length >= 1) expect(inRoom.length).toBeLessThan(free.length)
        }
      }
    }
    expect(sawVault, 'expected at least one 2×2 vault across the seed sweep').toBe(true)
  })

  it('adds only interactable entities — it never mutates the tile grid', () => {
    // Furniture is entities, not tiles: the level checksum inputs are untouched,
    // so reachability/mission placement and the frozen floor-1 map are safe.
    for (const s of [1, 2, 3]) {
      for (const f of floors) {
        const before = createWorld(s, f)
        const tilesBefore = Uint8Array.from(before.level.tiles)
        const solidBefore = Uint8Array.from(before.level.solid)
        populateWorld(before)
        expect(before.level.tiles).toEqual(tilesBefore)
        expect(before.level.solid).toEqual(solidBefore)
      }
    }
  })
})
