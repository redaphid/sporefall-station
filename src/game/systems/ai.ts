// The one AI system. Every thinking entity carries an `ai` component whose
// `behavior` id selects a registered bundle of considerations (behaviors.ts);
// this system runs the think (decide → goal), records the "why" on the entity
// (lastScores/goal/goalSince + `aiGoal` events), and executes the chosen goal
// through steering. No archetype-specific code paths — swap the component,
// swap the brain.

import { WEAPONS } from '../data/items'
import type { Entity } from '../entity'
import { emitFear, type World } from '../world'
import { ALERT, DRAWN, GARRISON, PATROL, RETREAT, SCAVENGE, SEARCH, WORK, decide } from './behaviors'
import { fireWeapon } from './combat'
import { BATTLE, FLEE, INVESTIGATE, PURSUE, perceives, type Goal } from './goals'
import { CRIME_HATE, addHate } from './relationships'
import { isImmobilized } from './statusFx'

const THINK_INTERVAL = 5 // ~6Hz per NPC at 30Hz sim, phase-spread by id
const WANDER_RADIUS = 4
/** Ticks an alerted guard commits to charging the reported spot before
 * re-arbitrating — long enough to close the gap and perceive the culprit itself. */
const ALERT_CHASE_TICKS = 45
/** Close enough to a sought entity to act on it (alert a guard). */
const ALERT_REACH = 1.4
/** Close enough to a sought pickup to grab it. */
const SCAVENGE_REACH = 0.55
/** Goal codes whose adoption (or abandonment) is worth a world event. */
const NOTABLE_GOALS = new Set([BATTLE, PURSUE, FLEE, ALERT, SEARCH, SCAVENGE])
/** Ticks of no movement progress toward an unseen chase goal before the trail
 * is declared cold (steering is straight-line; concave walls can wedge it). */
const STALL_TICKS = 45
/** Movement below this distance across STALL_TICKS counts as no progress. */
const STALL_DIST = 0.5

export const aiSystem = (w: World): void => {
  for (const e of w.entities) {
    if (!e.ai || e.dead) continue
    // #68: a dormant entity is INERT — no think, no move (the awakeningSystem,
    // run just before this, flips it active the tick a stimulus trips it).
    if (e.ai.dormant) {
      e.intent.x = 0
      e.intent.y = 0
      continue
    }
    if ((e.status && (e.status.stun > 0 || e.status.sleep > 0)) || isImmobilized(e)) {
      e.intent.x = 0
      e.intent.y = 0
      continue
    }
    if (w.tick >= e.ai.thinkAt) {
      think(w, e)
      e.ai.thinkAt = w.tick + THINK_INTERVAL + (e.id % 5)
    }
    steer(w, e)
  }
}

const think = (w: World, e: Entity): void => {
  const ai = e.ai!
  const { goal, scores } = decide(w, e)
  ai.lastScores = scores
  if (goal.code !== ai.goal) {
    ai.goalSince = w.tick
    // Notable transitions (into OR out of a charged goal) are world events, so
    // an agent watching the stream sees aggro/flee/alert/search as they happen.
    if (NOTABLE_GOALS.has(goal.code) || (ai.goal !== undefined && NOTABLE_GOALS.has(ai.goal))) {
      w.events.push({
        type: 'aiGoal',
        entityId: e.id,
        goal: goal.code,
        prev: ai.goal ?? 'none',
        ...(goal.target !== undefined ? { targetId: goal.target } : {}),
      })
    }
  }
  applyGoal(w, e, goal)
}

/** Translate the decided goal into the mode/target/waypoint that steer()
 * executes. Battle and Pursue both drive `aggro` — steer engages if in weapon
 * range, else closes on the target (or its last-known spot). */
