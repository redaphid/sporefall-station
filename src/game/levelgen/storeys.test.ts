// The structural rule for storeys, enforced (docs/design/stairs-and-storeys.md
// §2.1). The owner's ask: "floors above must make sense given the supporting
// structure below. But towers are fine." Every check here measures the upper
// storey against the WHOLE ground storey below it, independently of how
// storeys.ts chose to build it — so a generator bug can't grade its own work.

import { describe, expect, it } from 'vitest'
import { populateWorld } from '../populate'
import { mulberry32 } from '../rng'
import { floodLinked, stairReservedKeys } from '../stairs'
import { setupFloor } from '../systems/missions'
import { createWorld } from '../world'
import { generateComplexLevel, generateLevel } from './generate'
import {
  isFloorTile,
  isStairTile,
  isWallTile,
  levelChecksum,
  STOREY_GUTTER,
  STOREY_SIZE,
  STOREY_STRIDE,
  Tile,
  type Building,
  type Level,
  type StairLink,
} from './level'
import {
  addStoreys,
  bearingMasks,
  BEAR_N,
  chebDistance,
  clearanceTiles,
  dilate8,
  nicheTiles,
  planSlab,
  SPAN,
  STAIR_KEEP_OFF,
} from './storeys'

const S = STOREY_SIZE
const FLOORS = [3, 5, 7, 9, 11]
const N8 = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const

const at = (level: Level, slot: number, x: number, y: number): number =>
  x < 0 || y < 0 || x >= S || y >= S ? Tile.Hull : level.tiles[y * level.w + slot * STOREY_STRIDE + x]

/** Open-sky courts: wings that own no module. */
const courts = (level: Level): Uint8Array => {
  const m = new Uint8Array(S * S)
  for (const wg of level.complex?.wings ?? []) {
    if (wg.buildings.length > 0) continue
    for (let y = wg.rect.y; y < wg.rect.y + wg.rect.h; y++)
      for (let x = wg.rect.x; x < wg.rect.x + wg.rect.w; x++) if (!isWallTile(at(level, 0, x, y))) m[y * S + x] = 1
  }
  return m
}

/**
 * Every structural assertion of §2.1 (1-8) for one multi-storey level. Returns
 * a list of violations (empty = valid) so sweeps report the first bad seed.
 */
