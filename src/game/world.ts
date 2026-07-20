import type { Entity } from './entity'
import { generateLevel } from './levelgen/generate'
import { isSolidTile, type Level } from './levelgen/level'
import { mulberry32, type Rng } from './rng'
import { aiSystem } from './systems/ai'
import { combatSystem } from './systems/combat'
import { elementSystem, fireSystem } from './systems/fire'
import { sporeSystem } from './systems/spore'
import { interactionSystem } from './systems/interaction'
import { missionSystem } from './systems/missions'
import { movementSystem } from './systems/movement'
import { rollSystem } from './systems/roll'
import { projectileSystem } from './systems/projectiles'
import { regenSystem } from './systems/regen'
import { statusSystem } from './systems/status'
import { statusFxSystem } from './systems/statusFx'
import type { Annotation, EntityId, InputCmd, SimEvent } from './types'

export interface MissionState {
  /** `steal`/`assassinate`/`reach` are the classic objectives. Sporefall adds:
   *  `contain`    — destroy the Spore Node (targetEntityId) before it BLOOMS;
   *                 the bloom is a soft-fail (room floods with spores), never a loss.
   *  `infiltrate` — reach & eliminate a target sealed behind a biolock (open it by
   *                 keycard, power-cut, or breach). Completes on target death. */
  template: 'steal' | 'assassinate' | 'reach' | 'contain' | 'infiltrate'
  targetEntityId?: EntityId
  targetBuilding?: number
  complete: boolean
  exitUnlocked: boolean
  description: string
  /** `contain` only: absolute tick the Spore Node blooms if still alive. Optional
   * so every other mission serializes byte-for-byte as before. */
  bloomTick?: number
  /** `contain` only: the bloom already fired (soft-fail latched, room flooded). */
  bloomed?: boolean
  /** The door entity DIRECTLY guarding the objective (boss room / objective room)
   * — its nearest gateway, tagged at mission-gen (`door.objectiveGate`). Unlocking
   * it by ANY means turns the whole floor hostile (see missions.maybeTriggerBossAggro).
   * Optional so `reach` (no target building) and pre-feature snapshots omit it. */
  objectiveDoorId?: EntityId
  /** Latch: the boss-door aggro escalation has already fired (once per floor).
   * Optional/omitted-when-false so old snapshots round-trip byte-for-byte. */
  bossAggroTriggered?: boolean
}

/** A heard disturbance NPCs can investigate — a point that decays after a while. */
export interface Noise {
  x: number
  y: number
  /** Absolute tick at which it is forgotten. */
  expires: number
}

/** Ticks a noise lingers for NPCs to hear and investigate (~3s at 30tps). */
export const NOISE_TTL = 90

/**
 * Run difficulty. `casual` is the forgiving mode (endless self-revives, no
 * revive penalty) — meant for playing with a young kid. `normal` restores
 * stakes: a finite per-run revive economy and a comeback penalty (see
 * combat.kill / interaction.recover). The mode is a pure sim input threaded
 * from the host session and shipped to clients so co-op agrees on the rules.
 */
export type RunMode = 'casual' | 'normal'

/** Downs a `normal`-mode run can recover from before a down becomes fatal.
 * Shared across the party — a co-op run has one pool, not one per player. */
export const REVIVES_PER_RUN = 2

export interface World {
  tick: number
  seed: number
  floor: number
  level: Level
  entities: Entity[]
  byId: Map<EntityId, Entity>
  nextId: EntityId
  mission: MissionState
  /** Host-only sim randomness (AI dice, loot). Clients never draw from it. */
  rng: Rng
  /** Root PRNG for the run; per-floor sim streams fork from it. */
  baseRng: Rng
  /** Per-tick FX/net events; consumed after each tick. */
  events: SimEvent[]
  /** City heat 0..3 — cop aggro threshold. */
  alarm: number
  /** Per-wing power state: `powerCut[wing] === true` means that wing's grid is
   * down (a hacked generator/Cryo Terminal), which auto-unseals its `'power'`
   * biolocks and wakes its Derelict Units. A wing absent/false = powered (the
   * default — a fresh station is fully lit). Keyed by wing id. */
  powerCut: Record<string, boolean>
  /** Active heard disturbances; NPCs investigate the nearest. */
  noises: Noise[]
  gameOver: boolean
  /** Difficulty rules for this run (see RunMode). */
  mode: RunMode
  /** Party-shared comebacks left this run; only consumed/gated in `normal`. */
  revivesLeft: number
  /** Combat tunable: when true every NPC treats players as an enemy on sight and
   * engages regardless of faction disposition (the "make them all enemies" knob).
   * Default true; turn off for a peaceful/faction-only world. Sleeping, downed and
   * cloaked-guard exemptions still apply — this only sets the baseline stance. */
  hostile: boolean
  /** AI feature toggles. The shipped autonomy fixes — #62 goal hysteresis and
   * #63 NPC-vs-NPC targeting — are ON by default; a value is only needed to
   * FORCE a feature off for A/B measurement (the ai-sim harness / regression
   * tests), or to explicitly enable/disable the gated spore-infection feature
   * (#64), which otherwise follows the mission/floor gate. NOT serialized
   * (serialize.ts whitelists fields), so the release/replay path is
   * byte-identical whether or not this is present. */
  aiFlags?: {
    /** Incumbent-goal hysteresis/deadband in `decide` (#62, fixes #59 thrash).
     * Undefined → ON (shipped). `false` → the old zero-deadband behaviour. */
    hysteresis?: boolean
    /** `threat` scores any Hostile-disposition entity, not only players — the
     * autonomous faction/sworn-enemy matrix (#63). Undefined → ON (shipped).
     * `false` → the old players-only scan. */
    npcVsNpc?: boolean
    /** Spore contagion turns exposed crew into hostile Infected (#64). Undefined
     * → follow the mission/floor gate; `true`/`false` → force on/off. */
    infection?: boolean
  }
  /** Inert on-screen annotations (labels/pins/arrows/circles/text) the render
   * overlay draws OVER the world. NO sim system reads or mutates this, so it never
   * touches determinism — it just serializes/replays with the world (see types.ts
   * `Annotation`). Default `[]`. */
  annotations: Annotation[]
}

