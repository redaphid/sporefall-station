import type { Entity } from './entity'
import { generateLevel } from './levelgen/generate'
import { isSolidTile, type Level } from './levelgen/level'
import { mulberry32, type Rng } from './rng'
import { aiSystem } from './systems/ai'
import { combatSystem } from './systems/combat'
import { elementSystem, fireSystem } from './systems/fire'
import { interactionSystem } from './systems/interaction'
import { missionSystem } from './systems/missions'
import { movementSystem } from './systems/movement'
import { projectileSystem } from './systems/projectiles'
import { statusSystem } from './systems/status'
import { statusFxSystem } from './systems/statusFx'
import type { Annotation, EntityId, InputCmd, SimEvent } from './types'

export interface MissionState {
  template: 'steal' | 'assassinate' | 'reach'
  targetEntityId?: EntityId
  targetBuilding?: number
  complete: boolean
  exitUnlocked: boolean
  description: string
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
  /** Active heard disturbances; NPCs investigate the nearest. */
  noises: Noise[]
  gameOver: boolean
  /** Difficulty rules for this run (see RunMode). */
  mode: RunMode
  /** Party-shared comebacks left this run; only consumed/gated in `normal`. */
  revivesLeft: number
  /** Inert on-screen annotations (labels/pins/arrows/circles/text) the render
   * overlay draws OVER the world. NO sim system reads or mutates this, so it never
   * touches determinism — it just serializes/replays with the world (see types.ts
   * `Annotation`). Default `[]`. */
  annotations: Annotation[]
}

export const createWorld = (seed: number, floor: number, mode: RunMode = 'normal'): World => {
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
      description: 'Reach the exit',
    },
    rng: baseRng.fork(`sim:${floor}`),
    baseRng,
    events: [],
    alarm: 0,
    noises: [],
    gameOver: false,
    mode,
    revivesLeft: REVIVES_PER_RUN,
    annotations: [],
  }
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
  movementSystem(w, inputs)
  combatSystem(w, inputs)
  projectileSystem(w)
  interactionSystem(w, inputs)
  fireSystem(w)
  elementSystem(w)
  statusSystem(w)
  statusFxSystem(w)
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
