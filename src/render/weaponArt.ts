// Which weapons draw a held sprite, and whether they swing or shoot. The
// drawings themselves are pixel art in weaponSprites.ts (one per class per
// view, keyed by `weaponClass`); the pose that picks among them is
// weaponPose.ts. Pure: no pixi, no DOM, no RNG.

import { WEAPONS } from '../game/data/items'

/** Does this weapon draw a held sprite at all? NATURAL armament does not — bare
 * fists, or a Mireclaw's claws (a boss swinging a floating blade in its fist was
 * exactly the tell that it was a reskinned mutant). Everything else — including an
 * unknown id, which falls back to the rod — does. */
export const hasHeldWeapon = (id: string): boolean => WEAPONS[id]?.natural !== true

/** Is this a swinging (melee) weapon? Unknown ids default to melee so the
 * fallback rod still reads as a swing rather than freezing at a gun's idle hold. */
export const isMeleeWeapon = (id: string): boolean => WEAPONS[id]?.kind !== 'ranged'
