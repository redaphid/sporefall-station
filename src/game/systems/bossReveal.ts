// THE BOSS ENTRANCE — the shared latch every boss announces itself through.
//
// Extracted verbatim from systems/mireclaw.ts, which is still its only other
// caller. It is here rather than there because every boss needs it and a boss
// system importing a DIFFERENT boss's system to borrow one helper would be a
// dependency nobody expects.
//
// WHY A BOSS MUST NOT ACT BEFORE IT IS SEEN. This is not presentation. The
// Mireclaw shipped without it and its phase machinery ran from tick 0, so the
// Alpha hit its 8-brood cap about ten seconds into the floor — minutes before
// anyone opened the door. Players then walked into a static room of sporelings
// and never once saw a boss summon anything. A boss that acts before it is
// witnessed spends its entire kit on an empty room.
//
// Every boss inherits that failure unless it gates on this. The Vigil would
// otherwise spend its escalating wake budget on noise nobody was there to make.

import type { Entity } from '../entity'
import type { World } from '../world'
import { canSeeEntity } from './goals'
import { vlen } from '../simMath'

/** Tiles at which a live player's first unbroken sight of a boss counts as the
 * ENTRANCE — comfortably inside a room, so the reveal fires as the door swings
 * rather than through a corridor slit half a level away. */
export const REVEAL_RANGE = 11

/** A live player who can actually SEE this boss right now, within reveal range. */
const witness = (w: World, boss: Entity): Entity | undefined => {
  for (const e of w.entities) {
    if (!e.playerCtl || e.dead || e.playerCtl.downed) continue
    if (vlen(e.pos.x - boss.pos.x, e.pos.y - boss.pos.y) > REVEAL_RANGE) continue
    if (canSeeEntity(w, e, boss)) return e
  }
  return undefined
}

/**
 * The ENTRANCE. The first time a live player lays eyes on the boss, announce it:
 * one latched `bossReveal` event carrying its id and max HP, which the UI turns
 * into a name card and pins a health bar to (ui/bossModel.ts).
 *
 * Returns whether the boss is revealed — so a boss system's whole body can sit
 * behind `if (!maybeRevealBoss(w, boss)) continue`.
 *
 * Latched on `mission.bossRevealed` (once per floor, and it survives
 * serialization) so walking back out of the room and in again never re-fires it.
 * Deterministic: a pure read of positions plus line of sight, no RNG and no
 * wall-clock.
 */
export const maybeRevealBoss = (w: World, boss: Entity): boolean => {
  if (w.mission.bossRevealed) return true
  if (!witness(w, boss)) return false
  w.mission.bossRevealed = true
  w.events.push({ type: 'bossReveal', entityId: boss.id, x: boss.pos.x, y: boss.pos.y, maxHp: boss.health!.max })
  return true
}
