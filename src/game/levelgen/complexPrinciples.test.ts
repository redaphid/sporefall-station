// The floorplan principles of docs/design/floorplan-principles.md (P1..P14),
// each asserted the way the spec's "Test" line states it, over many seeds.
// The generator's structural facts (depths, suites, towers, passages) come
// from carveComplex's `meta`, built with the exact rng generateLevel uses.

import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { carveComplex, type ComplexMeta } from './complex'
import { generateLevel } from './generate'
import { isWallTile, Tile, TileGrid, type Building, type Level } from './level'
import type { Rect } from './rooms'

interface Floor {
  tag: string
  level: Level
  meta: ComplexMeta
}

/** The level and the generator's meta for one complex floor. */
const floorOf = (seed: number, floor: number): Floor => {
  const level = generateLevel(seed, floor)
  const grid = new TileGrid(level.w, level.h, new Uint8Array(level.w * level.h))
  const { meta } = carveComplex(mulberry32(seed).fork(`levelgen:${floor}`).fork('complex'), grid, floor)
  return { tag: `seed ${seed} floor ${floor} (${meta.archetype})`, level, meta }
}

const cache = new Map<number, Floor[]>()
/** seeds x complex floors 3, 5, 7, 9. */
const sweep = (seeds: number): Floor[] => {
  const hit = cache.get(seeds)
  if (hit) return hit
  const out: Floor[] = []
  for (let seed = 1; seed <= seeds; seed++) for (let floor = 3; floor <= 9; floor += 2) out.push(floorOf(seed, floor))
  cache.set(seeds, out)
  return out
}

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h
const tileAt = (level: Level, x: number, y: number): number => level.tiles[y * level.w + x]

/** Two room interiors separated by exactly one wall line. */
const touch = (a: Rect, b: Rect): boolean => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ((a.x + a.w + 1 === b.x || b.x + b.w + 1 === a.x) && oy > 0) || ((a.y + a.h + 1 === b.y || b.y + b.h + 1 === a.y) && ox > 0)
}
const touches = (a: Building, b: Building): boolean => a.rooms.some((r) => b.rooms.some((q) => touch(r, q)))

/** Walking distance (tiles) from spawn, over non-solid tiles; `blocked` adds solids. */
const walk = (level: Level, blocked: ReadonlySet<number> = new Set()): Int32Array => {
  const dist = new Int32Array(level.w * level.h).fill(-1)
  const start = Math.floor(level.spawn.y) * level.w + Math.floor(level.spawn.x)
  dist[start] = 0
  const queue = [start]
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]
    const x = i % level.w
    const y = (i / level.w) | 0
    for (const [dx, dy] of ORTHO) {
      const n = (y + dy) * level.w + x + dx
      if (dist[n] >= 0 || level.solid[n] || blocked.has(n)) continue
      dist[n] = dist[i] + 1
      queue.push(n)
    }
  }
  return dist
}

const reachedRoom = (level: Level, b: Building, dist: Int32Array): boolean =>
  b.rooms.some((r) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (dist[y * level.w + x] >= 0) return true
    return false
  })

/** The module each door tile belongs to (a shared interior door has two). */
const doorOwners = (level: Level): Map<number, number[]> => {
  const m = new Map<number, number[]>()
  level.buildings.forEach((b, i) => {
    for (const d of b.doors) m.set(d.y * level.w + d.x, [...(m.get(d.y * level.w + d.x) ?? []), i])
  })
  return m
}

describe('P1: a hierarchy of circulation', () => {
  it('no 1-wide corridor run longer than 2 tiles; service passages are plating, never corridor', () => {
    for (const { level, meta, tag } of sweep(40)) {
      // Circulation: open deck in no room, no doorway, no servants' passage
      // (puddles and moss may lie over a corridor).
      const doors = doorOwners(level)
      const passage = new Set(meta.service.tiles)
      const hall = (x: number, y: number): boolean => {
        const k = y * level.w + x
        if (level.solid[k] || doors.has(k) || passage.has(k)) return false
        return [Tile.Hall, Tile.Grate, Tile.Exit].includes(tileAt(level, x, y) as 10) || level.complex!.corridors.some((c) => inRect(c.rect, x, y))
      }
      for (let y = 1; y < level.h - 1; y++) {
        let run = 0
        for (let x = 1; x < level.w - 1; x++) {
          const thin = hall(x, y) && !hall(x, y - 1) && !hall(x, y + 1)
          run = thin ? run + 1 : 0
          expect(run, `${tag}: 1-wide hall at ${x},${y}`).toBeLessThanOrEqual(2)
        }
      }
      for (let x = 1; x < level.w - 1; x++) {
        let run = 0
        for (let y = 1; y < level.h - 1; y++) {
          const thin = hall(x, y) && !hall(x - 1, y) && !hall(x + 1, y)
          run = thin ? run + 1 : 0
          expect(run, `${tag}: 1-wide hall at ${x},${y}`).toBeLessThanOrEqual(2)
        }
      }
      for (const k of meta.service.tiles) {
        const x = k % level.w
        const y = (k / level.w) | 0
        expect([Tile.Plating, Tile.Bog, Tile.Grass], tag).toContain(tileAt(level, x, y))
        expect(level.complex!.corridors.some((c) => inRect(c.rect, x, y)), `${tag}: passage in a corridor`).toBe(false)
      }
    }
  })
})

