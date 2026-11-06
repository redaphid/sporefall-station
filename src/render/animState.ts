/**
 * Character animation STATES — the pure logic layer under the sprite animator.
 *
 * Layer 1 of the animation system (docs/themes.md "Animation states"): named
 * states with variable frame counts and per-state cadence, resolved from sim
 * state the renderer already sees. Everything here is a pure function of the
 * integer sim tick + entity id (+ constants), so frame selection is
 * deterministic on every device and replay — no wall clock, no Math.random.
 * The procedural motion layer (motion.ts) composes on top.
 *
 * One table, ANIM_STATE_DEFS, says everything the engine knows about a state:
 * whether it loops, its cadence, how long a one-shot stays up, what it borrows
 * when a pack draws no frames for it, and whether it hides the held weapon. A
 * new action is a row here, a start source in animTracker.ts, and a slot in
 * ANIM_PRIORITY; the theme loader, manifest validation and key grammar all
 * iterate ANIM_STATES, so the frames load with no further change.
 */

// ---------------------------------------------------------------------------
// The state table

/** Every named animation state a character can be in. */
export type AnimStateName = 'idle' | 'walk' | 'attack' | 'hurt' | 'roll' | 'death' | 'draw' | 'fidget'

/** How long a one-shot stays active once started:
 * - `{ clipAtLeast: n }`: the pose's own drawn clip, `frames × tpf`, but never
 *   less than n ticks. A pack that draws no frames for the state gets exactly
 *   n (the fixed gameplay-feel window), so it looks as it always did; a pack
 *   that draws a longer clip plays all of it. The effects timed against n (the
 *   weapon swing, lunge, flinch, death topple) keep n: see STATE_TICKS.
 * - `'sim'`: the sim's own window, passed in as `AnimInputs.simEnds` (roll);
 * - `'clip'`: exactly the pose's own drawn clip, `frames × tpf`. Such a state is
 *   DRAWN-ONLY: with no frames of its own it never activates, and the character
 *   shows whatever it would have shown without it. */
export type OnceWindow = { clipAtLeast: number } | 'sim' | 'clip'

export type AnimStateDef =
  | {
      play: 'loop'
      /** Default ticks per frame (30 ticks = 1 s); the manifest `anim` section
       * overrides it per theme (1..30). */
      tpf: number
      /** When the loop is the active state (given nothing above it is). */
      while: 'moving' | 'always'
      /** States whose FIRST FRAME stands in when the pose has no frames of its
       * own, tried in order. */
      borrows: readonly AnimStateName[]
    }
  | {
      play: 'once'
      tpf: number
      window: OnceWindow
      borrows: readonly AnimStateName[]
      /** The held-weapon sprite hides while this state plays: its clip draws
       * the weapon itself. */
      stowsWeapon?: true
    }

/** THE state table. `satisfies` keeps each row's literal types, so
 * `ANIM_STATE_DEFS.attack.window.clipAtLeast` is the number 6. */
export const ANIM_STATE_DEFS = {
  idle: { play: 'loop', tpf: 12, while: 'always', borrows: [] },
  // walk tpf matches the legacy 2-frame walk cadence (WALK_TPF).
  walk: { play: 'loop', tpf: 6, while: 'moving', borrows: ['idle'] },
  // attack, hurt, death: a drawn clip plays whole; without one, the fixed window.
  attack: { play: 'once', tpf: 2, window: { clipAtLeast: 6 }, borrows: ['walk', 'idle'] },
  hurt: { play: 'once', tpf: 3, window: { clipAtLeast: 8 }, borrows: ['idle'] },
  // Roll's window is the sim's (`playerCtl.roll.untilTick`), never a render guess.
  roll: { play: 'once', tpf: 3, window: 'sim', borrows: ['walk', 'idle'] },
  death: { play: 'once', tpf: 5, window: { clipAtLeast: 18 }, borrows: ['hurt', 'idle'] },
  // An armed NPC pulls its weapon the moment it engages (animTracker.ts).
  draw: { play: 'once', tpf: 2, window: 'clip', borrows: [], stowsWeapon: true },
  // An occasional idle variant (scratch, shift weight) on a still, calm body.
  fidget: { play: 'once', tpf: 3, window: 'clip', borrows: [] },
} as const satisfies Record<AnimStateName, AnimStateDef>

