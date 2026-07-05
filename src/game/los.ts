import type { Level } from './levelgen/level'
import { isSolidTile } from './levelgen/level'

/**
 * Tile-grid line of sight: Bresenham from (x0,y0) to (x1,y1) in world coords.
 * Walls block; closed doors are checked by the caller via blockedExtra.
 */
export const hasLineOfSight = (
  level: Level,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  blockedExtra?: (tx: number, ty: number) => boolean,
): boolean => {
  let tx = Math.floor(x0)
  let ty = Math.floor(y0)
  const ex = Math.floor(x1)
  const ey = Math.floor(y1)
  const dx = Math.abs(ex - tx)
  const dy = Math.abs(ey - ty)
  const sx = tx < ex ? 1 : -1
  const sy = ty < ey ? 1 : -1
  let err = dx - dy
  for (let guard = 0; guard < 256; guard++) {
    if (tx === ex && ty === ey) return true
    if ((tx !== Math.floor(x0) || ty !== Math.floor(y0)) && (isSolidTile(level, tx, ty) || blockedExtra?.(tx, ty))) {
      return false
    }
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      tx += sx
    }
    if (e2 < dx) {
      err += dx
      ty += sy
    }
  }
  return false
}
