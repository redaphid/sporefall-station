/**
 * Wall-cap autotiling: where the lit top strip ("cap") of a wall goes.
 *
 * Wall sprites used to carry their cap baked along the NORTH edge, so every
 * wall tile drew it there regardless of its neighbours — a horizontal run read
 * fine, but a vertical run (or the inside of a thick wall mass) became a ladder
 * of grey dashes. Now the wall body is capless and the cap is a separate strip
 * (authored along the north edge) that the tilemap lays on EVERY edge of a
 * wall tile that faces open ground, rotated to that edge. The set of
 * wall/ground edges is closed, so the cap line runs continuously along runs,
 * around convex corners (two strips meet) and past T-junctions. The one place
 * a gap would open is a concave corner — wall to two sides, open diagonal —
 * where the two neighbours' strips stop a cap-width short of each other; an
 * `inner` nub fills it.
 *
 * Pure function of the tile grid (no pixi), so the rules are unit-testable and
 * every device bakes the same walls.
 */

import { isWallTile, WALL_CUT_OUTSIDE } from '../game/levelgen/level'
import type { OverlaySide } from './art'

export type CapCorner = 'nw' | 'ne' | 'se' | 'sw'

export interface WallCapPlan {
  /** Edges that face open ground and take the edge strip. */
  sides: OverlaySide[]
  /** Concave corners (both flanking sides wall, diagonal open) that take the nub. */
  inner: CapCorner[]
}

/** Clockwise quarter turns that carry the north-authored strip to each edge. */
export const CAP_QUARTER_TURNS: Readonly<Record<OverlaySide, number>> = { n: 0, e: 1, s: 2, w: 3 }
/** Clockwise quarter turns that carry the NW-authored nub to each corner. */
export const CORNER_QUARTER_TURNS: Readonly<Record<CapCorner, number>> = { nw: 0, ne: 1, se: 2, sw: 3 }

const SIDE_DELTA: Readonly<Record<OverlaySide, readonly [number, number]>> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
}
const CAP_SIDES: readonly OverlaySide[] = ['n', 'e', 's', 'w']
const CORNERS: readonly { c: CapCorner; a: OverlaySide; b: OverlaySide; dx: number; dy: number }[] = [
  { c: 'nw', a: 'n', b: 'w', dx: -1, dy: -1 },
  { c: 'ne', a: 'n', b: 'e', dx: 1, dy: -1 },
  { c: 'se', a: 's', b: 'e', dx: 1, dy: 1 },
  { c: 'sw', a: 's', b: 'w', dx: -1, dy: 1 },
]

/** The two edges a bevelled corner tile exposes. Their caps (and the one along
 * the 45° cut) are baked into the bevel's texture, clipped to the kept area, so
 * the tilemap must not lay full-width strips there. */
export const cutCapSides = (tileId: number): OverlaySide[] => {
  const cut = WALL_CUT_OUTSIDE[tileId]
  if (!cut) return []
  return [cut.dy < 0 ? 'n' : 's', cut.dx < 0 ? 'w' : 'e']
}

interface Grid {
  w: number
  h: number
  tiles: ArrayLike<number>
}

/** Off-map counts as wall: the void past the map edge gets no cap. */
const solidAt = (g: Grid, x: number, y: number): boolean =>
  x < 0 || y < 0 || x >= g.w || y >= g.h ? true : isWallTile(g.tiles[y * g.w + x])

/** Cap pieces for the wall tile at (tx,ty); undefined for non-wall tiles. */
export const planWallCaps = (g: Grid, tx: number, ty: number): WallCapPlan | undefined => {
  const t = g.tiles[ty * g.w + tx]
  if (!isWallTile(t)) return undefined
  const baked = cutCapSides(t)
  const sides = CAP_SIDES.filter((s) => {
    const [dx, dy] = SIDE_DELTA[s]
    return !baked.includes(s) && !solidAt(g, tx + dx, ty + dy)
  })
  const inner = CORNERS.filter(({ a, b, dx, dy }) => {
    const [adx, ady] = SIDE_DELTA[a]
    const [bdx, bdy] = SIDE_DELTA[b]
    return solidAt(g, tx + adx, ty + ady) && solidAt(g, tx + bdx, ty + bdy) && !solidAt(g, tx + dx, ty + dy)
  }).map(({ c }) => c)
  return { sides, inner }
}
