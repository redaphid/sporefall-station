// The weapon-modifier table — ROUNDS-style stackable "cards" for unique guns.
// A mod is PURE DATA (`add`/`mul`/`behavior`/`trigger`), exactly like WEAPONS /
// ELEMENTS / THROWABLES: adding a mod is a registry entry, never scattered
// special-casing. `resolveWeapon` (systems/resolveWeapon.ts) folds these over the
// immutable WeaponDef at the single fire site. Re-expressed from a study of
// ROUNDS (bundle-a-downside balance, rarity tiers) + Risk of Rain 2 (per-effect
// scaling curves) — authored fresh, not ported.

import type { StatusApply } from './items'

/** The mutable stat surface a STAT mod tweaks (mirrors the fire-relevant fields
 * of WeaponDef). `cooldownTicks` IS fireRate — lower fires faster. */
export interface WeaponStats {
  damage: number
  cooldownTicks: number
  spread: number
  pellets: number
  projectileSpeed: number
  knockback: number
}

/** Numeric bullet-behavior spec a BEHAVIOR mod sets on the spawned projectile.
 * All additive-accumulating across mods (× stacks), then clamped in resolve. */
export interface BulletBehavior {
  pierce: number
  bounce: number
  homing: number
  explodeRadius: number
  explodeDamage: number
  split: number
  /** Fragment count for the on-termination radial shatter (splinterShot). */
  splinter: number
  lifestealFrac: number
}

/** A data-only trigger: an effect fired at a combat choke point. `on-reload` is
 * declared for completeness but not yet wired (no reload action exists — P4). */
export interface ModTrigger {
  event: 'hit' | 'kill' | 'reload'
  /** Chain explosion (detonator): a blast at the victim on the trigger event. */
  explode?: { radius: number; damage: number }
}

/** A trigger after stack-scaling, carried on the projectile and fired by the
 * projectile/melee hit path. Plain JSON → serializes with the world. */
export interface ResolvedTrigger {
  event: 'hit' | 'kill' | 'reload'
  explode?: { radius: number; damage: number }
}

export type ModCategory = 'stat' | 'behavior' | 'trigger'
export type ModRarity = 'common' | 'rare' | 'legendary'

export interface ModDef {
  id: string
  name: string
  /** Kid-readable one-liner shown on the draft card + tap-inspect (#41/#51). */
  blurb: string
  /** Single-glyph badge for the hotbar + card. */
  icon: string
  category: ModCategory
  rarity: ModRarity
  /** Cap on stacks to keep huge stacks finite/non-degenerate. Default DEFAULT_MAX_STACKS. */
  maxStacks?: number
  /** Additive stat deltas, applied × stacks (linear pool, order-independent). */
  add?: Partial<WeaponStats>
  /** Multiplicative stat factors, applied ^ stacks (compounding — gate with a downside). */
  mul?: Partial<WeaponStats>
  /** Bullet-behavior contributions, accumulated × stacks then clamped. */
  behavior?: Partial<BulletBehavior>
  /** An element applied to whatever the bullet strikes (reuses the ELEMENTS table). */
  onHit?: StatusApply
  /** A trigger effect; its magnitude scales with stacks in resolveWeapon. */
  trigger?: ModTrigger
}

/** Default stack cap (ROUNDS lets you re-pick a card; we bound it). */
export const DEFAULT_MAX_STACKS = 5

