// The run's floor plan (floors.ts): floors 1-2 are the sunken city, every floor
// from 3 is the indoor station complex, and the city never comes back. The
// subject here IS the generator's seed+floor -> setting mapping, so these tests
// stay seed-based.

import { describe, expect, it } from 'vitest'
import { serializeWorld } from '../serialize'
import { createWorld, type RunMode } from '../world'
import { BIOMES, biomeForFloor, biomeOrder, COMPLEX_MIN_FLOOR, floorSetting, OPENING_POOLS, openingDistricts } from './floors'
import { generateLevel } from './generate'
import { levelChecksum, themeNamed, THEMES, type Level } from './level'

/** What a generated level actually is, read off the level itself. */
const settingOf = (level: Level): string => (level.complex ? `complex:${level.complex.biome}` : `city:${level.theme}`)

const SEEDS = [1, 2, 3, 7, 18, 42, 1000, 12345, 20260715, 0x7fffffff, 0xdeadbeef, 0xffffffff]

describe('the floor plan', () => {
  it('opens on two city floors, then the complex from floor 3', () => {
    expect(COMPLEX_MIN_FLOOR).toBe(3)
    expect(OPENING_POOLS).toHaveLength(2)
    for (const seed of SEEDS) {
      expect(floorSetting(seed, 1)).toEqual({ kind: 'city', theme: themeNamed('downtown') })
      const second = floorSetting(seed, 2)
      expect(second.kind).toBe('city')
      expect(OPENING_POOLS[1]).toContain(second.kind === 'city' ? second.theme.name : undefined)
      for (let f = 3; f <= 30; f++) expect(floorSetting(seed, f).kind, `seed ${seed} floor ${f}`).toBe('complex')
    }
  })

  it('over 200 seeds x floors 1-30 the generated level never builds the city at floor 3+, and always does at 1-2', () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (let f = 1; f <= 30; f++) {
        const level = generateLevel(seed, f)
        const tag = `seed ${seed} floor ${f}: ${settingOf(level)}`
        if (f <= 2) {
          expect(level.complex, tag).toBeUndefined()
          expect(level.theme, tag).toBe(openingDistricts(seed)[f - 1].name)
        } else {
          expect(level.complex, tag).toBeDefined()
          expect(level.complex!.biome, tag).toBe(biomeForFloor(seed, f))
        }
      }
    }
  }, 120_000)

  it('the city never comes back however deep the run goes', () => {
    for (const seed of SEEDS) {
      for (const f of [31, 64, 99, 100, 255, 256, 1000, 65_535, 1e6, 2 ** 31 - 1, Number.MAX_SAFE_INTEGER]) {
        expect(floorSetting(seed, f).kind, `seed ${seed} floor ${f}`).toBe('complex')
      }
    }
    for (const f of [64, 1000, 2 ** 31 - 1]) expect(generateLevel(5, f).complex, `floor ${f}`).toBeDefined()
  })

  it('no two consecutive floors share a biome, across every lap seam', () => {
    for (let seed = 1; seed <= 500; seed++) {
      for (let f = 3; f < 40; f++) expect(biomeForFloor(seed, f), `seed ${seed} floor ${f}`).not.toBe(biomeForFloor(seed, f + 1))
    }
  })

  it('every lap of four floors plays all four biomes', () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (let lap = 0; lap < 5; lap++) {
        const floors = [0, 1, 2, 3].map((i) => COMPLEX_MIN_FLOOR + 4 * lap + i)
        expect(floors.map((f) => biomeForFloor(seed, f)).sort(), `seed ${seed} lap ${lap}`).toEqual([...BIOMES].sort())
      }
    }
  })

  it('the seed picks the order: every one of the 24 orders turns up, and floor 3 is not always the same biome', () => {
    const orders = new Set<string>()
    const firsts = new Map<string, number>()
    for (let seed = 0; seed < 2000; seed++) {
      orders.add(biomeOrder(seed).join(','))
      const b = biomeForFloor(seed, 3)
      firsts.set(b, (firsts.get(b) ?? 0) + 1)
    }
    expect(orders.size).toBe(24)
    for (const b of BIOMES) expect(firsts.get(b) ?? 0, `floor 3 as ${b}`).toBeGreaterThan(350)
  })
})

