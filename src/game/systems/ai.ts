// The one AI system. Every thinking entity carries an `ai` component whose
// `behavior` id selects a registered bundle of considerations (behaviors.ts);
// this system runs the think (decide → goal), records the "why" on the entity
// (lastScores/goal/goalSince + `aiGoal` events), and executes the chosen goal
// through steering. No archetype-specific code paths — swap the component,
// swap the brain.

import { WEAPONS } from '../data/items'
import type { Entity } from '../entity'
import { hasLineOfSight } from '../los'
import { isSolidTile } from '../levelgen/level'
import { findPath } from '../path'
import { emitFear, type World } from '../world'
import { ALERT, DRAWN, FLANK, FORMUP, FORTIFY, GARRISON, PATROL, RETREAT, SCAVENGE, SEARCH, STACK, WORK, decide } from './behaviors'
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
 * is declared cold — the safety net under the router (bodies can jam a door). */
const STALL_TICKS = 45
/** Movement below this distance across STALL_TICKS counts as no progress. */
const STALL_DIST = 0.5

// ── Routing (path.ts) tuning ───────────────────────────────────────────────
/** Ticks between route recomputes per NPC (+ id stagger, so repaths spread). */
const REPATH_TICKS = 20
/** Per-entity stagger modulus added to REPATH_TICKS — no repath tick spikes. */
const REPATH_STAGGER = 7
/** Close enough to a route node to advance to the next. */
const NODE_ARRIVE = 0.45
/** The goal drifting this far from a cached route's goal forces a recompute. */
const GOAL_DRIFT = 1.3
/** Within this range of a closed door on the route, the walker shoves it open. */
const DOOR_OPEN_RANGE = 1.1
/** Stand-and-scan pause after arriving at a destination (~1.2s). */
export const SCAN_TICKS = 36
/** The scan sweeps facing one notch every SCAN_STEP ticks. */
const SCAN_STEP = 12
const SCAN_TURN = 0.9
/** How far ahead the flee steering probes for a wall before re-aiming. */
const FLEE_PROBE = 1.2

/** Per-tick door context for steering: closed doors split by openability, and
 * the door entity per tile so a walker can shove one open on contact. Built
 * ONCE per aiSystem pass (the same O(entities) sweep movement does). */
interface DoorCtx {
  /** Tile keys of closed, UNLOCKED doors — routable at a cost; open on contact. */
  closedDoors: Set<number>
  /** Tile keys of closed LOCKED/overgrown doors — walls to an ordinary NPC. */
  lockedDoors: Set<number>
  doorByTile: Map<number, Entity>
}

const buildDoorCtx = (w: World): DoorCtx => {
  const lw = w.level.w
  const ctx: DoorCtx = { closedDoors: new Set(), lockedDoors: new Set(), doorByTile: new Map() }
  for (const d of w.entities) {
    if (!d.door || d.door.open || d.dead) continue
    const k = Math.floor(d.pos.y) * lw + Math.floor(d.pos.x)
    if (d.door.locked || d.door.overgrown) ctx.lockedDoors.add(k)
    else ctx.closedDoors.add(k)
    ctx.doorByTile.set(k, d)
  }
  return ctx
}