const applyGoal = (w: World, e: Entity, goal: Goal): void => {
  const ai = e.ai!
  ai.goal = goal.code
  if (goal.code === BATTLE || goal.code === PURSUE) {
    ai.mode = 'aggro'
    ai.targetId = goal.target
    ai.search = undefined // a live trail supersedes any cold-trail sweep
    const target = goal.target !== undefined ? w.byId.get(goal.target) : undefined
    if (target && perceives(w, e, target)) ai.lastKnownTargetPos = { x: target.pos.x, y: target.pos.y }
    return
  }
  if (goal.code === FLEE) {
    const wasFleeing = ai.mode === 'flee'
    ai.mode = 'flee'
    ai.targetId = goal.target
    ai.fearId = goal.target // remember the scarer — the alert's subject
    // #65: a contagious flee runs from a POINT (the fear pulse), not an entity.
    ai.fleeFrom = goal.target === undefined ? goal.at : undefined
    // A body that JUST broke into flight screams — throwing a fear pulse nearby
    // crew catch and stampede from (world.ts emitFear / behaviors.contagiousFear).
    if (!wasFleeing) emitFear(w, e)
    return
  }
  if (goal.code === INVESTIGATE) {
    ai.mode = 'wander'
    ai.targetId = undefined
    ai.waypoint = goal.at
    return
  }
  if (goal.code === PATROL) {
    ai.mode = 'patrol'
    ai.targetId = undefined
    if (goal.at) ai.waypoint = { x: goal.at.x, y: goal.at.y }
    return
  }
  if (goal.code === SEARCH) {
    // Sweeping for a lost quarry: keep targetId (the hunt's bookkeeping) and
    // walk the current sweep point.
    ai.mode = 'wander'
    if (goal.at) ai.waypoint = { x: goal.at.x, y: goal.at.y }
    return
  }
  if (goal.code === WORK || goal.code === GARRISON || goal.code === DRAWN || goal.code === RETREAT) {
    // #77 territory / #66 hive draw / #69 boss retreat-to-spore: steer toward a
    // world-derived point (home room, objective core, strongest stimulus, or the
    // spore cloud). Same steering as investigate — walk there, settle on arrival.
    ai.mode = 'wander'
    ai.targetId = undefined
    ai.lastKnownTargetPos = undefined
    if (goal.at) ai.waypoint = { x: goal.at.x, y: goal.at.y }
    return
  }
  if (goal.code === ALERT) {
    ai.mode = 'seek'
    if (goal.subject !== undefined) ai.fearId = goal.subject
    ai.targetId = goal.target // the guard being run to
    return
  }
  if (goal.code === SCAVENGE) {
    ai.mode = 'seek'
    ai.targetId = goal.target // the pickup being fetched
    return
  }
  // WANDER: shed any old chase and amble around home (guards hold their post).
  if (ai.mode === 'aggro' || ai.mode === 'flee' || ai.mode === 'seek') {
    ai.targetId = undefined
    ai.lastKnownTargetPos = undefined
  }
  if (!ai.guard && !ai.waypoint && w.rng.chance(0.3)) {
    const tx = ai.home.x + w.rng.int(-WANDER_RADIUS, WANDER_RADIUS)
    const ty = ai.home.y + w.rng.int(-WANDER_RADIUS, WANDER_RADIUS)
    ai.waypoint = { x: tx, y: ty }
    ai.mode = 'wander'
  } else if (!ai.waypoint) {
    ai.mode = 'idle'
  }
}

/** Reaching the guard: report the scarer — the guard turns on it (hate + aggro),
 * the alerter remembers it already told someone and goes back to fleeing. */
const performAlert = (w: World, alerter: Entity, guard: Entity): void => {
  const ai = alerter.ai!
  const threatId = ai.fearId
  const threatE = threatId !== undefined ? w.byId.get(threatId) : undefined
  ai.thinkAt = w.tick // re-decide next tick
  if (threatId === undefined || !threatE || threatE.dead || !guard.ai) {
    // Nothing (left) to report — calm down.
    ai.mode = 'idle'
    ai.targetId = undefined
    return
  }
  ai.alerted = threatId
  ai.mode = 'flee'
  ai.targetId = threatId
  addHate(guard, threatId, CRIME_HATE)
  guard.ai.mode = 'aggro'
  guard.ai.targetId = threatId
  guard.ai.lastKnownTargetPos = { x: threatE.pos.x, y: threatE.pos.y }
  // Commit to the charge: the reported spot is likely outside the guard's own
  // perception, so give it time to get there before goal arbitration (which can
  // only score what the guard itself perceives) would shrug the report off.
  guard.ai.thinkAt = w.tick + ALERT_CHASE_TICKS
  w.events.push({ type: 'alerted', entityId: guard.id, byId: alerter.id, targetId: threatId })
}

/** Reaching a sought pickup: take it off the floor into the stash. */
const collectPickup = (w: World, e: Entity, item: Entity): void => {
  const ai = e.ai!
  item.dead = true
  w.events.push({ type: 'pickup', entityId: item.id, byId: e.id, itemId: item.pickup!.itemId })
  const stash = (ai.stash ??= [])
  if (stash.length < 32) stash.push(item.pickup!.itemId)
  ai.mode = 'idle'
  ai.targetId = undefined
  ai.thinkAt = w.tick
}

