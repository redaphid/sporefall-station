import { WEAPONS } from '../data/items'
import type { Entity } from '../entity'
import { hasLineOfSight } from '../los'
import { doorClosedAt, type World } from '../world'
import { applyDamage, spawnProjectile } from './combat'
import { dispositionToward } from './relationships'
import { isImmobilized } from './statusFx'

const THINK_INTERVAL = 5 // ~6Hz per NPC at 30Hz sim, phase-spread by id
const WANDER_RADIUS = 4
const LEASH = 1.5 // × sightRange before giving up a chase

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
  const ai = e.ai!

  // Sighting checks: aggro any player this NPC is disposed hostile toward.
  const target = findHostileTarget(w, e)
  if (target) {
    ai.mode = 'aggro'
    ai.targetId = target.id
    ai.lastKnownTargetPos = { x: target.pos.x, y: target.pos.y }
    return
  }

  if (ai.mode === 'aggro') {
    const target = ai.targetId !== undefined ? w.byId.get(ai.targetId) : undefined
    if (!target || target.dead) {
      dropAggro(ai)
    } else {
      const dist = Math.hypot(target.pos.x - e.pos.x, target.pos.y - e.pos.y)
      if (canSee(w, e, target)) {
        ai.lastKnownTargetPos = { x: target.pos.x, y: target.pos.y }
      } else if (dist > ai.sightRange * LEASH) {
        dropAggro(ai)
      }
    }
    return
  }

  if (ai.mode === 'flee') {
    const threat = ai.targetId !== undefined ? w.byId.get(ai.targetId) : undefined
    if (!threat || threat.dead || Math.hypot(threat.pos.x - e.pos.x, threat.pos.y - e.pos.y) > ai.sightRange * 2) {
      ai.mode = 'idle'
      ai.targetId = undefined
    }
    return
  }

  // idle/wander: occasionally pick a new waypoint near home (guards hold post)
  if (!ai.guard && !ai.waypoint && w.rng.chance(0.3)) {
    const tx = ai.home.x + w.rng.int(-WANDER_RADIUS, WANDER_RADIUS)
    const ty = ai.home.y + w.rng.int(-WANDER_RADIUS, WANDER_RADIUS)
    ai.waypoint = { x: tx, y: ty }
    ai.mode = 'wander'
  }
}

const dropAggro = (ai: NonNullable<Entity['ai']>): void => {
  ai.mode = 'wander'
  ai.targetId = undefined
  ai.waypoint = { ...ai.home }
}

const findHostileTarget = (w: World, e: Entity): Entity | null => {
  const ai = e.ai!
  let best: Entity | null = null
  let bestDist = Infinity
  for (const p of w.entities) {
    if (!p.playerCtl || p.dead || p.playerCtl.downed) continue
    // Aggro only players this NPC is disposed hostile toward; a raised alarm
    // makes every cop treat the player as hostile (city-wide heat).
    const hostile = dispositionToward(e, p.id) === 'Hostile' || (ai.faction === 'cop' && w.alarm >= 2)
    if (!hostile) continue
    // Cloaked players are much harder to spot
    const sight = p.status && p.status.cloakUntil > w.tick ? ai.sightRange * 0.5 : ai.sightRange
    const dist = Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y)
    if (dist > sight || dist >= bestDist) continue
    if (!canSee(w, e, p)) continue
    best = p
    bestDist = dist
  }
  return best
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
          e.combat.cooldown = weapon.cooldownTicks + w.rng.int(0, 10) // stagger volleys
          spawnProjectile(w, e, weapon.damage, weapon.projectileSpeed ?? 12, weapon.range)
        }
        // Hold a standoff distance instead of closing to melee
        if (dist < weapon.range * 0.4) {
          e.intent.x = -dx / dist
          e.intent.y = -dy / dist
        }
        return
      }
    } else if (target && !target.dead && dist <= weapon.range + target.radius && canSee(w, e, target)) {
      e.facing = Math.atan2(dy, dx)
      if (e.combat && e.combat.cooldown <= 0) {
        e.combat.cooldown = weapon.cooldownTicks
        applyDamage(w, target, weapon.damage, e.pos.x, e.pos.y, weapon.knockback, e.id)
      }
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
