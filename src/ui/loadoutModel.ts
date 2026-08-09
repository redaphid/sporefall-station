// Pure builder for the LOADOUT panel — the "detailed gun + mods" readout shown on
// the pause and death screens. Given a player entity it produces a DOM-free view
// model: the equipped weapon's name/kind/glyph, its BASE vs mod-RESOLVED stats
// (so the player sees exactly what their build adds up to), one coloured chip per
// applied mod, and the resolved bullet-behavior badges (pierce/explosive/element…).
//
// It reuses the sim's single sources of truth — WEAPONS (data/items), MODS
// (data/mods), `weaponStack` (systems/inventory) for the equipped stack's mod
// list, `resolveWeapon` (systems/resolveWeapon) for the folded stats, and
// `modPickupColor` (render/modColors) for each mod's signature gem hue — so the
// panel never re-derives balance numbers or colours. Kept pure so it is unit-
// tested exhaustively and the panel just paints the result.

import type { Entity } from '../game/entity'
import { WEAPONS } from '../game/data/items'
import { MODS, type ModRarity } from '../game/data/mods'
import { weaponStack } from '../game/systems/inventory'
import { resolveWeapon, type ResolvedWeapon } from '../game/systems/resolveWeapon'
import { modPickupColor } from '../render/modColors'
import { SIM_RATE } from '../game/types'

/** A 0xRRGGBB number → a `#rrggbb` CSS string (single conversion point). */
export const toCssHex = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`

/** One stat, shown as base → resolved so a mod's effect on it is visible. */
export interface LoadoutStat {
  key: string
  label: string
  baseText: string
  resolvedText: string
  /** True when the mods moved this stat (drives the "changed" accent). */
  changed: boolean
  /** True when a higher number is better (arrow/colour direction). */
  higherBetter: boolean
  /** +1 improved, -1 worsened, 0 unchanged (relative to higherBetter). */
  direction: -1 | 0 | 1
}

/** One applied mod, as a coloured chip. */
export interface LoadoutMod {
  id: string
  name: string
  icon: string
  desc: string
  stacks: number
  rarity: ModRarity
  /** The mod's signature gem colour as `#rrggbb` (from modPickupColor). */
  color: string
}

/** A resolved bullet-behavior badge (pierce/bounce/explosive/element/…). */
export interface LoadoutBehavior {
  key: string
  icon: string
  label: string
}

export interface LoadoutModel {
  weaponId: string
  name: string
  kind: 'melee' | 'ranged'
  /** True for bare fists / a missing weapon — mods are empty, stats are innate. */
  unarmed: boolean
  glyph: string
  stats: LoadoutStat[]
  mods: LoadoutMod[]
  behaviors: LoadoutBehavior[]
}

const round = (n: number, dp = 0): number => {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** Shots per second from a cooldown in ticks (SIM_RATE ticks/sec). */
const fireRate = (cooldownTicks: number): number => SIM_RATE / Math.max(1, cooldownTicks)
const degrees = (rad: number): number => (rad * 180) / Math.PI

const makeStat = (
  key: string,
  label: string,
  base: number,
  resolved: number,
  higherBetter: boolean,
  fmt: (n: number) => string,
): LoadoutStat => {
  const changed = round(base, 3) !== round(resolved, 3)
  const better = resolved > base ? 1 : resolved < base ? -1 : 0
  const direction = (changed ? (higherBetter ? better : (-better as 1 | -1)) : 0) as -1 | 0 | 1
  return { key, label, baseText: fmt(base), resolvedText: fmt(resolved), changed, higherBetter, direction }
}

/** The mod chips for the equipped stack, in the same sorted-id order the sim
 * folds them (so chip order matches the resolved stats). */
const buildMods = (e: Entity): LoadoutMod[] => {
  const stack = weaponStack(e)
  return (stack?.mods ?? [])
    .filter((m) => MODS[m.id] && m.stacks > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const def = MODS[m.id]
      return {
        id: def.id,
        name: def.name,
        icon: def.icon,
        desc: def.blurb,
        stacks: m.stacks,
        rarity: def.rarity,
        color: toCssHex(modPickupColor(def.id)),
      }
    })
}

