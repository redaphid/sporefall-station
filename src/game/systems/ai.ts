import { WEAPONS } from '../data/items'
import type { Entity } from '../entity'
import { hasLineOfSight } from '../los'
import { doorClosedAt, type World } from '../world'
import { fireWeapon } from './combat'
import { arbitrateGoal, BATTLE, FLEE, INVESTIGATE, PURSUE, type Goal } from './goals'
import { isImmobilized } from './statusFx'

const THINK_INTERVAL = 5 // ~6Hz per NPC at 30Hz sim, phase-spread by id
const WANDER_RADIUS = 4

export const aiSystem = (w: World): void => {
  for (const e of w.entities) {
    if (!e.ai || e.dead) continue
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
  applyGoal(w, e, arbitrateGoal(w, e))
}

/** Translate the arbitrated goal into the FSM mode/target/waypoint that steer()
 * executes. Battle and Pursue both drive `aggro` — steer engages if in weapon
 * range, else closes on the target (or its last-known spot). */
const applyGoal = (w: World, e: Entity, goal: Goal): void => {
  const ai = e.ai!
  ai.goal = goal.code
  if (goal.code === BATTLE || goal.code === PURSUE) {
    ai.mode = 'aggro'
    ai.targetId = goal.target
    const target = goal.target !== undefined ? w.byId.get(goal.target) : undefined
    if (target && canSee(w, e, target)) ai.lastKnownTargetPos = { x: target.pos.x, y: target.pos.y }
    return
  }
  if (goal.code === FLEE) {
    ai.mode = 'flee'
    ai.targetId = goal.target
    return
  }
  if (goal.code === INVESTIGATE) {
    ai.mode = 'wander'
    ai.targetId = undefined
    ai.waypoint = goal.at
    return
  }
  // WANDER: shed any old chase and amble around home (guards hold their post).
  if (ai.mode === 'aggro' || ai.mode === 'flee') {
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

const canSee = (w: World, e: Entity, target: Entity): boolean =>
  hasLineOfSight(w.level, e.pos.x, e.pos.y, target.pos.x, target.pos.y, (tx, ty) => doorClosedAt(w, tx, ty))

const steer = (w: World, e: Entity): void => {
  const ai = e.ai!
  e.intent.x = 0
  e.intent.y = 0

  if (ai.mode === 'aggro') {
    const target = ai.targetId !== undefined ? w.byId.get(ai.targetId) : undefined
    const goal = target && !target.dead && canSee(w, e, target) ? target.pos : ai.lastKnownTargetPos
    if (!goal) return
    const dx = goal.x - e.pos.x
    const dy = goal.y - e.pos.y
    const dist = Math.hypot(dx, dy)
    const weapon = WEAPONS[e.combat?.weapon ?? 'fists']

    if (weapon.kind === 'ranged') {
      if (target && !target.dead && dist <= weapon.range * 0.8 && canSee(w, e, target)) {
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
    } else if (target && !target.dead && dist <= weapon.range + target.radius && canSee(w, e, target)) {
      e.facing = Math.atan2(dy, dx)
      if (e.combat && e.combat.cooldown <= 0) fireWeapon(w, e) // shared melee swing
      return
    }
    if (dist > 0.2) {
      e.intent.x = dx / dist
      e.intent.y = dy / dist
      e.facing = Math.atan2(dy, dx)
    } else {
      // Reached last known position with no target in sight
      ai.lastKnownTargetPos = undefined
    }
    return
  }

  if (ai.mode === 'flee') {
    const threat = ai.targetId !== undefined ? w.byId.get(ai.targetId) : undefined
    if (!threat) return
    const dx = e.pos.x - threat.pos.x
    const dy = e.pos.y - threat.pos.y
    const dist = Math.hypot(dx, dy) || 1
    e.intent.x = dx / dist
    e.intent.y = dy / dist
    e.facing = Math.atan2(dy, dx)
    return
  }

  if (ai.mode === 'wander' && ai.waypoint) {
    const dx = ai.waypoint.x - e.pos.x
    const dy = ai.waypoint.y - e.pos.y
    const dist = Math.hypot(dx, dy)
    if (dist < 0.4) {
      ai.waypoint = undefined
      ai.mode = 'idle'
      return
    }
    e.intent.x = (dx / dist) * 0.6 // amble, don't sprint
    e.intent.y = (dy / dist) * 0.6
    e.facing = Math.atan2(dy, dx)
  }
}