const steer = (w: World, e: Entity): void => {
  const ai = e.ai!
  e.intent.x = 0
  e.intent.y = 0

  if (ai.mode === 'aggro') {
    const target = ai.targetId !== undefined ? w.byId.get(ai.targetId) : undefined
    // Steer at the live position only while it is actually PERCEIVED (range +
    // LOS) — an unseen target is tracked via its last-known spot, never psychically.
    const seen = target && !target.dead && perceives(w, e, target)
    const goal = seen ? target.pos : ai.lastKnownTargetPos
    if (!goal) return
    const dx = goal.x - e.pos.x
    const dy = goal.y - e.pos.y
    const dist = Math.hypot(dx, dy)
    const weapon = WEAPONS[e.combat?.weapon ?? 'fists']

    if (weapon.kind === 'ranged') {
      // Engage only a PERCEIVED target — `dist` is to the live position exactly
      // when `seen`, so range checks and trigger pulls always agree.
      if (seen && dist <= weapon.range * 0.8) {
        e.facing = Math.atan2(dy, dx) + (w.rng.next() - 0.5) * 0.15 // imperfect aim
        if (e.combat && e.combat.cooldown <= 0) {
          // THE shared fire path — mods/elements/pellets apply to NPCs too.
          fireWeapon(w, e)
          e.combat.cooldown += w.rng.int(0, 10) // stagger volleys so they don't fire in lockstep
        }
        // Keep spacing: back off if crowded to melee range, else strafe a little
        // (perpendicular, side chosen by id) so a firing line doesn't clump.
        if (dist < weapon.range * 0.4) {
          e.intent.x = -dx / dist
          e.intent.y = -dy / dist
        } else {
          const side = e.id % 2 === 0 ? 1 : -1
          e.intent.x = (-dy / dist) * side * 0.35
          e.intent.y = (dx / dist) * side * 0.35
        }
        return
      }
    } else if (seen && dist <= weapon.range + target.radius) {
      e.facing = Math.atan2(dy, dx)
      if (e.combat && e.combat.cooldown <= 0) fireWeapon(w, e) // shared melee swing
      return
    }
    if (seen) {
      ai.progress = undefined // live pursuit — stall bookkeeping is for cold trails
    } else if (!ai.progress || Math.hypot(e.pos.x - ai.progress.x, e.pos.y - ai.progress.y) > STALL_DIST) {
      ai.progress = { x: e.pos.x, y: e.pos.y, tick: w.tick } // moved — mark fresh progress
    } else if (w.tick - ai.progress.tick > STALL_TICKS) {
      // Wedged against geometry chasing a memory: declare the trail cold so the
      // behavior can move on (a hunter opens its sweep, basic gives up).
      ai.lastKnownTargetPos = undefined
      ai.progress = undefined
      return
    }
    if (dist > 0.2) {
      e.intent.x = dx / dist
      e.intent.y = dy / dist
      e.facing = Math.atan2(dy, dx)
    } else {
      // Reached last known position with no target in sight
      ai.lastKnownTargetPos = undefined
      ai.progress = undefined
    }
    return
  }

  if (ai.mode === 'flee') {
    const threat = ai.targetId !== undefined ? w.byId.get(ai.targetId) : undefined
    // Run from the threat entity if there is one, else from the fear-pulse point
    // (#65 stampede) — the crew flees off-screen danger it never directly saw.
    const from = threat ? threat.pos : ai.fleeFrom
    if (!from) return
    const dx = e.pos.x - from.x
    const dy = e.pos.y - from.y
    const dist = Math.hypot(dx, dy) || 1
    e.intent.x = dx / dist
    e.intent.y = dy / dist
    e.facing = Math.atan2(dy, dx)
    return
  }

  if (ai.mode === 'seek') {
    const target = ai.targetId !== undefined ? w.byId.get(ai.targetId) : undefined
    if (!target || target.dead) {
      // The sought entity vanished mid-seek: an alerter falls back to fleeing
      // its scarer; anyone else re-decides from scratch.
      ai.targetId = undefined
      if (ai.goal === ALERT && ai.fearId !== undefined && w.byId.get(ai.fearId)) {
        ai.mode = 'flee'
        ai.targetId = ai.fearId
      } else {
        ai.mode = 'idle'
      }
      ai.thinkAt = w.tick
      return
    }
    const dx = target.pos.x - e.pos.x
    const dy = target.pos.y - e.pos.y
    const dist = Math.hypot(dx, dy)
    if (ai.goal === ALERT && dist <= ALERT_REACH) return performAlert(w, e, target)
    if (ai.goal === SCAVENGE && dist <= SCAVENGE_REACH) return collectPickup(w, e, target)
    if (dist > 0.2) {
      const pace = ai.goal === ALERT ? 1 : 0.8 // panicked sprint vs a busy trot
      e.intent.x = (dx / dist) * pace
      e.intent.y = (dy / dist) * pace
      e.facing = Math.atan2(dy, dx)
    }
    return
  }

  if ((ai.mode === 'wander' || ai.mode === 'patrol') && ai.waypoint) {
    const dx = ai.waypoint.x - e.pos.x
    const dy = ai.waypoint.y - e.pos.y
    const dist = Math.hypot(dx, dy)
    if (dist < 0.4) {
      ai.waypoint = undefined
      ai.mode = 'idle'
      return
    }
    const pace = ai.mode === 'patrol' ? 0.85 : 0.6 // a beat is brisker than an amble
    e.intent.x = (dx / dist) * pace
    e.intent.y = (dy / dist) * pace
    e.facing = Math.atan2(dy, dx)
  }
}
