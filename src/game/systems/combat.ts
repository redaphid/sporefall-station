import { CLASSES } from '../data/classes'
import { WEAPONS } from '../data/items'
import { NPCS } from '../data/npcs'
import { makeEntity, type Entity } from '../entity'
import type { InputCmd } from '../types'
import { addEntity, type World } from '../world'
import { isFrozen, isImmobilized, removeStatus } from './statusFx'

const IFRAME_TICKS = 5
const FLASH_TICKS = 3

/** Interaction-matrix rule: a solid IMPACT on a frozen body shatters it — an
 * instant kill regardless of the blow's damage, clearing the frost. Only impact
 * (this path) shatters; damage-over-time never routes through here, so a frozen
 * agent burned to death by fire dies normally and does not shatter. Grounded in
 * StatusEffects.cs (frozen death → IceGib) + the frozen one-hit backstab. */
const shatter = (w: World, target: Entity): void => {
  removeStatus(target, 'frozen')
  target.health!.hp = 0
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
  if (isFrozen(target)) return shatter(w, target)
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

  markCrime(w, target, attackerId)

  if (target.health.hp <= 0) kill(w, target)
}

const CRIME_TICKS = 15 * 30 // stay "wanted" for 15s

/** Attacking civilians or cops is a crime: flags the player, panics witnesses, raises the alarm. */
const markCrime = (w: World, target: Entity, attackerId: number): void => {
  const attacker = w.byId.get(attackerId)
  if (!attacker?.playerCtl || !target.ai) return
  if (target.ai.faction !== 'civ' && target.ai.faction !== 'cop') return
  attacker.playerCtl.crimeUntilTick = w.tick + CRIME_TICKS
  for (const witness of w.entities) {
    if (!witness.ai || witness.dead || witness === target) continue
    const dist = Math.hypot(witness.pos.x - target.pos.x, witness.pos.y - target.pos.y)
    if (dist > witness.ai.sightRange) continue
    if (witness.ai.faction === 'civ' && NPCS[witness.archetype]?.fleesOnDamage) {
      witness.ai.mode = 'flee'
      witness.ai.targetId = attackerId
      witness.ai.thinkAt = w.tick
    } else if (witness.ai.faction === 'cop') {
      if (w.alarm < 3) w.alarm++
      witness.ai.thinkAt = w.tick // cop reacts immediately
    }
  }
}

export const kill = (w: World, target: Entity): void => {
  w.events.push({ type: 'death', x: target.pos.x, y: target.pos.y, entityId: target.id })
  if (target.playerCtl) {
    // Downed: crawl-immobile, bleeding out; teammates can revive (interaction system).
    target.health!.hp = 0
    target.playerCtl.downed = { bleedTicks: 30 * 30, reviveProgress: 0 }
    target.vel.x = 0
    target.vel.y = 0
    return
  }
  target.dead = true
}

/** Swing at the nearest live target inside range and a 90° arc around facing. */
export const meleeAttack = (w: World, attacker: Entity, damage: number, range: number, knockback: number): boolean => {
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
  if (!best) return false
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
  return true
}

export const spawnProjectile = (
  w: World,
  owner: Entity,
  damage: number,
  speed: number,
  rangeTiles: number,
): void => {
  const e = makeEntity('projectile', 'projectile', owner.pos.x, owner.pos.y, 0.15)
  e.facing = owner.facing
  e.vel.x = Math.cos(owner.facing) * speed
  e.vel.y = Math.sin(owner.facing) * speed
  e.projectile = { ownerId: owner.id, damage, ttl: Math.ceil((rangeTiles / speed) * 30) }
  addEntity(w, e)
}

/** Player attack + ability inputs. NPC attacks happen in the AI system. */
export const combatSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  for (const e of w.entities) {
    if (!e.playerCtl || !e.combat || e.dead || e.playerCtl.downed) continue
    if (e.status && (e.status.stun > 0 || e.status.sleep > 0)) continue
    if (isImmobilized(e)) continue // frozen/electrified can't act
    const cmd = inputs.get(e.playerCtl.playerId)
    if (!cmd) continue
    const cls = CLASSES[e.playerCtl.classId]

    if (cmd.special && cls && e.playerCtl.abilityCooldown <= 0) {
      if (cls.ability(w, e)) e.playerCtl.abilityCooldown = cls.abilityCooldownTicks
    }

    if (!cmd.attack || e.combat.cooldown > 0) continue
    const weapon = WEAPONS[e.combat.weapon] ?? WEAPONS.fists
    e.combat.cooldown = weapon.cooldownTicks
    if (weapon.kind === 'melee') {
      const damage = Math.round(weapon.damage * (cls?.meleeDamageMult ?? 1))
      meleeAttack(w, e, damage, weapon.range, weapon.knockback)
    } else {
      spawnProjectile(w, e, weapon.damage, weapon.projectileSpeed ?? 12, weapon.range)
    }
  }
}