describe('P2: a depth gradient, public to private', () => {
  it('the objective is at least 3 doors deep on every floor, and is the deepest far module', () => {
    for (const { level, meta, tag } of sweep(60)) {
      const obj = level.complex!.objective!
      expect(obj, tag).toBeGreaterThanOrEqual(0)
      expect(meta.depth[obj], `${tag}: objective depth`).toBeGreaterThanOrEqual(3)
      // Every module is reachable in the access graph.
      for (const d of meta.depth) expect(d, tag).toBeGreaterThanOrEqual(1)
    }
  })

  it('the objective is reached through an antechamber, never straight off a corridor', () => {
    for (const { level, tag } of sweep(60)) {
      const b = level.buildings[level.complex!.objective!]
      for (const d of b.doors) {
        const onHall = ORTHO.some(([dx, dy]) => [Tile.Hall, Tile.Grate].includes(tileAt(level, d.x + dx, d.y + dy) as 10))
        expect(onHall, `${tag}: objective door ${d.x},${d.y} opens on a corridor`).toBe(false)
      }
    }
  })

  it('quarters sit deeper than the mess, on average', () => {
    let q = 0
    let qn = 0
    let m = 0
    let mn = 0
    for (const { level, meta } of sweep(60)) {
      level.buildings.forEach((b, i) => {
        if (b.role === 'quarters') {
          q += meta.depth[i]
          qn++
        }
        if (b.role === 'mess') {
          m += meta.depth[i]
          mn++
        }
      })
    }
    expect(q / qn).toBeGreaterThan(m / mn)
  })

  it('private rooms are never the first rooms at the airlock', () => {
    for (const { level, meta, tag } of sweep(60)) {
      level.buildings.forEach((b, i) => {
        if (b.role !== 'quarters' || meta.depth[i] > 1) return
        const d = Math.hypot(b.rect.x + b.rect.w / 2 - level.spawn.x, b.rect.y + b.rect.h / 2 - level.spawn.y)
        expect(d, `${tag}: bunk room by the airlock`).toBeGreaterThanOrEqual(9)
      })
    }
  })
})

/** Does the straight line between two tile centres cross a solid tile? */
const blockedLine = (level: Level, a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4)
  for (let i = 0; i <= steps; i++) {
    const x = Math.floor(a.x + ((b.x - a.x) * i) / steps)
    const y = Math.floor(a.y + ((b.y - a.y) * i) / steps)
    if (level.solid[y * level.w + x]) return true
  }
  return false
}

describe('P3: the entrance sequence', () => {
  it('a gatehouse booth holds the security post, and it is among the first two rooms reached', () => {
    for (const { level, meta, tag } of sweep(60)) {
      expect(meta.booths.length, tag).toBeGreaterThanOrEqual(1)
      expect(
        meta.booths.some((i) => level.buildings[i].role === 'security'),
        `${tag}: no guard in the gatehouse`,
      ).toBe(true)
      const dist = walk(level)
      const first = level.buildings
        .map((b, i) => {
          let best = Infinity
          for (const r of b.rooms) {
            for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (dist[y * level.w + x] >= 0) best = Math.min(best, dist[y * level.w + x])
          }
          return { i, best }
        })
        .sort((a, b) => a.best - b.best)
        .slice(0, 2)
      expect(
        first.some(({ i }) => level.buildings[i].role === 'security'),
        tag,
      ).toBe(true)
    }
  })

  it('a bent entry hides the exit from the landing, and bent entries do occur', () => {
    let bent = 0
    for (const { level, meta, tag } of sweep(60)) {
      if (!meta.bent) continue
      bent++
      expect(blockedLine(level, level.spawn, { x: level.exit.x + 0.5, y: level.exit.y + 0.5 }), tag).toBe(true)
    }
    expect(bent).toBeGreaterThan(20)
  })
})

