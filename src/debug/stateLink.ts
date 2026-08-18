// Shareable debug-state links: "send a friend a URL and they get EXACTLY the
// world I was looking at — and it keeps behaving the way mine did."
//
// A link does not open on a frozen tableau. It restores the world from ~1 second
// BEFORE the interesting moment and PLAYS that second forward at normal speed,
// so a friend WATCHES the bug happen and then lands on the captured frame.
// "Respawned inside a wall" needs the spawn, not the corpse.
//
// WHY THIS IS MOSTLY NOT NEW CODE, AND WHY THAT IS THE POINT
// `game/serialize.ts` already round-trips a whole `World` INCLUDING the PRNG
// stream position (`rng`/`baseRng` via `Rng.state()`). That is the entire
// determinism story: capture the world but not the RNG cursor and the level
// looks identical and then every AI roll, spawn and loot drop diverges the
// moment it resumes — a debugging tool that LIES, which is worse than none.
//
// THE REPLAY IS THE PROOF, NOT JUST A FLOURISH
// Replaying from T-1s with the recorded inputs MUST land exactly on the state
// captured at T. So every link checks itself: `verifyStateLink` replays and
// compares. Match = determinism proven FOR THAT CAPTURE, which is far stronger
// evidence than any test over synthetic worlds. Mismatch = the capture is
// incomplete, and the tool says so loudly — with the tick it started and the
// first field that differs — instead of showing something plausible and wrong.
//
// NOT the net snapshot path (`net/protocol/messages.ts`). Those are
// interest-culled, capped at 48 entities and carry only wire-visible fields;
// a real mid-run world is ~195 entities. Snapshots exist to draw a remote view,
// not to reproduce a world, and reusing one would silently drop most of it.
//
// PURITY: no `Date.now()`, no `Math.random()` — the sim forbids both and this
// module sits next to it. The clock and the id bytes are INJECTED by the app
// layer (`src/app/stateShare.ts`), which is also what makes this unit-testable.

import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import type { InputCmd } from '../game/types'
import { tickWorld, type World } from '../game/world'

/** Envelope schema version. Independent of `WorldJson.v`: this wrapper can gain
 * fields without touching the sim's snapshot format, and vice versa. */
export const STATE_LINK_VERSION = 1

/**
 * A cheap per-tick fingerprint: `[rng cursor, entity count]`.
 *
 * This is what lets a divergence report name the TICK it began rather than only
 * "the end state is wrong". Hashing the whole world every tick would be a full
 * serialize at 30 Hz — far too expensive to leave armed during play. The RNG
 * cursor is nearly free to read and is the single most likely thing to drift
 * (it is what a naive snapshot forgets), and entity count catches spawn/despawn
 * divergence. Two ints per tick.
 *
 * LIMIT, stated honestly: a divergence that moves no entity count and draws no
 * dice — a position drifting by an epsilon, say — will slip past the per-tick
 * signature and only be caught by the exact field compare at the end. The tick
 * number is then unknown, and the report says so rather than guessing.
 */
export type TickSig = [rngCursor: number, entityCount: number]

/** One tick of ground-truth input, as handed to `tickWorld`.
 *
 * Deliberately NOT `record.ts`'s `RecordedTick`: that also carries the tick's
 * `events`, which are fully DERIVABLE by replaying these inputs. Storing them
 * would inflate every link with data the reader can recompute exactly. */
export interface StateFrame {
  tick: number
  /** The exact slot to command map fed to `tickWorld` for this tick. */
  inputs: Array<[number, InputCmd]>
  /** Fingerprint AFTER this tick — see `TickSig`. */
  sig?: TickSig
}

/** The lead-in to a bug: a world from N ticks ago plus every input since, so the
 * situation that PRODUCED the captured state can be watched, not just its result. */
export interface StateRewind {
  /** The world as it stood `frames.length` ticks before the capture. */
  world: WorldJson
  /** Inputs for each tick from `world.tick` up to the capture tick, in order. */
  frames: StateFrame[]
}

export interface StateLinkMeta {
  /** Freeform human note — "respawned inside a wall". */
  note?: string
  /** `__APP_VERSION__` of the build that captured it; a mismatch is the first
   * thing to suspect when a restored world behaves oddly on someone else's tab. */
  build?: string
  /** Wall-clock ms at capture. Informational ONLY — never reaches the sim. */
  capturedAt?: number
}

