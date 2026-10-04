import { isLowTile } from '../game/floorModifiers'
import { STOREY_SIZE, type Level } from '../game/levelgen/level'

/**
 * Presentation for the floor modifiers. Pure (no pixi) so it is unit-testable;
 * the renderer only draws what these return.
 */

/** Tide water over the low ground, at full flood. */
export const TIDE_COLOR = 0x2f5b4b
export const TIDE_ALPHA = 0.6
/** Seconds for the water to rise or drain fully. */
export const TIDE_EASE_S = 1.5

/** Horizontal runs of ground-storey low tiles, so the water is a few dozen
 * rects rather than one per tile. */
export const lowTileRuns = (level: Level): { x: number; y: number; w: number }[] => {
  const runs: { x: number; y: number; w: number }[] = []
  const maxX = Math.min(level.w, STOREY_SIZE)
  for (let y = 0; y < level.h; y++) {
    let start = -1
    for (let x = 0; x <= maxX; x++) {
      const low = x < maxX && isLowTile(level.tiles[y * level.w + x])
      if (low && start < 0) start = x
      else if (!low && start >= 0) {
        runs.push({ x: start, y, w: x - start })
        start = -1
      }
    }
  }
  return runs
}

/** Ease the water level toward in/out; returns the new overlay alpha. */
export const easeTide = (alpha: number, flooded: boolean, dt: number): number => {
  const step = (TIDE_ALPHA * dt) / TIDE_EASE_S
  return flooded ? Math.min(TIDE_ALPHA, alpha + step) : Math.max(0, alpha - step)
}

/** Brownout: a lamp of clear sight round each player, falling off to dark. */
export const LAMP_INNER = 3
export const LAMP_OUTER = 6.5
export const BROWNOUT_ALPHA = 0.85
/** Darkness steps; tiles are grouped into runs of equal step. */
const STEPS = 6

/** Darkness alpha at `d` tiles from the nearest lamp, quantized to STEPS. */
export const lampDarkness = (d: number): number => {
  const t = Math.min(1, Math.max(0, (d - LAMP_INNER) / (LAMP_OUTER - LAMP_INNER)))
  return (Math.round(t * STEPS) / STEPS) * BROWNOUT_ALPHA
}

/** Row runs of equal darkness over the visible tile rect. `lamps` are world
 * positions. With no lamp (everyone down) the whole view is dark. */
export const darknessRuns = (
  view: { x: number; y: number; w: number; h: number },
  lamps: readonly { x: number; y: number }[],
): { x: number; y: number; w: number; alpha: number }[] => {
  const out: { x: number; y: number; w: number; alpha: number }[] = []
  const x0 = Math.floor(view.x)
  const y0 = Math.floor(view.y)
  const x1 = Math.ceil(view.x + view.w)
  const y1 = Math.ceil(view.y + view.h)
  for (let y = y0; y < y1; y++) {
    let runX = x0
    let runA = -1
    for (let x = x0; x <= x1; x++) {
      let a = -1
      if (x < x1) {
        let d = Infinity
        for (const l of lamps) d = Math.min(d, Math.hypot(x + 0.5 - l.x, y + 0.5 - l.y))
        a = lampDarkness(d)
      }
      if (a !== runA) {
        if (runA > 0) out.push({ x: runX, y, w: x - runX, alpha: runA })
        runX = x
        runA = a
      }
    }
  }
  return out
}
