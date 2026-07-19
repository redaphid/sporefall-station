// The procedural bullet-visual grammar — Nova-Drift style. Every weapon mod
// contributes VISUAL TRAIT DELTAS (declared in MOD_VISUALS below, the ONE place
// a new mod gets its look), and `composeBulletTraits` folds a bullet's mod
// provenance into a single composed appearance: size/elongation multiply,
// colors blend by weight, glow/trail/flicker accumulate and clamp. 2–3 stacked
// mods therefore produce a COMBINED look, never a switch to one preset — the
// player literally sees their build in every shot.
//
// Pure module: no pixi, no DOM, no RNG — a total function of the mod list, so
// host, client and replay all derive the identical style, and it unit-tests
// exhaustively. The renderer (bullets.ts / bulletShader.ts) maps these traits
// onto sprite tint/scale and shader uniforms.

import { MODS, modMaxStacks } from '../game/data/mods'
import type { WeaponMod } from '../game/entity'

/** The composed appearance of one bullet. All fields finite and clamped. */
export interface BulletTraits {
  /** Core radius multiplier (1 = the vanilla 4px tracer). */
  size: number
  /** Elongation along the heading (1 = round; >1 = dart/tracer streak). */
  length: number
  /** Core tint (0xRRGGBB), blended from every contributing mod hue. */
  color: number
  /** Energy-halo strength 0..1 (0 = no glow pass at all). */
  glow: number
  /** Halo tint — usually the element/effect hue, not the core hue. */
  glowColor: number
  /** Afterimage trail length in ghost sprites / shader quads, 0..TRAIL_CAP. */
  trail: number
  trailColor: number
  /** Positional flicker 0..1 (tesla arc jitter, fire waver). */
  jitter: number
  /** Size pulse 0..1 (armed/explosive throb). */
  pulse: number
  /** Orbiting shard flecks 0..1 (splinter). */
  flecks: number
  /** Chromatic fringing 0..1 — grows with total stack power (shader RGB split). */
  chroma: number
  /** Total effective stacks — the renderer's "how built is this gun" scalar. */
  power: number
}

/** One mod's visual contribution. Multiplicative fields compound per stack
 * (^stacks); additive fields accumulate (×stacks); hues blend by weight×stacks. */
export interface BulletTraitDelta {
  /** Core-size factor per stack (compounds). */
  sizeMul?: number
  /** Elongation factor per stack (compounds). */
  lengthMul?: number
  /** Core-hue contribution: blended into the tint with `weight` per stack. */
  hue?: { color: number; weight: number }
  /** Halo strength added per stack. */
  glowAdd?: number
  /** Halo tint this mod pulls toward (weighted like `hue`). */
  glowColor?: number
  /** Trail ghosts added per stack. */
  trailAdd?: number
  /** Trail tint this mod pulls toward. */
  trailColor?: number
  jitterAdd?: number
  pulseAdd?: number
  flecksAdd?: number
}

/** Vanilla tracer gold — the base look every composition starts from. */
export const BASE_BULLET_COLOR = 0xffe066

/** Clamp rails — bullets must stay legible on-screen at any stack count. */
export const TRAIL_CAP = 5
const SIZE_MIN = 0.6
const SIZE_MAX = 2.4
const LENGTH_MAX = 3.2
/** Weight of the base gold in the hue blend — kept LOW so an element's
 * canonical hue dominates (gold+blue in RGB otherwise washes to green). */
const BASE_HUE_WEIGHT = 0.3
/** Post-blend saturation push: weighted RGB mixes drift grey; this pulls the
 * composed hue back out so builds stay vivid against the pixel-art floors. */
const SAT_BOOST = 1.35

/**
 * THE mod-id → visual-trait table. Add a registry entry here when adding a mod
 * to `data/mods.ts` (a unit test enforces 1:1 coverage). Each mapping is derived
 * from what the mod DOES, so the look reads as the mechanic:
 *  - damage mods grow the core + glow, fire-rate thins it into a tracer,
 *  - pierce elongates into a dart, bounce recolors the trail lime,
 *  - elements own their canonical hue (frost ice-blue, fire ember, tesla arc),
 *  - splinter orbits flecks, vampiric drips a blood trail, detonator throbs.
 */
