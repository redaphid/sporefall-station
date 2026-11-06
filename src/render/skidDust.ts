/**
 * The puff of dust a SKID kicks forward from the feet (animTracker.observeSkid,
 * motion.ts `skid`). Procedural on purpose: art is generated, never hand-drawn,
 * so the dust is pixi Graphics drawn on the world pixel grid, like the other
 * procedural effect layers (activityFx, groupFx).
 *
 * The model is pure: every puff is a function of the skid (stop tick, feet,
 * run direction and speed), the entity id and the view-time t. Variation seeds
 * from hash(id, stop tick), never Math.random, so every device and replay kicks
 * the same dust.
 */

import type { Graphics } from 'pixi.js'
import { charFootPx } from './anim'
import { TILE_PX } from './art'
import type { Skid } from './animTracker'
import type { LocomotionStyle } from './motion'

/** THE tunable table, in world pixels and sim ticks. `puffs` per legged style;
 * each flies `reach` px forward (at the player's 4 tiles/s run, scaled by the
 * run's speed), fanned `spread` radians either side of the run, rising `rise`
 * px and swelling to `radius` px as it fades over `ticks`. */
export const DUST = {
  puffs: { stride: 3, waddle: 2 },
  ticks: 12,
  reach: 9,
  refSpeed: 4,
  spread: 0.55,
  rise: 3,
  radius: 2.5,
  alpha: 0.85,
  edge: 0x7d7262,
  core: 0xb9ad94,
} as const

export interface Puff {
  /** Centre, world px (integers: the dust sits on the pixel grid). */
  x: number
  y: number
  /** Radius, whole px. */
  r: number
  alpha: number
}

/** murmur3's finalizer over (id, tick): well-mixed and deterministic. */
const hash = (id: number, tick: number, k: number): number => {
  let x = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(tick + k * 0x27d4eb2f, 0xc2b2ae35)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 0x100000000
}

/** The puffs of `skid` at view-time t; empty before the stop and once settled. */
export const skidDust = (skid: Skid, id: number, t: number, style: LocomotionStyle = 'stride'): Puff[] => {
  if (style !== 'stride' && style !== 'waddle') return []
  const s = t - skid.at
  if (s <= 0 || s >= DUST.ticks) return []
  const u = s / DUST.ticks
  const ease = 1 - (1 - u) * (1 - u) // fast out, settling
  const fx = skid.x * TILE_PX
  const fy = charFootPx(skid.y, TILE_PX)
  const n = DUST.puffs[style]
  const reach = DUST.reach * Math.min(1.25, skid.speed / DUST.refSpeed) * (style === 'waddle' ? 0.6 : 1)
  const out: Puff[] = []
  for (let k = 0; k < n; k++) {
    // Fan the puffs across the run, jittered per stop.
    const lane = (k / (n - 1)) * 2 - 1
    const a = Math.atan2(skid.dirY, skid.dirX) + (lane + (hash(id, skid.at, k) - 0.5) * 0.6) * DUST.spread
    const d = reach * (0.6 + 0.4 * hash(id, skid.at, k + 7)) * ease
    out.push({
      x: Math.round(fx + Math.cos(a) * d),
      y: Math.round(fy + Math.sin(a) * d * 0.6 - DUST.rise * ease), // flattened onto the floor, lifting
      r: Math.max(1, Math.round(1 + (DUST.radius - 1) * ease)),
      alpha: DUST.alpha * (1 - u) * (1 - u * 0.5),
    })
  }
  return out
}

/** Draw a pixel disc: one rect per row, so the puff stays on the pixel grid. */
const disc = (g: Graphics, cx: number, cy: number, r: number, color: number, alpha: number): void => {
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy) + 0.35)
    g.rect(cx - w, cy + dy, w * 2 + 1, 1)
  }
  g.fill({ color, alpha })
}

/** Draw the puffs into `g` (cleared first): a darker rim under a lighter core. */
export const drawSkidDust = (g: Graphics, puffs: readonly Puff[]): void => {
  g.clear()
  for (const p of puffs) {
    disc(g, p.x, p.y, p.r, DUST.edge, p.alpha)
    if (p.r > 1) disc(g, p.x, p.y - 1, p.r - 1, DUST.core, p.alpha)
  }
}
