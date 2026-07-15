// Pure helpers for GENERAL entity selection — the player tapping/clicking an
// entity to point it out. Selection is an inert per-entity flag (`Entity.selected`)
// that no sim system reads, so nothing here affects determinism; it just flips a
// boolean and serializes with the entity like any other component. An agent finds
// selected entities with a normal `entities`/`get` query. Picking is pure geometry
// (a world point → nearest entity), so it is fully unit-testable without a renderer.

import type { Entity } from './entity'
import type { EntityId } from './types'
import type { World } from './world'

/**
 * Nearest non-dead entity whose centre is within `maxRadius` world tiles of
 * (wx,wy), or undefined if none. Ties break by smaller distance, then smaller id,
 * so a tap on overlapping sprites is deterministic. `filter` optionally restricts
 * the candidates (e.g. skip projectiles/fire so a tap lands on the actor).
 */
export const pickNearestEntity = (
  entities: readonly Entity[],
  wx: number,
  wy: number,
  maxRadius: number,
  filter?: (e: Entity) => boolean,
): Entity | undefined => {
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return undefined
  let best: Entity | undefined
  let bestD2 = maxRadius * maxRadius
  for (const e of entities) {
    if (e.dead) continue
    if (filter && !filter(e)) continue
    const dx = e.pos.x - wx
    const dy = e.pos.y - wy
    const d2 = dx * dx + dy * dy
    if (d2 > bestD2) continue
    if (best === undefined || d2 < bestD2 || (d2 === bestD2 && e.id < best.id)) {
      best = e
      bestD2 = d2
    }
  }
  return best
}

/** Set/clear the selection flag on one entity (keeps the entity JSON clean by
 * deleting the flag rather than storing `false`). */
export const setSelected = (e: Entity, on: boolean): void => {
  if (on) e.selected = true
  else delete e.selected
}

/** Toggle selection on the entity with `id`; returns the new state (or undefined
 * if there is no such entity). */
export const toggleSelected = (w: World, id: EntityId): boolean | undefined => {
  const e = w.byId.get(id)
  if (!e) return undefined
  const next = !e.selected
  setSelected(e, next)
  return next
}

/** Clear the selection flag from every entity; returns how many were cleared.
 * Takes the entity list (not the whole World) so the UI overlay can call it with a
 * `RenderView`'s live entities too. */
export const clearSelection = (entities: readonly Entity[]): number => {
  let n = 0
  for (const e of entities)
    if (e.selected) {
      delete e.selected
      n++
    }
  return n
}

/** Every currently-selected entity (multi-select). */
export const selectedEntities = (entities: readonly Entity[]): Entity[] => entities.filter((e) => e.selected)
