// Fire — the first element, end to end. A fire is a grid-cell hazard: its own
// sim entity (kind 'fire') addressed by the cell it sits in, at most one per
// cell. Each tick a fire licks at its four orthogonal neighbors and ignites any
// flammable object standing there (spread), sets `burning` on flammable things
// in its own cell, and burns its fuel down until it gutters out. The `burning`
// status then deals its damage-over-time generically via elementSystem, so a
// thing keeps burning after it walks out of the flames. Re-expressed from
// observed Streets of Rogue behavior, not ported. Deterministic: spread follows
// object positions in ascending entity-id order, no randomness.

import { ELEMENTS } from '../data/elements'
import { makeEntity, type Entity } from '../entity'
import { addEntity, type World } from '../world'
import { kill } from './combat'
import { addStatus } from './statusFx'

/** Ticks a freshly-lit cell burns before guttering out (~12s at 30tps). */
const FUEL = 360

/** Fire creeps to a new neighbor every this-many ticks, not every frame — so
 * you watch it crawl down a row rather than flash across it. */
const SPREAD_INTERVAL = 18

/** Fixed neighbor probe order — part of determinism, never reorder. */
const NEIGHBORS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** Is any fire burning in this cell? */
export const fireAt = (w: World, tx: number, ty: number): boolean => {
  for (const e of w.entities) {
    if (e.fire && !e.dead && Math.floor(e.pos.x) === tx && Math.floor(e.pos.y) === ty) return true
  }
  return false
}

/** Light a cell. One fire per cell — an occupied cell is a no-op. */
export const igniteCell = (w: World, tx: number, ty: number): Entity | undefined => {
  if (fireAt(w, tx, ty)) return undefined
  const e = makeEntity('fire', 'fire', tx + 0.5, ty + 0.5, 0.4)
  e.fire = { fuel: FUEL }
  return addEntity(w, e)
}

/** Light the cell an entity stands in (molotov splash, debug ignite). */
export const ignite = (w: World, target: Entity): Entity | undefined =>
  igniteCell(w, Math.floor(target.pos.x), Math.floor(target.pos.y))

/** The fire lifecycle each tick: SPREAD to flammable neighbors, IGNITE
 * flammable things in a burning cell, then BURN DOWN and extinguish. Fires lit
 * by spread this tick only probe their own neighbors next tick. */
export const fireSystem = (w: World): void => {
  const fires = w.entities.filter((e) => e.fire && !e.dead)
  const flammables = w.entities.filter((e) => e.flammable && !e.dead)

  if (w.tick % SPREAD_INTERVAL === 0) {
    for (const f of fires) {
      const fx = Math.floor(f.pos.x)
      const fy = Math.floor(f.pos.y)
      for (const t of flammables) {
        const tx = Math.floor(t.pos.x)
        const ty = Math.floor(t.pos.y)
        if (!NEIGHBORS.some(([dx, dy]) => fx + dx === tx && fy + dy === ty)) continue
        igniteCell(w, tx, ty)
      }
    }
  }

  for (const t of flammables) {
    if (!fireAt(w, Math.floor(t.pos.x), Math.floor(t.pos.y))) continue
    addStatus(w, t, 'burning', ELEMENTS.burning.durationTicks)
  }

  for (const f of fires) {
    f.fire!.fuel -= 1
    if (f.fire!.fuel <= 0) f.dead = true
  }
}

/** Generic per-tick element effects: any entity carrying an element with a
 * `dot` loses that hp each tick. Data-driven off ELEMENTS, so poisoned/etc.
 * light up for free once their behavior lands. */
export const elementSystem = (w: World): void => {
  for (const e of w.entities) {
    if (e.dead || !e.fx || !e.health) continue
    if (e.playerCtl?.downed) continue // a downed body is out of the fight — DOT can't re-kill it (#52)
    for (const kind of Object.keys(e.fx)) {
      const def = ELEMENTS[kind]
      if (!def || def.dot <= 0) continue
      if (w.tick % def.interval !== 0) continue
      e.health.hp -= def.dot
      w.events.push({ type: 'hit', x: e.pos.x, y: e.pos.y, targetId: e.id, amount: def.dot })
      if (e.health.hp <= 0) {
        kill(w, e)
        break
      }
    }
  }
}