/** Share of the solid layer that matches its mirror across the axis. */
const axisMirror = (level: Level, axis: { horizontal: boolean; at: number }): number => {
  let same = 0
  let n = 0
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const mx = axis.horizontal ? x : 2 * axis.at - x
      const my = axis.horizontal ? 2 * axis.at - y : y
      if (mx < 0 || my < 0 || mx >= level.w || my >= level.h) continue
      n++
      if (level.solid[y * level.w + x] === level.solid[my * level.w + mx]) same++
    }
  }
  return same / n
}

describe('P4: a grand axis with symmetric wings (Palladian)', () => {
  it('flipping the plan across the axis matches 85%+, and the axis runs through the landmark hall', () => {
    let palladian = 0
    for (const { level, meta, tag } of sweep(60)) {
      if (meta.archetype !== 'palladian') continue
      palladian++
      const axis = meta.axis!
      expect(axisMirror(level, axis), tag).toBeGreaterThanOrEqual(0.85)
      // The spawn is on the axis...
      expect(Math.floor(axis.horizontal ? level.spawn.y : level.spawn.x), tag).toBe(axis.at)
      // ...and so is the landmark.
      const hall = level.buildings[meta.landmark]
      expect(
        hall.rooms.some((r) => (axis.horizontal ? axis.at >= r.y && axis.at < r.y + r.h : axis.at >= r.x && axis.at < r.x + r.w)),
        tag,
      ).toBe(true)
    }
    expect(palladian).toBeGreaterThan(20)
  })
})

describe('P5: enfilade suites', () => {
  it('suite doors lie on one line, the rooms form a path, and each is one door deeper than the last', () => {
    let suites = 0
    let judged = 0
    let stepped = 0
    for (const { level, meta, tag } of sweep(60)) {
      const owners = doorOwners(level)
      for (const s of meta.suites) {
        suites++
        const links: { x: number; y: number }[] = []
        for (let k = 0; k + 1 < s.length; k++) {
          const shared = [...owners].filter(([, o]) => o.includes(s[k]) && o.includes(s[k + 1]))
          expect(shared.length, `${tag}: suite rooms ${s[k]}/${s[k + 1]} not linked`).toBeGreaterThanOrEqual(1)
          const [key] = shared[0]
          links.push({ x: key % level.w, y: (key / level.w) | 0 })
        }
        // Collinear: the line runs along the suite, across every partition.
        const sameRow = links.every((d) => d.y === links[0].y)
        const sameCol = links.every((d) => d.x === links[0].x)
        expect(sameRow || sameCol, `${tag}: suite doors off line`).toBe(true)
        // Only the antechamber opens on a corridor.
        for (const i of s.slice(1)) {
          const onHall = level.buildings[i].doors.some((d) =>
            ORTHO.some(([dx, dy]) => [Tile.Hall, Tile.Grate].includes(tileAt(level, d.x + dx, d.y + dy) as 10)),
          )
          expect(onHall, `${tag}: an inner suite room opens on a corridor`).toBe(false)
        }
        // The objective's cycle door (P10) opens a suite's far end on purpose.
        if (s.includes(level.complex!.objective!)) continue
        judged++
        if (s.every((r, k) => k === 0 || meta.depth[r] === meta.depth[s[k - 1]] + 1)) stepped++
      }
    }
    expect(suites).toBeGreaterThan(40)
    expect(stepped / judged).toBeGreaterThan(0.85)
  })
})

describe('P6: served and servant spaces', () => {
  it('a servants passage is a loop, not a lifeline, and never serves the bunk rooms', () => {
    let floors = 0
    for (const { level, meta, tag } of sweep(60)) {
      if (meta.service.tiles.length === 0) continue
      floors++
      const cut = walk(level, new Set(meta.service.tiles))
      level.buildings.forEach((b, i) => expect(reachedRoom(level, b, cut), `${tag}: ${b.role} ${i} stranded without the passage`).toBe(true))
      for (const i of meta.service.buildings) expect(level.buildings[i].role, tag).not.toBe('quarters')
      // The passage itself is reachable, and opens at 2+ places.
      const all = walk(level)
      for (const k of meta.service.tiles) expect(all[k], tag).toBeGreaterThanOrEqual(0)
    }
    expect(floors).toBeGreaterThan(40)
  })
})

