// AI goal primitives — the perception + desirability scoring toolkit the
// pluggable behaviors (./behaviors.ts) are composed from. Re-expressed from
// observed Streets of Rogue behavior (BrainUpdate.GoalArbitrate + Relationships
// AssessBattle/AssessFlee), not ported code.
//
// The two competing drives against a Hostile target, both weighted by how much
// it is hated (so the deeper grudge wins the target):
//   BATTLE  desirability ∝ OWN HEALTH   — a healthy body presses the attack.
//   FLEE    desirability ∝ WOUNDEDNESS  — a hurt body runs, even if it never
//                                          flees "on damage" normally.
// They cross around a third of max health (2·hp vs max−hp), so a badly wounded
// NPC breaks off and flees. Grounded in Relationships.cs AssessBattle
// (L4048-4053: relHate·health·2/(dist·2.5)) / AssessFlee (L4058-4077:
// relHate·clamp(max−health)/(dist·2.5)).
//
// This module holds only PURE, stateless helpers: goal codes, score formulas,
// and perception queries. Which considerations an NPC weighs — and how they
// combine into a decision — lives in ./behaviors.ts, keyed by the entity's
// `ai.behavior` component.

import type { Entity } from '../entity'
import { hasLineOfSight } from '../los'
import type { EntityId, Vec2 } from '../types'
import { anyPowerCut, doorClosedAt, type World } from '../world'
import { initialPlayerHate } from './relationships'
import { vlen } from '../simMath'

export const WANDER = 'wander'
export const BATTLE = 'battle'
export const PURSUE = 'pursue'
export const FLEE = 'flee'
export const INVESTIGATE = 'investigate'

/** Within this distance a Hostile target is fought rather than chased. */
export const ENGAGE_RANGE = 13
/** Baseline desirability of wandering — the floor every drive competes against. */
export const WANDER_SCORE = 1
/** Desirability of investigating a heard noise — beats wander, loses to a fight. */
export const INVESTIGATE_SCORE = 3
/** Shared distance divisor for battle & flee scores (the game's dist·100/40). */
export const DIST_K = 2.5
/** How far an NPC can hear a noise to investigate it. */
export const HEAR_RANGE = 12
/** Baseline hate a `w.hostile` world imputes toward players for an NPC with no
 * stored opinion — the `CRIME_HATE` threshold, so battleScore clears WANDER. */
export const WORLD_HOSTILE_HATE = 5
/** Multiple of sightRange an NPC keeps chasing a remembered target before giving up. */
export const LEASH = 1.5

/** What one arbitration decides: a goal code plus, when relevant, the entity it
 * is about (`target`), a world point (`at`), and — for goals that are ABOUT one
 * entity while MOVING to another (alerting a guard about an attacker) — the
 * `subject` the goal concerns. */
export interface Goal {
  code: string
  target?: EntityId
  at?: Vec2
  subject?: EntityId
}

export const battleScore = (hate: number, hp: number, dist: number): number => (hate * hp * 2) / (dist * DIST_K)

export const fleeScore = (hate: number, hp: number, max: number, dist: number): number =>
  (hate * Math.min(1000, Math.max(1, max - hp))) / (dist * DIST_K)

export const canSeeEntity = (w: World, a: Entity, b: Entity): boolean =>
  hasLineOfSight(w.level, a.pos.x, a.pos.y, b.pos.x, b.pos.y, (tx, ty) => doorClosedAt(w, tx, ty))

/** True when `a` actually PERCEIVES `b`: inside its (cloak-halved) sight range
 * AND with unbroken line of sight. The one definition of "can it see it" used by
 * scoring, memory updates, and steering — so an NPC can never track a live
 * position it has no way of knowing. */
export const perceives = (w: World, a: Entity, b: Entity): boolean => {
  const sight = a.ai?.sightRange ?? 0
  const range = b.status && b.status.cloakUntil > w.tick ? sight * 0.5 : sight
  if (vlen(b.pos.x - a.pos.x, b.pos.y - a.pos.y) > range) return false
  return canSeeEntity(w, a, b)
}

export const hateToward = (w: World, e: Entity, targetId: EntityId): number => {
  const stored = e.ai?.rel?.[targetId]?.hate
  if (stored !== undefined) return stored
  const base = initialPlayerHate(e.ai?.faction ?? 'neutral')
  // A hostile world floors an un-opinionated NPC's grudge to the hostile band so
  // it engages regardless of faction; likewise a POWER CUT rouses the station's
  // Derelict Units (robots) into open hostility — the standing cost of that path.
  // #64: when the Infected are involved (a field only ever set while the feature
  // is active), host and clean are floored to open hostility so the crew fights/
  // flees a host even in an otherwise peaceful world. A stored opinion still wins.
  const infectionInvolved = !!e.infected || !!w.byId.get(targetId)?.infected
  const rousedByCut = !!e.ai?.wakeOn?.includes('power-cut') && anyPowerCut(w)
  const forced = w.hostile || infectionInvolved || rousedByCut
  return forced ? Math.max(base, WORLD_HOSTILE_HATE) : base
}

export const nearestNoise = (w: World, e: Entity): Vec2 | undefined => {
  let best: Vec2 | undefined
  let bestDist = HEAR_RANGE
  for (const n of w.noises) {
    const d = vlen(n.x - e.pos.x, n.y - e.pos.y)
    if (d > bestDist) continue
    bestDist = d
    best = { x: n.x, y: n.y }
  }
  return best
}