export const aiSystem = (w: World): void => {
  const ctx = buildDoorCtx(w)
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
    steer(w, e, ctx)
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
  if (
    goal.code === WORK ||
    goal.code === GARRISON ||
    goal.code === DRAWN ||
    goal.code === RETREAT ||
    goal.code === FORMUP ||
    goal.code === FORTIFY
  ) {
    // #77 territory / #66 hive draw / #69 boss retreat-to-spore / squad
    // formation slot / barricade site: steer toward a world-derived point
    // (home room, objective core, stimulus, spore cloud, the leader's
    // shoulder, a doorway approach). Same steering as investigate — walk
    // there, settle on arrival (fortify builds from the consideration once
    // the body is standing on its site).
    ai.mode = 'wander'
    ai.targetId = undefined
    ai.lastKnownTargetPos = undefined
    if (goal.at) ai.waypoint = { x: goal.at.x, y: goal.at.y }
    return
  }
  if (goal.code === FLANK) {
    // Squad flanking: MOVE like a wander-to-point (around the target's far
    // side) but KEEP the engagement bookkeeping — the flanker still knows who
    // the fight is about, so `threat` takes over seamlessly on arrival.
    ai.mode = 'wander'
    ai.targetId = goal.target
    if (goal.at) ai.waypoint = { x: goal.at.x, y: goal.at.y }
    return
  }
  if (goal.code === STACK) {
    // Squad lead holding at a door until the stack forms: plant, face the door.
    ai.mode = 'idle'
    ai.waypoint = undefined
    if (goal.at) e.facing = Math.atan2(goal.at.y - e.pos.y, goal.at.x - e.pos.x)
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

/**
 * Steer `e` toward world point (gx,gy) at `pace`, routing around walls.
 *
 * The direct shortcut keeps open-field behavior EXACTLY as before the router:
 * with a clear line (walls + closed doors), steer straight. Otherwise follow
 * the cached tile route node-to-node — recomputing at the entity's staggered
 * repath window when the route is missing, exhausted, or the goal drifted —
 * and shove any closed unlocked door open on contact (the breach beat).
 *
 * `bestEffort` (waypoint errands: garrison, work, formation, sweeps) walks to
 * the nearest REACHABLE approach when the goal itself is sealed off — a guard
 * masses on the locked core's door instead of shrugging across the room.
 *
 * Returns 'arrived' (standing on it), 'moving', or 'blocked' — no (further)
 * route exists. On 'blocked' the caller decides what "sensible" means for its
 * goal; intent is left at zero (planted, not grinding). The unroutable verdict
 * is cached on `ai.path` as an empty node list, so between repath windows a
 * stranded NPC PLANTS rather than wall-grinding; every window re-tries, so a
 * door opening later un-strands it.
 */
const moveToward = (
  w: World,
  e: Entity,
  ctx: DoorCtx,
  gx: number,
  gy: number,
  pace: number,
  bestEffort = false,
): 'arrived' | 'moving' | 'blocked' => {
  const ai = e.ai!
  const dx = gx - e.pos.x
  const dy = gy - e.pos.y
  const dist = Math.hypot(dx, dy)
  if (dist < 0.05) {
    ai.path = undefined
    return 'arrived'
  }
  const lw = w.level.w
  const doorBlocked = (tx: number, ty: number): boolean =>
    ctx.closedDoors.has(ty * lw + tx) || ctx.lockedDoors.has(ty * lw + tx)
  const steerStraight = (): void => {
    e.intent.x = (dx / dist) * pace
    e.intent.y = (dy / dist) * pace
    e.facing = Math.atan2(dy, dx)
  }
  // The direct shortcut wants a BODY-WIDE corridor, not a one-pixel sightline:
  // a single Bresenham threads a doorway gap whose frame the circle then clips
  // (two bodies jam there, pushApart cancelling their squeeze-through drift).
  // Check the centre line plus both radius-offset lines; any clip → route via
  // tile centres instead, which carries the body cleanly through the middle.
  const px = (-dy / dist) * e.radius
  const py = (dx / dist) * e.radius
  if (
    hasLineOfSight(w.level, e.pos.x, e.pos.y, gx, gy, doorBlocked) &&
    hasLineOfSight(w.level, e.pos.x + px, e.pos.y + py, gx, gy, doorBlocked) &&
    hasLineOfSight(w.level, e.pos.x - px, e.pos.y - py, gx, gy, doorBlocked)
  ) {
    ai.path = undefined
    steerStraight()
    return 'moving'
  }
  // Line blocked → route. Recompute only inside this entity's repath window so
  // route queries stay staggered across the crowd (deterministic per id).
  const cached = ai.path
  const sameGoal = cached !== undefined && Math.hypot(cached.goal.x - gx, cached.goal.y - gy) <= GOAL_DRIFT
  const noRoute = sameGoal && cached.nodes.length === 0 // the cached "unroutable" verdict
  const spent = sameGoal && !noRoute && cached.i >= cached.nodes.length // walked a partial route to its end
  if (!sameGoal || noRoute || spent) {
    if (w.tick < (ai.repathAt ?? 0)) {
      // Window shut. A standing verdict (or a spent partial route) means we
      // KNOW pressing straight is a wall-grind — plant instead. With no cache
      // at all, press straight until the window opens; slide collision copes.
      if (sameGoal) return 'blocked'
      steerStraight()
      return 'moving'
    }
    ai.repathAt = w.tick + REPATH_TICKS + (e.id % REPATH_STAGGER)
    const nodes = findPath(w.level, e.pos.x, e.pos.y, gx, gy, {
      closedDoors: ctx.closedDoors,
      lockedDoors: ctx.lockedDoors,
      bestEffort,
    })
    if (!nodes || nodes.length === 0) {
      ai.path = { nodes: [], i: 0, goal: { x: gx, y: gy } } // remember the verdict
      return 'blocked'
    }
    ai.path = { nodes, i: 0, goal: { x: gx, y: gy } }
  }
  const p = ai.path!
  while (p.i < p.nodes.length && Math.hypot(p.nodes[p.i].x - e.pos.x, p.nodes[p.i].y - e.pos.y) < NODE_ARRIVE) p.i++
  if (p.i >= p.nodes.length) {
    // Route walked out. A FULL route ended on the goal tile — close the last
    // stretch straight. A PARTIAL (best-effort) route ended as near as the map
    // allows — hold here; the next window re-checks whether the world changed.
    const end = p.nodes[p.nodes.length - 1]
    if (Math.floor(end.x) === Math.floor(gx) && Math.floor(end.y) === Math.floor(gy)) {
      ai.path = undefined
      steerStraight()
      return 'moving'
    }
    return 'blocked'
  }
  const node = p.nodes[p.i]
  // A closed door on the node ahead: open it the moment it is in arm's reach —
  // the walker never phases through; it breaches, visibly, then walks in.
  const nKey = Math.floor(node.y) * lw + Math.floor(node.x)
  if (ctx.closedDoors.has(nKey) && Math.hypot(node.x - e.pos.x, node.y - e.pos.y) <= DOOR_OPEN_RANGE) {
    const d = ctx.doorByTile.get(nKey)
    if (d?.door) {
      d.door.open = true
      ctx.closedDoors.delete(nKey)
      w.events.push({ type: 'doorToggle', entityId: d.id, open: true })
    }
  }
  const ndx = node.x - e.pos.x
  const ndy = node.y - e.pos.y
  const nd = Math.hypot(ndx, ndy) || 1
  e.intent.x = (ndx / nd) * pace
  e.intent.y = (ndy / nd) * pace
  e.facing = Math.atan2(ndy, ndx)
  return 'moving'
}

/** The 8 compass directions (unit vectors), fixed order = deterministic ties. */
const COMPASS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.7071, 0.7071],
  [0, 1],
  [-0.7071, 0.7071],
  [-1, 0],
  [-0.7071, -0.7071],
  [0, -1],
  [0.7071, -0.7071],
]