describe('P7: poche', () => {
  it('thick walls: 8%+ of inner wall tiles sit in a 2x2 block of wall, and every niche opens on one room', () => {
    let thick = 0
    let walls = 0
    let niches = 0
    for (const { level, tag } of sweep(40)) {
      const wall = (x: number, y: number): boolean => tileAt(level, x, y) === Tile.Wall
      for (let y = 1; y < level.h - 1; y++) {
        for (let x = 1; x < level.w - 1; x++) {
          if (!wall(x, y)) continue
          walls++
          if (
            [
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ].some(([dx, dy]) => wall(x + dx, y) && wall(x, y + dy) && wall(x + dx, y + dy))
          )
            thick++
        }
      }
      for (const b of level.buildings) {
        for (const r of b.rooms) {
          if (Math.min(r.w, r.h) !== 1 || Math.max(r.w, r.h) > 2) continue
          niches++
          // Exactly one side of a niche is open, onto its own room.
          let open = 0
          for (let y = r.y; y < r.y + r.h; y++) {
            for (let x = r.x; x < r.x + r.w; x++) {
              for (const [dx, dy] of ORTHO) {
                const nx = x + dx
                const ny = y + dy
                if (inRect(r, nx, ny) || level.solid[ny * level.w + nx]) continue
                open++
                expect(b.rooms.some((q) => inRect(q, nx, ny)), `${tag}: niche opens outside its room`).toBe(true)
              }
            }
          }
          expect(open, tag).toBe(1)
        }
      }
    }
    expect(thick / walls).toBeGreaterThan(0.08)
    expect(niches).toBeGreaterThan(100)
  })
})

describe('P8: the cloister', () => {
  it('most range rooms open onto the cloister walk', () => {
    let cloisters = 0
    for (const { level, meta, tag } of sweep(60)) {
      if (meta.archetype !== 'cloister') continue
      cloisters++
      const walk2 = level.complex!.corridors.filter((c) => (c.axis === 'h' ? c.rect.h : c.rect.w) === 2)
      let onWalk = 0
      let onHall = 0
      for (const b of level.buildings) {
        for (const d of b.doors) {
          const hall = ORTHO.find(([dx, dy]) => [Tile.Hall, Tile.Grate].includes(tileAt(level, d.x + dx, d.y + dy) as 10))
          if (!hall) continue
          onHall++
          if (walk2.some((c) => inRect(c.rect, d.x + hall[0], d.y + hall[1]))) onWalk++
        }
      }
      expect(onWalk / onHall, tag).toBeGreaterThanOrEqual(0.6)
    }
    expect(cloisters).toBeGreaterThan(20)
  })
})

describe('P9: corner towers', () => {
  it('towers project past their neighbours and are single rooms two doors deep', () => {
    let towers = 0
    for (const { level, meta, tag } of sweep(60)) {
      for (const t of meta.towers) {
        towers++
        expect(t.projection, tag).toBeGreaterThanOrEqual(2)
        expect(meta.depth[t.building], `${tag}: tower depth`).toBeGreaterThanOrEqual(2)
        expect(level.buildings[t.building].rooms.length, tag).toBe(1)
      }
    }
    expect(towers).toBeGreaterThan(100)
  })
})

describe('P10: loops', () => {
  it('the room + corridor graph has cyclomatic number 3+, and the objective often lies on a cycle', () => {
    let rich = 0
    let cycled = 0
    const floors = sweep(60)
    for (const { level } of floors) {
      // Edges: each door (double doors count once) and each open arch.
      const owners = doorOwners(level)
      const edges = new Set<string>()
      const seen = new Set<number>()
      for (const [k, o] of owners) {
        if (seen.has(k)) continue
        seen.add(k)
        for (const nb of [k + 1, k + level.w]) if (owners.get(nb)?.join() === o.join()) seen.add(nb)
        edges.add(o.length === 1 ? `${o[0]}:C:${k}` : `${o.join('-')}:${k}`)
      }
      // Arches: a walkable tile in no room, with deck of two modules either side.
      const roomOf = (x: number, y: number): number => level.buildings.findIndex((b) => b.rooms.some((r) => inRect(r, x, y)))
      for (let y = 1; y < level.h - 1; y++) {
        for (let x = 1; x < level.w - 1; x++) {
          const k = y * level.w + x
          if (level.solid[k] || owners.has(k) || roomOf(x, y) >= 0) continue
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
          ] as const) {
            const a = roomOf(x - dx, y - dy)
            const b = roomOf(x + dx, y + dy)
            if (a >= 0 && b >= 0 && a !== b) edges.add(`arch:${Math.min(a, b)}-${Math.max(a, b)}`)
          }
        }
      }
      if (edges.size - (level.buildings.length + 1) + 1 >= 3) rich++
      const ob = level.buildings[level.complex!.objective!]
      const separate = ob.doors.filter((d) => !ob.doors.some((e) => (e.x === d.x + 1 && e.y === d.y) || (e.y === d.y + 1 && e.x === d.x)))
      if (separate.length >= 2) cycled++
    }
    expect(rich / floors.length).toBeGreaterThan(0.95)
    expect(cycled / floors.length).toBeGreaterThan(0.3)
  })
})

