// The held-weapon SILHOUETTE grammar. Every wielded weapon (melee or ranged)
// maps to one of a small set of procedural shapes, drawn grip-anchored so the
// renderer can pin it to the wielder's hand and rotate it around the grip for
// the swing. This is the ONE place a weapon id gets its shape, and — critically —
// EVERY id resolves to a shape, so a weapon is never invisible (the bug this
// feature fixes). Pure: no pixi, no DOM, no RNG — just id → shape, unit-testable.

import { WEAPONS } from '../game/data/items'

/** The drawable held-weapon silhouettes. `rod` is the guaranteed fallback for an
 * unknown id, so an unregistered weapon still shows *something* in hand. */
export type WeaponShape = 'hammer' | 'club' | 'blade' | 'gun' | 'rod'

/** Per-melee-id silhouette. Ranged weapons all share the `gun` shape (resolved
 * from the registry kind below), so only the distinctive melee shapes are named
 * here. `fists` is present so `weaponShape` is total, but it draws no held sprite
 * (see `hasHeldWeapon`) — bare hands hold nothing. */
const MELEE_SHAPE: Record<string, WeaponShape> = {
  sledgehammer: 'hammer',
  bat: 'club',
  knife: 'blade',
  fists: 'rod',
  claws: 'blade',
}

/**
 * Weapon id → silhouette. Named melee shapes win; otherwise the registry kind
 * decides (ranged → gun, any other registered melee → club); an id absent from
 * the registry falls back to a generic `rod` so it is NEVER invisible.
 */
export const weaponShape = (id: string): WeaponShape => {
  const named = MELEE_SHAPE[id]
  if (named) return named
  const def = WEAPONS[id]
  if (def) return def.kind === 'ranged' ? 'gun' : 'club'
  return 'rod'
}

/** Does this weapon draw a held sprite at all? NATURAL armament does not — bare
 * fists, or a Mireclaw's claws (a boss swinging a floating blade in its fist was
 * exactly the tell that it was a reskinned thug). Everything else — including an
 * unknown id, which falls back to the rod — does. */
export const hasHeldWeapon = (id: string): boolean => WEAPONS[id]?.natural !== true

/** Is this a swinging (melee) weapon? Unknown ids default to melee so the
 * fallback rod still reads as a swing rather than freezing at a gun's idle hold. */
export const isMeleeWeapon = (id: string): boolean => WEAPONS[id]?.kind !== 'ranged'

/** The weapon-sprite canvas. Weapons are drawn pointing +x (east) with the grip
 * near the left edge, so rotating the sprite around `grip` swings the head. */
export const WEAPON_CANVAS = { w: 44, h: 18, grip: 5 } as const

/** The grip anchor (fraction of the canvas) the renderer pins to the hand and
 * rotates the swing around: horizontally at the grip, vertically centred. */
export const WEAPON_ANCHOR = { x: WEAPON_CANVAS.grip / WEAPON_CANVAS.w, y: 0.5 } as const
