import { makeEntity, type Entity } from '../entity'
import { SIM_DT } from '../types'
import { addEntity, isBlocked, type World } from '../world'
import { applyDamage, detonate, runHitTriggers } from './combat'
import { applyAreaEffect } from './itemEffects'
import { applyStatus } from './statusFx'

/** Steer a homing projectile: rotate its velocity toward the nearest hostile
 * body by at most `homing` radians this tick, preserving speed. Deterministic —
 * nearest wins, ties broken by ascending id, no RNG. */
const homeToward = (w: World, e: Entity): void => {
  const p = e.projectile!
  let best: Entity | null = null
  let bestDist = Infinity
  for (const o of w.entities) {
    if (o.id === p.ownerId || o.dead || !o.health || o.kind === 'projectile' || o.kind === 'player') continue
    const d = Math.hypot(o.pos.x - e.pos.x, o.pos.y - e.pos.y)
    if (d < bestDist) {
      best = o
      bestDist = d
    }
  }
  if (!best) return
  const speed = Math.hypot(e.vel.x, e.vel.y) || 1
  const cur = Math.atan2(e.vel.y, e.vel.x)
  const want = Math.atan2(best.pos.y - e.pos.y, best.pos.x - e.pos.x)
  let diff = want - cur
  while (diff > Math.PI) diff -= 2 * Math.PI
  while (diff < -Math.PI) diff += 2 * Math.PI
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
      // EVERY on-hit effect below is gated on the blow actually landing. It used
      // not to be, and that single omission produced three separate bugs: you
      // could be stunned by a swing you dodge-rolled through, lifesteal healed
      // off bullets i-frames had already voided, and mod triggers fired on hits
      // that never connected. A body's i-frames are 5 ticks, so a multi-pellet
      // volley lands most of its pellets straight into them.
      const dealt = applyDamage(w, other, p.damage, e.pos.x - e.vel.x * SIM_DT, e.pos.y - e.vel.y * SIM_DT, 3, p.ownerId)
      // `!== null`, NOT truthiness: 0 is a hit that landed and dealt no hp (the
      // freeze ray), and it must still apply its status.
      const landed = dealt !== null
      if (landed && p.onHit) applyStatus(w, other, p.onHit.status, p.onHit.ticks)
      const killed = !!other.dead || (other.health?.hp ?? 1) <= 0
      if (landed && p.lifestealFrac) {
        // Pay out on damage ACTUALLY DEALT, never the bullet's intended damage.
        // Reading `p.damage` here ignored resist entirely, so an armoured target
        // absorbed most of the blow while the shooter was still paid in full.
        const owner = w.byId.get(p.ownerId) // may be gone — guard
        if (owner?.health) owner.health.hp = Math.min(owner.health.max, owner.health.hp + dealt * p.lifestealFrac)
      }
      if (landed) runHitTriggers(w, other, p.triggers, p.ownerId, killed)
      if (landed && p.split) spawnSplit(w, e)

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