export const ANIM_STATES = Object.keys(ANIM_STATE_DEFS) as readonly AnimStateName[]

/** Resolution order, highest first. Death is terminal; a roll is a committed
 * whole-body tumble (and its i-frames make a mid-roll hurt impossible); a hurt
 * flinch reads as more urgent than anything the body chose to do. `draw` over
 * `attack` no longer decides anything for a pistol carrier: the sim holds its
 * first shot for `NpcDef.drawTicks`, which ends as an 8-frame default-cadence
 * clip does. It still decides two overlaps: a body with no wind-up that swings
 * on its engage tick, and a theme whose `anim.draw` tpf outlasts the wind-up.
 * There attack on top would cut into the clip, show the held weapon, then jump
 * back into the draw; draw on top plays the clip whole and only hides the
 * attack pose (the shot still flies). Walk beats fidget so a step cancels a
 * scratch. */
export const ANIM_PRIORITY: readonly AnimStateName[] = [
  'death',
  'roll',
  'hurt',
  'draw',
  'attack',
  'walk',
  'fidget',
  'idle',
]

/** Frames per state are indexed 0..MAX_ANIM_FRAMES-1 (manifest key grammar
 * `char.<kind>.<dir>-<state>-<n>`). Contiguous from 0; a gap ends the clip. */
export const MAX_ANIM_FRAMES = 8

export const isLoop = (s: AnimStateName): boolean => ANIM_STATE_DEFS[s].play === 'loop'

/** Default cadence per state, in sim ticks per frame (from the table). */
export const DEFAULT_TPF = Object.fromEntries(ANIM_STATES.map((s) => [s, ANIM_STATE_DEFS[s].tpf])) as Record<
  AnimStateName,
  number
>

/** The fixed gameplay-feel windows, by name: the whole state when the pack
 * draws no clip, and the span motion.ts and the weapon swing time their
 * envelopes against whatever the art. A longer drawn clip keeps playing after
 * them (the swing is back at rest, the lunge and flinch have settled, the
 * death fade runs over the clip's last STATE_TICKS.death ticks). */
export const STATE_TICKS = {
  attack: ANIM_STATE_DEFS.attack.window.clipAtLeast,
  hurt: ANIM_STATE_DEFS.hurt.window.clipAtLeast,
  death: ANIM_STATE_DEFS.death.window.clipAtLeast,
} as const

/** Mirrors combat.ts FLASH_TICKS (not exported there; sim is frozen for this
 * feature): `status.hitFlashUntil = hitTick + 3`. Lets the hurt state derive
 * its start tick purely from a field the RenderView already exposes. */
export const HURT_FLASH_TICKS = 3

/** The tick a hit landed, from `status.hitFlashUntil`. 0/absent is the
 * never-hit sentinel (status initializes to 0) — without it, ticks 0..8 would
 * boot every entity "hurt". */
export const hurtStart = (hitFlashUntil: number | undefined): number | undefined =>
  hitFlashUntil !== undefined && hitFlashUntil > 0 ? hitFlashUntil - HURT_FLASH_TICKS : undefined

// ---------------------------------------------------------------------------
// State resolution

/** The signals (all on the RenderView entity, or derived render-side from
 * observed changes — animTracker.ts) that drive state resolution. */
export interface AnimInputs {
  /** Current sim tick. */
  tick: number
  /** isMoving(vel) — drives walk vs idle. */
  moving: boolean
  /** Tick each one-shot started, as observed. Absent = not started. */
  starts?: Partial<Record<AnimStateName, number>>
  /** End tick of each `'sim'`-window state (roll: `playerCtl.roll.untilTick`). */
  simEnds?: Partial<Record<AnimStateName, number>>
  /** Length in ticks of the pose's OWN clip for each state whose window reads
   * it (CLIP_SIZED_STATES): frames × tpf. Absent or 0 = the pack does not draw
   * it. */
  clipTicks?: Partial<Record<AnimStateName, number>>
}

export interface ResolvedAnim {
  state: AnimStateName
  /** Tick the state began — one-shot clips index from here. Loop states use 0
   * (their cycle is a function of absolute tick + entity phase, not onset). */
  start: number
}

/** End tick (exclusive) of a one-shot that started at `start`, or undefined
 * when it cannot be active at all (a drawn-only state the pack does not draw,
 * a sim window with no end). */
