// AI goals — desirability arbitration. Re-expressed from observed Streets of
// Rogue behavior (BrainUpdate.GoalArbitrate + Relationships AssessBattle/
// AssessFlee), not ported code. Each thinking NPC scores a set of candidate
// goals from world state and commits to the highest scorer, replacing the flat
// idle/aggro/flee FSM decision with a situational one.
//
// The two competing drives against a Hostile target, both weighted by how much
// it is hated (so the deeper grudge wins the target):
//   BATTLE  desirability ∝ OWN HEALTH   — a healthy body presses the attack.
//   FLEE    desirability ∝ WOUNDEDNESS  — a hurt body runs, even if it never
//                                          flees "on damage" normally.
// They cross around a third of max health (2·hp vs max−hp), so a badly wounded
// NPC breaks off and flees. A remembered-but-unseen target is PURSUEd toward its
// last-known spot; a heard disturbance with no threat around is INVESTIGATEd;
// otherwise the NPC just WANDERs. Grounded in Relationships.cs AssessBattle
// (L4048-4053: relHate·health·2/(dist·2.5)) / AssessFlee (L4058-4077:
// relHate·clamp(max−health)/(dist·2.5)) and BrainUpdate.GoalArbitrate's
// keep-the-highest loop. Deterministic: no rand, ascending-id iteration, ties
// resolve by candidate order (Wander first, then targets by id, strictly-greater
// replaces).

import type { Entity } from '../entity'
import { hasLineOfSight } from '../los'
import type { EntityId, Vec2 } from '../types'
import { doorClosedAt, type World } from '../world'
import { dispositionToward, initialPlayerHate } from './relationships'

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
/** Multiple of sightRange an NPC keeps chasing a remembered target before giving up. */
const LEASH = 1.5

export interface Goal {
  code: string
  target?: EntityId
  at?: Vec2
}

const battleScore = (hate: number, hp: number, dist: number): number => (hate * hp * 2) / (dist * DIST_K)

const fleeScore = (hate: number, hp: number, max: number, dist: number): number =>
  (hate * Math.min(1000, Math.max(1, max - hp))) / (dist * DIST_K)

const canSee = (w: World, a: Entity, b: Entity): boolean =>
  hasLineOfSight(w.level, a.pos.x, a.pos.y, b.pos.x, b.pos.y, (tx, ty) => doorClosedAt(w, tx, ty))

const hateToward = (e: Entity, targetId: EntityId): number =>
  e.ai?.rel?.[targetId]?.hate ?? initialPlayerHate(e.ai?.faction ?? 'neutral')

const nearestNoise = (w: World, e: Entity): Vec2 | undefined => {
  let best: Vec2 | undefined
  let bestDist = HEAR_RANGE
  for (const n of w.noises) {
    const d = Math.hypot(n.x - e.pos.x, n.y - e.pos.y)
    if (d > bestDist) continue
    bestDist = d
    best = { x: n.x, y: n.y }
  }
  return best
}

interface Best {
  code: string
  score: number
  target?: EntityId
  at?: Vec2
}

/** Score every candidate goal and return the winner. */
export const arbitrateGoal = (w: World, e: Entity): Goal => {
  const ai = e.ai!
  const hp = e.health?.hp ?? 1
  const max = e.health?.max ?? 1
  let best: Best = { code: WANDER, score: WANDER_SCORE }

  for (const p of w.entities) {
    if (!p.playerCtl || p.dead || p.playerCtl.downed) continue
    const hostile = dispositionToward(e, p.id) === 'Hostile' || (ai.faction === 'cop' && w.alarm >= 2)
    if (!hostile) continue
    const dist = Math.max(1, Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y))
    // Cloaked players are much harder to spot.
    const sight = p.status && p.status.cloakUntil > w.tick ? ai.sightRange * 0.5 : ai.sightRange
    if (dist > sight || !canSee(w, e, p)) continue // must actually perceive it
    const hate = hateToward(e, p.id)
    const aggress = battleScore(hate, hp, dist)
    if (aggress > best.score) best = { code: dist <= ENGAGE_RANGE ? BATTLE : PURSUE, score: aggress, target: p.id }
    const flee = fleeScore(hate, hp, max, dist)
    if (flee > best.score) best = { code: FLEE, score: flee, target: p.id }
  }

  // No fresh target beat wander: keep chasing a remembered one, keep fleeing a
  // recent scare, else investigate a noise, else wander.
  if (best.code === WANDER && ai.targetId !== undefined && ai.lastKnownTargetPos) {
    const t = w.byId.get(ai.targetId)
    if (t && !t.dead && Math.hypot(t.pos.x - e.pos.x, t.pos.y - e.pos.y) <= ai.sightRange * LEASH) {
      best = { code: PURSUE, score: WANDER_SCORE + 0.5, target: ai.targetId }
    }
  }
  // A frightened NPC (e.g. a civilian who saw a crime) keeps fleeing its scarer
  // until it's well clear, even though it has no hostile disposition to score.
  if (best.code === WANDER && ai.mode === 'flee' && ai.targetId !== undefined) {
    const threat = w.byId.get(ai.targetId)
    if (threat && !threat.dead && Math.hypot(threat.pos.x - e.pos.x, threat.pos.y - e.pos.y) <= ai.sightRange * 2) {
      best = { code: FLEE, score: WANDER_SCORE + 0.5, target: ai.targetId }
    }
  }
  if (best.code === WANDER) {
    const noise = nearestNoise(w, e)
    if (noise) best = { code: INVESTIGATE, score: INVESTIGATE_SCORE, at: noise }
  }

  if (best.target !== undefined) return { code: best.code, target: best.target }
  if (best.at) return { code: best.code, at: best.at }
  return { code: best.code }
}
