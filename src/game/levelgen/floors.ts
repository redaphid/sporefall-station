import { mulberry32 } from '../rng'
import { themeNamed, type BiomeName, type Theme, type ThemeName } from './level'

/**
 * THE RUN'S FLOOR PLAN: what each floor of a run is built as. This module is
 * the one place that decides it; `generateLevel` reads it and nothing else
 * branches on the floor number to pick a setting.
 *
 * The opening floors are the sunken city. Each draws its district from its own
 * pool, seeded, never the district of the floor before. Every floor after them
 * is the indoor station complex, and the city never comes back however deep the
 * run goes. The station's biomes turn over one per floor in an order the run's
 * seed shuffles, so floor 3 is not the same biome every run.
 */
export type FloorSetting = { kind: 'city'; theme: Theme } | { kind: 'complex'; biome: BiomeName }

/** The district pool of floors 1 and 2, in order.
 *
 * Floor 1 is the landing: the classic downtown grid, byte-frozen because the
 * in-game demos, every committed floor-1 world and every shared floor-1
 * `?state=` link replay on it (levelgen/floor1.frozen.test.ts). Widening its
 * pool is a one-line change here once those move to authored worlds; the
 * no-repeat rule below already covers it. */
export const OPENING_POOLS: readonly (readonly ThemeName[])[] = [['downtown'], ['slums', 'stillworks', 'culturebeds']]

/** Run `seed`'s opening districts, one per opening floor: each a seeded pick
 * from its pool, never the floor before's district. Its own rng fork, so it
 * moves no other draw. */
export const openingDistricts = (seed: number): readonly Theme[] => {
  const rng = mulberry32(seed).fork('floors:districts')
  const out: Theme[] = []
  for (const pool of OPENING_POOLS) {
    const prev = out[out.length - 1]?.name
    const choices = pool.filter((name) => name !== prev)
    out.push(themeNamed(choices.length === 1 ? choices[0] : choices[rng.int(0, choices.length - 1)]))
  }
  return out
}

/** Every station biome. A run plays them in a seeded order, one per floor,
 * and repeats that order lap after lap. */
export const BIOMES: readonly BiomeName[] = ['habitation', 'flooded', 'reactor', 'overgrown']

/** First floor built as the indoor complex. */
export const COMPLEX_MIN_FLOOR = OPENING_POOLS.length + 1

/** Run `seed`'s biome order: a Fisher-Yates shuffle of BIOMES on its own
 * stream, so it moves no other draw. Every entry is distinct, so no two
 * consecutive floors share a biome, across a lap's seam included. */
export const biomeOrder = (seed: number): readonly BiomeName[] => {
  const rng = mulberry32(seed).fork('floors:biomes')
  const order = [...BIOMES]
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/** The setting floor `floor` (1-based) of run `seed` is built as. Total over
 * every number: floors below 1 (and a non-finite floor) build as floor 1, and
 * fractions round down. */
export const floorSetting = (seed: number, floor: number): FloorSetting => {
  const f = Number.isFinite(floor) ? Math.floor(floor) : 1
  if (f < COMPLEX_MIN_FLOOR) return { kind: 'city', theme: openingDistricts(seed)[Math.max(f, 1) - 1] }
  const order = biomeOrder(seed)
  return { kind: 'complex', biome: order[(f - COMPLEX_MIN_FLOOR) % order.length] }
}

/** The biome floor `floor` of run `seed` wears. Off the complex (floors 1-2)
 * it is the run's first station biome, the one a complex generated there for
 * a test would wear. */
export const biomeForFloor = (seed: number, floor: number): BiomeName => {
  const s = floorSetting(seed, floor)
  return s.kind === 'complex' ? s.biome : biomeOrder(seed)[0]
}