export const onceEnd = (s: AnimStateName, start: number, a: AnimInputs): number | undefined => {
  const def: AnimStateDef = ANIM_STATE_DEFS[s]
  if (def.play === 'loop') return undefined
  if (def.window === 'sim') return a.simEnds?.[s]
  const len = a.clipTicks?.[s] ?? 0
  if (def.window === 'clip') return len > 0 ? start + len : undefined
  return start + Math.max(def.window.clipAtLeast, len)
}

export const resolveAnimState = (a: AnimInputs): ResolvedAnim => {
  for (const s of ANIM_PRIORITY) {
    const def = ANIM_STATE_DEFS[s]
    if (def.play === 'loop') {
      if (def.while === 'always' || a.moving) return { state: s, start: 0 }
      continue
    }
    const start = a.starts?.[s]
    if (start === undefined || a.tick < start) continue
    const end = onceEnd(s, start, a)
    if (end !== undefined && a.tick < end) return { state: s, start }
  }
  return { state: 'idle', start: 0 } // unreachable: idle is `always`
}

// ---------------------------------------------------------------------------
// Fidget timing — deterministic per entity, staggered across a crowd.

/** Fidget cadence, in sim ticks. A body must have been still and calm for
 * `stillTicks` before a fidget may start; fidgets then fall on a per-entity
 * grid whose period is `period + (hash(id) % jitter)` and whose phase is also
 * hashed from the id, so a pack of hounds never scratches in unison. `gap` is
 * the least stillness kept between two fidgets when a clip is long. */
export const FIDGET = { stillTicks: 90, period: 180, jitter: 150, gap: 30 } as const

/** murmur3's 32-bit finalizer: a well-mixed, deterministic hash of an id
 * (consecutive ids land far apart, unlike a plain multiple). */
const mixId = (id: number): number => {
  let x = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return x >>> 0
}

/** An entity's fidget grid: onsets are the ticks where (tick + phase) is a
 * multiple of period. The period never undercuts the clip, so two fidgets
 * cannot overlap. */
export const fidgetGrid = (id: number, clipTicks: number): { period: number; phase: number } => {
  const h = mixId(id)
  const period = Math.max(FIDGET.period + (h % FIDGET.jitter), clipTicks + FIDGET.gap)
  return { period, phase: (h >>> 8) % period }
}

/** Start tick of the fidget playing at `tick`, or undefined when none is.
 * `stillSince` is the tick the body last became still (animTracker.ts);
 * `clipTicks` the pose's own fidget clip length (0 = not drawn → never). Pure
 * in (id, tick, stillSince, clipTicks): no wall clock, no Math.random. */
export const fidgetStart = (
  id: number,
  tick: number,
  stillSince: number | undefined,
  clipTicks: number,
): number | undefined => {
  if (stillSince === undefined || clipTicks <= 0) return undefined
  const { period, phase } = fidgetGrid(id, clipTicks)
  const onset = tick - ((((tick + phase) % period) + period) % period)
  return onset - stillSince >= FIDGET.stillTicks && tick < onset + clipTicks ? onset : undefined
}

// ---------------------------------------------------------------------------
// Death derivation — scene continuity.
//
// Corpses are swept from the snapshot the SAME tick they die, and the one-tick
// `death` event is unreliable render-side (a slow frame can run 2+ sim ticks;
// the event list is cleared every tick). So death is DERIVED from observed
// change: a character view that vanished while the scene stayed CONTINUOUS
// died and becomes a ghost. A floor switch or restart (floor change, tick
// regression, or an implausibly large jump) is a scene cut — no ghosts.

/** Ticks the entity layer may skip and still count as continuous: hitstop
 * freezes the layer up to HITSTOP_MAX (6) frames while the sim runs on. */
export const MAX_TICK_SKIP = 6

export const sceneContinuous = (
  prevTick: number,
  prevFloor: number,
  tick: number,
  floor: number,
): boolean => prevTick >= 0 && floor === prevFloor && tick >= prevTick && tick - prevTick <= MAX_TICK_SKIP

// ---------------------------------------------------------------------------
// Clip resolution — per-state frame lists with fallback chains.

/** Frame lists per state (textures at runtime; anything in tests). */
export type AnimClips<T> = Partial<Record<AnimStateName, readonly T[]>>

