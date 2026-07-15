// Record & replay for the deterministic sim. The world is a pure function of
// (seed → forked RNG) + the per-tick InputCmd map, so a run is fully captured by
// its initial player seeds plus the exact input map fed to `tickWorld` each tick.
// Replay rebuilds the world from those seeds and re-feeds the recorded inputs —
// inputs are the ONLY entropy, so it reproduces the same entities and events
// bit-for-bit. Nothing here reads `Date.now()`/`Math.random()`: the sim forbids
// both (eslint-guarded), and this module only clones data and re-runs the sim.

import { spawnPlayer } from '../game/player'
import { populateWorld } from '../game/populate'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { setupFloor } from '../game/systems/missions'
import type { InputCmd, SimEvent } from '../game/types'
import { createWorld, tickWorld, type World } from '../game/world'
import { serializeEntity } from './verbs'

/** A player's genesis state — enough to respawn it identically on replay. */
export interface RecordedPlayer {
  slot: number
  classId: string
  x: number
  y: number
}

export interface RecordingHeader {
  seed: number
  /** The world's initial floor (always 1 today) — feeds `createWorld(seed, floor)`. */
  floor: number
  /** Genesis players in SPAWN ORDER (host first): replay respawns them in this
   * order so entity ids line up with the original run. */
  players: RecordedPlayer[]
}

export interface RecordedTick {
  tick: number
  /** The exact slot→command map that was fed to `tickWorld` this tick. */
  inputs: Array<[number, InputCmd]>
  /** `w.events` produced by this tick (consumed before the next tick clears them). */
  events: SimEvent[]
}

export interface Recording {
  header: RecordingHeader
  ticks: RecordedTick[]
  /** Verbatim serialized entities at the end — a whole-state checksum for replay. */
  finalState: Record<string, unknown>[]
}

export interface ReplayResult {
  ok: boolean
  ticks: number
  /** Per-tick divergences in the event stream (empty when deterministic). */
  eventMismatches: Array<{ tick: number; expected: SimEvent[]; actual: SimEvent[] }>
  /** Whether the replayed final entity state matched the recording. */
  finalStateMatch: boolean
}

const cloneCmd = (c: InputCmd): InputCmd => ({ ...c })
const cloneInputs = (inputs: Map<number, InputCmd>): Array<[number, InputCmd]> =>
  [...inputs].map(([slot, cmd]) => [slot, cloneCmd(cmd)])
const cloneEvents = (events: readonly SimEvent[]): SimEvent[] => JSON.parse(JSON.stringify(events)) as SimEvent[]
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Snapshot the genesis players of a freshly-started world (insertion order). */
export const playerSeeds = (w: World): RecordedPlayer[] =>
  w.entities
    .filter((e) => e.playerCtl)
    .map((e) => ({ slot: e.playerCtl!.playerId, classId: e.playerCtl!.classId, x: e.pos.x, y: e.pos.y }))

/**
 * Captures the per-tick input map + event stream of a run. Feed it every tick
 * AFTER `tickWorld`, with the input map that was used. Call `finish(world)` to
 * seal the recording with a final-state checksum.
 */
export class Recorder {
  private frames: RecordedTick[] = []
  constructor(readonly header: RecordingHeader) {}

  frame(tick: number, inputs: Map<number, InputCmd>, events: readonly SimEvent[]): void {
    this.frames.push({ tick, inputs: cloneInputs(inputs), events: cloneEvents(events) })
  }

  finish(finalWorld: World): Recording {
    return { header: this.header, ticks: this.frames, finalState: finalWorld.entities.map(serializeEntity) }
  }
}

/** Rebuild a world at genesis from a recording header (deterministic from seed). */
export const worldFromHeader = (header: RecordingHeader): World => {
  const w = createWorld(header.seed, header.floor)
  populateWorld(w)
  setupFloor(w)
  for (const p of header.players) spawnPlayer(w, p.slot, p.classId, p.x, p.y)
  return w
}

/**
 * Re-run a recording from genesis, feeding the recorded inputs tick-by-tick, and
 * assert the event stream + final state match. Because the sim is pure over
 * (seed, inputs), any mismatch means real nondeterminism crept in — the test the
 * whole harness exists to catch.
 */
export const replay = (rec: Recording): ReplayResult => {
  const w = worldFromHeader(rec.header)
  const eventMismatches: ReplayResult['eventMismatches'] = []
  for (const frame of rec.ticks) {
    tickWorld(w, new Map(frame.inputs.map(([slot, cmd]) => [slot, cloneCmd(cmd)])))
    const actual = cloneEvents(w.events)
    if (!eq(actual, frame.events)) eventMismatches.push({ tick: frame.tick, expected: frame.events, actual })
  }
  const finalStateMatch = eq(w.entities.map(serializeEntity), rec.finalState)
  return { ok: eventMismatches.length === 0 && finalStateMatch, ticks: rec.ticks.length, eventMismatches, finalStateMatch }
}

// ---- save / load full-world fixtures ------------------------------------
// Thin wrappers over the canonical `serializeWorld`/`deserializeWorld`
// (`game/serialize.ts`). Unlike the old dump, this path is LOSSLESS: it carries
// the RNG stream position, so a loaded world is byte-identical on subsequent
// ticks. `applyFixture` restores in place so readonly holders of `w` keep their
// reference. Replay above still reconstructs from genesis for its exactness.

/** @deprecated Alias of the canonical world snapshot — use `WorldJson`. */
export type WorldFixture = WorldJson

export const saveWorld = (w: World): WorldFixture => serializeWorld(w)

/** Restore a fixture into an existing world in place (its `level`/`rng` are
 * regenerated/resumed from the snapshot, so the reference stays valid). */
export const applyFixture = (w: World, fx: WorldFixture): void => {
  const restored = deserializeWorld(fx)
  w.seed = restored.seed
  w.floor = restored.floor
  w.level = restored.level
  w.tick = restored.tick
  w.nextId = restored.nextId
  w.alarm = restored.alarm
  w.gameOver = restored.gameOver
  w.mission = restored.mission
  w.noises = restored.noises
  w.events = restored.events
  w.rng = restored.rng
  w.baseRng = restored.baseRng
  w.entities = restored.entities
  w.byId = restored.byId
}
