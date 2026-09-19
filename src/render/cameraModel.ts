// The ONE definition of "where is the camera actually looking" — pure math,
// no pixi. Camera.apply (the real render transform) and the DOM overlay
// projections (ui/locatorModel: markers, edge arrows, tap-to-inspect) all call
// this, so a marker can never drift from the rendered world again. The soft
// edge clamp (overscan) lives HERE: history shows duplicating it is exactly how
// the mission marker ended up pointing at empty ground in map corners.

/** Fraction of the half-view the camera may run past a level edge, so a player
 * standing in a map corner is framed well inside the screen (clear of the HUD)
 * instead of pinned to the corner pixel. The strip beyond the edge renders as
 * the theme background. View-only; the sim never sees the camera. */
export const OVERSCAN_FRAC = 0.4

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * The camera centre actually applied to the world container for a nominal
 * (follow-target) centre `(x, y)`: soft-clamped to the level with OVERSCAN_FRAC
 * slack per axis, or locked to the level centre when the whole level fits on
 * screen. `T` is the tile size in screen px (TILE_PX * zoom).
 *
 * On a multi-storey floor the "level" is the viewer's STOREY rect, not the
 * whole atlas (stairs.ts `storeyBounds`): `x0`/`y0` are its origin, so the
 * camera never slides into the gutter or the storey next door.
 */
export const appliedCenter = (
  x: number,
  y: number,
  T: number,
  screenW: number,
  screenH: number,
  levelW: number,
  levelH: number,
  x0 = 0,
  y0 = 0,
): { x: number; y: number } => {
  const halfW = screenW / 2 / T
  const halfH = screenH / 2 / T
  const mX = halfW * OVERSCAN_FRAC
  const mY = halfH * OVERSCAN_FRAC
  return {
    x: levelW * T > screenW ? clamp(x, x0 + halfW - mX, x0 + levelW - halfW + mX) : x0 + levelW / 2,
    y: levelH * T > screenH ? clamp(y, y0 + halfH - mY, y0 + levelH - halfH + mY) : y0 + levelH / 2,
  }
}
