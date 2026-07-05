import type { Entity } from './entity'
import { generateLevel } from './levelgen/generate'
import { isSolidTile, type Level } from './levelgen/level'
import { mulberry32, type Rng } from './rng'
import { aiSystem } from './systems/ai'
import { combatSystem } from './systems/combat'
import { interactionSystem } from './systems/interaction'
import { movementSystem } from './systems/movement'
import { projectileSystem } from './systems/projectiles'
import { statusSystem } from './systems/status'
import type { EntityId, InputCmd, SimEvent } from './types'

export interface MissionState {
  template: 'steal' | 'assassinate' | 'reach'
  targetEntityId?: EntityId
  targetBuilding?: number
  complete: boolean
  exitUnlocked: boolean
  description: string
}

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
  /** Per-tick FX/net events; consumed after each tick. */
  events: SimEvent[]
  /** City heat 0..3 — cop aggro threshold. */
  alarm: number
}

export const createWorld = (seed: number, floor: number): World => ({
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
  rng: mulberry32(seed).fork(`sim:${floor}`),
  events: [],
  alarm: 0,
})

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
  for (const e of w.entities) {
    e.prevPos.x = e.pos.x
    e.prevPos.y = e.pos.y
  }
  aiSystem(w)
  movementSystem(w, inputs)
  combatSystem(w, inputs)
  projectileSystem(w)
  interactionSystem(w)
  statusSystem(w)
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
