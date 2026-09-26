// The SINGLE weapon-mod composition point. `resolveWeapon` is a PURE function of
// (immutable WeaponDef, mod list) — no clock, no RNG — so it is trivially unit-
// testable and identical on every peer. It folds the MODS registry over the base
// def in SORTED-KEY order, so the same card set yields the same stats regardless
// of PICK order (Brotato's additive-pool lesson + RoR2's per-effect curves). The
// one exception is the element: a hit carries one, and it is the NEWEST element
// on the list (the list is pickup order), so the player's latest pick is the one
// that lands. A mod that makes its own hit (shards, shrapnel, a blast) carries
// the element closest to it on the list instead (elementFor). Every
// output field is clamped to stay finite and non-degenerate under huge stacks
// (cooldown floored ≥1 so fireRate can't divide-by-zero; chance-like fields use a
// hyperbolic curve that approaches but never reaches 100%).

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
  /** Element applied on hit (base weapon's, or set by an elemental mod). */
  onHit?: StatusApply
  /** The mods this weapon executes, in normalizeMods form: every mod except the
   * elements a newer element overrides. Absent when none. A round's provenance
   * is built from this, so its look never shows an element the hit will not apply. */
  mods?: WeaponMod[]
  behavior: BulletBehavior
  /** The element each self-hitting behavior carries (elementFor). */
  carries: CarriedElements
  triggers: ResolvedTrigger[]
}

/** The element mod id carried by each behavior whose hits are its own: split
 * shards, splinter shrapnel, and the explosive blast. A key is absent when the
 * weapon lacks the behavior or its list holds no element. A trigger's blast
 * carries its own, on `ResolvedTrigger.explode.element`. */
export interface CarriedElements {
  split?: string
  splinter?: string
  explode?: string
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

/** Which side wins when two elements sit equally close to a mod: 1 = the later
 * pick, -1 = the earlier one. Later matches newest-wins and sequenced riding,
 * where a modifier rides the payload after it. */
export const ELEMENT_TIE_BREAK = 1 as 1 | -1

/**
 * The element a mod that makes its own hit (split shards, splinter shrapnel, an
 * explosive or detonator blast) carries: the element mod closest to it in the
 * live list, measured in list positions. `live` is the weapon's mod list in
 * pickup order with unknown ids and empty stacks already dropped, and
 * `modIndex` indexes into it. Returns undefined when the list holds no element.
 */
export const elementFor = (modIndex: number, live: readonly WeaponMod[]): WeaponMod | undefined => {
  for (let d = 1; d < live.length; d++) {
    for (const j of [modIndex + d * ELEMENT_TIE_BREAK, modIndex - d * ELEMENT_TIE_BREAK]) {
      const m = live[j]
      if (m && MODS[m.id]?.onHit) return m
    }
  }
  return undefined
}

const zeroBehavior = (): BulletBehavior => ({
  pierce: 0, bounce: 0, homing: 0, explodeRadius: 0, explodeDamage: 0, split: 0, splinter: 0, lifestealFrac: 0,
})

/**
 * Fold a mod list over the immutable base weapon into an effective, resolved
 * weapon + bullet-behavior spec. Pure and total: sum all additive deltas
 * (× stacks), multiply all factors (^ stacks), then clamp. Stats fold in sorted
 * registry-id order, so they are order-independent. The element (onHit) is the
 * newest element mod in list order, falling back to the base weapon's.
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
  const newestElement = [...known].reverse().find((m) => MODS[m.id].onHit)
  const onHit: StatusApply | undefined = newestElement ? MODS[newestElement.id].onHit : base.onHit
  const executed = known.filter((m) => !MODS[m.id].onHit || m.id === newestElement?.id)

  // Sorted-key fold → order-independent stats. Skip unknown ids and non-positive stacks.
  // The sort is stable, so a repeated id keeps list order and its first entry
  // decides the element its behavior carries.
  const active = known
    .map((m, i) => ({ def: MODS[m.id], stacks: Math.min(Math.floor(m.stacks), modMaxStacks(m.id)), element: elementFor(i, known)?.id }))
    .sort((a, b) => a.def.id.localeCompare(b.def.id))
  const carries: CarriedElements = {}

  for (const { def, stacks, element } of active) {
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
      if (element) {
        if (b.split) carries.split ??= element
        if (b.splinter) carries.splinter ??= element
        if (b.explodeRadius) carries.explode ??= element
      }
      if (b.explodeDamage) behavior.explodeDamage += b.explodeDamage * stacks
      if (b.lifestealFrac) lifestealStacks += stacks // hyperbolic — folded below
    }
    if (def.trigger) {
      const t = def.trigger
      triggers.push({
        event: t.event,
        ...(t.explode ? { explode: { radius: t.explode.radius, damage: t.explode.damage * stacks, ...(element ? { element } : {}) } } : {}),
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
    mods: normalizeMods(executed),
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
    carries,
    triggers,
  }
}
