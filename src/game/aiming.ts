/**
 * AIMING: does a body hold a ranged weapon ready, pointed down `entity.facing`?
 *
 * A pure read of state the sim already keeps; nothing here mutates the world.
 * The renderer plays the `aim`/`aimwalk` loops from it (render/animTracker.ts),
 * and the host sends its verdict to co-op clients (net/protocol `aim` trailer),
 * which hold no AI or combat state of their own and read `aimShown` instead.
 *
 * - An NPC aims while its AI is engaged (`ai.mode === 'aggro'`: battle or
 *   pursuit) with a ranged weapon, once its engage wind-up has run
 *   (`ai.draw.readyAt`, the same gate that holds its first shot). Fleeing,
 *   seeking, idle, dormant: not engaged, so not aiming.
 * - A player aims whenever it holds a ranged weapon and is free to use it. The
 *   aim it points is the sim's own: movement.ts sets `facing` from the
 *   InputCmd's aim vector (the aim stick or mouse, else the move direction),
 *   and every shot fires along it. The InputCmd does not say which of those it
 *   was, so the player's gun is always up: the twin-stick shooter's stance.
 * - Neither aims while stunned, asleep, frozen or shocked (isMovementLocked):
 *   such a body cannot fire.
 */

import { WEAPONS } from './data/items'
import type { Entity } from './entity'
import { isMovementLocked } from './systems/statusFx'

/** Past the engage wind-up at `tick` (always, for a body without one). This is
 * the gate systems/ai.ts holds an NPC's attacks behind. */
export const weaponDrawn = (e: Entity, tick: number): boolean => e.ai?.draw === undefined || tick >= e.ai.draw.readyAt

const holdsRanged = (e: Entity): boolean => {
  const id = e.combat?.weapon
  return id !== undefined && WEAPONS[id]?.kind === 'ranged'
}

/** Is `e` aiming as of `tick` (the world's tick: the next one to run)? */
export const isAiming = (e: Entity, tick: number): boolean => {
  if (e.aimShown !== undefined) return e.aimShown
  if (e.dead || !holdsRanged(e) || isMovementLocked(e)) return false
  const pc = e.playerCtl
  if (pc) return pc.downed === undefined && pc.channel === undefined && pc.draft === undefined
  const ai = e.ai
  return ai !== undefined && ai.mode === 'aggro' && ai.dormant !== true && weaponDrawn(e, tick)
}
