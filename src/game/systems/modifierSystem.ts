// The per-tick side of the floor modifiers (floorModifiers.ts holds the shape
// and the pure queries). Brownout needs no tick work: `goals.perceives` reads
// `sightMult` directly. Wading speed is read by movement via `wadeMult`.
//
// Determinism: tick arithmetic plus stateless streams forked from the run seed
// (`hunt:<floor>:<n>:<tick>`). Never `w.rng`, so a modifier floor's sim stream draws
// exactly what the same floor would draw clean.

import {
  HUNT_FIRST,
  HUNT_GAP,
  HUNT_RETRY,
  inFlood,
  rollFloorModifier,
  TIDE_FLOOD,
  TIDE_PERIOD,
  tideFlooded,
  type FloorModifierKind,
} from '../floorModifiers'
import { hashLabel, mulberry32 } from '../rng'
import type { World } from '../world'
import { findArrival, groupById, livePlayers, packSize, spawnPack } from './groups'
import { wet } from './interactions'

/** Tracker packs land this far (path-reachable tiles) from their prey: out of
 * the first glance, close enough that the pressure is real. */
export const HUNT_BAND: readonly [number, number] = [14, 20]

/** Put `kind` in force as if the floor had begun `age` ticks ago (the debug
 * verb uses the age to skip straight to a flood or a hunt), and announce it. */
export const startFloorModifier = (w: World, kind: FloorModifierKind, age = 0): void => {
  const since = w.tick - age
  w.modifier = { kind, since, ...(kind === 'hunted' ? { huntAt: since + HUNT_FIRST, hunts: 0 } : {}) }
  w.events.push({ type: 'floorModifier', kind })
}

/** Roll this floor's modifier and announce it. setupFloor calls it last. */
export const applyFloorModifier = (w: World): void => {
  w.modifier = undefined
  const kind = rollFloorModifier(w.seed, w.floor, w.level)
  if (kind) startFloorModifier(w, kind)
}

export const modifierSystem = (w: World): void => {
  const m = w.modifier
  if (!m || w.gameOver) return
  if (m.kind === 'bogTide') tide(w)
  else if (m.kind === 'hunted') hunt(w)
}

const tide = (w: World): void => {
  const m = w.modifier!
  const flooded = tideFlooded(m, w.tick)
  const age = w.tick - m.since
  if (age > 0 && age % TIDE_PERIOD === TIDE_PERIOD - TIDE_FLOOD) w.events.push({ type: 'tide', rising: true })
  else if (age > 0 && age % TIDE_PERIOD === 0) w.events.push({ type: 'tide', rising: false })
  if (!flooded) return
  for (const e of w.entities) {
    if (e.dead || !e.health || e.projectile || e.pickup) continue
    if (inFlood(w, e)) wet(w, e)
  }
}

const hunt = (w: World): void => {
  const m = w.modifier!
  if (m.packId !== undefined) {
    if (groupById(w, m.packId)) return // still on the hunt
    m.packId = undefined
    m.huntAt = w.tick + HUNT_GAP
    return
  }
  if (m.huntAt === undefined || w.tick < m.huntAt) return
  const players = livePlayers(w)
  const n = m.hunts ?? 0
  const r = mulberry32(hashLabel(w.seed >>> 0, `hunt:${w.floor}:${n}:${w.tick}`))
  const target = players.length > 0 ? players[r.int(0, players.length - 1)] : undefined
  const at = target ? findArrival(w, 'staging', target, r, HUNT_BAND) : null
  const g = target && at ? spawnPack(w, at, packSize(w.floor)) : null
  if (!target || !g) {
    m.huntAt = w.tick + HUNT_RETRY
    return
  }
  g.tracker = true
  g.targetId = target.id
  g.mark = { x: target.pos.x, y: target.pos.y }
  g.markAt = w.tick
  m.packId = g.id
  m.huntAt = undefined
  m.hunts = n + 1
  w.events.push({ type: 'huntersArrive', groupId: g.id, x: at!.x, y: at!.y, count: g.size, targetId: target.id })
}
