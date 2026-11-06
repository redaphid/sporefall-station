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
 * (nx, ny), spun by rot, texture w x h px (screen px). The body is an ellipse
 * inside the canvas, not the canvas: a box's corner would hold a half-tipped
 * body a hand's width off the face. */
export const reachToWall = (rot: number, w: number, h: number, nx: number, ny: number): number => {
  const hw = (w * BODY_FILL.w) / 2
  const hh = (h * BODY_FILL.h) / 2
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  // Support of the spun ellipse along the unit direction (nx, ny).
  const u = nx * cs + ny * sn
  const v = -nx * sn + ny * cs
  return Math.hypot(hw * u, hh * v) / Math.max(1e-9, Math.hypot(nx, ny))
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
const DUST = 0x8f8068
const DUST_LIT = 0xb3a283

/** A deterministic 0..1 from a seed and a salt (the same murmur finaliser as
 * displayBody's). */
const unit = (seed: number, salt: number): number => {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ salt
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 0x100000000
}

/** Half-angle of the burst's fan about the normal. Off a side wall (seen in
 * profile) the rays stay out of the wall; behind a body slammed into a north
 * or south wall they ring it, and the body hides the middle. */
export const FAN = { profile: Math.PI * 0.36, ring: Math.PI } as const

/** The rays of the burst: unit directions fanned `fan` either side of the
 * normal, jittered per body. */
const rays = (seed: number, nx: number, ny: number, fan: number): { x: number; y: number; len: number }[] => {
  const base = Math.atan2(ny, nx)
  const out: { x: number; y: number; len: number }[] = []
  const n = fan >= Math.PI ? 8 : 7
  for (let i = 0; i < n; i++) {
    const spread = fan >= Math.PI ? (i / n) * 2 - 1 : (i / (n - 1)) * 2 - 1
    const a = base + spread * fan + (unit(seed, 10 + i) - 0.5) * 0.25
    out.push({ x: Math.cos(a), y: Math.sin(a), len: i % 2 === 0 ? 1 : 0.6 + 0.3 * unit(seed, 20 + i) })
  }
  return out
}

/** The impact burst `s` ticks after the hit, at world px (cx, cy) on the face,
 * the wall's normal (nx, ny). Empty outside 0 .. SLAM.burstTicks. Frame 0: a
 * white flash and short spikes; 1-2: long yellow-orange spikes; then the
 * spikes break into flying chips of grit and fade. */
export const burstBlocks = (s: number, seed: number, cx: number, cy: number, nx: number, ny: number, fan: number = FAN.profile): Block[] => {
  if (!(s >= 0) || s >= SLAM.burstTicks) return []
  const f = Math.floor(s)
  const X = Math.round(cx)
  const Y = Math.round(cy)
  const out: Block[] = []
  const px = (x: number, y: number, color: number, alpha = 1, size = 1): void => {
    out.push({ x: Math.round(x - size / 2), y: Math.round(y - size / 2), w: size, h: size, color, alpha })
  }
  if (f === 0) {
    px(X, Y, WHITE, 1, 5)
    for (const r of rays(seed, nx, ny, fan)) for (let k = 3; k <= 3 + 4 * r.len; k++) px(X + r.x * k, Y + r.y * k, k < 5 ? WHITE : YELLOW, 1, k < 5 ? 2 : 1)
    return out
  }
  if (f <= 2) {
    px(X, Y, f === 1 ? YELLOW : ORANGE, 1, f === 1 ? 3 : 2)
    for (const r of rays(seed, nx, ny, fan)) {
      const from = 3 + f * 2
      const to = from + 5 * r.len
      for (let k = from; k <= to; k++) px(X + r.x * k, Y + r.y * k, k < from + 2 ? YELLOW : ORANGE)
    }
  }
  // Chips of grit thrown off the face, from frame 1, falling a little.
  const fade = 1 - (f - 1) / (SLAM.burstTicks - 1)
  for (let i = 0; i < 5; i++) {
    const a = Math.atan2(ny, nx) + (unit(seed, 30 + i) - 0.5) * 2 * Math.min(fan, 1.1)
    const sp = 3 + 2.5 * unit(seed, 40 + i)
    const d = sp * f
    px(X + Math.cos(a) * d, Y + Math.sin(a) * d + 0.5 * f * f, i % 2 === 0 ? GRIT : ORANGE, fade, i < 2 ? 2 : 1)
  }
  return out
}

/** The dust puff where the body comes to rest at the wall's foot, `s` ticks
 * after it reaches the floor, at world px (cx, cy) on the floor line under it.
 * Empty outside 0 .. SLAM.dustTicks. Clumps of grime roll out to both sides
 * from under the body and rise, each a dark block with a lit top. */
export const dustBlocks = (s: number, seed: number, cx: number, cy: number): Block[] => {
  if (!(s >= 0) || s >= SLAM.dustTicks) return []
  const f = Math.floor(s)
  const u = f / SLAM.dustTicks
  const out: Block[] = []
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const reach = (8 + 7 * unit(seed, 50 + i)) * Math.sqrt(u + 0.1)
    const size = i < 2 ? 4 : 3
    const x = Math.round(cx + side * reach - size / 2)
    const y = Math.round(cy - size - (1 + 3 * unit(seed, 60 + i)) * u)
    const alpha = 0.85 * (1 - u * u)
    out.push({ x, y, w: size, h: size, color: DUST, alpha })
    out.push({ x, y, w: size, h: 1, color: DUST_LIT, alpha })
  }
  return out
}
