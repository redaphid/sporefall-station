// Attack commitment — the CONTACT system issue #1 asked for.
//
// Before this, every NPC's whole contact routine was three lines in ai.ts:
// face the target, `fireWeapon`, return. The audit measured the result — 11 of
// 13 archetypes producing one mode, one goal and one constant swing interval —
// so approach intelligence (squads, flanks, predator ecology) never reached the
// part of the fight the player is looking at, and the dodge roll's i-frames had
// nothing to dodge.
//
// Now an attack is a three-phase commitment stamped in ABSOLUTE ticks:
//
//   beginAttack  → e.attack = { activeAt, recoverAt, endAt, aim, … }
//   wind-up      → planted, telegraphing; tracks the target until `lockAt`, then
//                  the aim FREEZES. A stun/freeze/sleep here BREAKS it outright.
//   active       → strikes resolve on their exact ticks. UNCANCELLABLE — a body
//                  stunned after the wind-up completes still swings.
//   recovery     → planted and taking PUNISH_MULT damage. The reward for reading.
//   endAt        → the component is dropped; absence == "free", exactly like
//                  `playerCtl.roll`.
//
// DETERMINISM. Every field is an absolute tick or a plain number, so a snapshot
// taken mid-wind-up deserializes and replays bit-identically with no fixup
// (`serialize.ts` clones entities verbatim — no whitelist to update). The RNG is
// touched at most twice per commitment, both draws at `beginAttack`: a wind-up
// jitter so a pack does not attack in lockstep, and (ranged only) the aim error
// that used to be redrawn every tick in the old fire loop. No wall-clock, no
// per-frame accumulators, no unseeded randomness.

import { WEAPONS } from '../data/items'
import { TELLS, tellFor, type Tell } from '../data/tells'
import type { Entity } from '../entity'
import type { EntityId } from '../types'
import type { World } from '../world'
import { fireWeapon } from './combat'
import { isImmobilized } from './statusFx'

/** Max extra wind-up ticks drawn once per commitment (0..JITTER_TICKS
 * inclusive). It only ever LENGTHENS a wind-up, so it shifts the dodge window
 * later without narrowing it — a pack stops attacking in lockstep, and the
 * player's reaction budget for a given tell is unchanged. */
const JITTER_TICKS = 4
/** Spread of the one-shot NPC aim error, in radians — the old per-tick
 * `(rng.next() - 0.5) * 0.15` jitter, now drawn ONCE and baked into the locked
 * aim so a ranged tell is a line the player can actually step off. */
const AIM_ERROR = 0.15

/** The phases of a committed attack. `none` = free to act. */
export type AttackPhase = 'none' | 'windup' | 'active' | 'recovery'

/**
 * A committed attack in flight. All ticks ABSOLUTE, all fields plain JSON —
 * same discipline as `playerCtl.roll`, so it round-trips losslessly and a
 * mid-wind-up snapshot resumes on exactly the right tick.
 */
export interface AttackState {
  /** Key into `TELLS` — the silhouette being performed, and the presentation
   * key the renderer/mixer/haptics switch on. */
  shape: string
  /** Tick the wind-up began (the telegraph's start, for a fill-up bar). */
  startAt: number
  /** Tick the aim freezes. Before it the body still tracks its target. */
  lockAt: number
  /** Tick the FIRST strike lands — the end of the wind-up and of cancellability. */
  activeAt: number
  /** Tick recovery begins (one past the last strike). */
  recoverAt: number
  /** Tick the whole commitment releases and the body is free again. */
  endAt: number
  /** The aim (radians) the strikes resolve along, frozen at `lockAt`. */
  aim: number
  /** Index of the next unresolved strike in the tell's `strikes` list. */
  next: number
  /** Who the commitment was aimed at — presentation only (the telegraph tells
   * THAT player they are the one about to be hit). Never re-homed after `lockAt`. */
  targetId?: EntityId
}

/** The tell `a` is performing, defaulting defensively so a snapshot naming a
 * retired shape still resolves rather than throwing mid-replay. */
const tellOf = (a: AttackState): Tell => TELLS[a.shape] ?? TELLS.swing

/** Which phase `e` is in at `tick`. Derived from the absolute windows rather
 * than stored, so it can never disagree with them. */
export const attackPhase = (e: Entity, tick: number): AttackPhase => {
  const a = e.attack
  if (!a || tick >= a.endAt) return 'none'
  if (tick < a.activeAt) return 'windup'
  if (tick < a.recoverAt) return 'active'
  return 'recovery'
}

/** True while `e` is locked into an attack and may not think, steer or start
 * another — the single "is this body busy" predicate, mirroring `isRolling`. */
export const isCommitted = (e: Entity, tick: number): boolean => attackPhase(e, tick) !== 'none'

/** True while `e` is telegraphing: the readable window, and the ONLY phase an
 * interrupt can cancel. What the renderer draws a cone for. */
export const isWindingUp = (e: Entity, tick: number): boolean => attackPhase(e, tick) === 'windup'

/** True while `e` is in its punish window — planted and taking extra damage. */
export const isRecovering = (e: Entity, tick: number): boolean => attackPhase(e, tick) === 'recovery'

/** The exact predicate ai.ts/movement.ts/roll.ts use for "cannot act". A
 * wind-up caught by any of these is broken; an ACTIVE window ignores it. */
const isInterrupted = (e: Entity): boolean =>
  (e.status !== undefined && (e.status.stun > 0 || e.status.sleep > 0)) || isImmobilized(e)

/**
 * Drop a commitment without resolving it and tell the world why. The ONE
 * cancel path, so a wind-up broken by a stun, a freeze or a death always leaves
 * the same (empty) state behind — no dangling windows on a corpse, and the
 * renderer always gets a matching close for every `attackWindup` it opened.
 */
