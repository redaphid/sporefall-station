// Group-granted modifiers, as pure per-entity reads.
//
// The group layer (systems/groups.ts) STAMPS absolute-tick windows onto members
// (`ai.rallyUntil` from a leader's aura, `ai.rageUntil` from a pack's manhunter
// rage); the movement and damage paths READ them through these two functions.
// Kept in a leaf module with no imports so movement.ts and combat.ts can use it
// without pulling the group system (and its spawn/populate imports) into their
// import graph. Absent windows → ×1, so no entity outside a group is touched.

import type { Entity } from '../entity'

/** Walk-speed multiplier while RALLIED by a leader. */
export const RALLY_SPEED = 1.15
/** Incoming-damage multiplier while RALLIED (a quarter off every hit). */
export const RALLY_DAMAGE = 0.75
/** Walk-speed multiplier while a pack is MANHUNTER. 4.2 * 1.2 = 5.04 — a raging
 * hound outruns the player (4.5); the rage is the part you do not walk away from. */
export const RAGE_SPEED = 1.2

const active = (until: number | undefined, tick: number): boolean => until !== undefined && tick < until

/** Movement speed multiplier from group effects (1 when none apply). */
export const groupSpeedMult = (e: Entity, tick: number): number => {
  const ai = e.ai
  if (!ai) return 1
  let m = 1
  if (active(ai.rallyUntil, tick)) m *= RALLY_SPEED
  if (active(ai.rageUntil, tick)) m *= RAGE_SPEED
  return m
}

/** Incoming-damage multiplier from group effects (1 when none apply). */
export const groupDamageMult = (e: Entity, tick: number): number =>
  e.ai && active(e.ai.rallyUntil, tick) ? RALLY_DAMAGE : 1