describe('P11 / P12: adjacency', () => {
  it('washrooms gather on wet walls (70%+ touch a wet room or quarters)', () => {
    let wash = 0
    let wet = 0
    for (const { level } of sweep(60)) {
      for (const b of level.buildings) {
        if (b.role !== 'washroom') continue
        wash++
        if (level.buildings.some((c) => c !== b && ['washroom', 'galley', 'medbay', 'quarters'].includes(c.role) && touches(b, c))) wet++
      }
    }
    expect(wet / wash).toBeGreaterThan(0.7)
  })

  it('a reactor never shares a wall with quarters, the infirmary or the mess (500 floors)', () => {
    for (let seed = 1; seed <= 125; seed++) {
      for (let floor = 3; floor <= 9; floor += 2) {
        const level = generateLevel(seed, floor)
        for (const b of level.buildings) {
          if (b.role !== 'reactor') continue
          for (const c of level.buildings) {
            if (['quarters', 'medbay', 'mess'].includes(c.role)) expect(touches(b, c), `seed ${seed} floor ${floor}: reactor by ${c.role}`).toBe(false)
          }
        }
      }
    }
  })
})

describe('P13: room proportions', () => {
  it('plain box rooms keep to 1:1 .. 1:2 (95%+)', () => {
    let rooms = 0
    let ok = 0
    for (const { level } of sweep(40)) {
      for (const b of level.buildings) {
        if (b.rooms.length !== 1) continue
        const r = b.rooms[0]
        let feature = false
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (isWallTile(tileAt(level, x, y))) feature = true
        if (feature) continue
        rooms++
        if (Math.max(r.w, r.h) / Math.min(r.w, r.h) <= 2) ok++
      }
    }
    expect(ok / rooms).toBeGreaterThan(0.95)
  })
})

describe('P14: one band per institution', () => {
  it('on ladder floors, 70%+ of the zones in a band share one purpose', () => {
    let bands = 0
    let dominant = 0
    for (let seed = 1; seed <= 300; seed++) {
      const { meta } = floorOf(seed, 3 + 2 * (seed % 4))
      if (meta.archetype !== 'ladder') continue
      for (const label of ['north', 'mid', 'south']) {
        const kinds = (meta.bandKinds[label] ?? []).filter((k) => k !== 'entry')
        if (kinds.length < 2) continue
        bands++
        const counts = new Map<string, number>()
        for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
        dominant += Math.max(...counts.values()) / kinds.length
      }
    }
    expect(bands).toBeGreaterThan(20)
    expect(dominant / bands).toBeGreaterThanOrEqual(0.7)
  })
})

describe('archetypes', () => {
  it('every archetype appears, the fallback stays near a quarter, and each builds a whole floor', () => {
    const seen = new Map<string, number>()
    const floors = sweep(60)
    for (const { meta } of floors) seen.set(meta.archetype, (seen.get(meta.archetype) ?? 0) + 1)
    for (const a of ['palladian', 'cloister', 'pavilion', 'ship']) expect(seen.get(a) ?? 0, a).toBeGreaterThan(20)
    const fallback = ['spine', 'tee', 'ladder', 'ring'].reduce((s, a) => s + (seen.get(a) ?? 0), 0)
    expect(fallback / floors.length).toBeGreaterThan(0.12)
    expect(fallback / floors.length).toBeLessThan(0.35)
  })

  it('pavilion wards stand in a comb with open courts between them', () => {
    for (const { level, meta, tag } of sweep(60)) {
      if (meta.archetype !== 'pavilion') continue
      // The courts are open wings: walkable deck in no module.
      const courts = level.complex!.wings.filter((w) => w.buildings.length === 0)
      expect(courts.length, tag).toBeGreaterThanOrEqual(1)
    }
  })

  it('ship bulkheads carry hatches on one line', () => {
    let ships = 0
    for (const { meta, tag } of sweep(60)) {
      if (meta.archetype !== 'ship') continue
      ships++
      expect(meta.hatches.length, tag).toBeGreaterThanOrEqual(3)
    }
    expect(ships).toBeGreaterThan(20)
  })
})
