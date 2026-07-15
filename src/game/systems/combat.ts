import { CLASSES } from '../data/classes'
import { WEAPONS, type StatusApply } from '../data/items'
import type { ResolvedTrigger } from '../data/mods'
import { NPCS } from '../data/npcs'
import { makeEntity, type Entity } from '../entity'
import type { EntityId, InputCmd } from '../types'
import { addEntity, type World } from '../world'
import { applyStatus, isFrozen, isImmobilized, removeStatus } from './statusFx'
import { equipSlot, spendAmmo, useHeld, wearMelee, weaponStack } from './inventory'
import { commitCrime } from './relationships'
import { destroyObject, isObject, resistsDamage } from './objects'
import { resolveWeapon, type ResolvedWeapon } from './resolveWeapon'
import { isRolling } from './roll'

const IFRAME_TICKS = 5
const FLASH_TICKS = 3
const THROW_COOLDOWN = 20

/** Interaction-matrix rule: a solid IMPACT on a frozen body shatters it — an
 * instant kill regardless of the blow's damage, clearing the frost. Only impact
 * (this path) shatters; damage-over-time never routes through here, so a frozen
 * agent burned to death by fire dies normally and does not shatter. Grounded in
 * StatusEffects.cs (frozen death → IceGib) + the frozen one-hit backstab. */
const shatter = (w: World, target: Entity): void => {
  removeStatus(target, 'frozen')
  target.health!.hp = 0
  // A frozen PLAYER shattering must DOWN them (via kill's player path), NOT
  // gib-vanish: skip the `shattered` flag and the ice-gib event so they stay a
  // visible, revivable downed body instead of disappearing from the snapshot.
  if (target.playerCtl) {
    kill(w, target)
    return
  }
  target.shattered = true
  w.events.push({ type: 'shatter', x: target.pos.x, y: target.pos.y, entityId: target.id })
  kill(w, target)
}

export const applyDamage = (
  w: World,
  target: Entity,
  amount: number,
  fromX: number,
  fromY: number,
  knockback: number,
  attackerId: number,
): void => {
  if (!target.health || target.dead || target.health.iframes > 0) return
  if (target.playerCtl?.downed) return // downed players are out of the fight, not a piñata
  if (isRolling(target, w.tick)) return // dodge-roll i-frames: roll THROUGH bullets/melee
  if (isFrozen(target)) return shatter(w, target)
  // Negative damage must NOT heal: clamp to 0 so a "negative hit" still registers
  // as a (harmless) blow — iframes, flash, knockback, event — but can never add hp.
  if (amount < 0) amount = 0
  if (resistsDamage(target, amount)) return // e.g. a barrel shrugs off a weak hit
  target.health.hp -= amount
  target.health.iframes = IFRAME_TICKS
  if (target.status) {
    target.status.hitFlashUntil = w.tick + FLASH_TICKS
    target.status.sleep = 0 // damage wakes sleepers
  }
  const dx = target.pos.x - fromX
  const dy = target.pos.y - fromY
  const len = Math.hypot(dx, dy) || 1
  target.vel.x += (dx / len) * knockback
  target.vel.y += (dy / len) * knockback
  w.events.push({ type: 'hit', x: target.pos.x, y: target.pos.y, targetId: target.id, amount })

  // Civilians panic when hurt; bouncers take it personally
  if (target.ai) {
    const def = NPCS[target.archetype]
    if (def?.fleesOnDamage) {
      target.ai.mode = 'flee'
      target.ai.targetId = attackerId
      target.ai.thinkAt = w.tick // re-think immediately
    } else if (def?.retaliates) {
      target.ai.mode = 'aggro'
      target.ai.targetId = attackerId
      const attacker = w.byId.get(attackerId)
      if (attacker) target.ai.lastKnownTargetPos = { x: attacker.pos.x, y: attacker.pos.y }
      target.ai.thinkAt = w.tick
    }
  }

  // Disposition: a player attack on a civ/cop is a crime — witnesses re-derive
  // their stance toward the attacker (cops/allies turn hostile, civilians flee).
  commitCrime(w, target, w.byId.get(attackerId))

  if (target.health.hp <= 0) {
    if (isObject(target)) destroyObject(w, target, attackerId)
    else kill(w, target)
  }
}