const violations = (level: Level): string[] => {
  const out: string[] = []
  if (!level.storeys) return out
  expect(level.w).toBe(STOREY_STRIDE * level.storeys.length - STOREY_GUTTER)
  // 8. The gutter is solid Hull, every row.
  for (let slot = 0; slot < level.storeys.length - 1; slot++)
    for (let y = 0; y < level.h; y++)
      for (let x = slot * STOREY_STRIDE + S; x < (slot + 1) * STOREY_STRIDE; x++) {
        const i = y * level.w + x
        if (level.tiles[i] !== Tile.Hull || level.solid[i] !== 1) out.push(`gutter ${x},${y} not solid hull`)
      }
  // The ground storey as the structure below: its whole walkable area.
  const F = new Uint8Array(S * S)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (!isWallTile(at(level, 0, x, y))) F[y * S + x] = 1
  const court = courts(level)
  const { H, D } = bearingMasks((x, y) => at(level, 0, x, y), F, court)
  const courtHalo = dilate8(court)
  for (const st of level.storeys) {
    if (st.z === 0) continue
    // 5. Phase 1: exactly one loft, directly over the ground.
    if (st.z !== 1) out.push(`storey z=${st.z} in Phase 1`)
    const walk = (x: number, y: number): boolean => !isWallTile(at(level, st.slot, x, y))
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const t = at(level, st.slot, x, y)
        const i = y * S + x
        if (t === Tile.Hull) continue
        // 1. Inside the hull of the storey it bears on.
        if (!H[i]) out.push(`upper ${x},${y} outside the ground hull`)
        // 4. Never over (or hard against) an open-sky court.
        if (courtHalo[i]) out.push(`upper ${x},${y} over a court`)
        if (isWallTile(t)) {
          // 2. Walls bear: an upper wall stands within N of a wall below.
          if (D[i] > BEAR_N) out.push(`upper wall ${x},${y} bears on nothing (D=${D[i]})`)
        } else {
          // 3. Span: no walkable slab further than SPAN from a bearing wall.
          if (D[i] > SPAN) out.push(`upper deck ${x},${y} spans ${D[i]}`)
          if (!isFloorTile(t) && t !== Tile.StairDown) out.push(`upper ${x},${y} odd tile ${t}`)
        }
      }
    // 2 (cont). The Hull that closes a walkable upper tile is a wall too: it must bear.
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        if (!walk(x, y)) continue
        for (const [dx, dy] of N8) {
          const nx = x + dx
          const ny = y + dy
          if (walk(nx, ny)) continue
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) out.push(`upper deck ${x},${y} on the slot edge`)
          else if (D[ny * S + nx] > BEAR_N) out.push(`upper enclosure ${nx},${ny} bears on nothing`)
        }
      }
  }
  // 6. Stairs: aligned shafts, walkable landings, clear niches and approaches.
  const doors = new Set(level.buildings.flatMap((b) => b.doors.map((d) => d.y * S + d.x)))
  const vents = new Set((level.complex?.vents ?? []).map((v) => v.y * S + v.x))
  const ups = (level.stairs ?? []).filter((l) => l.from.x < STOREY_STRIDE)
  if (ups.length === 0) out.push('storeys but no stair up')
  for (const l of ups) {
    const p = { x: l.from.x, y: l.from.y }
    if (at(level, 0, p.x, p.y) !== Tile.StairUp) out.push(`ground stair ${p.x},${p.y} is not StairUp`)
    if (l.to.x !== p.x + STOREY_STRIDE || l.to.y !== p.y) out.push(`shaft misaligned ${JSON.stringify(l)}`)
    if (at(level, 1, p.x, p.y) !== Tile.StairDown) out.push(`upper stair ${p.x},${p.y} is not StairDown`)
    const back = (level.stairs ?? []).find((b) => b.from.x === l.to.x && b.from.y === l.to.y)
    if (!back || back.to.x !== p.x || back.to.y !== p.y || back.dir !== l.dir) out.push('no matching down link')
    for (const slot of [0, 1]) {
      const landing = slot === 0 ? back?.landing : l.landing
      if (!landing || level.solid[landing.y * level.w + landing.x]) out.push(`slot ${slot} landing blocked`)
      for (const n of nicheTiles(p, l.dir))
        if (!isWallTile(at(level, slot, n.x, n.y))) out.push(`slot ${slot} niche ${n.x},${n.y} open`)
      for (const c of clearanceTiles(p, l.dir)) {
        const t = at(level, slot, c.x, c.y)
        if (!isFloorTile(t) || t === Tile.Grate) out.push(`slot ${slot} clearance ${c.x},${c.y} not deck (${t})`)
        if (slot === 0 && (doors.has(c.y * S + c.x) || vents.has(c.y * S + c.x))) out.push(`clearance ${c.x},${c.y} holds a door/vent`)
      }
    }
    const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
    for (const k of [{ x: Math.floor(level.spawn.x), y: Math.floor(level.spawn.y) }, level.exit])
      if (cheb(k, p) < STAIR_KEEP_OFF) out.push(`stair ${p.x},${p.y} crowds spawn/exit`)
  }
  // 7. Connectivity: a stair-following flood from spawn reaches every walkable tile.
  const reach = floodLinked(level, Math.floor(level.spawn.y) * level.w + Math.floor(level.spawn.x))
  for (let i = 0; i < level.tiles.length; i++)
    if (!level.solid[i] && !reach[i]) out.push(`tile ${i % level.w},${(i / level.w) | 0} unreachable`)
  return out
}

