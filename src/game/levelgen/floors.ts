import { mulberry32 } from '../rng'
import { THEMES, type BiomeName, type Theme } from './level'

/**
 * THE RUN'S FLOOR PLAN: what each floor of a run is built as. This module is
 * the one place that decides it; `generateLevel` reads it and nothing else
 * branches on the floor number to pick a setting.
 *
 * The opening floors are the sunken city. Every floor after them is the indoor
 * station complex, and the city never comes back however deep the run goes.
 * The station's biomes turn over one per floor in an order the run's seed
 * shuffles, so floor 3 is not the same biome every run.
 */
export type FloorSetting = { kind: 'city'; theme: Theme } | { kind: 'complex'; biome: BiomeName }

/** Floors 1 and 2, in order: the sunken city's two opening districts. */
export const OPENING_FLOORS: readonly FloorSetting[] = [
  { kind: 'city', theme: THEMES[0] },
  { kind: 'city', theme: THEMES[1] },
]

/** Every station biome. A run plays them in a seeded order, one per floor,
 * and repeats that order lap after lap. */
export const BIOMES: readonly BiomeName[] = ['habitation', 'flooded', 'reactor', 'overgrown']

/** First floor built as the indoor complex. */
export const COMPLEX_MIN_FLOOR = OPENING_FLOORS.length + 1

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
  if (f < COMPLEX_MIN_FLOOR) return OPENING_FLOORS[Math.max(f, 1) - 1]
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