/** Best open direction to run given the desired away-vector (ax,ay): the raw
 * direction when the tile ahead is open, else the open compass direction most
 * aligned with it (strictly-greater dot, fixed order — deterministic). A body
 * boxed in on all sides keeps its raw heading (nothing better exists). */
const openFleeDir = (w: World, ctx: DoorCtx, e: Entity, ax: number, ay: number): { x: number; y: number } => {
  const lw = w.level.w
  const open = (vx: number, vy: number): boolean => {
    const tx = Math.floor(e.pos.x + vx * FLEE_PROBE)
    const ty = Math.floor(e.pos.y + vy * FLEE_PROBE)
    const k = ty * lw + tx
    return !isSolidTile(w.level, tx, ty) && !ctx.closedDoors.has(k) && !ctx.lockedDoors.has(k)
  }
  if (open(ax, ay)) return { x: ax, y: ay }
  let best: { x: number; y: number } | undefined
  let bestDot = -Infinity
  for (const [cx, cy] of COMPASS) {
    if (!open(cx, cy)) continue
    const dot = cx * ax + cy * ay
    if (dot > bestDot) {
      bestDot = dot
      best = { x: cx, y: cy }
    }
  }
  return best ?? { x: ax, y: ay }
}

const steer = (w: World, e: Entity, ctx: DoorCtx): void => {
  const ai = e.ai!
  e.intent.x = 0
  e.intent.y = 0

  // The deliberate pause: a body mid-scan PLANTS and sweeps its facing — the
  // "arrive, look around, move on" beat. Any urgent mode cancels it instantly,
  // so responsiveness to a real threat is unchanged.
  if (ai.scanUntil !== undefined) {
    if (w.tick < ai.scanUntil && ai.mode !== 'aggro' && ai.mode !== 'flee' && ai.mode !== 'seek') {
      if ((ai.scanUntil - w.tick) % SCAN_STEP === 0) e.facing += SCAN_TURN
      return
    }
    ai.scanUntil = undefined
  }

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
      const res = moveToward(w, e, ctx, goal.x, goal.y, 1)
      if (res === 'blocked') {
        if (seen) {
          // A locked door between us and a target we can SEE: hold and face it
          // (the stare-down) — combat engages the moment range/LOS allow.
          e.facing = Math.atan2(dy, dx)
        } else {
          // No route to a remembered position — declare the trail cold NOW
          // instead of grinding at a wall until the stall timer fires.
          ai.lastKnownTargetPos = undefined
          ai.progress = undefined
        }
      }
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
    // Flight has no destination to route to — steer the away-vector, deflected
    // to the openest compass direction when a wall looms, so a panicked body
    // streams along walls and out of doorless corners instead of grinding.
    const dir = openFleeDir(w, ctx, e, dx / dist, dy / dist)
    e.intent.x = dir.x
    e.intent.y = dir.y
    e.facing = Math.atan2(dir.y, dir.x)
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
      const res = moveToward(w, e, ctx, target.pos.x, target.pos.y, pace)
      if (res === 'blocked') {
        // The errand's subject is unroutable (sealed off). An alerter writes
        // the report off as delivered (so it stops re-choosing this guard) and
        // falls back to plain flight; anyone else just re-decides.
        if (ai.goal === ALERT && ai.fearId !== undefined) {
          ai.alerted = ai.fearId
          ai.mode = 'flee'
          ai.targetId = ai.fearId
        } else {
          ai.targetId = undefined
          ai.mode = 'idle'
        }
        ai.thinkAt = w.tick
      }
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
      ai.path = undefined
      // Arrived on purpose → pause and look around before the next errand.
      // Squad positioning (formation slots, flank runs) skips the beat: those
      // arrivals are tactical placement, and a fidgeting stack reads wrong.
      if (ai.goal !== FORMUP && ai.goal !== FLANK) ai.scanUntil = w.tick + SCAN_TICKS
      return
    }
    const pace = ai.mode === 'patrol' ? 0.85 : 0.6 // a beat is brisker than an amble
    // Waypoint errands run BEST-EFFORT: a garrison whose core is sealed masses
    // on its locked door (the nearest reachable approach) instead of shrugging.
    const res = moveToward(w, e, ctx, ai.waypoint.x, ai.waypoint.y, pace, true)
    if (res === 'blocked') {
      // As close as the map allows (or nowhere to go at all): settle here and
      // re-decide instead of wall-grinding or oscillating.
      ai.waypoint = undefined
      ai.mode = 'idle'
    }
  }
}
