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

export type Dir = 'front' | 'side' | 'back'

/** Map a heading (radians; screen +x right, +y down) to a sprite facing and
 * whether to flip horizontally. Down → front (toward camera), up → back, and
 * left/right → the side sprite (flipped when heading left). */
export const facingDir = (facing: number): { dir: Dir; flip: boolean } => {
  const c = Math.cos(facing)
  const s = Math.sin(facing)
  if (Math.abs(s) >= Math.abs(c)) return { dir: s > 0 ? 'front' : 'back', flip: false }
  return { dir: 'side', flip: c < 0 }
}

const MOVE_EPS = 0.05

/** Is this entity walking (worth swapping to a step pose / bobbing)? */
export const isMoving = (vx: number, vy: number, threshold = MOVE_EPS): boolean =>
  Math.hypot(vx, vy) > threshold

/** Vertical bob for a walking character, in pixels. Zero at t=0, |bob| <= 1.5. */
export const walkBob = (t: number): number => Math.sin(t * 0.9) * 1.5

/** 0..1 pulse for a burning entity's ember glow (drives tint/scale lerp). */
export const burnPulse = (t: number): number => (Math.sin(t * 0.7) + 1) / 2