export const createWorld = (seed: number, floor: number, mode: RunMode = 'normal', hostile = true): World => {
  const baseRng = mulberry32(seed)
  return {
    tick: 0,
    seed,
    floor,
    level: generateLevel(seed, floor),
    entities: [],
    byId: new Map(),
    nextId: 1,
    mission: {
      template: 'reach',
      complete: true,
      exitUnlocked: true,
      description: 'Reach the Launch Bay',
    },
    rng: baseRng.fork(`sim:${floor}`),
    baseRng,
    events: [],
    alarm: 0,
    powerCut: {},
    noises: [],
    gameOver: false,
    mode,
    revivesLeft: REVIVES_PER_RUN,
    hostile,
    annotations: [],
  }
}

/** Is any wing's power currently cut? Robots (Derelict Units) turn hostile while
 * so (behaviors.ts) — the standing cost of the power-cut infiltration path. */
export const anyPowerCut = (w: World): boolean => {
  for (const k in w.powerCut) if (w.powerCut[k]) return true
  return false
}

/** Register a heard disturbance at a point; NPCs nearby will investigate it. */
export const emitNoise = (w: World, x: number, y: number, ttl = NOISE_TTL): void => {
  w.noises.push({ x, y, expires: w.tick + ttl })
}

export const addEntity = (w: World, e: Entity): Entity => {
  e.id = w.nextId++
  w.entities.push(e)
  w.byId.set(e.id, e)
  return e
}

/** Is a closed door standing on this tile? */
export const doorClosedAt = (w: World, tx: number, ty: number): boolean => {
  // Few doors per level — linear scan is fine until profiling says otherwise.
  for (const e of w.entities) {
    if (e.door && !e.door.open && !e.dead && Math.floor(e.pos.x) === tx && Math.floor(e.pos.y) === ty) {
      return true
    }
  }
  return false
}

/** Is this world tile blocked, considering walls and closed doors? */
export const isBlocked = (w: World, tx: number, ty: number): boolean =>
  isSolidTile(w.level, tx, ty) || doorClosedAt(w, tx, ty)

export const tickWorld = (w: World, inputs: Map<number, InputCmd>): void => {
  w.events.length = 0
  if (w.noises.length > 0) w.noises = w.noises.filter((n) => n.expires > w.tick)
  for (const e of w.entities) {
    e.prevPos.x = e.pos.x
    e.prevPos.y = e.pos.y
  }
  aiSystem(w)
  rollSystem(w, inputs)
  movementSystem(w, inputs)
  combatSystem(w, inputs)
  projectileSystem(w)
  interactionSystem(w, inputs)
  fireSystem(w)
  sporeSystem(w)
  elementSystem(w)
  statusSystem(w)
  statusFxSystem(w)
  // Regen runs LAST among the damage-aware systems: after every source that can
  // hurt a player this tick (so "hurt this tick" is final) and after movement (so
  // stillness reflects the settled position/velocity), before mission/sweep.
  regenSystem(w)
  missionSystem(w)
  sweepDead(w)
  w.tick++
}

const sweepDead = (w: World): void => {
  let removed = false
  for (const e of w.entities) {
    if (e.dead) {
      w.byId.delete(e.id)
      removed = true
    }
  }
  if (removed) {
    let j = 0
    for (let i = 0; i < w.entities.length; i++) {
      if (!w.entities[i].dead) w.entities[j++] = w.entities[i]
    }
    w.entities.length = j
  }
}