/** Resolved bullet-behavior badges — only the effects the build actually grants. */
const buildBehaviors = (r: ResolvedWeapon): LoadoutBehavior[] => {
  const out: LoadoutBehavior[] = []
  const b = r.behavior
  if (b.pierce > 0) out.push({ key: 'pierce', icon: '🏹', label: `Pierce ×${b.pierce}` })
  if (b.bounce > 0) out.push({ key: 'bounce', icon: '🪃', label: `Bounce ×${b.bounce}` })
  if (b.homing > 0) out.push({ key: 'homing', icon: '🧲', label: 'Homing' })
  if (b.explodeRadius > 0) out.push({ key: 'explosive', icon: '💣', label: `Explosive (${b.explodeDamage})` })
  if (b.split > 0) out.push({ key: 'split', icon: '✳️', label: `Split ×${b.split}` })
  if (b.splinter > 0) out.push({ key: 'splinter', icon: '🔪', label: `Splinter ×${b.splinter}` })
  if (b.lifestealFrac > 0) out.push({ key: 'lifesteal', icon: '🩸', label: `Lifesteal ${Math.round(b.lifestealFrac * 100)}%` })
  if (r.onHit) out.push({ key: 'onhit', icon: '✨', label: `${r.onHit.status} on hit` })
  for (const t of r.triggers) out.push({ key: `trigger:${t.event}`, icon: '☠️', label: `On ${t.event}: blast` })
  return out
}

/**
 * Build the loadout view model for a player entity, or `null` when it holds no
 * weapon component at all (nothing to show). Bare fists / an unknown weapon id
 * resolve as `unarmed` with innate stats and no mods — never a crash or a blank.
 */
export const buildLoadout = (e: Entity | undefined): LoadoutModel | null => {
  if (!e || !e.combat) return null
  const wid = e.combat.weapon
  const def = WEAPONS[wid] ?? WEAPONS.fists
  const unarmed = !wid || wid === 'fists' || !WEAPONS[wid]

  const stack = weaponStack(e)
  const mods = unarmed ? [] : (stack?.mods ?? [])
  const base = resolveWeapon(def, [])
  const res = resolveWeapon(def, mods)

  const ranged = def.kind === 'ranged'
  const stats: LoadoutStat[] = [
    makeStat('damage', 'Damage', base.damage, res.damage, true, (n) => String(round(n))),
    makeStat('fireRate', 'Fire rate', fireRate(base.cooldownTicks), fireRate(res.cooldownTicks), true, (n) => `${round(n, 1)}/s`),
    makeStat('knockback', 'Knockback', base.knockback, res.knockback, true, (n) => String(round(n, 1))),
  ]
  if (ranged) {
    stats.push(makeStat('pellets', 'Pellets', base.pellets, res.pellets, true, (n) => String(round(n))))
    stats.push(makeStat('spread', 'Spread', degrees(base.spread), degrees(res.spread), false, (n) => `${round(n)}°`))
    stats.push(makeStat('speed', 'Bullet speed', base.projectileSpeed, res.projectileSpeed, true, (n) => String(round(n, 1))))
    stats.push(makeStat('range', 'Range', def.range, def.range, true, (n) => `${round(n)}t`))
    // No 'Magazine' row: guns carry no ammo, so there is no round count to show.
  } else {
    stats.push(makeStat('range', 'Reach', def.range, def.range, true, (n) => `${round(n, 1)}t`))
    if (def.durability) stats.push(makeStat('dura', 'Durability', def.durability, def.durability, true, (n) => String(round(n))))
  }

  return {
    weaponId: def.id,
    name: unarmed ? 'Unarmed' : def.name,
    kind: def.kind,
    unarmed,
    glyph: def.kind === 'ranged' ? '🔫' : unarmed ? '👊' : '🗡️',
    stats,
    mods: unarmed ? [] : buildMods(e),
    behaviors: buildBehaviors(res),
  }
}
