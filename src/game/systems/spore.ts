// Bog spores — a spreading ground hazard, built on the SAME deterministic
// pattern as fire (systems/fire.ts): a spore is its own sim entity (kind 'fire',
// a non-colliding ground hazard) addressed by the cell it sits in, at most one
// per cell. Each spread tick it creeps to its orthogonal open-floor neighbors
// (crawling, not flashing), lays the `spore` element on any body standing in a
// spore cell, and burns its fuel down until it dies. The `spore` status then
// deals its damage-over-time generically via elementSystem, so a thing keeps
// choking after it walks clear of the cloud.
//
// Spores are seeded by two events: a BREACHED overgrown hatch rupturing its
// spore-sac (combat.detonate), and a `contain` mission's Spore Node BLOOMING
// when it isn't destroyed in time (systems/missions.ts). Growth is bounded: a
// child cell inherits LESS fuel than its parent and only a cell above the spread
// threshold can spawn more, so a burst blooms out to a fixed radius and stops.
// No randomness — spread walks entities in ascending id order over a fixed
// neighbor order, identical on every device and every replay.

import { ELEMENTS } from '../data/elements'
import { makeEntity, type Entity } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { addEntity, type World } from '../world'
import { addStatus } from './statusFx'

/** Ticks a freshly-seeded spore cell lasts at full fuel (~8s at 30tps). */
export const SPORE_FUEL = 240
/** Spores creep to a new neighbor every this-many ticks (a shade slower than fire). */
const SPORE_SPREAD_INTERVAL = 24
/** A child cell inherits this much less fuel than its parent — the growth brake. */
const SPORE_SPREAD_COST = 60
/** Only a cell with MORE fuel than this may seed neighbors, so a burst blooms to
 * a bounded radius (≈ (SPORE_FUEL - threshold) / SPORE_SPREAD_COST cells) then stops. */
const SPORE_SPREAD_THRESHOLD = 60

/** Fixed neighbor probe order — part of determinism, never reorder. */
const NEIGHBORS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** Is a spore cloud occupying this cell? */
export const sporeAt = (w: World, tx: number, ty: number): boolean => {
  for (const e of w.entities) {
    if (e.spore && !e.dead && Math.floor(e.pos.x) === tx && Math.floor(e.pos.y) === ty) return true
  }
  return false
}

/** Seed one spore cell. One per cell (occupied → no-op) and never on a wall. */
export const seedSpore = (w: World, tx: number, ty: number, fuel = SPORE_FUEL): Entity | undefined => {
  if (isSolidTile(w.level, tx, ty) || sporeAt(w, tx, ty)) return undefined
  const e = makeEntity('fire', 'spore', tx + 0.5, ty + 0.5, 0.4)
  e.spore = { fuel }
  return addEntity(w, e)
}

/** Rupture/bloom: seed a spore cloud at (tx,ty) plus its open neighbors, so a
 * burst reads as an instant gout the players must burn or flee, not one dot. */
export const spawnSporeBurst = (w: World, tx: number, ty: number, fuel = SPORE_FUEL): void => {
  seedSpore(w, tx, ty, fuel)
  for (const [dx, dy] of NEIGHBORS) seedSpore(w, tx + dx, ty + dy, fuel - SPORE_SPREAD_COST)
}

/** The spore lifecycle each tick: SPREAD to open neighbors, LAY the `spore`
 * element on bodies in a spore cell, then BURN DOWN and dissipate. */
export const sporeSystem = (w: World): void => {
  const spores = w.entities.filter((e) => e.spore && !e.dead)
  if (spores.length === 0) return

  if (w.tick % SPORE_SPREAD_INTERVAL === 0) {
    for (const s of spores) {
      if (s.spore!.fuel <= SPORE_SPREAD_THRESHOLD) continue
      const sx = Math.floor(s.pos.x)
      const sy = Math.floor(s.pos.y)
      for (const [dx, dy] of NEIGHBORS) seedSpore(w, sx + dx, sy + dy, s.spore!.fuel - SPORE_SPREAD_COST)
    }
  }

  for (const e of w.entities) {
    if (e.dead || !e.health || e.spore) continue
    if (!sporeAt(w, Math.floor(e.pos.x), Math.floor(e.pos.y))) continue
    addStatus(w, e, 'spore', ELEMENTS.spore.durationTicks)
  }

  for (const s of spores) {
    s.spore!.fuel -= 1
    if (s.spore!.fuel <= 0) s.dead = true
  }
}