describe('the opening districts', () => {
  it('floor 1 is the landing downtown; floor 2 is a seeded pick of the other three, never a repeat', () => {
    const seen = new Map<string, number>()
    for (let seed = 0; seed < 3000; seed++) {
      const [first, second] = openingDistricts(seed)
      expect(first.name, `seed ${seed}`).toBe('downtown')
      expect(second.name, `seed ${seed}`).not.toBe(first.name)
      seen.set(second.name, (seen.get(second.name) ?? 0) + 1)
    }
    for (const name of ['slums', 'stillworks', 'culturebeds']) expect(seen.get(name) ?? 0, name).toBeGreaterThan(850)
  })

  it('every district a run can open on is reachable, and every district in THEMES is in some pool', () => {
    const pooled = new Set(OPENING_POOLS.flat())
    for (const t of THEMES) expect(pooled.has(t.name), t.name).toBe(true)
  })

  it('the generated floor 2 is built as its district: courtyard ground, plaza heart and roles', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const level = generateLevel(seed, 2)
      const district = themeNamed(level.theme!)
      for (const b of level.buildings) {
        if (b.role !== 'bunker') expect(district.roles, `seed ${seed} ${district.name}`).toContain(b.role)
      }
      for (const sq of level.plazas ?? []) {
        const heart = level.tiles[(sq.y + 3) * level.w + sq.x + 3]
        expect(heart, `seed ${seed} ${district.name} plaza heart`).toBe(district.plazaHeart)
      }
    }
  })
})

describe('the floor plan: degenerate floors and seeds', () => {
  it('floor 0, negative floors and non-finite floors build as floor 1', () => {
    for (const seed of SEEDS) {
      for (const f of [0, -1, -2, -3, -100, -(2 ** 31), Number.MIN_SAFE_INTEGER, -Infinity, Infinity, NaN]) {
        expect(floorSetting(seed, f), `seed ${seed} floor ${f}`).toEqual(floorSetting(seed, 1))
        expect(BIOMES, `seed ${seed} floor ${f}`).toContain(biomeForFloor(seed, f))
      }
    }
  })

  it('fractional floors round down', () => {
    expect(floorSetting(9, 2.99)).toEqual(floorSetting(9, 2))
    expect(floorSetting(9, 3.5)).toEqual(floorSetting(9, 3))
    expect(floorSetting(9, 0.5)).toEqual(floorSetting(9, 1))
  })

  it('degenerate seeds still give a full order of distinct biomes', () => {
    for (const seed of [0, -1, -0x80000000, 0xffffffff, 2 ** 53, 1.5, NaN]) {
      const order = biomeOrder(seed)
      expect([...order].sort(), `seed ${seed}`).toEqual([...BIOMES].sort())
    }
  })

  it('generates a level for floor 0 and negative floors without throwing', () => {
    for (const f of [0, -1, -7]) {
      const level = generateLevel(3, f)
      expect(level.complex, `floor ${f}`).toBeUndefined()
      expect(level.w * level.h).toBe(level.tiles.length)
    }
  })
})

describe('the floor plan: determinism', () => {
  it('the same seed+floor builds a byte-identical level, every time', () => {
    for (const [seed, f] of [
      [1, 3],
      [1, 4],
      [42, 5],
      [0xdeadbeef, 6],
      [7, 30],
    ]) {
      expect(levelChecksum(generateLevel(seed, f)), `seed ${seed} floor ${f}`).toBe(levelChecksum(generateLevel(seed, f)))
      expect(biomeOrder(seed)).toEqual(biomeOrder(seed))
    }
  })

  it('createWorld is byte-identical for every mode x hostile variant, and the variant never changes the setting', () => {
    const modes: RunMode[] = ['casual', 'normal']
    for (const seed of [1, 42, 0xdeadbeef]) {
      for (const f of [1, 2, 3, 4, 5, 9]) {
        const settings = new Set<string>()
        for (const mode of modes) {
          for (const hostile of [true, false]) {
            const a = createWorld(seed, f, mode, hostile)
            const b = createWorld(seed, f, mode, hostile)
            const tag = `seed ${seed} floor ${f} ${mode} hostile=${hostile}`
            expect(serializeWorld(a), tag).toEqual(serializeWorld(b))
            expect(a.mode, tag).toBe(mode)
            expect(a.hostile, tag).toBe(hostile)
            expect(a.level.complex !== undefined, tag).toBe(f >= COMPLEX_MIN_FLOOR)
            settings.add(`${settingOf(a.level)}#${levelChecksum(a.level)}`)
          }
        }
        expect(settings.size, `seed ${seed} floor ${f}`).toBe(1)
      }
    }
  })

  it('createWorld with the default mode and hostility matches the explicit defaults', () => {
    expect(serializeWorld(createWorld(11, 4))).toEqual(serializeWorld(createWorld(11, 4, 'normal', true)))
  })
})
