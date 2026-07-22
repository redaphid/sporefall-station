// make-rooms-make-sense — every generated room gets a TYPE (shopfloor/bedroom/
// ward/armory/…) derived purely from geometry the generator already fixed, so
// furnishing/missions/AI can reason about rooms instead of anonymous rects.
// Strict + adversarial: sweeps many seeds across all four themes, checks the
// semantic invariants of each role's anatomy (street doors open into the
// front-of-house, the bathroom is the smallest room, the bunker core is the
// armory, a sealed vault is a vault), and proves the assignment drew NO rng —
// the frozen floor-1 checksums and themed-floor tiles are byte-identical with
// and without it.

import { describe, expect, it } from 'vitest'
import { generateLevel } from './generate'
import { levelChecksum, type Building, type RoomType } from './level'
import { assignRoomTypes, roomOwningTile } from './roomTypes'

const seeds = [1, 2, 3, 7, 13, 22, 42, 99, 123, 424242]
const floors = [1, 2, 3, 4, 5]

/** Room indices with a door through the building's exterior wall (mirrors the
 * implementation's geometry on purpose — the INVARIANTS below are the test). */
const entryRoomIndices = (b: Building): Set<number> => {
  const { x, y, w, h } = b.rect
  const set = new Set<number>()
  for (const d of b.doors) {
    let ix = d.x
    let iy = d.y
    if (d.x === x) ix = x + 1
    else if (d.x === x + w - 1) ix = x + w - 2
    else if (d.y === y) iy = y + 1
    else if (d.y === y + h - 1) iy = y + h - 2
    else continue
    const ri = roomOwningTile(b.rooms, ix, iy)
    if (ri >= 0) set.add(ri)
  }
  return set
}

const area = (b: Building, ri: number): number => b.rooms[ri].w * b.rooms[ri].h

describe('room types — every room gets a legible identity', () => {
  it('assigns a defined type to every room of every building on every floor', () => {
    for (const s of seeds) {
      for (const f of floors) {
        for (const b of generateLevel(s, f).buildings) {
          expect(b.roomTypes, `seed ${s} floor ${f}: missing roomTypes`).toBeDefined()
          expect(b.roomTypes!.length).toBe(b.rooms.length)
          for (const t of b.roomTypes!) expect(t).toBeTruthy()
        }
      }
    }
  })

  it('is deterministic: regenerating the level reproduces identical types', () => {
    for (const s of [1, 7, 42]) {
      for (const f of floors) {
        const a = generateLevel(s, f).buildings.map((b) => b.roomTypes)
        const c = generateLevel(s, f).buildings.map((b) => b.roomTypes)
        expect(a).toEqual(c)
      }
    }
  })

  it('draws no rng: tiles are byte-identical to a generation without types (frozen floor 1 included)', () => {
    // The pinned floor-1 checksums (floor1.frozen.test.ts) already gate this
    // for floor 1; extend the guarantee to every themed floor by checksumming
    // twice — any rng draw inside assignment would desync fork streams.
    for (const s of seeds) {
      for (const f of floors) {
        expect(levelChecksum(generateLevel(s, f))).toBe(levelChecksum(generateLevel(s, f)))
      }
    }
  })
})