export const MOD_VISUALS: Record<string, BulletTraitDelta> = {
  // ---- STAT ------------------------------------------------------------------
  // Overload (+damage, slower): a heavier, hotter slug — bigger core, hot glow.
  overload: { sizeMul: 1.16, hue: { color: 0xffa538, weight: 0.35 }, glowAdd: 0.18, glowColor: 0xff9030 },
  // Barrage (more, weaker pellets): each pellet visibly thinner and paler.
  bulk: { sizeMul: 0.85, lengthMul: 0.95, hue: { color: 0xffd98a, weight: 0.2 } },
  // Rapid Fire: a slimmer, streaking tracer.
  rapid: { sizeMul: 0.92, lengthMul: 1.22, trailAdd: 0.5, hue: { color: 0xfff2a8, weight: 0.15 } },
  // Heavy Rounds (+flat damage/knockback): chunky bronze slug.
  heavy: { sizeMul: 1.2, hue: { color: 0xd9a066, weight: 0.4 }, glowAdd: 0.08, glowColor: 0xc98940 },
  // Choke (tight spread): a truer, whiter, laser-straight round.
  choke: { lengthMul: 1.18, hue: { color: 0xffffff, weight: 0.22 } },
  // Hot Loads (+speed): screaming-fast — long streak + hot trail.
  velocity: { lengthMul: 1.3, trailAdd: 1, trailColor: 0xff9a30, hue: { color: 0xffb040, weight: 0.2 } },
  // Glass Cannon: prismatic overcharged shard — big, violet, strongly glowing.
  glassCannon: { sizeMul: 1.4, glowAdd: 0.4, glowColor: 0xc080ff, hue: { color: 0xd08cff, weight: 0.55 } },

  // ---- BEHAVIOR: elements ----------------------------------------------------
  frost: { hue: { color: 0x8fd4ff, weight: 1 }, glowAdd: 0.3, glowColor: 0x8fd4ff, trailAdd: 1, trailColor: 0xc9ecff },
  incendiary: { hue: { color: 0xff7a2a, weight: 1 }, glowAdd: 0.35, glowColor: 0xff6018, trailAdd: 1, trailColor: 0xffb040, jitterAdd: 0.18 },
  shock: { hue: { color: 0xfff27a, weight: 1 }, glowAdd: 0.3, glowColor: 0xaad4ff, jitterAdd: 0.6, trailAdd: 0.5, trailColor: 0xd8f0ff },

  // ---- BEHAVIOR: bullet mechanics -------------------------------------------
  // Bouncy: the trail flips signature lime — a ricochet reads mid-flight.
  bounce: { hue: { color: 0x9dff57, weight: 0.5 }, trailAdd: 1, trailColor: 0x9dff57 },
  // Piercing: an elongated armor-punching dart.
  pierce: { lengthMul: 1.45, sizeMul: 0.95, hue: { color: 0xc8f0ff, weight: 0.25 } },
  // Homing: seeking magenta pulse + a curving trail to sell the steer.
  homing: { hue: { color: 0xff6ad5, weight: 0.55 }, pulseAdd: 0.35, trailAdd: 1, trailColor: 0xff8ee0, glowAdd: 0.15, glowColor: 0xff6ad5 },
  // Explosive: an armed grenade-round — fat, red-hot, throbbing.
  explosive: { sizeMul: 1.14, hue: { color: 0xff5030, weight: 0.5 }, glowAdd: 0.35, glowColor: 0xff4020, pulseAdd: 0.5 },
  // Splinter: shard flecks orbit the round, hinting the burst to come.
  split: { flecksAdd: 0.7, hue: { color: 0xc0ff90, weight: 0.25 }, trailAdd: 0.5, trailColor: 0xd8ffb0 },
  // Vampiric: crimson round dripping a blood trail.
  lifesteal: { hue: { color: 0xd8304a, weight: 0.7 }, trailAdd: 1, trailColor: 0xa01830, glowAdd: 0.12, glowColor: 0xd8304a },

  // ---- TRIGGER ---------------------------------------------------------------
  // Detonator: dark payload with a menacing red throb.
  detonator: { hue: { color: 0x903030, weight: 0.4 }, glowAdd: 0.4, glowColor: 0xff3020, pulseAdd: 0.7 },
}

const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo

/** RoR2-style hyperbolic accumulation for 0..1 intensity fields: approaches but
 * never reaches `max` however many contributions stack — the anti-blowup rule. */
const saturating = (sum: number, max: number): number => max * (1 - 1 / (1 + sum))

const rgb = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
const hex = (r: number, g: number, b: number): number =>
  (Math.round(clamp(r, 0, 255)) << 16) | (Math.round(clamp(g, 0, 255)) << 8) | Math.round(clamp(b, 0, 255))

/** Push a color's channels away from its own luminance (re-saturate). */
const saturate = (c: number, amount: number): number => {
  const [r, g, b] = rgb(c)
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return hex(lum + (r - lum) * amount, lum + (g - lum) * amount, lum + (b - lum) * amount)
}

