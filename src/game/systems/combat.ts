import { PLAYER_MELEE_MULT, SPECIAL_COOLDOWN_TICKS, throwGrenade } from '../player'
import { WEAPONS, type StatusApply } from '../data/items'
import { normalizeMods, type ResolvedTrigger } from '../data/mods'
import { NPCS } from '../data/npcs'
import { makeEntity, resistMult, type Entity, type WeaponMod } from '../entity'
import type { EntityId, InputCmd } from '../types'
import { addEntity, emitFear, emitNoise, type World } from '../world'
import { applyStatus, isBrittleFrozen, isFrozen, isImmobilized, removeStatus } from './statusFx'
import { equipSlot, useHeld, wearMelee, weaponStack } from './inventory'
import { commitCrime } from './relationships'
import { destroyObject, isObject, resistsDamage } from './objects'
import { resolveWeapon, type ResolvedWeapon } from './resolveWeapon'
import { isRolling, tryStartRoll } from './roll'
import { spawnSporeBurst } from './spore'

const IFRAME_TICKS = 5
const FLASH_TICKS = 3
const THROW_COOLDOWN = 20

/** Damage multiplier for cracking a NON-brittle freeze (Cryo Rounds). Frost's
 * verb is CONTROL, and this is the payoff the control sets up: freeze, then land
 * one heavy blow. Deliberately a multiplier applied BEFORE `resistMult`, so the
 * bonus is still resisted like any other physical damage — a bonus that skipped
 * resist would just be the shatter bug wearing a smaller number. */
const FROZEN_HIT_DAMAGE_MULT = 2.5

/** Extra shove on that same blow. Knocking the thawed body back re-opens the gap
 * frost just bought you, so the follow-up reads as an impact rather than a stat. */
const FROZEN_HIT_KNOCKBACK = 10

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

/**
 * Resolve one blow. Returns the damage ACTUALLY APPLIED, or `null` if the blow
 * never landed at all.
 *
 * ⚠️ `null` and `0` mean different things, and conflating them breaks real
 * weapons. `null` = the blow was voided (i-frames, dodge-roll, downed, dead, an
 * object below its damage threshold) and NOTHING about it should happen. `0` =
 * it genuinely landed but dealt no hp — a pure-utility hit such as the freeze
 * ray, whose whole job is its status. So callers must test `!== null`, never
 * truthiness, or every 0-damage utility weapon silently stops working.
 *
 * The return value is load-bearing, not a convenience, and it closes two
 * separate defects that were both symptoms of it being `void`:
 *
 *  - Everything a hit does BESIDES damage — applying an element, healing via
 *    lifesteal, firing a mod trigger — ran unconditionally, because no caller
 *    could know this function had bailed out. i-frames, the dodge-roll and the
 *    downed state therefore suppressed the DAMAGE only: you could roll through a
 *    sledgehammer swing, take nothing, and be stunned anyway, which defeats the
 *    single piece of counterplay the game offers against being locked down.
 *  - Effects that SCALE with damage had no way to read what was actually dealt,
 *    so lifesteal healed off the bullet's INTENDED damage and ignored resist
 *    entirely — a 0.35-armoured brute absorbed 82% of a hit while the shooter
 *    was paid in full for it.
 *
 * Returning the applied amount makes any future damage-scaled effect correct by
 * construction rather than by remembering to patch it.
 */