/** Build the effective clip table from a pose's LEGACY two frames (idle/step)
 * plus any explicit per-state clips. Backward-compat contract: a theme with
 * only idle/step behaves exactly as today — walk = [idle, step] (or [idle]
 * when step is missing), idle = [idle]. Explicit new-grammar clips win. */
export const effectiveClips = <T>(
  base: { idle?: T; step?: T },
  clips: AnimClips<T> = {},
): AnimClips<T> => {
  const out: AnimClips<T> = { ...clips }
  if (!out.idle?.length && base.idle !== undefined) out.idle = [base.idle]
  if (!out.walk?.length) {
    if (base.idle !== undefined && base.step !== undefined) out.walk = [base.idle, base.step]
    else if (base.idle !== undefined) out.walk = [base.idle]
  }
  return out
}

export interface ResolvedClip<T> {
  /** The state whose frames are actually shown (=== requested unless borrowed). */
  source: AnimStateName
  frames: readonly T[]
}

/** The state itself, then what it borrows (ANIM_STATE_DEFS.borrows). A state
 * with no frames borrows the FIRST FRAME ONLY of the next state in its chain
 * that has any — a static stand-in pose; the procedural motion layer
 * (motion.ts) carries the action feel. docs/themes.md spells this out. */
export const fallbackChain = (state: AnimStateName): readonly AnimStateName[] => [
  state,
  ...ANIM_STATE_DEFS[state].borrows,
]

/** Walk the state's fallback chain over the clip table. Borrowed states yield
 * a single held frame (frame 0 of the donor); the state's own frames play in
 * full. Undefined = nothing anywhere (caller falls back to non-directional /
 * procedural art — only possible for a pose with no idle at all, or a
 * drawn-only state the pack does not draw, which never resolves anyway). */
export const resolveClip = <T>(clips: AnimClips<T>, state: AnimStateName): ResolvedClip<T> | undefined => {
  for (const s of fallbackChain(state)) {
    const frames = clips[s]
    if (frames && frames.length > 0) {
      return s === state ? { source: s, frames } : { source: s, frames: [frames[0]] }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Frame indexing — deterministic from tick + entity id.

/** Per-entity phase so a crowd doesn't animate in lockstep: a fixed prime
 * multiple of the id, folded into the loop period. Pure & deterministic. */
export const entityPhase = (id: number, period: number): number => {
  if (period <= 0) return 0
  const p = (id * 7919) % period
  return p < 0 ? p + period : p
}

/**
 * Which frame of a clip shows at `tick`.
 * - Loop states cycle `frames` at `tpf` ticks/frame, phase-shifted per entity.
 * - One-shots index from `start`, clamp to the last frame, and hold it there
 *   until the state window closes (never wrap, never go negative).
 */
export const animFrame = (
  state: AnimStateName,
  frames: number,
  tick: number,
  start: number,
  tpf: number,
  id: number,
): number => {
  if (frames <= 1) return 0
  const t = Math.max(1, Math.floor(tpf))
  if (isLoop(state)) {
    const period = frames * t
    const at = (((tick + entityPhase(id, period)) % period) + period) % period
    return Math.floor(at / t)
  }
  return Math.min(frames - 1, Math.floor(Math.max(0, tick - start) / t))
}

/** Does this state hide the held-weapon sprite while it plays? */
export const stowsWeapon = (s: AnimStateName): boolean => {
  const def: AnimStateDef = ANIM_STATE_DEFS[s]
  return def.play === 'once' && def.stowsWeapon === true
}

/** The drawn-only states: their window is their own clip (`window: 'clip'`). */
export const DRAWN_ONLY_STATES: readonly AnimStateName[] = ANIM_STATES.filter((s) => {
  const def: AnimStateDef = ANIM_STATE_DEFS[s]
  return def.play === 'once' && def.window === 'clip'
})

/** The states whose window reads the pose's own clip length (`'clip'` or
 * `{ clipAtLeast }`): the renderer measures frames × tpf for exactly these. */
export const CLIP_SIZED_STATES: readonly AnimStateName[] = ANIM_STATES.filter((s) => {
  const def: AnimStateDef = ANIM_STATE_DEFS[s]
  return def.play === 'once' && def.window !== 'sim'
})