export const kill = (w: World, target: Entity): void => {
  // Already bleeding out? A second lethal blow (a DOT tick landing on the downed
  // body, a stray hit) must NOT re-arm the bleed timer or emit a fresh death —
  // that would reset the 30s clock every DOT interval and trap a downed solo
  // player at hp 0 forever (the red-flash dead-end, #52). They are out of the
  // fight: pin hp at 0 and let the existing bleed-out run to its resolution.
  if (target.playerCtl?.downed) {
    target.health!.hp = 0
    return
  }
  w.events.push({ type: 'death', x: target.pos.x, y: target.pos.y, entityId: target.id })
  if (target.playerCtl) {
    target.health!.hp = 0
    target.vel.x = 0
    target.vel.y = 0
    // `normal` with an empty revive pool: the comeback economy is spent, so this
    // down is PERMANENT death (feeds the run-over check in missions.ts). Otherwise
    // — and always in `casual` — go downed: crawl-immobile and bleeding out. A
    // teammate can revive (interaction system); solo bleeds out to a self-revive
    // at a penalty, or, out of lives, to a real run-over.
    if (w.mode === 'normal' && w.revivesLeft <= 0) {
      target.playerCtl.downed = undefined
      target.dead = true
      return
    }
    target.playerCtl.downed = { bleedTicks: 30 * 30, reviveProgress: 0 }
    return
  }
  target.dead = true
}

/** Swing at the nearest live target inside range and a 90° arc around facing. */
export const meleeAttack = (w: World, attacker: Entity, damage: number, range: number, knockback: number): Entity | null => {
  const fx = Math.cos(attacker.facing)
  const fy = Math.sin(attacker.facing)
  let best: Entity | null = null
  let bestDist = Infinity
  for (const e of w.entities) {
    if (e === attacker || e.dead || !e.health) continue
    const dx = e.pos.x - attacker.pos.x
    const dy = e.pos.y - attacker.pos.y
    const dist = Math.hypot(dx, dy)
    // Weapon range is edge-to-edge: include both bodies' radii.
    if (dist > range + attacker.radius + e.radius) continue
    // Within 90° of facing (or point-blank)
    if (dist > 0.3 && (dx * fx + dy * fy) / dist < 0.5) continue
    if (dist < bestDist) {
      best = e
      bestDist = dist
    }
  }
  if (!best) return null
  let finalDamage = damage
  // Cloaked backstab: attacker unseen and behind the target's facing → triple damage.
  if (attacker.status && attacker.status.cloakUntil > w.tick) {
    const tx = Math.cos(best.facing)
    const ty = Math.sin(best.facing)
    const adx = attacker.pos.x - best.pos.x
    const ady = attacker.pos.y - best.pos.y
    const alen = Math.hypot(adx, ady) || 1
    if ((adx / alen) * tx + (ady / alen) * ty < -0.2) finalDamage *= 3
    attacker.status.cloakUntil = w.tick // attacking breaks cloak
  }
  applyDamage(w, best, finalDamage, attacker.pos.x, attacker.pos.y, knockback, attacker.id)
  return best
}

/** Resolved bullet-behavior spec carried onto a spawned projectile (weapon mods). */
export interface ProjectileSpec {
  onHit?: StatusApply
  pierce?: number
  bounce?: number
  homing?: number
  explodeRadius?: number
  explodeDamage?: number
  split?: number
  lifestealFrac?: number
  triggers?: ResolvedTrigger[]
}

export const spawnProjectile = (
  w: World,
  owner: Entity,
  damage: number,
  speed: number,
  rangeTiles: number,
  angleOffset = 0,
  onHit?: StatusApply,
  spec?: ProjectileSpec,
): void => {
  const angle = owner.facing + angleOffset
  const e = makeEntity('projectile', 'projectile', owner.pos.x, owner.pos.y, 0.15)
  e.facing = angle
  e.vel.x = Math.cos(angle) * speed
  e.vel.y = Math.sin(angle) * speed
  const ttl = Math.ceil((rangeTiles / speed) * 30)
  e.projectile = { ownerId: owner.id, damage, ttl, onHit: spec?.onHit ?? onHit }
  // Attach only the mod fields that are actually present → snapshot-stable: a
  // vanilla shot serializes exactly as before this feature.
  if (spec) {
    const p = e.projectile
    if (spec.pierce) p.pierceLeft = spec.pierce
    if (spec.bounce) p.bounceLeft = spec.bounce
    if (spec.homing) p.homing = spec.homing
    if (spec.explodeRadius && spec.explodeDamage) p.explode = { radius: spec.explodeRadius, damage: spec.explodeDamage }
    if (spec.split && spec.split > 0) p.split = { count: spec.split, damage: Math.max(1, Math.round(damage * 0.5)), speed, ttl: Math.ceil(ttl / 2) }
    if (spec.lifestealFrac) p.lifestealFrac = spec.lifestealFrac
    if (spec.triggers && spec.triggers.length) p.triggers = spec.triggers
  }
  addEntity(w, e)
}

/** A blast at (x,y): every live body in radius takes `damage` from the owner.
 * The one AoE primitive — reused by grenades/explosive bullets (projectiles.ts)
 * and by on-kill detonator triggers. Kept here (not projectiles.ts) so the
 * projectile system can import it without a cycle back through applyDamage. */