export interface StateLinkPayload {
  v: typeof STATE_LINK_VERSION
  /** The state AT the moment of capture. Always present: it is both what the
   * replay must land on and what `?state=` falls back to when there is no
   * rewind to play. */
  world: WorldJson
  /** The second before. Present whenever a `StateRing` was armed. */
  rewind?: StateRewind
  meta: StateLinkMeta
}

const cloneInputs = (inputs: ReadonlyMap<number, InputCmd>): Array<[number, InputCmd]> =>
  [...inputs].map(([slot, cmd]) => [slot, { ...cmd }])

const sigOf = (w: World): TickSig => [w.rng.state(), w.entities.length]

/** Rebuild the world a rewind leads up to, watching the per-tick signatures so
 * the FIRST tick that drifts is known rather than inferred.
 *
 * There is deliberately no unchecked variant: replaying without comparing is how
 * you end up trusting a state that quietly diverged. */
export const replayRewindChecked = (rw: StateRewind): { world: World; divergedAtTick?: number } => {
  const w = deserializeWorld(rw.world)
  let divergedAtTick: number | undefined
  for (const f of rw.frames) {
    tickWorld(w, new Map(f.inputs.map(([slot, cmd]) => [slot, { ...cmd }])))
    if (divergedAtTick === undefined && f.sig) {
      const [rng, n] = f.sig
      if (w.rng.state() !== rng || w.entities.length !== n) divergedAtTick = w.tick
    }
  }
  return { world: w, divergedAtTick }
}

const brief = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s === undefined) return 'undefined'
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

export interface FieldDifference {
  /** Dotted/indexed path, e.g. `entities[3].pos.x` or `rng`. */
  path: string
  expected: string
  actual: string
}

/**
 * First differing field between two snapshots, depth-first in a stable order.
 *
 * "Which field" is the whole value of a divergence report: `rng` means the PRNG
 * cursor was not carried, `entities[7].health.hp` means a system ran differently.
 * A bare "they differ" tells a developer nothing actionable.
 *
 * Keys that are absent on one side and `undefined` on the other are treated as
 * equal — that difference is a JSON round-trip artefact, not a real one, and
 * reporting it would bury the genuine divergence in noise.
 */
