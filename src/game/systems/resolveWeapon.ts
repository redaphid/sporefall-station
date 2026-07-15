// The SINGLE weapon-mod composition point. `resolveWeapon` is a PURE function of
// (immutable WeaponDef, mod list) — no clock, no RNG — so it is trivially unit-
// testable and identical on every peer. It folds the MODS registry over the base
// def in SORTED-KEY order, so the same card set yields the same gun regardless of
// PICK order (Brotato's additive-pool lesson + RoR2's per-effect curves). Every
// output field is clamped to stay finite and non-degenerate under huge stacks
// (cooldown floored ≥1 so fireRate can't divide-by-zero; chance-like fields use a
// hyperbolic curve that approaches but never reaches 100%).

import type { WeaponDef, StatusApply } from '../data/items'
import { MODS, modMaxStacks, type BulletBehavior, type ResolvedTrigger, type WeaponStats } from '../data/mods'
import type { WeaponMod } from '../entity'

export interface ResolvedWeapon {
  base: WeaponDef
  damage: number
  cooldownTicks: number
  pellets: number
  spread: number
  projectileSpeed: number
  knockback: number
  /** Element applied on hit (base weapon's, or set by an elemental mod). */
  onHit?: StatusApply
  behavior: BulletBehavior
  triggers: ResolvedTrigger[]
}

// Clamp bounds — the anti-blowup guardrails (all finite, no NaN/Infinity).
const DAMAGE_CAP = 9999
const COOLDOWN_FLOOR = 1 // never 0 → no infinite fire / div-by-zero
const PELLET_CAP = 32
const SPEED_CAP = 60
const KNOCKBACK_CAP = 60
const BEHAVIOR_CAP = 50 // pierce/bounce/split integer caps
const HOMING_CAP = 0.5 // radians/tick

const finite = (n: number, fallback = 0): number => (Number.isFinite(n) ? n : fallback)
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, finite(n, lo)))

/** RoR2 hyperbolic curve: 1 − 1/(1 + a·x). Asymptotes below 1 no matter how many
 * stacks — the anti-degenerate rule for any chance/fraction field (e.g. lifesteal). */
const hyperbolic = (perStack: number, stacks: number): number => 1 - 1 / (1 + perStack * stacks)

const zeroBehavior = (): BulletBehavior => ({
  pierce: 0, bounce: 0, homing: 0, explodeRadius: 0, explodeDamage: 0, split: 0, lifestealFrac: 0,
})

/**
 * Fold a mod list over the immutable base weapon into an effective, resolved
 * weapon + bullet-behavior spec. Pure and total: sum all additive deltas
 * (× stacks), multiply all factors (^ stacks), then clamp. Mods are visited in
 * sorted registry-id order so composition is order-independent and deterministic.
 */
export const resolveWeapon = (base: WeaponDef, mods: readonly WeaponMod[] = []): ResolvedWeapon => {
  // Accumulators: additive pool (starts at base) and multiplicative product.
  const add: WeaponStats = {
    damage: base.damage,
    cooldownTicks: base.cooldownTicks,
    spread: base.spread ?? 0,
    pellets: base.pellets ?? 1,
    projectileSpeed: base.projectileSpeed ?? 12,
    knockback: base.knockback,
  }
  const mul: WeaponStats = { damage: 1, cooldownTicks: 1, spread: 1, pellets: 1, projectileSpeed: 1, knockback: 1 }
  const behavior = zeroBehavior()
  // A hyperbolic field can't just be summed: track its per-stack rate × total stacks.
  let lifestealStacks = 0
  const lifestealPerStack = MODS.lifesteal.behavior!.lifestealFrac!
  let onHit: StatusApply | undefined = base.onHit
  const triggers: ResolvedTrigger[] = []

  // Sorted-key fold → order-independence. Skip unknown ids and non-positive stacks.
  const active = [...mods]
    .filter((m) => MODS[m.id] && m.stacks > 0)
    .map((m) => ({ def: MODS[m.id], stacks: Math.min(Math.floor(m.stacks), modMaxStacks(m.id)) }))
    .sort((a, b) => a.def.id.localeCompare(b.def.id))

  for (const { def, stacks } of active) {
    if (def.add) for (const k of Object.keys(def.add) as (keyof WeaponStats)[]) add[k] += (def.add[k] ?? 0) * stacks
    if (def.mul) for (const k of Object.keys(def.mul) as (keyof WeaponStats)[]) mul[k] *= Math.pow(def.mul[k] ?? 1, stacks)
    if (def.behavior) {
      const b = def.behavior
      if (b.pierce) behavior.pierce += b.pierce * stacks
      if (b.bounce) behavior.bounce += b.bounce * stacks
      if (b.split) behavior.split += b.split * stacks
      if (b.homing) behavior.homing += b.homing * stacks
      if (b.explodeRadius) behavior.explodeRadius += b.explodeRadius * stacks
      if (b.explodeDamage) behavior.explodeDamage += b.explodeDamage * stacks
      if (b.lifestealFrac) lifestealStacks += stacks // hyperbolic — folded below
    }
    if (def.onHit) onHit = def.onHit // last (sorted-key) elemental mod wins the single onHit slot
    if (def.trigger) {
      const t = def.trigger
      triggers.push({
        event: t.event,
        ...(t.explode ? { explode: { radius: t.explode.radius, damage: t.explode.damage * stacks } } : {}),
      })
    }
  }

  behavior.lifestealFrac = lifestealStacks > 0 ? hyperbolic(lifestealPerStack, lifestealStacks) : 0

  return {
    base,
    damage: clamp(Math.round((add.damage * mul.damage) || 0), 0, DAMAGE_CAP),
    cooldownTicks: clamp(Math.ceil(add.cooldownTicks * mul.cooldownTicks), COOLDOWN_FLOOR, 100000),
    pellets: clamp(Math.round(add.pellets * mul.pellets), 1, PELLET_CAP),
    spread: clamp(add.spread * mul.spread, 0, Math.PI),
    projectileSpeed: clamp(add.projectileSpeed * mul.projectileSpeed, 0.5, SPEED_CAP),
    knockback: clamp(add.knockback * mul.knockback, 0, KNOCKBACK_CAP),
    onHit,
    behavior: {
      pierce: clamp(Math.round(behavior.pierce), 0, BEHAVIOR_CAP),
      bounce: clamp(Math.round(behavior.bounce), 0, BEHAVIOR_CAP),
      homing: clamp(behavior.homing, 0, HOMING_CAP),
      explodeRadius: clamp(behavior.explodeRadius, 0, 20),
      explodeDamage: clamp(Math.round(behavior.explodeDamage), 0, DAMAGE_CAP),
      split: clamp(Math.round(behavior.split), 0, BEHAVIOR_CAP),
      lifestealFrac: clamp(behavior.lifestealFrac, 0, 0.95),
    },
    triggers,
  }
}