export const applyDamage = (
  w: World,
  target: Entity,
  amount: number,
  fromX: number,
  fromY: number,
  knockback: number,
  attackerId: number,
): number | null => {
  if (!target.health || target.dead || target.health.iframes > 0) return null
  if (target.playerCtl?.downed) return null // downed players are out of the fight, not a piñata
  if (isRolling(target, w.tick)) return null // dodge-roll i-frames: roll THROUGH bullets/melee
  // A frozen body shatters on impact — but NOT a player. The shatter rule is an
  // instant kill regardless of the blow's damage, and a player has no answer to
  // it: freeze is applied BY enemies (freeze ray / freeze grenade, 120 ticks =
  // four seconds) and immobilizes completely, so the sequence "enemy freezes
  // you, any enemy touches you, you are downed" is unavoidable and reads as
  // dying in one hit. Harmless while the station ignored you; lethal now the
  // alert escalation sends the whole floor at you at once.
  //
  // So for a player the impact CRACKS THE ICE instead: the freeze breaks and the
  // blow lands as ordinary damage. Costs you tempo and a hit, not the run. The
  // anti-chain-lock guard in statusFx then grants its usual post-immobilize
  // immunity, so you cannot be instantly re-frozen either.
  //
  // Enemies shatter only from BRITTLE ice — a thrown freeze grenade. The execute
  // belongs to a limited consumable you have to find, carry and aim. Cryo Rounds
  // is a permanent weapon mod firing every other shot; the same rule there made a
  // 320hp boss die exactly as fast as a 40hp thug, because shatter ignores hp,
  // resist and archetype completely.
  //
  // A NON-brittle freeze cracks instead, for everyone. That is frost's actual
  // design: its verb is CONTROL, and this is the payoff it sets up — freeze, then
  // land one heavy blow that hits far harder and shoves the body back. The freeze
  // is SPENT doing it, and the anti-chain-lock's post-immobilize immunity then
  // gates the next one, so the loop is freeze → punish → wait, not a stun-lock.
  if (isFrozen(target)) {
    if (!target.playerCtl && isBrittleFrozen(target)) {
      shatter(w, target)
      // Reports 0 DEALT, deliberately: the blow landed, but the ice did the
      // killing, not the bullet. Reporting the shattered body's whole hp pool
      // here would let a lifesteal round heal for a 320hp boss's lifebar off a
      // grenade someone else threw — a brand-new exploit created by fixing this
      // one. You are paid for the damage you deal, and shatter deals none.
      return 0
    }
    removeStatus(target, 'frozen')
    // The player's own thaw stays a plain hit — being frozen is already punishing
    // enough when the whole floor is converging on you.
    if (!target.playerCtl) {
      amount *= FROZEN_HIT_DAMAGE_MULT
      knockback += FROZEN_HIT_KNOCKBACK
    }
  }
  // Negative damage must NOT heal: clamp to 0 so a "negative hit" still registers
  // as a (harmless) blow — iframes, flash, knockback, event — but can never add hp.
  if (amount < 0) amount = 0
  // #78 damage affinity: armoured bodies shrug off impact, flammable ones don't.
  // Impact/explosion damage is 'physical'; missing table → ×1 (unchanged).
  amount = Math.round(amount * resistMult(target, 'physical'))
  if (resistsDamage(target, amount)) return null // e.g. a barrel shrugs off a weak hit
  target.health.hp -= amount
  target.health.iframes = IFRAME_TICKS
  // Stamp the last-hurt tick: passive regen (systems/regen.ts) counts its
  // "unharmed" window from here, so any landed blow (even a clamped 0-damage one)
  // interrupts and restarts the wait. Only LANDED blows reach this line — the
  // iframes/roll/downed/resist early-outs above never do.
  target.health.lastHurtTick = w.tick
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

  // A landed blow breaks a lockpick channel — the one non-movement interrupt.
  // Only LANDED blows: iframes/roll/downed early-outs above never reach here.
  if (target.playerCtl?.channel) {
    w.events.push({ type: 'pickCancel', entityId: target.playerCtl.channel.targetId, byId: target.id, reason: 'hurt' })
    target.playerCtl.channel = undefined
  }

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
  return amount
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
  // NPC death: a body dropping throws off a fear pulse (#65) — nearby crew see
  // it fall and stampede, even with no sight of the killer.
  if (target.ai) emitFear(w, target)
  // Mark dead, then roll for a weapon drop. Ordering the roll AFTER `dead = true`
  // keeps the spawned pickup from ever re-entering this same kill.
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
  // Report the target ONLY if the blow actually landed. `fireWeapon`'s melee
  // branch applies the weapon's element and mod triggers to whatever this
  // returns, so returning a target whose damage was voided by i-frames, a
  // dodge-roll or the downed state is what let a sledgehammer stun a player who
  // had successfully rolled through the swing.
  return applyDamage(w, best, finalDamage, attacker.pos.x, attacker.pos.y, knockback, attacker.id) !== null ? best : null
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
  splinter?: number
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
  mods?: readonly WeaponMod[],
): void => {
  const angle = owner.facing + angleOffset
  const e = makeEntity('projectile', 'projectile', owner.pos.x, owner.pos.y, 0.15)
  e.facing = angle
  e.vel.x = Math.cos(angle) * speed
  e.vel.y = Math.sin(angle) * speed
  const ttl = Math.ceil((rangeTiles / speed) * 30)
  e.projectile = { ownerId: owner.id, damage, ttl, onHit: spec?.onHit ?? onHit }
  // Build provenance for the renderer/wire: normalized, absent when vanilla.
  const normalized = normalizeMods(mods)
  if (normalized) e.projectile.mods = normalized
  // Attach only the mod fields that are actually present → snapshot-stable: a
  // vanilla shot serializes exactly as before this feature.
  if (spec) {
    const p = e.projectile
    if (spec.pierce) p.pierceLeft = spec.pierce
    if (spec.bounce) p.bounceLeft = spec.bounce
    if (spec.homing) {
      p.homing = spec.homing
      p.aim = e.facing // freeze the shot direction: homing only forgives a near miss
    }
    if (spec.explodeRadius && spec.explodeDamage) p.explode = { radius: spec.explodeRadius, damage: spec.explodeDamage }
    if (spec.split && spec.split > 0) p.split = { count: spec.split, damage: Math.max(1, Math.round(damage * 0.5)), speed, ttl: Math.ceil(ttl / 2) }
    // Splinter: a radial shrapnel burst on death — many short-lived, weak fragments
    // (fast but ttl ~6 ticks → a tight scatter, not a second volley).
    if (spec.splinter && spec.splinter > 0) p.splinter = { count: spec.splinter, damage: Math.max(1, Math.round(damage * 0.35)), speed: speed * 0.7, ttl: 6 }
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
  // Explosions are LOUD: every NPC in earshot comes to investigate the boom —
  // the price of the fast door-breach path below (vs the slow, quiet pick).
  emitNoise(w, x, y)
  for (const other of w.entities) {
    if (other.dead || !other.health) continue
    const dist = Math.hypot(other.pos.x - x, other.pos.y - y)
    if (dist <= radius + other.radius) applyDamage(w, other, damage, x, y, 10, ownerId)
  }
  // Breach: a blast centred close enough blows a door open, locked or not —
  // the always-available alternative to picking (the player special IS a
  // grenade), so a mission door can never dead-end a run. Centre distance on
  // purpose (no door-radius bonus): a charge must be placed AT the door, so
  // one grenade can't take both bunker airlock doors (2 tiles apart) at once.
  for (const d of w.entities) {
    if (d.dead || !d.door || d.door.open) continue
    if (Math.hypot(d.pos.x - x, d.pos.y - y) > radius) continue
    const door = d.door
    const wasOvergrown = door.overgrown === true
    // A biolock or bog seal breached is LOUD: the always-available fallback that
    // guarantees no hatch dead-ends a run, but it announces you to the station.
    const wasSealed = wasOvergrown || door.sealKind !== undefined
    door.overgrown = false
    if (wasOvergrown) door.growthHp = 0
    door.locked = false
    door.open = true
    w.events.push({ type: 'doorBreach', entityId: d.id, x: d.pos.x, y: d.pos.y })
    if (wasOvergrown) {
      // Rupture the spore-sac the bog had swollen behind the hatch: a spreading
      // spore gout floods the breach (deterministic, see systems/spore.ts).
      spawnSporeBurst(w, Math.floor(d.pos.x), Math.floor(d.pos.y))
      w.events.push({ type: 'sealOpen', entityId: d.id, via: 'breach' })
    }
    if (wasSealed) w.alarm = Math.min(3, w.alarm + 1)
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
  const has = b.pierce || b.bounce || b.homing || b.explodeRadius || b.split || b.splinter || b.lifestealFrac || rw.triggers.length
  if (!has) return undefined
  return {
    pierce: b.pierce || undefined,
    bounce: b.bounce || undefined,
    homing: b.homing || undefined,
    explodeRadius: b.explodeRadius || undefined,
    explodeDamage: b.explodeDamage || undefined,
    split: b.split || undefined,
    splinter: b.splinter || undefined,
    lifestealFrac: b.lifestealFrac || undefined,
    triggers: rw.triggers.length ? rw.triggers : undefined,
  }
}

/** Fire the entity's equipped weapon along its current `facing`. THE single fire
 * site: players (combatSystem) and NPCs (ai.ts) both route through here, so mods,
 * elements (onHit), pellets, projectile behavior and melee arcs work identically
 * for either. Sets `combat.cooldown` and returns whether a shot/swing happened
 * (currently always true — there is no ammo, so a gun can never click dry).
 * Durability is spent only for INVENTORY melee weapons (a `weaponStack`); NPCs
 * carry no inventory, so their loadout is innate and never wears out. Callers
 * gate on `combat.cooldown <= 0` before calling. */
export const fireWeapon = (w: World, e: Entity): boolean => {
  if (!e.combat) return false
  const weapon = WEAPONS[e.combat.weapon] ?? WEAPONS.fists
  const stack = weaponStack(e)
  const rw = resolveWeapon(weapon, stack?.mods)
  if (weapon.kind === 'melee') {
    e.combat.cooldown = rw.cooldownTicks
    const damage = Math.round(rw.damage * (e.playerCtl ? PLAYER_MELEE_MULT : 1))
    const hit = meleeAttack(w, e, damage, weapon.range, rw.knockback)
    if (weapon.durability !== undefined && stack) wearMelee(e)
    if (hit) {
      if (rw.onHit) applyStatus(w, hit, rw.onHit.status, rw.onHit.ticks)
      runHitTriggers(w, hit, rw.triggers, e.id, hit.dead === true || (hit.health?.hp ?? 1) <= 0)
    }
    return true
  }
  // No ammo: a gun always fires. (Guns carry no magazine — the player's single
  // permanent pistol costs nothing to shoot, and NPC guns were always innate.)
  e.combat.cooldown = rw.cooldownTicks
  const spec = projectileSpec(rw)
  for (let i = 0; i < rw.pellets; i++) {
    const offset = rw.pellets > 1 ? (i / (rw.pellets - 1) - 0.5) * rw.spread : 0
    spawnProjectile(w, e, rw.damage, rw.projectileSpeed, weapon.range, offset, rw.onHit, spec, stack?.mods)
  }
  return true
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

    if (cmd.special && e.playerCtl.abilityCooldown <= 0) {
      if (throwGrenade(w, e)) e.playerCtl.abilityCooldown = SPECIAL_COOLDOWN_TICKS
    }

    // Hotbar: equip a slot.
    if (cmd.hotbar >= 0) equipSlot(e, cmd.hotbar)

    // USE/Throw button: use the held/active usable item (consume or throw); when
    // there's NOTHING usable, dodge-roll instead — the "backflip on the use key"
    // fallback (the ONLY place the fire↔use arbitration ever rolls). A roll that
    // starts here ends the player's turn (continue) so a same-tick fire can't also
    // land; tryStartRoll self-gates on the roll cooldown (no chaining). Gated on
    // combat.cooldown so use/roll share the item-use cadence.
    if (cmd.throwItem && e.combat.cooldown <= 0) {
      if (useHeld(w, e)) e.combat.cooldown = THROW_COOLDOWN
      else if (tryStartRoll(w, e, cmd.moveX, cmd.moveY)) continue // nothing usable → backflip
    }

    if (!cmd.attack || e.combat.cooldown > 0) continue
    // FIRE always fires the weapon. The old arbitration ("a usable item in the
    // active slot makes FIRE use it instead") existed only because weapons and
    // items shared the hotbar; now the player's weapon is permanent and is NOT a
    // hotbar selection, so FIRE is unambiguously the gun and USE is the held
    // item. Without this, holding a grenade would leave you unable to shoot.
    fireWeapon(w, e) // THE single fire-site: mods/elements/pellets fold in here
  }
}
