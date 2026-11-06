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
  cageRam: 'hammer',
  pressureLance: 'club',
  siphonSpike: 'blade',
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
 * exactly the tell that it was a reskinned mutant). Everything else — including an
 * unknown id, which falls back to the rod — does. */
export const hasHeldWeapon = (id: string): boolean => WEAPONS[id]?.natural !== true

/** Is this a swinging (melee) weapon? Unknown ids default to melee so the
 * fallback rod still reads as a swing rather than freezing at a gun's idle hold. */
export const isMeleeWeapon = (id: string): boolean => WEAPONS[id]?.kind !== 'ranged'

/** The weapon-sprite AUTHORING canvas. Weapons are drawn pointing +x (east)
 * with the grip near the left edge, so rotating the sprite around `grip` swings
 * the head. This is drawing room, not the size the weapon shows at: a 44px
 * canvas held 1:1 against a 48px character made every pistol nearly as long as
 * the body holding it. `heldScale` shrinks it to `HELD_LENGTH`. */
export const WEAPON_CANVAS = { w: 44, h: 18, grip: 5 } as const

/** Grip-to-tip span of the authoring canvas: the length `HELD_LENGTH` maps onto. */
export const CANVAS_REACH = WEAPON_CANVAS.w - WEAPON_CANVAS.grip

/** How long each silhouette reads IN THE HAND, grip to tip, in character-canvas
 * px (the 48px `CHAR_PX` frame; the renderer scales it with CHAR_PX). Sized off
 * the bodies the packs draw: a diver stands ~45 of its 48px, and the pistol its
 * hand-painted `draw` clip holds is ~7px (13px at the hi-res pack's 96). A held
 * pistol at 10 reads as a pistol at play zoom without outsizing the hand-painted
 * one by more than ~1.5x; the one-handed tools sit near it, and only the
 * two-handed sledge reaches half the body. Every value stays under half the
 * character, which `weaponArt.test.ts` and the render-layer test pin. */
export const HELD_LENGTH: Record<WeaponShape, number> = {
  gun: 10,
  blade: 8,
  club: 12,
  hammer: 22,
  rod: 12,
}

/** Sprite scale that shows weapon `id`'s authored canvas at its `HELD_LENGTH`
 * (before the mod skin's growth and the CHAR_PX/48 factor). */
export const heldScale = (id: string): number => HELD_LENGTH[weaponShape(id)] / CANVAS_REACH

/** The grip anchor (fraction of the canvas) the renderer pins to the hand and
 * rotates the swing around: horizontally at the grip, vertically centred. */
export const WEAPON_ANCHOR = { x: WEAPON_CANVAS.grip / WEAPON_CANVAS.w, y: 0.5 } as const
