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
import type { Annotation, SimEvent } from './types'
import {
  createWorld,
  REVIVES_PER_RUN,
  type FearPulse,
  type MissionState,
  type Noise,
  type RunMode,
  type World,
} from './world'

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
  /** #65 active fear pulses (World.fear). Omitted when empty so pre-feature
   * snapshots round-trip byte-for-byte and load with no pulses. */
  fear?: FearPulse[]
  /** Pending FX/net events (empty at a tick boundary; carried for completeness). */
  events: SimEvent[]
  /** Sim stream position (host AI/loot/mission dice) — the byte-identical keystone. */
  rng: number
  /** Root run PRNG position; per-floor sim streams fork from it. */
  baseRng: number
  /** FNV-1a of the regenerated level — a mismatch means seed/floor drift. */
  levelChecksum: number
  /** Combat "all NPCs are enemies" tunable. Omitted when true (the default) so
   * pre-feature snapshots round-trip byte-for-byte and load as hostile. */
  hostile?: boolean
  /** Run difficulty. A SIM INPUT, not presentation: `combat.kill` and
   * `interaction.recover` both branch on it, so a `casual` run that reloaded
   * without this silently regained `normal` stakes. Omitted at the 'normal'
   * default so pre-feature snapshots round-trip byte-for-byte. */
  mode?: RunMode
  /** Party-shared comebacks left this run. MUTATED during play
   * (`interaction.recover` decrements it) and READ by `combat.kill` to decide
   * whether a down is fatal — so omitting it handed a restored run its revives
   * back and moved when the run ends. Omitted at the fresh-run default. */
  revivesLeft?: number
  /** Per-wing power-cut flags (World.powerCut). Omitted when nothing is cut (the
   * default) so pre-feature snapshots round-trip byte-for-byte and load as fully
   * powered — same optional-field discipline as `hostile`/`annotations`. */
  powerCut?: Record<string, boolean>
  entities: Record<string, unknown>[]
  /** Inert on-screen annotations (types.ts). Absent in pre-annotation snapshots →
   * restored as `[]`. Entity SELECTION needs no field here: `Entity.selected`
   * rides along in each entity's verbatim JSON above. */
  annotations?: Annotation[]
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
  // Omit when empty so pre-feature snapshots round-trip byte-for-byte.
  ...(w.fear.length ? { fear: w.fear.map((f) => ({ ...f })) } : {}),
  events: clone(w.events),
  rng: w.rng.state(),
  baseRng: w.baseRng.state(),
  levelChecksum: levelChecksum(w.level),
  entities: w.entities.map(serializeEntity),
  // Omit when at the hostile default so pre-existing snapshots stay byte-for-byte
  // unchanged; only a peaceful (false) world writes the field.
  ...(w.hostile ? {} : { hostile: false }),
  // Difficulty + the revive economy. Both are read by the sim (combat.kill,
  // interaction.recover), so leaving them out made a restored world diverge in a
  // way NO existing test could see: `expectWorldEqual` compares two
  // `serializeWorld` outputs, and a field absent from the schema is invisible on
  // both sides. Same omit-at-default discipline as `hostile` above.
  ...(w.mode === 'normal' ? {} : { mode: w.mode }),
  ...(w.revivesLeft === REVIVES_PER_RUN ? {} : { revivesLeft: w.revivesLeft }),
  // Omit when nothing is cut so a fully-powered station serializes exactly as
  // before this feature (no `powerCut` key at all).
  ...(Object.values(w.powerCut).some(Boolean) ? { powerCut: { ...w.powerCut } } : {}),
  // Omit when empty so pre-existing snapshots stay byte-for-byte unchanged (a
  // fresh world with no annotations serializes exactly as before this feature).
  ...(w.annotations.length ? { annotations: clone(w.annotations) } : {}),
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
  w.powerCut = j.powerCut ? { ...j.powerCut } : {} // pre-feature snapshots load fully powered
  w.hostile = j.hostile ?? true // pre-feature snapshots load as hostile (the default)
  w.mode = j.mode ?? 'normal' // pre-feature snapshots load at the normal default
  w.revivesLeft = j.revivesLeft ?? REVIVES_PER_RUN
  w.gameOver = j.gameOver
  w.mission = { ...j.mission }
  w.noises = j.noises.map((n) => ({ ...n }))
  w.fear = j.fear ? j.fear.map((f) => ({ ...f })) : [] // pre-feature snapshots load with no pulses
  w.events = clone(j.events)
  // Resume both streams at their exact saved positions. The sim stream is the
  // `sim:<floor>` fork of the root, so recover its seed the same way `fork` did.
  w.baseRng = mulberry32(j.seed, j.baseRng)
  w.rng = mulberry32(hashLabel(j.seed >>> 0, `sim:${j.floor}`), j.rng)
  // Deep-clone the entities so the returned world fully owns its data: the input
  // JSON stays pristine, and two worlds from the same snapshot never alias.
  w.entities = j.entities.map((e) => clone(e) as unknown as Entity)
  w.byId = new Map(w.entities.map((e) => [e.id, e]))
  // Annotations are inert presentation data; default to none for older snapshots.
  w.annotations = j.annotations ? clone(j.annotations) : []
  return w
}
