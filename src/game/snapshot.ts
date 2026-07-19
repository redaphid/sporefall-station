import type { Entity } from './entity'
import { isRolling } from './systems/roll'
import type { SimEvent } from './types'
import type { World } from './world'

/** Entity state bits shipped to clients (and used by render). */
export const SnapFlags = {
  Downed: 1 << 0,
  Sleeping: 1 << 1,
  Stunned: 1 << 2,
  DoorOpen: 1 << 3,
  HitFlash: 1 << 4,
  Cloaked: 1 << 5,
  Rolling: 1 << 6,
  /** Door archetype: the door is locked (drives the client's Unlock label,
   * lock art and pick-time inspect row — without it a joiner sees every
   * mission door as a plain openable door and the pick channel is invisible). */
  DoorLocked: 1 << 7,
} as const

export interface EntitySnap {
  id: number
  kind: string
  archetype: string
  x: number
  y: number
  facing: number
  hp?: number
  maxHp?: number
  flags: number
}

/**
 * The sim/net contract surface. M5's binary codec packs exactly this;
 * until then it feeds the local render path and tests.
 */
export interface Snapshot {
  tick: number
  entities: EntitySnap[]
  events: SimEvent[]
  alarm: number
}

export const snapEntity = (w: World, e: Entity): EntitySnap => {
  let flags = 0
  if (e.playerCtl?.downed) flags |= SnapFlags.Downed
  if (e.status) {
    if (e.status.sleep > 0) flags |= SnapFlags.Sleeping
    if (e.status.stun > 0) flags |= SnapFlags.Stunned
    if (e.status.hitFlashUntil > w.tick) flags |= SnapFlags.HitFlash
  }
  if (isRolling(e, w.tick)) flags |= SnapFlags.Rolling
  if (e.door?.open) flags |= SnapFlags.DoorOpen
  if (e.door?.locked) flags |= SnapFlags.DoorLocked
  return {
    id: e.id,
    kind: e.kind,
    archetype: e.archetype,
    x: e.pos.x,
    y: e.pos.y,
    facing: e.facing,
    hp: e.health?.hp,
    maxHp: e.health?.max,
    flags,
  }
}

export const buildSnapshot = (w: World): Snapshot => ({
  tick: w.tick,
  entities: w.entities.filter((e) => !e.dead).map((e) => snapEntity(w, e)),
  events: [...w.events],
  alarm: w.alarm,
})