/** Weighted RGB blender: fold colors in with weights, read the mix out. */
const makeBlend = (baseColor: number, baseWeight: number) => {
  const base = rgb(baseColor)
  let [r, g, b] = [base[0] * baseWeight, base[1] * baseWeight, base[2] * baseWeight]
  let total = baseWeight
  return {
    add(color: number, weight: number): void {
      const [cr, cg, cb] = rgb(color)
      r += cr * weight
      g += cg * weight
      b += cb * weight
      total += weight
    },
    mix(): number {
      return total > 0 ? hex(r / total, g / total, b / total) : baseColor
    },
    weight(): number {
      return total - baseWeight
    },
  }
}

/** The vanilla (no-mod) look: exactly today's small gold tracer, no extras. */
export const baseBulletTraits = (): BulletTraits => ({
  size: 1,
  length: 1,
  color: BASE_BULLET_COLOR,
  glow: 0,
  glowColor: BASE_BULLET_COLOR,
  trail: 0,
  trailColor: BASE_BULLET_COLOR,
  jitter: 0,
  pulse: 0,
  flecks: 0,
  chroma: 0,
  power: 0,
})

/**
 * Compose a bullet's appearance from its mod provenance. Pure and total:
 * unknown ids and non-positive stacks are skipped, stacks floor + cap at the
 * registry's maxStacks, and the fold visits mods in sorted-id order so the
 * result is independent of pick/attach order. Every output is clamped so a
 * max-stack monster build stays finite and on-screen-legible.
 */
export const composeBulletTraits = (mods: readonly WeaponMod[] | undefined): BulletTraits => {
  const t = baseBulletTraits()
  if (!mods || mods.length === 0) return t

  const active = [...mods]
    .filter((m) => MODS[m.id] && MOD_VISUALS[m.id] && m.stacks > 0)
    .map((m) => ({ id: m.id, delta: MOD_VISUALS[m.id], stacks: Math.min(Math.floor(m.stacks), modMaxStacks(m.id)) }))
    .filter((m) => m.stacks > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (active.length === 0) return t

  const core = makeBlend(BASE_BULLET_COLOR, BASE_HUE_WEIGHT)
  // Glow/trail hues blend ONLY from contributing mods (no gold base): an ice
  // halo must be pure ice, not gold-washed. No contributors → core color.
  const glow = makeBlend(BASE_BULLET_COLOR, 0)
  const trail = makeBlend(BASE_BULLET_COLOR, 0)
  let sizeMul = 1
  let lengthMul = 1
  let glowSum = 0
  let trailSum = 0
  let jitterSum = 0
  let pulseSum = 0
  let flecksSum = 0
  let power = 0

  for (const { delta, stacks } of active) {
    power += stacks
    // Per-stack compounding softens after the first stack (sqrt taper) so five
    // stacks read "much more", not "off the chart".
    const eff = 1 + Math.sqrt(stacks) - 1 // 1, 1.41, 1.73 … effective stacks
    if (delta.sizeMul) sizeMul *= Math.pow(delta.sizeMul, eff)
    if (delta.lengthMul) lengthMul *= Math.pow(delta.lengthMul, eff)
    if (delta.hue) core.add(delta.hue.color, delta.hue.weight * eff)
    if (delta.glowAdd) {
      glowSum += delta.glowAdd * eff
      glow.add(delta.glowColor ?? delta.hue?.color ?? BASE_BULLET_COLOR, (delta.glowAdd || 0.1) * eff)
    }
    if (delta.trailAdd) {
      trailSum += delta.trailAdd * eff
      trail.add(delta.trailColor ?? delta.hue?.color ?? BASE_BULLET_COLOR, delta.trailAdd * eff)
    }
    if (delta.jitterAdd) jitterSum += delta.jitterAdd * eff
    if (delta.pulseAdd) pulseSum += delta.pulseAdd * eff
    if (delta.flecksAdd) flecksSum += delta.flecksAdd * eff
  }

  t.size = clamp(sizeMul, SIZE_MIN, SIZE_MAX)
  t.length = clamp(lengthMul, 1, LENGTH_MAX)
  t.color = saturate(core.mix(), SAT_BOOST)
  t.glow = saturating(glowSum, 0.95)
  t.glowColor = saturate(glow.weight() > 0 ? glow.mix() : t.color, SAT_BOOST)
  t.trail = clamp(Math.round(Math.min(trailSum * 2, TRAIL_CAP)), 0, TRAIL_CAP)
  t.trailColor = saturate(trail.weight() > 0 ? trail.mix() : t.color, SAT_BOOST)
  t.jitter = saturating(jitterSum, 0.9)
  t.pulse = saturating(pulseSum, 0.9)
  t.flecks = saturating(flecksSum, 1)
  // Chromatic fringing is the "deep build" tell: it only appears past a few
  // total stacks and saturates below 1 (shader RGB-split stays subtle).
  t.chroma = power >= 3 ? saturating((power - 2) * 0.18, 0.8) : 0
  t.power = power
  return t
}
