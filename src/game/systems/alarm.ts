// The station's EAR (#86). Gunfire and attacks the crew or the law notice build
// HEAT; enough heat raises the alarm one level; an alarm raised all the way
// the loud way LOCKS DOWN the Launch Bay.
//
// Data shape (all on `w.mission`, so a new floor resets it for free and a
// snapshot round-trips it; both fields are omitted when calm):
//   heat         — accumulated noticed noise, in ticks of sustained gunfire.
//                  Decays 1 per HEAT_DECAY_EVERY ticks; every HEAT_PER_ALARM
//                  raises `w.alarm` by one.
//   lockdownTick — latched when `w.alarm` reaches LOCKDOWN_ALARM before the
//                  heist finale. The bay's seal cycle runs from this tick, and
//                  the cycle restarts when the objective completes, so a loud run
//                  holds the prize under the manhunt for LOCKDOWN_TICKS before
//                  the bay opens. A timer, never a key: nothing any one player
//                  does can leave the floor unfinishable.
//
// Perception reuses the existing primitives: hearing is the noise-lure radius
// (goals.HEAR_RANGE, and every shot also emits a real noise that guards
// investigate), sight is `perceives`. No RNG, no wall-clock.

import type { Entity } from '../entity'
import type { EntityId } from '../types'
import { NOISE_TTL, type World } from '../world'
import { HEAR_RANGE, perceives } from './goals'
import { vlen } from '../simMath'
import { traitScale } from './traits'

/** Heat per alarm level: ~12.5 s of unbroken fire (net of decay) near a
 * witness, so lockdown takes ~37 s of it. See scripts/test/alarm-sweep.mts. */
export const HEAT_PER_ALARM = 300
/** Heat bleeds off 1 per this many ticks (6/s). A pistol at 18-tick cadence
 * nets +24/s while firing; a lone shot is gone in ~3 s. */
export const HEAT_DECAY_EVERY = 5
/** Heat a crew/law witness adds by SEEING a player get hit. One second of fire. */
export const ATTACK_SEEN_HEAT = 30
/** The alarm level that seals the Launch Bay. */
export const LOCKDOWN_ALARM = 3
/** How long the bay stays sealed once the seal cycle runs (20 s at 30 tps). */
export const LOCKDOWN_TICKS = 600

/** Can `e` notice a disturbance for the station? The crew and the law only —
 * vermin and gangs don't call it in — and only while awake. */
const isWitness = (e: Entity): boolean =>
  !!e.ai &&
  !e.dead &&
  !e.ai.dormant &&
  !(e.status && e.status.sleep > 0) &&
  (e.ai.faction === 'civ' || e.ai.faction === 'cop')

const addHeat = (w: World, amount: number, cause: 'gunfire' | 'attack'): void => {
  if (w.alarm >= LOCKDOWN_ALARM) return // saturated: nothing left to raise
  let heat = (w.mission.heat ?? 0) + amount
  while (heat >= HEAT_PER_ALARM && w.alarm < LOCKDOWN_ALARM) {
    heat -= HEAT_PER_ALARM
    w.alarm++
    w.events.push({ type: 'alarmRaised', level: w.alarm, cause })
  }
  if (w.alarm >= LOCKDOWN_ALARM || heat <= 0) delete w.mission.heat
  else w.mission.heat = heat
}

/**
 * A player fired a gun. The shot is a real noise (guards come to investigate
 * it, dormant pods wake to it) and, if any crew/law member is within earshot,
 * `loudness` heat. Pass the shot's cadence in ticks, so heat tracks time spent
 * firing and a machinegun is not 3.6x louder than a pistol per second.
 */
export const hearGunfire = (w: World, shooter: Entity, loudness: number): void => {
  const { x, y } = shooter.pos
  const reach = traitScale(shooter, 'shotNoise')
  // A burst refreshes one noise instead of stacking dozens at the same spot,
  // and the refreshed noise carries as far as the louder of the two shots.
  const near = w.noises.find((n) => vlen(n.x - x, n.y - y) <= 1)
  if (near) {
    near.x = x
    near.y = y
    near.expires = w.tick + NOISE_TTL
    const louder = Math.max(near.reach ?? 1, reach)
    if (louder < 1) near.reach = louder
    else delete near.reach
  } else w.noises.push({ x, y, expires: w.tick + NOISE_TTL, ...(reach < 1 ? { reach } : {}) })
  for (const e of w.entities) {
    if (e === shooter || !isWitness(e)) continue
    if (vlen(e.pos.x - x, e.pos.y - y) > HEAR_RANGE * reach) continue
    addHeat(w, loudness, 'gunfire')
    return
  }
}

/** An NPC landed a blow on a player. If a crew/law member other than the
 * attacker SEES it, heat rises. The law beating you up is not news. */
export const seeAttackOnPlayer = (w: World, victim: Entity, attackerId: EntityId): void => {
  const attacker = w.byId.get(attackerId)
  if (!attacker || attacker.playerCtl || attacker.ai?.faction === 'cop') return
  for (const e of w.entities) {
    if (e === attacker || !isWitness(e)) continue
    if (!perceives(w, e, victim)) continue
    addHeat(w, ATTACK_SEEN_HEAT, 'attack')
    return
  }
}

/** Is the Launch Bay held shut by a lockdown right now? Purely a timer, so the
 * seal always lifts on its own. Before the objective the bay is shut anyway;
 * completion restarts the cycle (missions.completeMission), which is when it bites. */
export const exitSealed = (w: World): boolean => {
  const at = w.mission.lockdownTick
  return at !== undefined && w.tick < at + LOCKDOWN_TICKS
}

/** What the HUD shows about the lockdown: undefined when there is none to show;
 * `{}` while it waits on the objective (the cycle restarts then, so a countdown
 * now would mislead); `{ secondsLeft }` while the bay is sealed after it. */
export const lockdownView = (w: World): { secondsLeft?: number } | undefined => {
  const at = w.mission.lockdownTick
  if (at === undefined) return undefined
  // An extraction's cycle restarts at the grab, so it counts down while the prize is carried.
  const running = w.mission.complete || (w.mission.template === 'extraction' && w.mission.alertTick !== undefined)
  if (!running) return {}
  if (!exitSealed(w)) return undefined
  return { secondsLeft: Math.ceil((at + LOCKDOWN_TICKS - w.tick) / 30) }
}

/** Per tick, from missionSystem: bleed heat, latch the lockdown, announce the
 * bay reopening. The finale (gateway breach / station alert) maxes the alarm on
 * purpose; that is the heist working, not the player being loud, so it never
 * latches a lockdown. */
export const alarmSystem = (w: World): void => {
  const m = w.mission
  if (m.heat !== undefined && w.tick % HEAT_DECAY_EVERY === 0) {
    if (--m.heat <= 0) delete m.heat
  }
  if (m.lockdownTick === undefined) {
    if (w.alarm < LOCKDOWN_ALARM || m.bossAggroTriggered || m.alertTick !== undefined) return
    m.lockdownTick = w.tick
    w.events.push({ type: 'lockdown' })
    return
  }
  if (m.complete && w.tick === m.lockdownTick + LOCKDOWN_TICKS) w.events.push({ type: 'lockdownLifted' })
}