export const firstDifference = (a: unknown, b: unknown, path = ''): FieldDifference | null => {
  if (a === b) return null
  const here = path || '<root>'
  const bothObjects = typeof a === 'object' && typeof b === 'object' && a !== null && b !== null
  if (!bothObjects) {
    if (a === undefined && b === undefined) return null
    return { path: here, expected: brief(a), actual: brief(b) }
  }
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return { path: here, expected: brief(a), actual: brief(b) }
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length)
      return { path: `${here}.length`, expected: String(x.length), actual: String(y.length) }
    for (let i = 0; i < x.length; i++) {
      const d = firstDifference(x[i], y[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
    const d = firstDifference(x[k], y[k], path ? `${path}.${k}` : k)
    if (d) return d
  }
  return null
}

export interface StateLinkCheck {
  ok: boolean
  /** Human-readable summary; absent when ok. */
  reason?: string
  /** Ticks of lead-in the rewind carries (0 when there is no rewind). */
  rewindTicks: number
  /** Sim tick at which the per-tick signature first disagreed, when known. */
  divergedAtTick?: number
  /** First field that differs in the final state, when there is one. */
  difference?: FieldDifference
}

/**
 * Replay the rewind forward and demand it reproduce the captured world exactly.
 *
 * This is the honest check and it runs on every capture AND on every load — not
 * only in tests. It is the ONLY thing standing between "the link loaded" and
 * "the link is right".
 */
export const verifyStateLink = (p: StateLinkPayload): StateLinkCheck => {
  if (!p.rewind) return { ok: true, rewindTicks: 0 }
  const rewindTicks = p.rewind.frames.length
  let replayed: WorldJson
  let divergedAtTick: number | undefined
  try {
    const r = replayRewindChecked(p.rewind)
    replayed = serializeWorld(r.world)
    divergedAtTick = r.divergedAtTick
  } catch (e) {
    return { ok: false, reason: `rewind failed to replay: ${String(e)}`, rewindTicks }
  }
  const difference = firstDifference(p.world, replayed)
  if (!difference && divergedAtTick === undefined) return { ok: true, rewindTicks }

  const where = divergedAtTick !== undefined ? ` from tick ${divergedAtTick}` : ''
  const what = difference ? `; first difference at ${difference.path}: expected ${difference.expected}, got ${difference.actual}` : ''
  return {
    ok: false,
    reason: `replaying ${rewindTicks} ticks did not reproduce the captured world${where}${what}`,
    rewindTicks,
    divergedAtTick,
    ...(difference ? { difference } : {}),
  }
}

// ---- ids ------------------------------------------------------------------

/** Crockford-flavoured base32: no i, l, o or u, so an id survives being read
 * aloud, retyped, or pasted out of a chat client. */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** 16 chars x 5 bits = 80 bits of entropy. Unguessable on purpose: these links
 * are served from a public origin with no auth, so the id IS the capability. */
export const STATE_ID_LENGTH = 16

export const STATE_ID_RE = /^[0-9a-hjkmnp-tv-z]{16}$/

/** Reference implementation of the id format, pinned against the Worker's copy
 * (`newWorkerStateId`) by `debugState.test.ts`. The Worker is what actually
 * mints ids in production — a client-chosen id could squat on someone else's. */
export const newStateId = (randomBytes: Uint8Array): string => {
  if (randomBytes.length < STATE_ID_LENGTH) throw new Error(`need ${STATE_ID_LENGTH} random bytes`)
  let out = ''
  for (let i = 0; i < STATE_ID_LENGTH; i++) out += ID_ALPHABET[randomBytes[i]! & 31]
  return out
}

// ---- capture --------------------------------------------------------------

/** Snapshot a live world into a shareable payload. `rewind` comes from a
 * `StateRing` when one is armed; without it the link still restores the state,
 * it just opens on the captured frame instead of playing up to it. */
export const captureState = (w: World, meta: StateLinkMeta = {}, rewind?: StateRewind): StateLinkPayload => ({
  v: STATE_LINK_VERSION,
  world: serializeWorld(w),
  ...(rewind ? { rewind } : {}),
  meta,
})

/** Structural guard for something parsed off the network. Cheap shape check
 * only — `deserializeWorld` does the real validation (including the level
 * checksum, which catches seed/floor drift). */
export const isStateLinkPayload = (v: unknown): v is StateLinkPayload => {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Partial<StateLinkPayload>
  return p.v === STATE_LINK_VERSION && typeof p.world === 'object' && p.world !== null
}

// ---- the rewind ring ------------------------------------------------------

/** Ticks between checkpoints. The sim runs at 30 Hz (`SIM_RATE`), so 30 = one
 * second, and the double buffer below means a capture always carries between
 * 1 and 2 seconds of run-up — "play the game for a second as they load". */
export const DEFAULT_REWIND_TICKS = 30

interface Segment {
  world: WorldJson
  frames: StateFrame[]
}

/**
 * A rolling "last second or two" buffer. Double-buffered on purpose: a single
 * checkpoint that reset every N ticks would leave you with ~0 ticks of history
 * exactly when you hit capture right after a rotation — the friend would get a
 * frozen frame precisely when the bug was most interesting. Keeping the PREVIOUS
 * segment alive guarantees at least N ticks of lead-in at all times, for the
 * price of one extra `WorldJson` in memory.
 *
 * Cost is one `serializeWorld` per N ticks (the same order as the existing
 * throttled autosave) plus two ints per tick, so it is armed only for debug
 * sessions — see `src/app/stateShare.ts`. The normal player path never
 * constructs one.
 */
export class StateRing {
  private older: Segment | null = null
  private current: Segment

  constructor(
    world: World,
    private readonly every: number = DEFAULT_REWIND_TICKS,
  ) {
    this.current = { world: serializeWorld(world), frames: [] }
  }

  /** Call AFTER `tickWorld`, with the input map that was just used. */
  observe(world: World, inputs: ReadonlyMap<number, InputCmd>): void {
    this.current.frames.push({ tick: world.tick, inputs: cloneInputs(inputs), sig: sigOf(world) })
    if (this.current.frames.length >= this.every) {
      this.older = this.current
      this.current = { world: serializeWorld(world), frames: [] }
    }
  }

  /** Checkpoint plus every input since it. Between `every` and 2x `every` ticks. */
  rewind(): StateRewind {
    return this.older
      ? { world: this.older.world, frames: [...this.older.frames, ...this.current.frames] }
      : { world: this.current.world, frames: [...this.current.frames] }
  }

  /** The session REPLACED the world (restart / new seed / a loaded state), so the
   * buffered history belongs to a world that no longer exists. Start over. */
  reset(world: World): void {
    this.older = null
    this.current = { world: serializeWorld(world), frames: [] }
  }
}
