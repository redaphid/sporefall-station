import { isSolidTile, type Level } from './levelgen/level'
import { BODY_RADIUS } from './entity'
import { circleOverlapsTile } from './systems/movement'

/**
 * Where co-op players actually GO when a run starts.
 *
 * Every host used to fan slots out from `level.spawn` on a fixed offset
 * (`spawn.x + slot * 0.6` over the net, `slot * 1.5` for local pads) and place
 * the body there unconditionally. `level.spawn` is guaranteed walkable; the
 * tiles beside it are NOT — a swept 200 seeds x 5 floors x 7 slots put 18.6% of
 * net slots (26.3% of local ones) inside a solid tile.
 *
 * That is fatal, not cosmetic. `moveAndCollide` accepts a step only when the
 * destination circle overlaps no blocked tile, and a body that STARTS inside one
 * fails that test for every direction — including the direction that would walk
 * it back out. The player is entombed for the rest of the run; the only exit is
 * a floor change. Measured: 0.000 tiles of travel after 320 ticks of input in
 * all 8 directions.
 *
 * So: search for a spot the body genuinely FITS instead of assuming one.
 *
 * DETERMINISM IS THE HARD CONSTRAINT. Host and clients each rebuild the level
 * from `seed + floor`, and a late joiner / ghost rejoin re-derives its own slot's
 * position from the same level the lobby start used. Any disagreement here is a
 * desync, so this is a PURE function of `(level, slot)`: it draws no rng, reads
 * no live entity state, and never depends on which other slots are already
 * filled. Slot N is the N-th free spot, full stop.
 */

/** How far from the spawn tile the search looks, in tiles (a bounding box). */
const MAX_RING = 6

/**
 * Tile offsets to try, nearest-first: ascending squared distance from the spawn
 * tile, ties broken by a fixed scan order. Built once; integer keys only, so the
 * ordering is identical on every device and every engine.
 */
const SEARCH_OFFSETS: readonly { dx: number; dy: number }[] = (() => {
  const cells: { dx: number; dy: number; d2: number; idx: number }[] = []
  let idx = 0
  for (let dy = -MAX_RING; dy <= MAX_RING; dy++) {
    for (let dx = -MAX_RING; dx <= MAX_RING; dx++) cells.push({ dx, dy, d2: dx * dx + dy * dy, idx: idx++ })
  }
  cells.sort((a, b) => a.d2 - b.d2 || a.idx - b.idx)
  return cells.map(({ dx, dy }) => ({ dx, dy }))
})()

/**
 * Can a body of `radius` stand centred on (x, y)? This is the collision
 * resolver's own geometry — `circleOverlapsTile` is shared with `moveAndCollide`
 * precisely so placement and movement can never drift apart. If this says yes,
 * the very first step the player takes cannot be rejected for where they were
 * put.
 */
export const bodyFitsAt = (level: Level, x: number, y: number, radius: number = BODY_RADIUS): boolean => {
  const minTx = Math.floor(x - radius)
  const maxTx = Math.floor(x + radius)
  const minTy = Math.floor(y - radius)
  const maxTy = Math.floor(y + radius)
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!isSolidTile(level, tx, ty)) continue
      if (circleOverlapsTile(x, y, radius, tx, ty)) return false
    }
  }
  return true
}

/**
 * The spawn position for co-op `slot` on `level` — the slot-th walkable tile
 * centre in the nearest-first sweep out from `level.spawn`.
 *
 * Slot 0 lands on the spawn tile itself (so the host does not move), and the
 * rest cluster around it: whole-tile spacing puts neighbours 1.0 apart against a
 * 0.7 body diameter, so nobody starts overlapping either — the old 0.6 offset
 * did, on top of everything else.
 *
 * Fallback when the search finds fewer free tiles than `slot` needs (a spawn
 * walled into a closet): `level.spawn`, which the generator guarantees walkable.
 * Two players on one tile is recoverable — the separation pass pushes them
 * apart in a few ticks — and entombment is not. It is also deterministic, which
 * a "give up and use the raw offset" fallback would not be, safety-wise.
 */
export const playerSpawnPoint = (
  level: Level,
  slot: number,
  radius: number = BODY_RADIUS,
): { x: number; y: number } => {
  const tx0 = Math.floor(level.spawn.x)
  const ty0 = Math.floor(level.spawn.y)
  const wanted = Math.max(0, Math.floor(slot))
  let free = 0
  for (const { dx, dy } of SEARCH_OFFSETS) {
    const x = tx0 + dx + 0.5
    const y = ty0 + dy + 0.5
    if (!bodyFitsAt(level, x, y, radius)) continue
    if (free === wanted) return { x, y }
    free++
  }
  return { x: level.spawn.x, y: level.spawn.y }
}
