import { makeEntity, type Entity } from '../entity'
import { hasLineOfSight } from '../los'
import { SIM_DT, type EntityId } from '../types'
import { addEntity, doorClosedAt, isBlocked, type World } from '../world'
import { applyDamage, detonate, runHitTriggers } from './combat'
import { applyAreaEffect } from './itemEffects'
import { isObject } from './objects'
import { applyStatus } from './statusFx'

/** Shortest signed angle from `b` to `a`, wrapped to (-PI, PI]. */
const angleDiff = (a: number, b: number): number => {
  let d = a - b
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

/** Half-angle (radians) of the acquisition cone around the LAUNCH heading. A
 * homing round only ever considers targets inside this cone, so it forgives a
 * near miss instead of overruling your aim — it can never hook backwards onto
 * something you were not shooting at. ~28°. */
const HOMING_CONE = 0.5

/** A body a homing round may steer toward: a living, damageable, NON-player,
 * NON-object entity. Excluding objects matters — crates and barrels carry
 * `health`, and without this a bullet would curve into the nearest crate. */
const isHomingTarget = (e: Entity, ownerId: EntityId): boolean =>
  e.id !== ownerId && !e.dead && !!e.health && e.kind !== 'projectile' && e.kind !== 'player' && !isObject(e)

/** Steer a homing projectile: rotate its velocity toward the best target by at
 * most `homing` radians this tick, preserving speed.
 *
 * A valid target must be (1) inside `HOMING_CONE` of the round's LAUNCH heading
 * (`p.aim`, fixed at spawn — NOT the current heading, which would let small
 * per-tick turns accumulate into a hook), and (2) in unbroken LINE OF SIGHT, so
 * an enemy behind a wall is never acquired. Nearest qualifying body wins, ties
 * broken by ascending id. If nothing qualifies the round flies straight.
 *
 * Deterministic: no RNG, no wall-clock — a pure function of world state. */
const homeToward = (w: World, e: Entity): void => {
  const p = e.projectile!
  const aim = p.aim ?? Math.atan2(e.vel.y, e.vel.x)
  let best: Entity | null = null
  let bestDist = Infinity
  for (const o of w.entities) {
    if (!isHomingTarget(o, p.ownerId)) continue
    const dx = o.pos.x - e.pos.x
    const dy = o.pos.y - e.pos.y
    const d = Math.hypot(dx, dy)
    if (d >= bestDist) continue
    // (1) inside the acquisition cone around the ORIGINAL shot direction.
    if (Math.abs(angleDiff(Math.atan2(dy, dx), aim)) > HOMING_CONE) continue
    // (2) line of sight — never home through a wall or a closed door.
    if (!hasLineOfSight(w.level, e.pos.x, e.pos.y, o.pos.x, o.pos.y, (tx, ty) => doorClosedAt(w, tx, ty))) continue
    best = o
    bestDist = d
  }
  if (!best) return
  const speed = Math.hypot(e.vel.x, e.vel.y) || 1
  const cur = Math.atan2(e.vel.y, e.vel.x)
  const want = Math.atan2(best.pos.y - e.pos.y, best.pos.x - e.pos.x)
  const diff = angleDiff(want, cur)
  const turn = Math.max(-p.homing!, Math.min(p.homing!, diff))
  const na = cur + turn
  e.vel.x = Math.cos(na) * speed
  e.vel.y = Math.sin(na) * speed
  e.facing = na
}

/** Reflect a projectile off the wall it just entered, stepping it back out and
 * flipping the blocked axis (corner → flip both). Returns false when it can't
 * bounce (no bounces left) so the caller resolves it as a normal wall impact. */
const bounceOffWall = (w: World, e: Entity): boolean => {
  const p = e.projectile!
  if (!p.bounceLeft || p.bounceLeft <= 0) return false
  const px = e.pos.x - e.vel.x * SIM_DT
  const py = e.pos.y - e.vel.y * SIM_DT
  const blockX = isBlocked(w, Math.floor(e.pos.x), Math.floor(py))
  const blockY = isBlocked(w, Math.floor(px), Math.floor(e.pos.y))
  if (blockX) e.vel.x = -e.vel.x
  if (blockY) e.vel.y = -e.vel.y
  if (!blockX && !blockY) {
    e.vel.x = -e.vel.x
    e.vel.y = -e.vel.y
  }
  e.pos.x = px // back out of the wall so it doesn't stick
  e.pos.y = py
  e.facing = Math.atan2(e.vel.y, e.vel.x)
  p.bounceLeft -= 1
  return true
}

/** Spawn a projectile's split shards in a fan around its heading — children
 * inherit the owner (so kill credit / PvP scoring stay correct) and deal reduced
 * damage. Children never re-split, so a huge split stack can't cascade. */
const spawnSplit = (w: World, e: Entity): void => {
  const p = e.projectile!
  const s = p.split!
  const base = Math.atan2(e.vel.y, e.vel.x)
  const spread = 0.9
  for (let i = 0; i < s.count; i++) {
    const offset = s.count > 1 ? (i / (s.count - 1) - 0.5) * spread : 0
    const a = base + offset
    const child = makeEntity('projectile', 'projectile', e.pos.x, e.pos.y, 0.12)
    child.facing = a
    child.vel.x = Math.cos(a) * s.speed
    child.vel.y = Math.sin(a) * s.speed
    child.projectile = { ownerId: p.ownerId, damage: s.damage, ttl: s.ttl }
    // Shards inherit the parent's mod provenance so they read as the same build.
    if (p.mods) child.projectile.mods = p.mods.map((m) => ({ ...m }))
    addEntity(w, child)
  }
}

/** Shatter a dying projectile into a RADIAL burst of short-range fragments
 * (splinterShot). Distinct from `spawnSplit` (a forward fork on the first body
 * hit): this fires an omnidirectional shrapnel ring at the point the round dies —
 * wall, ttl expiry, or enemy. Directions are evenly spread around the circle with
 * a deterministic per-fragment jitter drawn from the world RNG (`w.rng`, whose
 * stream position serializes → replay-identical). Fragments carry NO `splinter`
 * field, so they can never re-splinter — the recursion guard. They inherit the
 * parent's element (onHit) and mod provenance (for the shared visual) but not its
 * explode/split/pierce/triggers, so a shatter can't cascade or double-detonate. */
const spawnSplinter = (w: World, e: Entity): void => {
  const p = e.projectile!
  const s = p.splinter!
  const base = w.rng.next() * Math.PI * 2 // deterministic ring rotation
  const slice = (Math.PI * 2) / s.count
  for (let i = 0; i < s.count; i++) {
    // Even spacing + a bounded jitter that stays inside the fragment's own slice,
    // so shards never perfectly overlap yet the spray never clumps.
    const a = base + i * slice + (w.rng.next() - 0.5) * slice * 0.6
    const child = makeEntity('projectile', 'projectile', e.pos.x, e.pos.y, 0.1)
    child.facing = a
    child.vel.x = Math.cos(a) * s.speed
    child.vel.y = Math.sin(a) * s.speed
    child.projectile = { ownerId: p.ownerId, damage: s.damage, ttl: s.ttl }
    if (p.onHit) child.projectile.onHit = { ...p.onHit }
    if (p.mods) child.projectile.mods = p.mods.map((m) => ({ ...m }))
    addEntity(w, child)
  }
}

export const projectileSystem = (w: World): void => {
  for (const e of w.entities) {
    if (!e.projectile || e.dead) continue
    const p = e.projectile
    if (p.homing) homeToward(w, e)
    e.pos.x += e.vel.x * SIM_DT
    e.pos.y += e.vel.y * SIM_DT
    p.ttl--

    if (p.ttl <= 0) {
      if (p.explode) detonate(w, e.pos.x, e.pos.y, p.explode.radius, p.explode.damage, p.ownerId)
      if (p.splinter) spawnSplinter(w, e)
      land(w, e)
      e.dead = true
      continue
    }
    if (isBlocked(w, Math.floor(e.pos.x), Math.floor(e.pos.y))) {
      if (bounceOffWall(w, e)) continue // ricochet — stays alive
      if (p.explode) detonate(w, e.pos.x, e.pos.y, p.explode.radius, p.explode.damage, p.ownerId)
      if (p.splinter) spawnSplinter(w, e)
      land(w, e)
      e.dead = true
      continue
    }

    for (const other of w.entities) {
      if (other.id === p.ownerId || other.dead || !other.health) continue
      if (p.hitIds && p.hitIds.includes(other.id)) continue // pierce: don't re-hit a body
      const dx = other.pos.x - e.pos.x
      const dy = other.pos.y - e.pos.y
      const rr = other.radius + e.radius
      if (dx * dx + dy * dy >= rr * rr) continue

      if (p.explode) {
        detonate(w, e.pos.x, e.pos.y, p.explode.radius, p.explode.damage, p.ownerId)
        if (p.splinter) spawnSplinter(w, e)
        land(w, e)
        e.dead = true
        break
      }
      if (p.onLand) {
        // A thrown item's whole effect is its onLand (fire/blast/status burst); the
        // point-damage hit is a no-op that would only grant iframes — skip it and
        // let land() resolve the area effect.
        land(w, e)
        e.dead = true
        break
      }

      // Normal bullet hit (incl. pierce/split/lifesteal/triggers).
      applyDamage(w, other, p.damage, e.pos.x - e.vel.x * SIM_DT, e.pos.y - e.vel.y * SIM_DT, 3, p.ownerId)
      if (p.onHit) applyStatus(w, other, p.onHit.status, p.onHit.ticks)
      const killed = !!other.dead || (other.health?.hp ?? 1) <= 0
      if (p.lifestealFrac) {
        const owner = w.byId.get(p.ownerId) // may be gone — guard
        if (owner?.health) owner.health.hp = Math.min(owner.health.max, owner.health.hp + p.damage * p.lifestealFrac)
      }
      runHitTriggers(w, other, p.triggers, p.ownerId, killed)
      if (p.split) spawnSplit(w, e)

      if (p.pierceLeft && p.pierceLeft > 0) {
        p.pierceLeft -= 1
        ;(p.hitIds ??= []).push(other.id)
        // pierce keeps flying — but split fires once, on the first body only.
        if (p.split) p.split = undefined
        continue
      }
      // Terminal body impact: shatter into shrapnel (splinter fires alongside any
      // forward split fork above — both are bounded, neither cascades).
      if (p.splinter) spawnSplinter(w, e)
      land(w, e)
      e.dead = true
      break
    }
  }
}

/** A thrown item applies its area effect where it lands (molotov → fire, freeze
 * grenade → frozen burst, grenade → blast). */
const land = (w: World, e: { pos: { x: number; y: number }; projectile?: { ownerId: number; onLand?: import('../data/items').AreaEffect } }): void => {
  if (e.projectile?.onLand) applyAreaEffect(w, e.pos.x, e.pos.y, e.projectile.onLand, e.projectile.ownerId)
}
