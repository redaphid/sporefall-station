// Pure helpers for GENERAL entity selection — the player tapping/clicking an
// entity to point it out. Selection is an inert per-entity flag (`Entity.selected`)
// that no sim system reads, so nothing here affects determinism; it just flips a
// boolean and serializes with the entity like any other component. An agent finds
// selected entities with a normal `entities`/`get` query. Picking is pure geometry
// (a world point → nearest entity), so it is fully unit-testable without a renderer.

import type { Entity } from './entity'
import type { EntityId } from './types'
import type { World } from './world'

/** Default tap-pick radius in world tiles. Characters draw on a feet-anchored
 * 48px canvas over 32px tiles, so the farthest visible pixel from the entity
 * centre is the top corner: √(0.75² + 1²) = 1.25 tiles. 1.4 keeps a finger-
 * friendly margin while staying tight enough that taps feel precise. */
export const PICK_RADIUS = 1.4

/** Smallest comfortable tap target in screen px (half-width): below this a
 * finger can't reliably hit an entity, so the WORLD radius grows to cover it. */
export const MIN_PICK_PX = 24

/**
 * Zoom-aware pick radius (world tiles) given the current screen scale in
 * px-per-tile. At normal/high zoom the sprite-derived PICK_RADIUS wins (taps on
 * the visible sprite always land); zoomed far OUT the sprite shrinks below a
 * finger, so the radius grows to keep MIN_PICK_PX of screen reach. Pure math —
 * callers pass `TILE_PX * zoom`. Degenerate scales fall back to PICK_RADIUS.
 */
export const pickRadiusAt = (pxPerTile: number): number =>
  Number.isFinite(pxPerTile) && pxPerTile > 0 ? Math.max(PICK_RADIUS, MIN_PICK_PX / pxPerTile) : PICK_RADIUS

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