/** 9. Ground byte-identity: slot 0 equals the no-storey generator except the
 * stair shaft (the StairUp tile and its niche), and spawn/exit/buildings match. */
const groundDiff = (level: Level, ref: Level): string[] => {
  const out: string[] = []
  const shaft = new Set<number>()
  for (const l of level.stairs ?? []) {
    if (l.from.x >= STOREY_STRIDE) continue
    shaft.add(l.from.y * S + l.from.x)
    for (const n of nicheTiles(l.from, l.dir)) shaft.add(n.y * S + n.x)
  }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const a = at(level, 0, x, y)
      const b = ref.tiles[y * S + x]
      if (a === b) continue
      if (!shaft.has(y * S + x)) out.push(`ground ${x},${y}: ${b} -> ${a}`)
      // A shaft tile may only become the stair or a niche wall.
      else if (!isStairTile(a) && !isWallTile(a)) out.push(`shaft ${x},${y}: ${b} -> ${a}`)
    }
  if (JSON.stringify(level.spawn) !== JSON.stringify(ref.spawn)) out.push('spawn moved')
  if (JSON.stringify(level.exit) !== JSON.stringify(ref.exit)) out.push('exit moved')
  if (JSON.stringify(level.buildings) !== JSON.stringify(ref.buildings)) out.push('buildings changed')
  if (JSON.stringify(level.complex) !== JSON.stringify(ref.complex)) out.push('complex info changed')
  return out
}