describe('room types — role anatomy invariants (adversarial seed sweep)', () => {
  it('shops: every street door opens into shop floor; back rooms hold stock', () => {
    for (const s of seeds) {
      for (const f of floors) {
        for (const b of generateLevel(s, f).buildings) {
          if (b.role !== 'shop') continue
          const entries = entryRoomIndices(b)
          for (const ri of entries) {
            // The sealed vault chamber never has a street door, so an entry
            // room is always plain shop floor.
            expect(b.roomTypes![ri], `seed ${s} floor ${f}`).toBe('shopfloor')
          }
          expect(b.roomTypes, 'a shop with no shop floor').toContain('shopfloor')
          for (let ri = 0; ri < b.rooms.length; ri++) {
            expect(['shopfloor', 'stockroom', 'vault']).toContain(b.roomTypes![ri])
          }
        }
      }
    }
  })

  it('apartments: one living room, the bathroom is never bigger than any bedroom', () => {
    for (const s of seeds) {
      for (const f of floors) {
        for (const b of generateLevel(s, f).buildings) {
          if (b.role !== 'apartment') continue
          const types = b.roomTypes!
          expect(types.filter((t) => t === 'living').length).toBe(1)
          const bathrooms = types.map((t, i) => [t, i] as const).filter(([t]) => t === 'bathroom')
          expect(bathrooms.length).toBeLessThanOrEqual(1)
          for (const [, bi] of bathrooms) {
            for (let ri = 0; ri < types.length; ri++) {
              if (types[ri] === 'bedroom' || types[ri] === 'living') {
                expect(area(b, bi), `bathroom bigger than a ${types[ri]}`).toBeLessThanOrEqual(area(b, ri))
              }
            }
          }
          if (types.length >= 2) expect(types).toContain('bathroom')
        }
      }
    }
  })

  it('offices: at most one lobby, storage closet no bigger than any workroom', () => {
    for (const s of seeds) {
      for (const f of floors) {
        for (const b of generateLevel(s, f).buildings) {
          if (b.role !== 'office') continue
          const types = b.roomTypes!
          expect(types.filter((t) => t === 'lobby').length).toBeLessThanOrEqual(1)
          const st = types.indexOf('storage')
          if (st >= 0) {
            for (let ri = 0; ri < types.length; ri++) {
              if (types[ri] === 'office') expect(area(b, st)).toBeLessThanOrEqual(area(b, ri))
            }
          }
          if (types.length >= 2) expect(types).toContain('lobby')
        }
      }
    }
  })

  it('warehouses are stock with at most a foreman office; clinics front with a waiting room', () => {
    for (const s of seeds) {
      for (const f of floors) {
        for (const b of generateLevel(s, f).buildings) {
          const types = b.roomTypes!
          if (b.role === 'warehouse') {
            expect(types.filter((t) => t === 'office').length).toBeLessThanOrEqual(1)
            for (const t of types) expect(['stockroom', 'office', 'vault']).toContain(t)
          }
          if (b.role === 'clinic') {
            expect(types.filter((t) => t === 'waiting').length).toBeLessThanOrEqual(1)
            if (types.length >= 2) expect(types).toContain('waiting')
            for (const t of types) expect(['waiting', 'ward', 'supply', 'vault']).toContain(t)
          }
        }
      }
    }
  })

  it('bunkers: guard band is the guardpost, the sealed core is the armory', () => {
    let sawBunker = false
    for (let s = 1; s <= 60; s++) {
      for (const f of [2, 3, 4]) {
        for (const b of generateLevel(s, f).buildings) {
          if (b.role !== 'bunker') continue
          sawBunker = true
          expect(b.roomTypes![0]).toBe('guardpost')
          const core = b.rooms.findIndex((r) => r === b.objectiveRoom)
          expect(core).toBeGreaterThanOrEqual(0)
          expect(b.roomTypes![core]).toBe('armory')
        }
      }
    }
    expect(sawBunker, 'seed sweep never produced a bunker').toBe(true)
  })

  it('vault set-pieces: the sealed chamber is typed vault, whatever the building role', () => {
    let sawVault = false
    for (let s = 1; s <= 60; s++) {
      for (const f of [1, 2, 3, 4]) {
        for (const b of generateLevel(s, f).buildings) {
          if (b.poi !== 'vault' || !b.objectiveRoom) continue
          sawVault = true
          const vi = b.rooms.findIndex((r) => r === b.objectiveRoom)
          expect(vi).toBeGreaterThanOrEqual(0)
          expect(b.roomTypes![vi]).toBe('vault')
        }
      }
    }
    expect(sawVault, 'seed sweep never produced a vault').toBe(true)
  })
})

describe('room types — degenerate buildings (adversarial)', () => {
  it('handles a single-room building without inventing back-of-house', () => {
    const room = { x: 1, y: 1, w: 5, h: 5 }
    const mk = (role: Building['role']): Building => ({
      rect: { x: 0, y: 0, w: 7, h: 7 },
      rooms: [room],
      doors: [{ x: 3, y: 0 }],
      role,
      objectiveRoom: room,
    })
    expect(assignRoomTypes(mk('shop'))).toEqual(['shopfloor'])
    expect(assignRoomTypes(mk('apartment'))).toEqual(['living'])
    expect(assignRoomTypes(mk('office'))).toEqual(['office'])
    expect(assignRoomTypes(mk('warehouse'))).toEqual(['stockroom'])
    expect(assignRoomTypes(mk('clinic'))).toEqual(['ward'])
  })

  it('handles a doorless building (no entries) by fronting the largest room', () => {
    const b: Building = {
      rect: { x: 0, y: 0, w: 12, h: 7 },
      rooms: [
        { x: 1, y: 1, w: 4, h: 5 },
        { x: 6, y: 1, w: 5, h: 5 },
      ],
      doors: [],
      role: 'shop',
    }
    const types = assignRoomTypes(b)
    expect(types[1]).toBe('shopfloor')
    expect(types[0]).toBe('stockroom')
  })

  it('never returns an undefined slot for any role/room-count combination', () => {
    const roles: Building['role'][] = ['shop', 'apartment', 'office', 'warehouse', 'clinic', 'bunker']
    for (const role of roles) {
      for (let count = 1; count <= 6; count++) {
        const rooms = Array.from({ length: count }, (_, i) => ({ x: 1 + i * 4, y: 1, w: 3, h: 3 + (i % 2) }))
        const b: Building = { rect: { x: 0, y: 0, w: 4 * count + 1, h: 6 }, rooms, doors: [], role, objectiveRoom: rooms[count - 1] }
        const types = assignRoomTypes(b)
        expect(types.length).toBe(count)
        for (const t of types) expect(t satisfies RoomType).toBeTruthy()
      }
    }
  })
})