export const breakAttack = (w: World, e: Entity, reason: 'stun' | 'death'): void => {
  const a = e.attack
  if (!a) return
  e.attack = undefined
  w.events.push({ type: 'attackBreak', entityId: e.id, x: e.pos.x, y: e.pos.y, shape: a.shape, reason })
}

/**
 * Commit `e` to an attack on `target`. Callers gate on `combat.cooldown <= 0`
 * and on `!isCommitted` — this is the one entry point, so every NPC attack in
 * the game goes through a wind-up and there is no path back to the instant swing.
 *
 * Draws from `w.rng` exactly once (wind-up jitter), twice for a ranged tell
 * (plus the one-shot aim error) — always in that order, so the stream position
 * after a commitment is a pure function of the tell's weapon kind.
 */
export const beginAttack = (w: World, e: Entity, target: Entity): void => {
  const tell = tellFor(e)
  const jitter = w.rng.int(0, JITTER_TICKS)
  const activeAt = w.tick + tell.windup + jitter
  const last = tell.strikes[tell.strikes.length - 1]
  let aim = Math.atan2(target.pos.y - e.pos.y, target.pos.x - e.pos.x)
  if ((WEAPONS[e.combat?.weapon ?? 'fists'] ?? WEAPONS.fists).kind === 'ranged') {
    aim += (w.rng.next() - 0.5) * AIM_ERROR
  }
  e.attack = {
    shape: tell.shape,
    startAt: w.tick,
    // Never before the current tick: a tell whose `lock` exceeds its wind-up
    // (or a big jitter) must still leave a coherent, non-negative window.
    lockAt: Math.max(w.tick, activeAt - tell.lock),
    activeAt,
    recoverAt: activeAt + last + 1,
    endAt: activeAt + last + 1 + tell.recovery,
    aim,
    next: 0,
    targetId: target.id,
  }
  e.facing = aim
  w.events.push({
    type: 'attackWindup',
    entityId: e.id,
    x: e.pos.x,
    y: e.pos.y,
    shape: tell.shape,
    aim,
    // The renderer/mixer get the whole schedule up front, so a net CLIENT (which
    // never receives the component itself) can draw the identical telegraph from
    // this one event — absolute ticks, so it stays in sync with no extrapolation.
    activeAt,
    recoverAt: activeAt + last + 1,
    endAt: activeAt + last + 1 + tell.recovery,
    targetId: target.id,
  })
}

/** Resolve one strike of an in-flight commitment along its frozen aim. */
const strike = (w: World, e: Entity, a: AttackState, tell: Tell, index: number): void => {
  e.facing = a.aim
  // A lunge/slam carries its body into the blow. Applied as knockback-style
  // velocity, so it runs through the normal movement + collision path and can
  // never punch a committed enemy through a wall.
  if (index === 0 && tell.dash) {
    e.vel.x += Math.cos(a.aim) * tell.dash
    e.vel.y += Math.sin(a.aim) * tell.dash
  }
  w.events.push({
    type: 'attackStrike',
    entityId: e.id,
    x: e.pos.x,
    y: e.pos.y,
    shape: a.shape,
    aim: a.aim,
    index,
  })
  // THE shared fire path — mods, elements, pellets and projectile behavior all
  // still apply to NPC attacks exactly as before; only the timing and the
  // per-tell damage/arc shaping are new.
  fireWeapon(w, e, { damageMult: tell.damage, arcDot: tell.arcDot })
}

/**
 * Advance `e`'s commitment by one tick. Returns true while the body is still
 * locked in (the caller must NOT think or steer it), false once it is free.
 *
 * Called from `aiSystem` BEFORE the stun/immobilize guard on purpose: that is
 * what makes the active window uncancellable. A body stunned during its wind-up
 * breaks (the counterplay); a body stunned one tick later is stuck with the
 * swing and then with the whole recovery it cannot act out of.
 */
export const stepAttack = (w: World, e: Entity): boolean => {
  const a = e.attack
  if (!a) return false
  if (w.tick >= a.endAt) {
    e.attack = undefined
    return false
  }
  const tell = tellOf(a)

  if (w.tick < a.activeAt) {
    // WIND-UP: interruptible, and the only phase that still tracks.
    if (isInterrupted(e)) {
      breakAttack(w, e, 'stun')
      return false
    }
    if (w.tick < a.lockAt) {
      const t = a.targetId !== undefined ? w.byId.get(a.targetId) : undefined
      if (t && !t.dead) a.aim = Math.atan2(t.pos.y - e.pos.y, t.pos.x - e.pos.x)
    }
    e.facing = a.aim
    e.intent.x = 0
    e.intent.y = 0
    return true
  }

  // ACTIVE + RECOVERY: planted and committed. A target that died, fled or
  // rolled clear during the wind-up does NOT spare the attacker — it swings at
  // where the fight was, which is the whole point of a commitment.
  e.facing = a.aim
  e.intent.x = 0
  e.intent.y = 0
  while (a.next < tell.strikes.length && w.tick >= a.activeAt + tell.strikes[a.next]) {
    strike(w, e, a, tell, a.next)
    a.next++
  }
  // One `attackRecover` per commitment: the tick recovery opens is unique, and
  // a committed body is stepped every tick (the guard runs before the stun
  // early-out), so this can neither double-fire nor be skipped.
  if (w.tick === a.recoverAt) {
    w.events.push({ type: 'attackRecover', entityId: e.id, x: e.pos.x, y: e.pos.y, shape: a.shape, endAt: a.endAt })
  }
  return true
}
