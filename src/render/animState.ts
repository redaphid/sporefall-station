/**
 * Character animation STATES — the pure logic layer under the sprite animator.
 *
 * Layer 1 of the animation system (docs/themes.md "Animation states"): named
 * states with variable frame counts and per-state cadence, resolved from sim
 * state the renderer already sees. Everything here is a pure function of the
 * integer sim tick + entity id (+ constants), so frame selection is
 * deterministic on every device and replay — no wall clock, no Math.random.
 * The procedural motion layer (motion.ts) composes on top.
 */

// ---------------------------------------------------------------------------
// The state graph

/** Every named animation state a character can be in. */
export type AnimStateName = 'idle' | 'walk' | 'attack' | 'hurt' | 'roll' | 'death'
export const ANIM_STATES: readonly AnimStateName[] = ['idle', 'walk', 'attack', 'hurt', 'roll', 'death']

/** Frames per state are indexed 0..MAX_ANIM_FRAMES-1 (manifest key grammar
 * `char.<kind>.<dir>-<state>-<n>`). Contiguous from 0; a gap ends the clip. */
export const MAX_ANIM_FRAMES = 8

/** States that LOOP (cycle forever while active). Everything else is a
 * one-shot: it plays once from the state's start tick and holds its last
 * frame until the state window ends. */
export const LOOP_STATES: ReadonlySet<AnimStateName> = new Set(['idle', 'walk'])

/** Default cadence per state, in sim ticks per frame (30 ticks = 1s). A theme
 * overrides per state via the manifest `anim` section (validated 1..30). */
export const DEFAULT_TPF: Record<AnimStateName, number> = {
  idle: 12,
  walk: 6, // matches the legacy 2-frame walk cadence (WALK_TPF)
  attack: 2,
  hurt: 3,
  roll: 3,
  death: 5,
}

/** Fixed window (sim ticks) each one-shot state stays active once triggered.
 * Roll is absent deliberately: its window is the sim's own roll window
 * (`playerCtl.roll.untilTick`), never a render-side guess. */
export const STATE_TICKS = { attack: 6, hurt: 8, death: 18 } as const

/** Mirrors combat.ts FLASH_TICKS (not exported there; sim is frozen for this
 * feature): `status.hitFlashUntil = hitTick + 3`. Lets the hurt state derive
 * its start tick purely from a field the RenderView already exposes. */
export const HURT_FLASH_TICKS = 3

// ---------------------------------------------------------------------------
// State resolution — priority: death > roll > hurt > attack > walk > idle.
//
// Rationale for the order: death is terminal and must never be pre-empted;
// a roll is a whole-body committed tumble (and the sim's i-frames make a
// mid-roll hurt impossible anyway); a hurt flinch reads as more urgent than
// the attack that may have caused it ("hurt while attacking" shows the hurt);
// attack beats locomotion so firing on the run still snaps the pose.

/** The sim signals (all already on the RenderView entity, or derived
 * render-side from observed changes) that drive state resolution. */
export interface AnimInputs {
  /** Current sim tick. */
  tick: number
  /** isMoving(vel) — drives walk vs idle. */
  moving: boolean
  /** `playerCtl.roll.untilTick` while tick < untilTick (i.e. actively rolling). */
  rollUntil?: number
  /** Tick the roll began: `untilTick - ROLL_TICKS` (the caller owns the sim
   * constant so this module stays free of sim imports). */
  rollStart?: number
  /** `status.hitFlashUntil` verbatim (0/absent = never hit). */
  hitFlashUntil?: number
  /** Render-derived: tick the last attack started (combat.cooldown observed
   * jumping UP between frames — the sim only ever decrements it). */
  attackStart?: number
  /** Render-derived: tick a death ghost began (the entity left the snapshot
   * with a `death` event naming it — corpses are swept the same tick). */
  deathStart?: number
}

export interface ResolvedAnim {
  state: AnimStateName
  /** Tick the state began — one-shot clips index from here. Loop states use 0
   * (their cycle is a function of absolute tick + entity phase, not onset). */
  start: number
}

export const resolveAnimState = (a: AnimInputs): ResolvedAnim => {
  if (a.deathStart !== undefined && a.tick < a.deathStart + STATE_TICKS.death) {
    return { state: 'death', start: a.deathStart }
  }
  if (a.rollUntil !== undefined && a.tick < a.rollUntil) {
    return { state: 'roll', start: a.rollStart ?? a.rollUntil }
  }
  // hitFlashUntil === 0 is the never-hit sentinel (status initializes to 0) —
  // without the > 0 guard, ticks 0..HURT tail would boot every entity "hurt".
  if (a.hitFlashUntil !== undefined && a.hitFlashUntil > 0) {
    const hurtStart = a.hitFlashUntil - HURT_FLASH_TICKS
    if (a.tick >= hurtStart && a.tick < hurtStart + STATE_TICKS.hurt) {
      return { state: 'hurt', start: hurtStart }
    }
  }
  if (a.attackStart !== undefined && a.tick >= a.attackStart && a.tick < a.attackStart + STATE_TICKS.attack) {
    return { state: 'attack', start: a.attackStart }
  }
  return a.moving ? { state: 'walk', start: 0 } : { state: 'idle', start: 0 }
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

/** Per-state fallback order (first entry is the state itself). A state with no
 * frames borrows the FIRST FRAME ONLY of the next state in its chain that has
 * any — a static stand-in pose; the procedural motion layer (motion.ts)
 * carries the action feel. docs/themes.md spells this out for theme authors. */
export const STATE_FALLBACK: Record<AnimStateName, readonly AnimStateName[]> = {
  idle: ['idle'],
  walk: ['walk', 'idle'],
  attack: ['attack', 'walk', 'idle'],
  hurt: ['hurt', 'idle'],
  roll: ['roll', 'walk', 'idle'],
  death: ['death', 'hurt', 'idle'],
}

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

/** Walk the state's fallback chain over the clip table. Borrowed states yield
 * a single held frame (frame 0 of the donor); the state's own frames play in
 * full. Undefined = nothing anywhere (caller falls back to non-directional /
 * procedural art — only possible for a pose with no idle at all). */
export const resolveClip = <T>(clips: AnimClips<T>, state: AnimStateName): ResolvedClip<T> | undefined => {
  for (const s of STATE_FALLBACK[state]) {
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
  if (LOOP_STATES.has(state)) {
    const period = frames * t
    const at = (((tick + entityPhase(id, period)) % period) + period) % period
    return Math.floor(at / t)
  }
  return Math.min(frames - 1, Math.floor(Math.max(0, tick - start) / t))
}
