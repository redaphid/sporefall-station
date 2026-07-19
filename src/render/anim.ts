// View-only animation math. Every function here is a PURE function of the sim
// tick (or a continuous view-time t = tick + interpolation alpha) — it reads the
// deterministic sim, never writes it, so animation can never desync the game.
// Frame selection is integer-tick based (identical on every client); procedural
// juice (bob/pulse) uses continuous t only for smoothness on screen.

/** Looping frame index: advances one frame every `ticksPerFrame`, wraps at
 * `frames`. A single-frame clip holds on 0. */
export const cycleFrame = (tick: number, frames: number, ticksPerFrame: number): number =>
  frames <= 1 ? 0 : Math.floor(tick / ticksPerFrame) % frames

/** One-shot frame index for an effect started at `startTick`. Returns -1 before
 * it starts and once it has finished — the caller drops the sprite on -1. */
export const onceFrame = (
  tick: number,
  startTick: number,
  frames: number,
  ticksPerFrame: number,
): number => {
  const elapsed = tick - startTick
  if (elapsed < 0) return -1
  const idx = Math.floor(elapsed / ticksPerFrame)
  return idx >= frames ? -1 : idx
}

/** The five DRAWN character facings. West-side headings (w/sw/nw) reuse the
 * east-side art (e/se/ne) mirrored horizontally, so artists draw five sprites
 * per pose, not eight. Sprite files are named `<kind>-<dir>-<frame>` with
 * dir ∈ {s,se,e,ne,n} and frame ∈ {idle,step}. */
export type Dir = 's' | 'se' | 'e' | 'ne' | 'n'

/** All eight compass headings an entity can face on screen. */
export type Facing8 = 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'n' | 'ne'

/** Compass order matching heading sectors: index k covers headings within
 * ±22.5° of k·45°, in screen coords (+x right → east, +y down → south). */
const SECTORS: readonly Facing8[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne']

const TAU = Math.PI * 2

/** Snap a heading (radians; screen +x right, +y down) to one of the eight
 * compass facings. Sector boundaries sit at 22.5° offsets so the diagonals get
 * full 45° sectors. Boundary headings (exactly 22.5° past a sector centre)
 * round forward (ccw→cw order): 22.5° → 'se'. Non-finite headings read south
 * (toward the camera) — the neutral "idle" facing. */
export const facing8 = (facing: number): Facing8 => {
  if (!Number.isFinite(facing)) return 's'
  const a = ((facing % TAU) + TAU) % TAU // normalize to [0, 2π)
  return SECTORS[Math.round(a / (Math.PI / 4)) % 8]
}

/** Which drawn sprite renders each compass facing, and whether it mirrors. */
const DRAWN: Record<Facing8, { dir: Dir; flip: boolean }> = {
  e: { dir: 'e', flip: false },
  se: { dir: 'se', flip: false },
  s: { dir: 's', flip: false },
  sw: { dir: 'se', flip: true },
  w: { dir: 'e', flip: true },
  nw: { dir: 'ne', flip: true },
  n: { dir: 'n', flip: false },
  ne: { dir: 'ne', flip: false },
}

/** Map a heading (radians; screen +x right, +y down) to the drawn sprite facing
 * and whether to flip horizontally: 8 compass sectors rendered from 5 drawn
 * directions, with the west half mirrored from the east half. */
export const facingDir = (facing: number): { dir: Dir; flip: boolean } => DRAWN[facing8(facing)]

/** Character sprites anchor bottom-centre at the entity's FEET, half a tile
 * below the entity centre (the entity stands on the lower half of its tile). */
export const CHAR_FOOT_OFFSET = 0.5

/** World-pixel y of a character's feet — the sprite's bottom-centre anchor.
 * Deliberately independent of the sprite canvas size: growing the canvas makes
 * the character taller ABOVE its feet (overlapping the tile behind it), never
 * sinks it into the ground. */
export const charFootPx = (yTiles: number, tilePx: number): number => (yTiles + CHAR_FOOT_OFFSET) * tilePx

/** Vertical world-pixel span [top, bottom] of a feet-anchored sprite. The
 * bottom is canvas-size-invariant; only the top moves when the canvas grows. */
export const charSpriteBounds = (
  yTiles: number,
  tilePx: number,
  canvasPx: number,
): { top: number; bottom: number } => {
  const bottom = charFootPx(yTiles, tilePx)
  return { top: bottom - canvasPx, bottom }
}

/** Depth key for the y-sorted entity layer. Every grounded entity sorts by its
 * world y (equivalently its sprite bottom — all sprites share the same +0.5
 * foot offset, so relative order is identical); flames float above everything
 * they consume. Bigger key draws in front. */
export const depthKey = (kind: string, yTiles: number): number => (kind === 'fire' ? yTiles + 1000 : yTiles)

const MOVE_EPS = 0.05

/** Is this entity walking (worth swapping to a step pose / bobbing)? */
export const isMoving = (vx: number, vy: number, threshold = MOVE_EPS): boolean =>
  Math.hypot(vx, vy) > threshold

/** Vertical bob for a walking character, in pixels. Zero at t=0, |bob| <= 1.5. */
export const walkBob = (t: number): number => Math.sin(t * 0.9) * 1.5

/** 0..1 pulse for a burning entity's ember glow (drives tint/scale lerp). */
export const burnPulse = (t: number): number => (Math.sin(t * 0.7) + 1) / 2