export const detonate = (w: World, x: number, y: number, radius: number, damage: number, ownerId: EntityId): void => {
  w.events.push({ type: 'explosion', x, y, radius })
  for (const other of w.entities) {
    if (other.dead || !other.health) continue
    const dist = Math.hypot(other.pos.x - x, other.pos.y - y)
    if (dist <= radius + other.radius) applyDamage(w, other, damage, x, y, 10, ownerId)
  }
}

/** Fire a bullet/melee hit's resolved triggers on a struck victim. `killed` is
 * whether this blow put the victim down. on-reload triggers are inert here (no
 * reload action yet — P4). Bounded: a detonator blast does NOT re-chain, so a
 * huge detonator stack can't recurse without limit. */
export const runHitTriggers = (
  w: World,
  victim: Entity,
  triggers: readonly ResolvedTrigger[] | undefined,
  ownerId: EntityId,
  killed: boolean,
): void => {
  if (!triggers) return
  for (const t of triggers) {
    if (!t.explode) continue
    if (t.event === 'hit' || (t.event === 'kill' && killed)) {
      detonate(w, victim.pos.x, victim.pos.y, t.explode.radius, t.explode.damage, ownerId)
    }
  }
}

/** Distil a resolved weapon into a projectile spec, or undefined when the shot
 * is fully vanilla (no behavior/trigger mods) — so an unmodded bullet spawns
 * byte-for-byte as before. */
const projectileSpec = (rw: ResolvedWeapon): ProjectileSpec | undefined => {
  const b = rw.behavior
  const has = b.pierce || b.bounce || b.homing || b.explodeRadius || b.split || b.lifestealFrac || rw.triggers.length
  if (!has) return undefined
  return {
    pierce: b.pierce || undefined,
    bounce: b.bounce || undefined,
    homing: b.homing || undefined,
    explodeRadius: b.explodeRadius || undefined,
    explodeDamage: b.explodeDamage || undefined,
    split: b.split || undefined,
    lifestealFrac: b.lifestealFrac || undefined,
    triggers: rw.triggers.length ? rw.triggers : undefined,
  }
}

/** Player attack + ability inputs. NPC attacks happen in the AI system. */
export const combatSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  for (const e of w.entities) {
    if (!e.playerCtl || !e.combat || e.dead || e.playerCtl.downed) continue
    if (isRolling(e, w.tick)) continue // mid-roll: hands full — no attack/ability/throw
    if (e.status && (e.status.stun > 0 || e.status.sleep > 0)) continue
    if (isImmobilized(e)) continue // frozen/electrified can't act
    const cmd = inputs.get(e.playerCtl.playerId)
    if (!cmd) continue
    const cls = CLASSES[e.playerCtl.classId]

    if (cmd.special && cls && e.playerCtl.abilityCooldown <= 0) {
      if (cls.ability(w, e)) e.playerCtl.abilityCooldown = cls.abilityCooldownTicks
    }

    // Hotbar: equip a slot; Use/Throw: use the held item (throw or consume).
    if (cmd.hotbar >= 0) equipSlot(e, cmd.hotbar)
    if (cmd.throwItem && e.combat.cooldown <= 0 && useHeld(w, e)) e.combat.cooldown = THROW_COOLDOWN

    if (!cmd.attack || e.combat.cooldown > 0) continue
    const weapon = WEAPONS[e.combat.weapon] ?? WEAPONS.fists
    // The SINGLE fire-site fold: mods hang off the swung weapon's ItemStack.
    const rw = resolveWeapon(weapon, weaponStack(e)?.mods)
    if (weapon.kind === 'melee') {
      e.combat.cooldown = rw.cooldownTicks
      const damage = Math.round(rw.damage * (cls?.meleeDamageMult ?? 1))
      const hit = meleeAttack(w, e, damage, weapon.range, rw.knockback)
      if (weapon.durability !== undefined) wearMelee(e)
      if (hit) {
        if (rw.onHit) applyStatus(w, hit, rw.onHit.status, rw.onHit.ticks)
        runHitTriggers(w, hit, rw.triggers, e.id, hit.dead === true || (hit.health?.hp ?? 1) <= 0)
      }
    } else {
      if (!spendAmmo(e)) continue // empty gun clicks — no shot, no cooldown
      e.combat.cooldown = rw.cooldownTicks
      const spec = projectileSpec(rw)
      for (let i = 0; i < rw.pellets; i++) {
        const offset = rw.pellets > 1 ? (i / (rw.pellets - 1) - 0.5) * rw.spread : 0
        spawnProjectile(w, e, rw.damage, rw.projectileSpeed, weapon.range, offset, rw.onHit, spec)
      }
    }
  }
}
