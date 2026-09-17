import { makeEntity, type Entity } from '../entity'
import { SIM_DT } from '../types'
import { addEntity, isBlocked, type World } from '../world'
import { applyDamage, detonate, runHitTriggers } from './combat'
import { canSeeEntity, hateToward } from './goals'
import { applyAreaEffect } from './itemEffects'
import { CRIME_HATE, initialFactionHate } from './relationships'
import { applyStatus } from './statusFx'
import { vlen } from '../simMath'

// ── Homing (reworked after playtest: "it mostly just curves bullets into walls").
// A homing round is a SEEKER HEAD, not a map-wide magnet: it only chases what it
// can actually SEE, inside a forward cone, and only genuine enemies of whoever
// fired it. No visible prey → it flies dead straight.

/** Acquisition radius (tiles) — beyond this a round doesn't even look. */
const HOMING_RANGE = 10
/** Base half-angle (radians) of the forward seek cone around the heading. */
const HOMING_CONE = 1.0
/** Extra cone half-angle per radian/tick of turn rate — so stacking the mod
 * widens the seek cone at the same time as it sharpens the turn. */
const HOMING_CONE_PER_TURN = 2

const wrapAngle = (a: number): number => {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

/** Is `t` a body a round fired by `owner` should hunt? Combatant bodies only —
 * npc/player, never doors, furniture, pickups or other bullets — never the owner
 * itself, and only when genuinely hostile to the owner's side:
 *  - player-owned rounds seek NPCs whose disposition toward that player is
 *    Hostile (stored grudge, faction opener, the `w.hostile` floor, infection —
 *    all via `hateToward`). Never players: co-op allies are not prey. In a
 *    peaceful world a Neutral civilian is not prey either — homing must never
 *    auto-commit a crime the player didn't aim.
 *  - NPC-owned rounds seek players the NPC hates (the enemy-fire symmetry the
 *    old global-nearest scan got backwards: it excluded players outright, so an
 *    enemy's homing gun chased its own allies), and NPCs it holds a Hostile
 *    stance toward (stored rel, else the faction matrix — cop vs gang).
 * Downed players are out of the fight (their hits void anyway) — skipped. */
const isHomingPrey = (w: World, owner: Entity, t: Entity): boolean => {
  if (t.id === owner.id || t.dead || !t.health) return false
  if (t.kind === 'player') {
    if (!owner.ai || t.playerCtl?.downed) return false
    return hateToward(w, owner, t.id) >= CRIME_HATE
  }
  if (t.kind !== 'npc') return false
  if (owner.playerCtl) return hateToward(w, t, owner.id) >= CRIME_HATE
  const stored = owner.ai?.rel?.[t.id]?.hate
  const hate = stored ?? initialFactionHate(owner.ai?.faction ?? 'neutral', t.ai?.faction ?? 'neutral')
  return hate >= CRIME_HATE
}

/** Steer a homing projectile. Candidates are live enemy bodies (`isHomingPrey`)
 * within HOMING_RANGE and inside the forward cone — never a target behind the
 * round, so it can't yank itself backwards — and, the load-bearing rule, only
 * ones the round can SEE (tile raycast via `canSeeEntity`; walls and closed
 * doors block). A target behind cover simply isn't there: with no visible
 * candidate the round flies straight, which is what kills the old
 * curve-into-the-wall failure. Among candidates the straightest-ahead wins
 * (smallest angular deviation; nearer breaks a dev tie; earliest in entity
 * order — ascending id — breaks that), then the velocity rotates toward it by
 * at most `homing` radians this tick, preserving speed. Re-evaluated every
 * tick, so breaking LOS mid-flight stops the steering that instant.
 * Deterministic: pure world-state reads, stable iteration order, no RNG. */
const homeToward = (w: World, e: Entity): void => {
  const p = e.projectile!
  const owner = w.byId.get(p.ownerId)
  if (!owner) return // an orphaned round has no side to fight for — fly straight
  const cur = Math.atan2(e.vel.y, e.vel.x)
  const halfCone = HOMING_CONE + p.homing! * HOMING_CONE_PER_TURN
  let best: Entity | null = null
  let bestDev = Infinity
  let bestDist = Infinity
  for (const o of w.entities) {
    if (!isHomingPrey(w, owner, o)) continue
    const dx = o.pos.x - e.pos.x
    const dy = o.pos.y - e.pos.y
    const d = vlen(dx, dy)
    if (d > HOMING_RANGE) continue
    const dev = Math.abs(wrapAngle(Math.atan2(dy, dx) - cur))
    if (dev > halfCone) continue
    if (dev > bestDev || (dev === bestDev && d >= bestDist)) continue // keep-first ⇒ lowest id on a full tie
    if (!canSeeEntity(w, e, o)) continue // the LOS gate: what it can't see, it won't chase
    best = o
    bestDev = dev
    bestDist = d
  }
  if (!best) return
  const speed = vlen(e.vel.x, e.vel.y) || 1
  const want = Math.atan2(best.pos.y - e.pos.y, best.pos.x - e.pos.x)
  const turn = Math.max(-p.homing!, Math.min(p.homing!, wrapAngle(want - cur)))
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

/** A thrown item applies its area effect where it lands (grenade → explode, freeze
 * grenade → frozen burst, grenade → blast). */
const land = (w: World, e: { pos: { x: number; y: number }; projectile?: { ownerId: number; onLand?: import('../data/items').AreaEffect } }): void => {
  if (e.projectile?.onLand) applyAreaEffect(w, e.pos.x, e.pos.y, e.projectile.onLand, e.projectile.ownerId)
}
