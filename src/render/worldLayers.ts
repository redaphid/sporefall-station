/**
 * The paint order of the world container, bottom-most first.
 *
 * Extracted as data — and pinned by `worldLayers.test.ts` — because this order
 * is load-bearing gameplay information that nothing else guards. `renderer.ts`
 * mounts pixi containers, so a reorder there typechecks, lints and passes the
 * whole suite while silently deleting a cue the player needs. Two of the
 * constraints, in particular, are not obvious from reading the mount site:
 *
 *   - `playerMarkers` ABOVE `entities`. The entity layer is y-sorted, so any
 *     prop standing one tile south of a player spans `foot-16 … foot+32` in
 *     world px — enough to swallow a ring (`ry ≈ 7.6px` about the foot) and its
 *     name entirely. Below `entities`, a downed teammate behind a desk shows no
 *     red ring, no X and no "P2 DOWN", and the revive cue is gone.
 *   - `playerMarkers` BELOW `statusFx`/`bullets`/`effects`, so the markers can
 *     never out-shout the things trying to kill you.
 */
export const WORLD_LAYER_ORDER = [
  'tilemap',
  'entities',
  'playerMarkers',
  'statusFx',
  'bullets',
  'effects',
  'reticle',
  'pick',
] as const

export type WorldLayerName = (typeof WORLD_LAYER_ORDER)[number]

/** Index of a layer in the paint order; `-1` if it is not mounted. */
export const layerDepth = (name: string): number => WORLD_LAYER_ORDER.indexOf(name as WorldLayerName)

/** Does `below` paint underneath `above`? Both must be mounted layers. */
export const paintsUnder = (below: string, above: string): boolean => {
  const b = layerDepth(below)
  const a = layerDepth(above)
  return b >= 0 && a >= 0 && b < a
}
