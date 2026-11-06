/**
 * The wall slam's look (#173, comic C), as pure numbers: the sprite's squash
 * as a 2x2 matrix, how far the body reaches toward the wall, and the impact
 * burst and the dust puff as lists of whole-pixel blocks. sprites.ts draws
 * them; nothing here touches pixi, the sim or the clock.
 *
 * Every block sits on the world pixel grid and every frame is a whole tick, so
 * the burst reads as a three-colour sprite effect at any zoom, not a vector
 * glow, and two phones draw the same blocks at the same tick.
 */

import { SLAM } from './displayBody'

/** A sprite's linear map: x' = a x + c y, y' = b x + d y (pixi's Matrix). */
export interface Mat {
  a: number
  b: number
  c: number
  d: number
}

/** Share of a character texture the body fills, across and down: the drawn
 * frames are padded (a 96 px mutant is ~46 px wide), and the slam presses the
 * body's edge to the wall, not the canvas's. */
export const BODY_FILL = { w: 0.5, h: 0.9 } as const

/** The spun, flipped sprite squashed along the screen normal (nx, ny) by q
 * (the share of its depth along the normal it loses) and spread across it by
 * SLAM.spread x q. Squash is in world axes: a body lying on its side against
 * an east wall flattens left-right whatever its spin. */
export const squashMatrix = (rot: number, flip: boolean, q: number, nx: number, ny: number): Mat => {
  const sN = 1 - q
  const sP = 1 + SLAM.spread * q
  // W = sN n nT + sP p pT, p = n turned a quarter.
  const w11 = sN * nx * nx + sP * ny * ny
  const w12 = (sN - sP) * nx * ny
  const w22 = sN * ny * ny + sP * nx * nx
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  const f = flip ? -1 : 1
  // R F: the sprite's x axis (cs, sn) * f, its y axis (-sn, cs).
  const rx = cs * f
  const ry = sn * f
  return {
    a: w11 * rx + w12 * ry,
    b: w12 * rx + w22 * ry,
    c: w11 * -sn + w12 * cs,
    d: w12 * -sn + w22 * cs,
  }
}

/** How far the body reaches from its centre toward the wall at normal
 * (nx, ny), spun by rot, texture w x h px (screen px). */
export const reachToWall = (rot: number, w: number, h: number, nx: number, ny: number): number => {
  const hw = (w * BODY_FILL.w) / 2
  const hh = (h * BODY_FILL.h) / 2
  const cs = Math.abs(Math.cos(rot))
  const sn = Math.abs(Math.sin(rot))
  const ex = cs * hw + sn * hh
  const ey = sn * hw + cs * hh
  return Math.abs(nx) * ex + Math.abs(ny) * ey
}

/** One block of an effect: world px, top-left, whole pixels. */
export interface Block {
  x: number
  y: number
  w: number
  h: number
  color: number
  alpha: number
}

const WHITE = 0xfffbe8
const YELLOW = 0xffd23f
const ORANGE = 0xe8701a
const GRIT = 0x8a8478
const DUST = 0xb9b1a0

/** A deterministic 0..1 from a seed and a salt (the same murmur finaliser as
 * displayBody's). */
const unit = (seed: number, salt: number): number => {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ salt
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 0x100000000
}

/** The rays of the burst: unit directions fanned off the wall face (into the
 * room, the half the normal points to), jittered per body. */
const rays = (seed: number, nx: number, ny: number): { x: number; y: number; len: number }[] => {
  const base = Math.atan2(ny, nx)
  const out: { x: number; y: number; len: number }[] = []
  const n = 7
  for (let i = 0; i < n; i++) {
    const a = base + ((i / (n - 1)) * 2 - 1) * (Math.PI * 0.55) + (unit(seed, 10 + i) - 0.5) * 0.25
    out.push({ x: Math.cos(a), y: Math.sin(a), len: i % 2 === 0 ? 1 : 0.6 + 0.3 * unit(seed, 20 + i) })
  }
  return out
}

/** The impact burst `s` ticks after the hit, at world px (cx, cy) on the face,
 * the wall's normal (nx, ny). Empty outside 0 .. SLAM.burstTicks. Frame 0: a
 * white flash and short spikes; 1-2: long yellow-orange spikes; then the
 * spikes break into flying chips of grit and fade. */
export const burstBlocks = (s: number, seed: number, cx: number, cy: number, nx: number, ny: number): Block[] => {
  if (!(s >= 0) || s >= SLAM.burstTicks) return []
  const f = Math.floor(s)
  const X = Math.round(cx)
  const Y = Math.round(cy)
  const out: Block[] = []
  const px = (x: number, y: number, color: number, alpha = 1, size = 1): void => {
    out.push({ x: Math.round(x - size / 2), y: Math.round(y - size / 2), w: size, h: size, color, alpha })
  }
  if (f === 0) {
    px(X, Y, WHITE, 1, 4)
    for (const r of rays(seed, nx, ny)) for (let k = 2; k <= 2 + 3 * r.len; k++) px(X + r.x * k, Y + r.y * k, k < 4 ? WHITE : YELLOW)
    return out
  }
  if (f <= 2) {
    px(X, Y, f === 1 ? YELLOW : ORANGE, 1, f === 1 ? 3 : 2)
    for (const r of rays(seed, nx, ny)) {
      const from = 2 + f * 2
      const to = from + 4 * r.len + 1
      for (let k = from; k <= to; k++) px(X + r.x * k, Y + r.y * k, k < from + 2 ? YELLOW : ORANGE)
    }
  }
  // Chips of grit thrown off the face, from frame 1, falling a little.
  const fade = 1 - (f - 1) / (SLAM.burstTicks - 1)
  for (let i = 0; i < 5; i++) {
    const a = Math.atan2(ny, nx) + (unit(seed, 30 + i) - 0.5) * 2.2
    const sp = 3 + 2.5 * unit(seed, 40 + i)
    const d = sp * f
    px(X + Math.cos(a) * d, Y + Math.sin(a) * d + 0.5 * f * f, i % 2 === 0 ? GRIT : ORANGE, fade, i < 2 ? 2 : 1)
  }
  return out
}

/** The dust puff where the body comes to rest at the wall's foot, `s` ticks
 * after it reaches the floor, at world px (cx, cy) on the floor line. Empty
 * outside 0 .. SLAM.dustTicks. Small clumps roll out to both sides and rise. */
export const dustBlocks = (s: number, seed: number, cx: number, cy: number): Block[] => {
  if (!(s >= 0) || s >= SLAM.dustTicks) return []
  const f = Math.floor(s)
  const u = f / SLAM.dustTicks
  const out: Block[] = []
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const reach = (5 + 6 * unit(seed, 50 + i)) * Math.sqrt(u + 0.12)
    const size = i < 2 ? 3 : 2
    const x = Math.round(cx + side * reach - size / 2)
    const y = Math.round(cy - 1 - (2 + 3 * unit(seed, 60 + i)) * u - size / 2)
    out.push({ x, y, w: size, h: size, color: DUST, alpha: 0.75 * (1 - u) })
  }
  return out
}
