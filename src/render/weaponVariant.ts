/**
 * The WEAPON dimension of character animation: the seam where per-weapon
 * draws, aims and braces slot in (docs/themes.md "Weapon variants").
 *
 * A character's clip for a state may one day differ by what it holds: a
 * sidearm quickdraw, a long gun shouldered, a heavy gun braced against its
 * recoil. Every such lookup walks ONE chain, most specific first:
 *
 *   exact weapon (`@pistol`) → weapon class (`@sidearm`) → the generic state
 *
 * so a pack that draws no weapon-specific art behaves exactly as before. Today
 * the chain resolves per-frame clip timings (`animTiming` keys
 * `<kind>.<state>@<variant>`); the frame keys
 * `char.<kind>.<dir>-<state>@<variant>-<n>` are reserved for the same chain.
 * Pure: no pixi, no world.
 */

import { WEAPONS } from '../game/data/items'

/** Coarse families a body handles alike: how it is drawn, aimed and braced. */
export const WEAPON_CLASSES = ['sidearm', 'longgun', 'heavy', 'melee1h', 'melee2h', 'natural'] as const
export type WeaponClass = (typeof WEAPON_CLASSES)[number]

/** Weapons whose class their `kind` alone does not tell. */
const CLASS_OF: Readonly<Record<string, WeaponClass>> = {
  pistol: 'sidearm',
  stunGun: 'sidearm',
  tranquilizer: 'sidearm',
  shotgun: 'longgun',
  freezeRay: 'longgun',
  machinegun: 'heavy',
  flamethrower: 'heavy',
  sledgehammer: 'melee2h',
}

/** A weapon's class, or undefined for an id that is no weapon. */
export const weaponClassOf = (id: string): WeaponClass | undefined => {
  const own = CLASS_OF[id]
  if (own !== undefined) return own
  const def = WEAPONS[id]
  if (def === undefined) return undefined
  if (def.natural === true) return 'natural'
  return def.kind === 'ranged' ? 'sidearm' : 'melee1h'
}

/** The variant suffixes to try for a held weapon, most specific first; the
 * last is always '' (the generic state). */
export const weaponVariants = (weaponId: string | undefined): readonly string[] => {
  if (weaponId === undefined) return ['']
  const cls = weaponClassOf(weaponId)
  return cls === undefined ? [''] : [`@${weaponId}`, `@${cls}`, '']
}

/** Every variant name a key may carry: a weapon id or a class. */
export const isWeaponVariant = (v: string): boolean =>
  (WEAPON_CLASSES as readonly string[]).includes(v) || WEAPONS[v] !== undefined

/** The first of `base + variant` (variants most specific first) that `lookup`
 * resolves, or undefined. */
export const pickVariant = <T>(
  base: string,
  weaponId: string | undefined,
  lookup: (key: string) => T | undefined,
): T | undefined => {
  for (const v of weaponVariants(weaponId)) {
    const hit = lookup(base + v)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** The frame keys a weapon-aware loader tries for frame n, most specific first
 * (reserved grammar: today's loader reads only the generic last key). */
export const frameKeyChain = (kind: string, dir: string, state: string, n: number, weaponId?: string): string[] =>
  weaponVariants(weaponId).map((v) => `char.${kind}.${dir}-${state}${v}-${n}`)
