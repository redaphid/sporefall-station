// Pure builder for the LOADOUT panel — the "detailed gun + mods" readout shown on
// the pause and death screens. Given a player entity it produces a DOM-free view
// model: the equipped weapon's name/kind/glyph, its BASE vs EXECUTED stats (so
// the player sees exactly what their build fires), one coloured chip per
// applied mod with its verdict (working, inert, or downside-only), and the
// bullet-behavior badges the fire path will actually run.
//
// It reuses the sim's single sources of truth — WEAPONS (data/items), MODS
// (data/mods), `weaponStack` (systems/inventory) for the equipped stack's mod
// list, `executedShot`/`modVerdict` (systems/modEffect) for what fires, and
// `modPickupColor` (render/modColors) for each mod's signature gem hue — so the
// panel never re-derives balance numbers or colours. Kept pure so it is unit-
// tested exhaustively and the panel just paints the result.

import type { Entity } from '../game/entity'
import { WEAPONS } from '../game/data/items'
import { MODS, type ModRarity } from '../game/data/mods'
import { weaponStack } from '../game/systems/inventory'
import { executedShot, modVerdict, type ExecutedShot, type ModVerdict } from '../game/systems/modEffect'
import { planCasts, sequenceShape } from '../game/systems/modSequence'
import type { ModCasting } from '../game/world'
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
  /** What the mod does on this weapon when it fires. */
  verdict: ModVerdict
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
  /** Sequenced casting: stats and effects describe the next shot only, since
   * each cast fires just its own mods. Default casting: every shot. */
  statsScope: 'every shot' | 'next shot'
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

/**
 * The verdict for mod `modId` on `self`'s weapon, or undefined when `self` holds
 * no real weapon. A mod `self` does not carry yet is judged as if picked up,
 * which is what the draft and a pickup's inspect card need.
 */
export const selfModVerdict = (
  self: Entity | undefined,
  modId: string,
  modCasting: ModCasting | undefined,
): ModVerdict | undefined => {
  const def = self?.combat && WEAPONS[self.combat.weapon]
  if (!def || def.id === 'fists') return undefined
  return modVerdict(def, weaponStack(self!)?.mods ?? [], modId, modCasting === 'sequence')
}

/** Bullet-behavior badges — only the effects the fire path executes. */
const buildBehaviors = (r: ExecutedShot): LoadoutBehavior[] => {
  const out: LoadoutBehavior[] = []
  const b = r.behavior
  if (b) {
    if (b.pierce > 0) out.push({ key: 'pierce', icon: '🏹', label: `Pierce ×${b.pierce}` })
    if (b.bounce > 0) out.push({ key: 'bounce', icon: '🪃', label: `Bounce ×${b.bounce}` })
    if (b.homing > 0) out.push({ key: 'homing', icon: '🧲', label: 'Homing' })
    if (b.explodeRadius > 0) out.push({ key: 'explosive', icon: '💣', label: `Explosive (${b.explodeDamage})` })
    if (b.split > 0) out.push({ key: 'split', icon: '✳️', label: `Split ×${b.split}` })
    if (b.splinter > 0) out.push({ key: 'splinter', icon: '🔪', label: `Splinter ×${b.splinter}` })
    if (b.lifestealFrac > 0) out.push({ key: 'lifesteal', icon: '🩸', label: `Lifesteal ${Math.round(b.lifestealFrac * 100)}%` })
  }
  if (r.onHit) out.push({ key: 'onhit', icon: '✨', label: `${r.onHit.status} on hit` })
  for (const t of r.triggers) out.push({ key: `trigger:${t.event}`, icon: '☠️', label: `On ${t.event}: blast` })
  return out
}

/**
 * Build the loadout view model for a player entity, or `null` when it holds no
 * weapon component at all (nothing to show). Bare fists / an unknown weapon id
 * resolve as `unarmed` with innate stats and no mods — never a crash or a blank.
 */
export const buildLoadout = (e: Entity | undefined, modCasting?: ModCasting): LoadoutModel | null => {
  if (!e || !e.combat) return null
  const wid = e.combat.weapon
  const def = WEAPONS[wid] ?? WEAPONS.fists
  const unarmed = !wid || wid === 'fists' || !WEAPONS[wid]
  const sequenced = modCasting === 'sequence'

  const stack = weaponStack(e)
  const mods = unarmed ? [] : (stack?.mods ?? [])
  // Sequenced: the next shot fires only the mods of the cast it plans next.
  const firing = sequenced && mods.length > 0 ? (planCasts(mods, sequenceShape(def), stack?.castIndex ?? 0).casts[0]?.mods ?? []) : mods
  const base = executedShot(def, [])
  const res = executedShot(def, firing)

  const stats: LoadoutStat[] = [
    makeStat('damage', 'Damage', base.damage, res.damage, true, (n) => String(round(n))),
    makeStat('fireRate', 'Fire rate', fireRate(base.cooldownTicks), fireRate(res.cooldownTicks), true, (n) => `${round(n, 1)}/s`),
  ]
  if (def.kind === 'ranged') {
    // No Knockback row: a bullet's shove is fixed, whatever the mods say.
    stats.push(makeStat('pellets', 'Pellets', base.pellets!, res.pellets!, true, (n) => String(round(n))))
    // Spread only aims a fan; a lone pellet always flies straight.
    if (res.spread !== undefined) stats.push(makeStat('spread', 'Spread', degrees(base.spread ?? 0), degrees(res.spread), false, (n) => `${round(n)}°`))
    stats.push(makeStat('speed', 'Bullet speed', base.projectileSpeed!, res.projectileSpeed!, true, (n) => String(round(n, 1))))
    stats.push(makeStat('range', 'Range', def.range, def.range, true, (n) => `${round(n)}t`))
    // No 'Magazine' row: guns carry no ammo, so there is no round count to show.
  } else {
    stats.push(makeStat('knockback', 'Knockback', base.knockback!, res.knockback!, true, (n) => String(round(n, 1))))
    stats.push(makeStat('range', 'Reach', def.range, def.range, true, (n) => `${round(n, 1)}t`))
    if (def.durability) stats.push(makeStat('dura', 'Durability', def.durability, def.durability, true, (n) => String(round(n))))
  }

  // Chips in the same sorted-id order the default fold visits them.
  const chips: LoadoutMod[] = mods
    .filter((m) => MODS[m.id] && m.stacks > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const d = MODS[m.id]
      return {
        id: d.id,
        name: d.name,
        icon: d.icon,
        desc: d.blurb,
        stacks: m.stacks,
        rarity: d.rarity,
        color: toCssHex(modPickupColor(d.id)),
        verdict: modVerdict(def, mods, d.id, sequenced),
      }
    })

  return {
    weaponId: def.id,
    name: unarmed ? 'Unarmed' : def.name,
    kind: def.kind,
    unarmed,
    glyph: def.kind === 'ranged' ? '🔫' : unarmed ? '👊' : '🗡️',
    statsScope: sequenced ? 'next shot' : 'every shot',
    stats,
    mods: chips,
    behaviors: buildBehaviors(res),
  }
}
