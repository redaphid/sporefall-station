// Canonical, lossless JSON round-trip for a whole `World`. The sim is a pure
// function of (seed → forked RNG) + per-tick InputCmd, and entities are plain
// data, so the ONLY thing standing between a snapshot and byte-identical replay
// on the next tick is the RNG stream position — captured here via `rng.state()`
// and resumed on load. The level is NOT stored (it is regenerable from
// seed+floor and never mutated at runtime); its `levelChecksum` rides along so a
// seed/floor drift is caught on load instead of silently producing a wrong map.

import { serializeEntity } from '../debug/verbs'
import type { Entity } from './entity'
import { levelChecksum } from './levelgen/level'
import { hashLabel, mulberry32 } from './rng'
import type { SimEvent } from './types'
import { createWorld, type MissionState, type Noise, type World } from './world'

/** The versioned on-disk shape of a whole world. Stable and JSON-safe: every
 * field is a scalar, a plain record, or a verbatim entity clone. `level` is
 * intentionally absent — `levelChecksum` validates the regenerated one. */
export interface WorldJson {
  v: 1
  seed: number
  floor: number
  tick: number
  nextId: number
  alarm: number
  gameOver: boolean
  mission: MissionState
  noises: Noise[]
  /** Pending FX/net events (empty at a tick boundary; carried for completeness). */
  events: SimEvent[]
  /** Sim stream position (host AI/loot/mission dice) — the byte-identical keystone. */
  rng: number
  /** Root run PRNG position; per-floor sim streams fork from it. */
  baseRng: number
  /** FNV-1a of the regenerated level — a mismatch means seed/floor drift. */
  levelChecksum: number
  entities: Record<string, unknown>[]
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Snapshot a world to a plain JSON object with full fidelity. */
export const serializeWorld = (w: World): WorldJson => ({
  v: 1,
  seed: w.seed,
  floor: w.floor,
  tick: w.tick,
  nextId: w.nextId,
  alarm: w.alarm,
  gameOver: w.gameOver,
  mission: { ...w.mission },
  noises: w.noises.map((n) => ({ ...n })),
  events: clone(w.events),
  rng: w.rng.state(),
  baseRng: w.baseRng.state(),
  levelChecksum: levelChecksum(w.level),
  entities: w.entities.map(serializeEntity),
})

/** Rebuild a fresh, standalone world from a snapshot — byte-identical on every
 * subsequent tick to the world it was captured from (given the same inputs). */
export const deserializeWorld = (j: WorldJson): World => {
  const w = createWorld(j.seed, j.floor) // regenerates the level from seed+floor
  if (levelChecksum(w.level) !== j.levelChecksum) {
    throw new Error(`level checksum drift for seed ${j.seed} floor ${j.floor} — cannot restore`)
  }
  w.tick = j.tick
  w.nextId = j.nextId
  w.alarm = j.alarm
  w.gameOver = j.gameOver
  w.mission = { ...j.mission }
  w.noises = j.noises.map((n) => ({ ...n }))
  w.events = clone(j.events)
  // Resume both streams at their exact saved positions. The sim stream is the
  // `sim:<floor>` fork of the root, so recover its seed the same way `fork` did.
  w.baseRng = mulberry32(j.seed, j.baseRng)
  w.rng = mulberry32(hashLabel(j.seed >>> 0, `sim:${j.floor}`), j.rng)
  // Deep-clone the entities so the returned world fully owns its data: the input
  // JSON stays pristine, and two worlds from the same snapshot never alias.
  w.entities = j.entities.map((e) => clone(e) as unknown as Entity)
  w.byId = new Map(w.entities.map((e) => [e.id, e]))
  return w
}
