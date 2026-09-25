// Stairs between storeys: the pure queries every layer shares
// (docs/design/stairs-and-storeys.md §1.1, §3.2).
//
// A storey is a function of position alone — the atlas lays storeys side by
// side in one Level grid (levelgen/level.ts STOREY_*). So the sim needs no
// storey field, the wire no storey bit, and the save no storey record: this
// module turns an x coordinate into a storey and a stair tile into a landing.
//
// The host's `stairSystem` (world.ts) and the client's prediction
// (app/netClient.ts stepSelf) call the SAME `stairStep`, so a predicted climb
// lands on the same tick as the authoritative one.

import { isSolidTile, STOREY_SIZE, STOREY_STRIDE, type Level, type StairLink } from './levelgen/level'

/** The atlas slot holding world x. Slot 0 is the ground storey. */
export const storeyOf = (x: number): number => Math.max(0, Math.floor(x / STOREY_STRIDE))

/** The storey height `z` of world x on this level (0 on single-storey floors). */
export const storeyZ = (level: Level, x: number): number => {
  if (!level.storeys) return 0
  const slot = storeyOf(x)
  return level.storeys.find((s) => s.slot === slot)?.z ?? 0
}

/** Do two world x coordinates sit on the same storey? */
export const sameStorey = (ax: number, bx: number): boolean => storeyOf(ax) === storeyOf(bx)

/** The tile rect of the storey containing world x — what the camera clamps to
 * and the tilemap shows. The whole level on a single-storey floor. */
export const storeyBounds = (level: Level, x: number): { x0: number; y0: number; w: number; h: number } => {
  if (!level.storeys) return { x0: 0, y0: 0, w: level.w, h: level.h }
  return { x0: storeyOf(x) * STOREY_STRIDE, y0: 0, w: STOREY_SIZE, h: level.h }
}

/** The link leaving from tile (tx, ty), if that tile is a stair. */
export const linkAt = (level: Level, tx: number, ty: number): StairLink | undefined => {
  const stairs = level.stairs
  if (!stairs) return undefined
  for (const l of stairs) if (l.from.x === tx && l.from.y === ty) return l
  return undefined
}

/** Is tile (tx, ty) a stair tile, or within the 3x3 around a landing (its
 * kept-clear approach)? A body anywhere in there after a climb stays "locked"
 * (see `stairStep`) — including when a body on the landing made it arrive on
 * the tile beside it. */
const inShaft = (level: Level, tx: number, ty: number): boolean => {
  for (const l of level.stairs ?? []) {
    if (l.from.x === tx && l.from.y === ty) return true
    if (Math.abs(l.landing.x - tx) <= 1 && Math.abs(l.landing.y - ty) <= 1) return true
  }
  return false
}

/**
 * Where a body at (x, y) goes if it takes a stair: the landing's tile centre
 * on the other storey, or null when (x, y) is not on a stair tile. Pure.
 */
export const stairTransit = (level: Level, x: number, y: number): { x: number; y: number; link: StairLink } | null => {
  const link = linkAt(level, Math.floor(x), Math.floor(y))
  if (!link) return null
  return { x: link.landing.x + 0.5, y: link.landing.y + 0.5, link }
}

/**
 * One stair tick for a body at (x, y). The shaft is the same tile on both
 * storeys, so a player still holding "forward" after arriving would walk
 * straight back onto the stair and bounce between storeys every few ticks.
 * `locked` is the hysteresis: set by a climb, it holds while the body stays on
 * the stair or within the 3x3 around its landing, and clears once it steps
 * clear of that — two tiles out. A locked body never transits. Pure — host and client prediction share it.
 */
export const stairStep = (
  level: Level,
  x: number,
  y: number,
  locked: boolean,
): { x: number; y: number; locked: boolean; link?: StairLink } => {
  if (!level.stairs) return { x, y, locked: false }
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  if (locked) return { x, y, locked: inShaft(level, tx, ty) }
  const t = stairTransit(level, x, y)
  if (!t) return { x, y, locked: false }
  return { x: t.x, y: t.y, locked: true, link: t.link }
}

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

/** Walkable neighbours of tile key `key` (ty*w+tx): the four orthogonal tiles
 * plus, on a stair tile, its landing on the other storey. */