/** The mod registry. A signature gun is a base weapon + a handful of these. */
export const MODS: Record<string, ModDef> = {
  // ---- STAT (P1) ------------------------------------------------------------
  overload: {
    id: 'overload', name: 'Overload', icon: '💥', category: 'stat', rarity: 'rare',
    blurb: 'Bigger boom — hits way harder, but fires a touch slower.',
    // +25% damage per stack (compounding), gated by ROUNDS-style downside: +8% cooldown.
    mul: { damage: 1.25, cooldownTicks: 1.08 },
  },
  bulk: {
    id: 'bulk', name: 'Barrage', icon: '🔱', category: 'stat', rarity: 'common',
    blurb: 'Two extra bullets per shot — but each one hits softer.',
    // ROUNDS "Barrage": more pellets, less damage each, wider.
    add: { pellets: 2, spread: 0.12 }, mul: { damage: 0.8 },
  },
  rapid: {
    id: 'rapid', name: 'Rapid Fire', icon: '⚡', category: 'stat', rarity: 'common',
    blurb: 'Fires faster — but the recoil kick shrinks.',
    mul: { cooldownTicks: 0.8, knockback: 0.85 },
  },
  heavy: {
    id: 'heavy', name: 'Heavy Rounds', icon: '🪨', category: 'stat', rarity: 'common',
    blurb: 'Punchier, knock-em-back rounds — a bit slower to fire.',
    add: { damage: 4, knockback: 3 }, mul: { cooldownTicks: 1.06 },
  },
  choke: {
    id: 'choke', name: 'Choke', icon: '🎯', category: 'stat', rarity: 'common',
    blurb: 'Tightens the spread — pellets fly straight and true.',
    mul: { spread: 0.6 },
  },
  velocity: {
    id: 'velocity', name: 'Hot Loads', icon: '🚀', category: 'stat', rarity: 'common',
    blurb: 'Bullets scream downrange faster.',
    mul: { projectileSpeed: 1.3 },
  },
  glassCannon: {
    id: 'glassCannon', name: 'Glass Cannon', icon: '🔮', category: 'stat', rarity: 'legendary',
    maxStacks: 2,
    blurb: 'Double damage — but you fire much slower to earn it.',
    mul: { damage: 2, cooldownTicks: 1.4 },
  },

  // ---- BEHAVIOR: elements (reuse ELEMENTS via onHit) ------------------------
  // All three are COMMON (was `rare`). With one weapon, an element is no longer
  // a spice pick — it is the only way to answer a bullet-resistant archetype
  // (brute/robot), so a run must not be able to roll zero elemental access.
  // `ELEMENTAL_MODS` in systems/draft.ts additionally guarantees one per hand.
  // frost's verb is CONTROL, and it is the one element that is not a damage
  // channel. Its freeze is deliberately NOT `brittle`: brittle ice shatters on
  // impact (an instant kill that ignores hp, resist and archetype alike), which
  // is a fair trade for a thrown grenade you have to find and aim, and a broken
  // one for a permanent mod that fires every other shot. Non-brittle ice cracks
  // instead, for a heavy bonus-damage shove — see applyDamage.
  frost: {
    id: 'frost', name: 'Cryo Rounds', icon: '❄️', category: 'behavior', rarity: 'common',
    maxStacks: 1,
    blurb: 'Freezes what it hits — then the next hit cracks the ice, hard.',
    onHit: { status: 'frozen', ticks: 120 },
  },
  incendiary: {
    id: 'incendiary', name: 'Incendiary', icon: '🔥', category: 'behavior', rarity: 'common',
    maxStacks: 1,
    blurb: 'Sets enemies on fire — they keep burning.',
    onHit: { status: 'burning', ticks: 240 },
  },
  shock: {
    id: 'shock', name: 'Tesla Rounds', icon: '🌩️', category: 'behavior', rarity: 'common',
    maxStacks: 1,
    blurb: 'Zaps and stuns — arcs through anything wet.',
    onHit: { status: 'electrified', ticks: 45 },
  },

  // ---- BEHAVIOR: bullet mechanics ------------------------------------------
  bounce: {
    id: 'bounce', name: 'Bouncy', icon: '🪃', category: 'behavior', rarity: 'rare',
    blurb: 'Bullets ricochet off walls.',
    behavior: { bounce: 2 },
  },
  pierce: {
    id: 'pierce', name: 'Piercing', icon: '🏹', category: 'behavior', rarity: 'common',
    blurb: 'Bullets punch clean through enemies.',
    behavior: { pierce: 1 },
  },
  homing: {
    id: 'homing', name: 'Homing', icon: '🧲', category: 'behavior', rarity: 'rare',
    maxStacks: 3,
    blurb: 'Bullets curve toward the nearest enemy.',
    behavior: { homing: 0.10 },
  },
  explosive: {
    id: 'explosive', name: 'Explosive', icon: '💣', category: 'behavior', rarity: 'rare',
    maxStacks: 3,
    blurb: 'Bullets blow up on impact.',
    behavior: { explodeRadius: 1.6, explodeDamage: 14 },
  },
  split: {
    id: 'split', name: 'Splinter', icon: '✳️', category: 'behavior', rarity: 'rare',
    maxStacks: 3,
    blurb: 'Bullets burst into shards on a hit.',
    behavior: { split: 2 },
  },
  splinterShot: {
    id: 'splinterShot', name: 'Splinter Shot', icon: '🔪', category: 'behavior', rarity: 'rare',
    maxStacks: 3,
    // DISTINCT from `split` (a forward FORK on the first body hit): splinterShot
    // makes the round SHATTER into a radial spray of short-range shrapnel wherever
    // it dies — a wall, ttl expiry, or an enemy. Great for corners and crowds.
    blurb: 'Shatters into a burst of shrapnel wherever it lands.',
    behavior: { splinter: 4 },
  },
  lifesteal: {
    id: 'lifesteal', name: 'Vampiric', icon: '🩸', category: 'behavior', rarity: 'rare',
    blurb: 'Heals you a little for every hit.',
    // Hyperbolic accumulation in resolve keeps this below 100% at any stack.
    behavior: { lifestealFrac: 0.15 },
  },

  // ---- TRIGGER --------------------------------------------------------------
  detonator: {
    id: 'detonator', name: 'Detonator', icon: '☠️', category: 'trigger', rarity: 'legendary',
    maxStacks: 3,
    blurb: 'Enemies explode when they die — chain the carnage.',
    trigger: { event: 'kill', explode: { radius: 2, damage: 24 } },
  },
}

/** A registry-checked mod id (used by the addMod verb + draft). */
export const isModId = (id: string): id is keyof typeof MODS => Object.prototype.hasOwnProperty.call(MODS, id)

/** The cap for a mod id (its own `maxStacks`, else the default). */
export const modMaxStacks = (id: string): number => MODS[id]?.maxStacks ?? DEFAULT_MAX_STACKS

/** Canonicalize a mod list: drop unknown ids and non-positive stacks, floor and
 * cap stack counts, sort by id. The ONE normal form for mod provenance carried
 * on a projectile (entity + wire codec + renderer), so the same loadout is
 * byte-identical however it was accumulated. Returns undefined when nothing
 * survives, so callers can keep the field absent (snapshot-stable). */
export const normalizeMods = (
  mods: readonly { id: string; stacks: number }[] | undefined,
): { id: string; stacks: number }[] | undefined => {
  if (!mods || mods.length === 0) return undefined
  const byId = new Map<string, number>()
  for (const m of mods) {
    if (!MODS[m.id] || !(m.stacks > 0)) continue
    const stacks = Math.min(Math.floor(m.stacks), modMaxStacks(m.id))
    if (stacks <= 0) continue
    byId.set(m.id, Math.min((byId.get(m.id) ?? 0) + stacks, modMaxStacks(m.id)))
  }
  if (byId.size === 0) return undefined
  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, stacks]) => ({ id, stacks }))
}
