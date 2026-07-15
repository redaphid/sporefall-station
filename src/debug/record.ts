// Record & replay for the deterministic sim. The world is a pure function of
// (seed → forked RNG) + the per-tick InputCmd map, so a run is fully captured by
// its initial player seeds plus the exact input map fed to `tickWorld` each tick.
// Replay rebuilds the world from those seeds and re-feeds the recorded inputs —
// inputs are the ONLY entropy, so it reproduces the same entities and events
// bit-for-bit. Nothing here reads `Date.now()`/`Math.random()`: the sim forbids
// both (eslint-guarded), and this module only clones data and re-runs the sim.

import type { Entity } from '../game/entity'
import { generateLevel } from '../game/levelgen/generate'
import { spawnPlayer } from '../game/player'
import { populateWorld } from '../game/populate'
import { setupFloor } from '../game/systems/missions'
import type { InputCmd, SimEvent } from '../game/types'
import { createWorld, tickWorld, type MissionState, type Noise, type World } from '../game/world'
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
// A whole-world dump used as a scenario STARTING POINT (not for bit-exact
// continuation: the seeded RNG stream is re-forked from seed+floor on load, so
// post-load AI/loot dice differ from an uninterrupted run). Replay above never
// uses this path — it reconstructs from genesis so determinism is exact.

export interface WorldFixture {
  seed: number
  floor: number
  tick: number
  nextId: number
  alarm: number
  gameOver: boolean
  mission: MissionState
  noises: Noise[]
  entities: Record<string, unknown>[]
}

export const saveWorld = (w: World): WorldFixture => ({
  seed: w.seed,
  floor: w.floor,
  tick: w.tick,
  nextId: w.nextId,
  alarm: w.alarm,
  gameOver: w.gameOver,
  mission: { ...w.mission },
  noises: w.noises.map((n) => ({ ...n })),
  entities: w.entities.map(serializeEntity),
})

/** Restore a fixture into an existing world in place (its `level`/`rng` are
 * regenerated from seed+floor, so the reference stays valid for readonly holders). */
export const applyFixture = (w: World, fx: WorldFixture): void => {
  w.floor = fx.floor
  w.level = generateLevel(fx.seed, fx.floor)
  w.tick = fx.tick
  w.nextId = fx.nextId
  w.alarm = fx.alarm
  w.gameOver = fx.gameOver
  w.mission = { ...fx.mission }
  w.noises = fx.noises.map((n) => ({ ...n }))
  w.entities.length = 0
  for (const e of fx.entities) w.entities.push(e as unknown as Entity)
  w.byId.clear()
  for (const e of w.entities) w.byId.set(e.id, e)
}