export const linkedNeighbors = (level: Level, key: number): number[] => {
  const w = level.w
  const tx = key % w
  const ty = (key - tx) / w
  const out: number[] = []
  for (const [dx, dy] of ORTHO) if (!isSolidTile(level, tx + dx, ty + dy)) out.push((ty + dy) * w + tx + dx)
  const l = linkAt(level, tx, ty)
  if (l && !isSolidTile(level, l.landing.x, l.landing.y)) out.push(l.landing.y * w + l.landing.x)
  return out
}

/** Every tile reachable from `start` (a tile key) on foot, taking stairs. An
 * optional `blocked` treats extra tiles as solid (furniture, closed doors). */
export const floodLinked = (level: Level, start: number, blocked?: (key: number) => boolean): Uint8Array => {
  const seen = new Uint8Array(level.w * level.h)
  if (start < 0 || start >= seen.length) return seen
  const sx = start % level.w
  if (isSolidTile(level, sx, (start - sx) / level.w) || blocked?.(start)) return seen
  seen[start] = 1
  const stack = [start]
  while (stack.length > 0) {
    const k = stack.pop()!
    for (const n of linkedNeighbors(level, k)) {
      if (seen[n] || blocked?.(n)) continue
      seen[n] = 1
      stack.push(n)
    }
  }
  return seen
}

/**
 * The ground-storey stand-in for a point on another storey: the landing at the
 * foot of the stairs that lead up to it (followed down storey by storey). A
 * ground point comes back unchanged. What the station-alert broadcast calls out
 * when the intruder is upstairs — the hunt converges on the stairwell.
 */
export const groundAnchor = (level: Level, x: number, y: number): { x: number; y: number } => {
  let at = { x, y }
  for (let guard = 0; guard < 8 && level.stairs && storeyZ(level, at.x) !== 0; guard++) {
    const z = storeyZ(level, at.x)
    const slot = storeyOf(at.x)
    const down = level.stairs.find(
      (l) => storeyOf(l.from.x) === slot && Math.abs(storeyZ(level, l.landing.x)) < Math.abs(z),
    )
    if (!down) break
    at = { x: down.landing.x + 0.5, y: down.landing.y + 0.5 }
  }
  return at
}

/**
 * Re-express `target` on the viewer's storey: the same LOCAL position, moved
 * into the viewer's slot, plus how many storeys up (+) or down (-) it really
 * is. The locator points at this instead of into the gutter.
 */
export const onViewerStorey = (
  level: Level,
  viewerX: number,
  target: { x: number; y: number },
): { x: number; y: number; dz: number } => {
  if (!level.storeys) return { x: target.x, y: target.y, dz: 0 }
  const shift = (storeyOf(viewerX) - storeyOf(target.x)) * STOREY_STRIDE
  return { x: target.x + shift, y: target.y, dz: storeyZ(level, target.x) - storeyZ(level, viewerX) }
}

const reservedCache = new WeakMap<Level, { stairs: Level['stairs']; w: number; keys: ReadonlySet<number> }>()

/**
 * Tile keys (ty*w+tx) the stairs keep clear (§3.1 clearance): every stair
 * tile, and the 3x3 around every landing. Furniture, loot, mission props and
 * spawns never land here, so a climb always arrives on open deck and the way
 * to a stair is never plugged. Same pattern as `bunkerLaneKeys`. Empty on a
 * single-storey floor. Cached per Level (levels are immutable once built).
 */
export const stairReservedKeys = (level: Level): ReadonlySet<number> => {
  const hit = reservedCache.get(level)
  if (hit && hit.stairs === level.stairs && hit.w === level.w) return hit.keys
  const out = new Set<number>()
  for (const l of level.stairs ?? []) {
    out.add(l.from.y * level.w + l.from.x)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) out.add((l.landing.y + dy) * level.w + l.landing.x + dx)
  }
  reservedCache.set(level, { stairs: level.stairs, w: level.w, keys: out })
  return out
}

/** The camera clamp rect for a viewer at world x, in the CameraState field
 * names (ui/locatorModel): the viewer's storey on a multi-storey floor, the
 * whole level otherwise. */
export const cameraRect = (level: Level, viewerX: number): { levelW: number; levelH: number; levelX0: number; levelY0: number } => {
  const b = storeyBounds(level, viewerX)
  return { levelW: b.w, levelH: b.h, levelX0: b.x0, levelY0: b.y0 }
}

/** "▲1" / "▼2" for a storey offset; empty on the same storey. */
export const storeyBadge = (dz: number): string => (dz === 0 ? '' : `${dz > 0 ? '▲' : '▼'}${Math.abs(dz)}`)