describe('storeys: the structural rule over 200 seeds x floors 3-11', () => {
  const levels: { tag: string; level: Level; seed: number; floor: number }[] = []
  for (let seed = 1; seed <= 200; seed++)
    for (const floor of FLOORS) levels.push({ tag: `seed ${seed} floor ${floor}`, level: generateLevel(seed, floor), seed, floor })

  it('every upper storey stands on the structure below (hull, bearing walls, span, courts, gutter, stairs, connectivity)', () => {
    let checked = 0
    for (const { tag, level } of levels) {
      if (!level.storeys) continue
      checked++
      expect(violations(level).slice(0, 5), tag).toEqual([])
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('the ground storey is byte-identical to the no-storey generator, bar the stair shaft', () => {
    for (const { tag, level, seed, floor } of levels.filter((_, i) => i % 4 === 0)) {
      const ref = generateComplexLevel(seed, floor, { storeys: false })
      expect(ref.storeys, tag).toBeUndefined()
      expect(groundDiff(level, ref).slice(0, 5), tag).toEqual([])
      if (!level.storeys) expect(levelChecksum(level), tag).toBe(levelChecksum(ref))
    }
  })

  it('is deterministic: two generations share a levelChecksum and the same stairs', () => {
    for (const { tag, level, seed, floor } of levels.filter((_, i) => i % 10 === 0)) {
      const again = generateLevel(seed, floor)
      expect(levelChecksum(again), tag).toBe(levelChecksum(level))
      expect(again.stairs, tag).toEqual(level.stairs)
    }
  })

  it('yields: at least 60% of complex floors get a loft (a rule that prunes everything fails here)', () => {
    const lofts = levels.filter(({ level }) => level.storeys).length
    expect(lofts / levels.length).toBeGreaterThanOrEqual(0.6)
  })

  it('Phase 1 shape: at most one loft (z=1), exactly one stair pair, city floors untouched', () => {
    for (const { tag, level } of levels) {
      if (!level.storeys) {
        expect(level.stairs, tag).toBeUndefined()
        expect(level.w, tag).toBe(S)
        continue
      }
      expect(level.storeys.map((s) => s.z), tag).toEqual([0, 1])
      expect(level.stairs, tag).toHaveLength(2)
    }
    for (const f of [1, 2, 4, 6]) {
      const city = generateLevel(3, f)
      expect(city.storeys).toBeUndefined()
      expect(city.w).toBe(S)
    }
  })

  it('generation stays inside the phone budget (< 15 ms per complex floor on average)', () => {
    const t0 = performance.now()
    for (let seed = 500; seed < 540; seed++) generateLevel(seed, 3 + 2 * (seed % 5))
    expect((performance.now() - t0) / 40).toBeLessThan(15)
  })
})

describe('storeys: loft population — loot only, nothing hostile upstairs', () => {
  it('each loft holds a crate, a mod and a pickup; no NPC spawns off the ground; the stair clearance stays empty', () => {
    let lofts = 0
    for (let seed = 1; seed <= 30; seed++)
      for (const floor of [3, 5, 7]) {
        const w = createWorld(seed, floor)
        populateWorld(w)
        setupFloor(w)
        const tag = `seed ${seed} floor ${floor}`
        const upstairs = w.entities.filter((e) => e.pos.x >= STOREY_STRIDE)
        const reserved = stairReservedKeys(w.level)
        for (const e of w.entities) {
          const k = Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)
          expect(reserved.has(k), `${tag}: ${e.archetype} on the stair clearance`).toBe(false)
        }
        expect(upstairs.filter((e) => e.kind === 'npc' || e.ai), tag).toEqual([])
        if (!w.level.storeys) {
          expect(upstairs, tag).toEqual([])
          continue
        }
        lofts++
        expect(upstairs.filter((e) => e.archetype === 'crate'), tag).toHaveLength(1)
        expect(upstairs.filter((e) => e.archetype.startsWith('mod.')), tag).toHaveLength(1)
        expect(upstairs.filter((e) => e.kind === 'pickup'), tag).toHaveLength(2)
        for (const e of upstairs) expect(isFloorTile(w.level.tiles[Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)]), tag).toBe(true)
      }
    expect(lofts).toBeGreaterThan(40)
  })
})

// ── 12. Adversarial ground storeys, built by hand ────────────────────────────
// Each must produce no storey or a valid one, and never throw.

const handLevel = (paint: (set: (x: number, y: number, t: number) => void) => void, buildings: Building[]): Level => {
  const tiles = new Uint8Array(S * S).fill(Tile.Hull)
  paint((x, y, t) => {
    if (x >= 0 && y >= 0 && x < S && y < S) tiles[y * S + x] = t
  })
  const solid = new Uint8Array(S * S)
  for (let i = 0; i < S * S; i++) solid[i] = isWallTile(tiles[i]) ? 1 : 0
  return {
    w: S,
    h: S,
    tiles,
    solid,
    buildings,
    spawn: { x: 1.5, y: 1.5 },
    exit: { x: 62, y: 62 },
    complex: { biome: 'habitation', corridors: [], vents: [], wings: [] },
  }
}

const room = (x: number, y: number, w: number, h: number, doors: { x: number; y: number }[] = []): Building => ({
  rect: { x: x - 1, y: y - 1, w: w + 2, h: h + 2 },
  rooms: [{ x, y, w, h }],
  doors,
  role: 'depot',
  poi: 'module',
})

const tryAdversarial = (level: Level, meta?: { towers: { building: number; projection: number }[]; booths: number[] }): Level => {
  const before = levelChecksum(level)
  expect(() => addStoreys(level, mulberry32(9).fork('storeys'), meta)).not.toThrow()
  if (!level.storeys) expect(levelChecksum(level)).toBe(before)
  else expect(violations(level).slice(0, 5)).toEqual([])
  return level
}

describe('storeys: adversarial lower storeys', () => {
  it('one 62x62 hall with no partitions: nothing can span it, so no loft', () => {
    const level = tryAdversarial(
      handLevel((set) => {
        for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) set(x, y, Tile.Floor)
      }, [room(1, 1, 62, 62)]),
    )
    expect(level.storeys).toBeUndefined()
  })

  it('one 3x3 room: too small to carry a loft', () => {
    const level = tryAdversarial(
      handLevel((set) => {
        for (let y = 1; y < 63; y++) for (let x = 1; x < 4; x++) set(x, y, Tile.Hall) // a corridor from spawn
        for (let y = 20; y < 23; y++) for (let x = 20; x < 23; x++) set(x, y, Tile.Floor)
      }, [room(20, 20, 3, 3)]),
    )
    expect(level.storeys).toBeUndefined()
  })

  it('a checkerboard of pillars: no throw, and any loft it grows is valid', () => {
    tryAdversarial(
      handLevel((set) => {
        for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) set(x, y, (x + y) % 2 === 0 ? Tile.Floor : Tile.Wall)
        for (let y = 1; y < 63; y++) set(1, y, Tile.Floor)
      }, [room(1, 1, 62, 62)]),
    )
  })

  it('an all-court floor: nothing may float over open sky', () => {
    const level = handLevel((set) => {
      for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) set(x, y, Tile.Grass)
      for (let y = 20; y < 29; y++) for (let x = 20; x < 29; x++) set(x, y, Tile.Wall)
      for (let y = 21; y < 28; y++) for (let x = 21; x < 28; x++) set(x, y, Tile.Floor)
      set(24, 20, Tile.Floor) // a doorway into the court
    }, [room(21, 21, 7, 7, [{ x: 24, y: 20 }])])
    level.complex!.wings = [{ rect: { x: 1, y: 1, w: 62, h: 62 }, buildings: [] }]
    tryAdversarial(level)
    expect(level.storeys).toBeUndefined()
  })

  it('a lone thick-walled 5x5 tower with no deck around it: a tower loft or nothing, never a bad one', () => {
    const level = handLevel((set) => {
      for (let y = 1; y < 63; y++) for (let x = 1; x < 3; x++) set(x, y, Tile.Hall)
      for (let x = 1; x < 30; x++) set(x, 30, Tile.Hall)
      for (let y = 26; y < 35; y++) for (let x = 30; x < 39; x++) set(x, y, Tile.Wall)
      for (let y = 28; y < 33; y++) for (let x = 32; x < 37; x++) set(x, y, Tile.Plating)
      set(30, 30, Tile.Hall)
      set(31, 30, Tile.Floor) // the door through the 2-thick wall
    }, [room(32, 28, 5, 5, [{ x: 31, y: 30 }])])
    tryAdversarial(level, { towers: [{ building: 0, projection: 0 }], booths: [] })
  })

  it('a 9x9 thick-walled room off a corridor grows a valid loft with its stair in the poché', () => {
    const level = handLevel((set) => {
      for (let y = 1; y < 63; y++) for (let x = 1; x < 3; x++) set(x, y, Tile.Hall)
      for (let x = 1; x < 20; x++) set(x, 30, Tile.Hall)
      for (let y = 23; y < 38; y++) for (let x = 19; x < 34; x++) set(x, y, Tile.Wall)
      for (let y = 26; y < 35; y++) for (let x = 22; x < 31; x++) set(x, y, Tile.Tiled)
      for (let x = 19; x < 22; x++) set(x, 30, Tile.Floor) // the entry through the thick wall
    }, [room(22, 26, 9, 9, [{ x: 21, y: 30 }])])
    tryAdversarial(level)
    expect(level.storeys?.map((s) => s.z)).toEqual([0, 1])
    // The loft is decked like the room below it.
    const l = level.stairs![0] as StairLink
    expect(level.tiles[l.landing.y * level.w + l.landing.x]).toBe(Tile.Tiled)
  })

  it('planSlab never throws on empty or all-wall input', () => {
    const none = new Uint8Array(S * S)
    const masks = bearingMasks(() => Tile.Hull, none, none)
    expect(planSlab(masks, none, 0)).toBeNull()
    expect(chebDistance(none).every((d) => d === 0xffff)).toBe(true)
  })
})
