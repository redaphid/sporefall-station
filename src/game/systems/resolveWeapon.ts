// The SINGLE weapon-mod composition point, resolving ONE CAST. The fire path
// (combat.fireWeapon) splits the mod list into casts (systems/modSequence), and
// each cast is its modifiers plus at most one element, which ends the cast.
// `resolveWeapon` is a PURE function of (immutable WeaponDef, cast mods) — no
// clock, no RNG — so it is trivially unit-testable and identical on every peer.
// It folds the MODS registry over the base def in SORTED-KEY order, so a cast's
// stats do not depend on the order of its modifiers (Brotato's additive-pool
// lesson + RoR2's per-effect curves). The cast's element, if it has one, is the
// hit's element; otherwise the base weapon's. Every output field is clamped to
// stay finite and non-degenerate under huge stacks (cooldown floored ≥1 so
// fireRate can't divide-by-zero; chance-like fields use a hyperbolic curve that
// approaches but never reaches 100%).

import type { WeaponDef, StatusApply } from '../data/items'
import { MODS, modMaxStacks, normalizeMods, type BulletBehavior, type ResolvedTrigger, type WeaponStats } from '../data/mods'
import type { WeaponMod } from '../entity'

export interface ResolvedWeapon {
  base: WeaponDef
  damage: number
  cooldownTicks: number
  pellets: number
  spread: number
  projectileSpeed: number
  knockback: number
  /** Element applied on hit (base weapon's, or the cast's element mod's). */
  onHit?: StatusApply
  /** The cast's mods, in normalizeMods form. Absent when none. A round's
   * provenance is built from this, so its look shows only what the cast runs. */
  mods?: WeaponMod[]
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
  pierce: 0, bounce: 0, homing: 0, explodeRadius: 0, explodeDamage: 0, split: 0, splinter: 0, lifestealFrac: 0,
})

/**
 * Fold one cast's mods over the immutable base weapon into an effective,
 * resolved weapon + bullet-behavior spec. Pure and total: sum all additive
 * deltas (× stacks), multiply all factors (^ stacks), then clamp. Stats fold in
 * sorted registry-id order, so they are order-independent. The element (onHit)
 * is the cast's element mod, falling back to the base weapon's.
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
  const triggers: ResolvedTrigger[] = []

  const known = mods.filter((m) => MODS[m.id] && m.stacks > 0)
  const element = known.find((m) => MODS[m.id].onHit)
  const onHit: StatusApply | undefined = element ? MODS[element.id].onHit : base.onHit

  // Sorted-key fold → order-independent stats. Skip unknown ids and non-positive stacks.
  const active = known
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
      if (b.splinter) behavior.splinter += b.splinter * stacks
      if (b.homing) behavior.homing += b.homing * stacks
      if (b.explodeRadius) behavior.explodeRadius += b.explodeRadius * stacks
      if (b.explodeDamage) behavior.explodeDamage += b.explodeDamage * stacks
      if (b.lifestealFrac) lifestealStacks += stacks // hyperbolic — folded below
    }
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
    mods: normalizeMods(known),
    behavior: {
      pierce: clamp(Math.round(behavior.pierce), 0, BEHAVIOR_CAP),
      bounce: clamp(Math.round(behavior.bounce), 0, BEHAVIOR_CAP),
      homing: clamp(behavior.homing, 0, HOMING_CAP),
      explodeRadius: clamp(behavior.explodeRadius, 0, 20),
      explodeDamage: clamp(Math.round(behavior.explodeDamage), 0, DAMAGE_CAP),
      split: clamp(Math.round(behavior.split), 0, BEHAVIOR_CAP),
      splinter: clamp(Math.round(behavior.splinter), 0, BEHAVIOR_CAP),
      lifestealFrac: clamp(behavior.lifestealFrac, 0, 0.95),
    },
    triggers,
  }
}
