import { PLAYER_MELEE_MULT, SPECIAL_COOLDOWN_TICKS, throwGrenade } from '../player'
import { WEAPONS, itemClass, type StatusApply } from '../data/items'
import { normalizeMods, type ResolvedTrigger } from '../data/mods'
import { NPCS } from '../data/npcs'
import { PUNISH_MULT } from '../data/tells'
import { makeEntity, resistMult, type Entity, type WeaponMod } from '../entity'
import type { EntityId, InputCmd } from '../types'
import { addEntity, emitFear, emitNoise, type World } from '../world'
import { applyStatus, isFrozen, isImmobilized, removeStatus } from './statusFx'
import { activeStack, equipSlot, spendAmmo, useHeld, wearMelee, weaponStack } from './inventory'
import { commitCrime } from './relationships'
import { destroyObject, isObject, resistsDamage } from './objects'
import { resolveWeapon, type ResolvedWeapon } from './resolveWeapon'
import { isRolling, tryStartRoll } from './roll'
import { spawnSporeBurst } from './spore'

const IFRAME_TICKS = 5
const FLASH_TICKS = 3
const THROW_COOLDOWN = 20

/**
 * ⚠️ TEMPORARY / TESTING-ONLY — flip to `false` to restore the normal ammo
 * economy exactly. While ON, ranged weapons never deplete and never read as
 * empty/out-of-ammo, so they always fire (effectively infinite ammo). This gates
 * ONLY the depletion in `fireWeapon`; the whole ammo system (spendAmmo, pickups,
 * qty) is left intact, so flipping this to `false` is a byte-exact revert to the
 * finite economy — no other change needed.
 *
 * Deterministic: it draws no RNG and touches no wall-clock — it just skips the
 * `spendAmmo` decrement, so the sim stays a pure function of seed + inputs.
 */
export const INFINITE_AMMO: boolean = true

/** Probability a dying NPC drops the weapon it was carrying as a grabbable
 * world pickup. The one sim tunable for the drop — kept here beside `kill`, the
 * single death site, mirroring the codebase's per-system-constant convention
 * (IFRAME_TICKS above, PICK_TICKS in interaction.ts). Any lethal death routes
 * through `kill`, so an NPC felled by a player, a fire tick, or an explosion all
 * roll identically. The roll draws from the world RNG (`w.rng`) so it is a pure
 * function of seed + inputs — a test predicts every drop from the seed. */
export const WEAPON_DROP_CHANCE = 0.25

/** A weapon id a corpse can actually drop: a real slotted melee/ranged weapon in
 * the registry, never innate 'fists' (the unarmed sentinel — dropping "Fists"
 * would be nonsense). Unarmed NPCs return false here and never draw the RNG. */
const isDroppableWeapon = (weaponId: string): boolean =>
  weaponId !== 'fists' &&
  (WEAPONS[weaponId]?.kind === 'melee' || WEAPONS[weaponId]?.kind === 'ranged')

/** On an NPC death, occasionally drop its carried weapon as a world pickup the
 * player can grab — reusing the `pickup.<itemId>` archetype + `collect` path
 * (interaction.ts), so a dropped gun equips exactly like any floor weapon. The
 * roll draws from `w.rng` ONLY when there is a real weapon to drop, so unarmed
 * deaths never perturb the shared stream. NPC loadouts are innate (no inventory,
 * no mods), so the weapon id is the whole of the carried state to preserve. */
const rollWeaponDrop = (w: World, victim: Entity): void => {
  const weaponId = victim.combat?.weapon
  if (!weaponId || !isDroppableWeapon(weaponId)) return
  if (!w.rng.chance(WEAPON_DROP_CHANCE)) return
  const drop = makeEntity('pickup', `pickup.${weaponId}`, victim.pos.x, victim.pos.y, 0.3)
  drop.pickup = { itemId: weaponId, qty: 1 }
  addEntity(w, drop)
  w.events.push({ type: 'weaponDrop', entityId: drop.id, fromId: victim.id, itemId: weaponId, x: victim.pos.x, y: victim.pos.y })
}

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
  // #78 damage affinity: armoured bodies shrug off impact, flammable ones don't.
  // Impact/explosion damage is 'physical'; missing table → ×1 (unchanged).
  amount = Math.round(amount * resistMult(target, 'physical'))
  // #1 PUNISH: a body caught in the recovery of its own committed attack takes
  // extra damage. This is what makes reading a tell and dodging it PAY — the
  // recovery window is not merely "the enemy is idle", it is an opening. Read
  // straight off the absolute windows (no import cycle back through
  // systems/commitment.ts); absent `attack` → untouched, as before this feature.
  const recovering = target.attack
  if (recovering && w.tick >= recovering.recoverAt && w.tick < recovering.endAt) {
    amount = Math.round(amount * PUNISH_MULT)
  }
  if (resistsDamage(target, amount)) return // e.g. a barrel shrugs off a weak hit
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
}

export const kill = (w: World, target: Entity): void => {
  // #1 A body killed mid-commitment must not leave a live attack window behind:
  // drop it and close the telegraph, so nothing is left drawing a wind-up for a
  // swing that will never come. Inlined rather than calling
  // `commitment.breakAttack` purely to keep combat.ts a leaf of that module (no
  // import cycle back through `fireWeapon`); the shape is identical.
  const committed = target.attack
  if (committed) {
    target.attack = undefined
    w.events.push({
      type: 'attackBreak',
      entityId: target.id,
      x: target.pos.x,
      y: target.pos.y,
      shape: committed.shape,
      reason: 'death',
    })
  }
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
  rollWeaponDrop(w, target)
}

/** The stock melee arc, as the minimum facing-dot a victim must satisfy
 * (0.5 → ±60°). A committed attack's tell may widen or narrow it via
 * `Tell.arcDot` — a raw dot, never an angle, so the hit test stays trig-free
 * and bit-identical on every device. */
const MELEE_ARC_DOT = 0.5

/** Swing at the nearest live target inside range and the melee arc around
 * facing. `arcDot` overrides the stock ±60° arc (see MELEE_ARC_DOT). */
export const meleeAttack = (
  w: World,
  attacker: Entity,
  damage: number,
  range: number,
  knockback: number,
  arcDot: number = MELEE_ARC_DOT,
): Entity | null => {
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
    // Within the arc around facing (or point-blank)
    if (dist > 0.3 && (dx * fx + dy * fy) / dist < arcDot) continue
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
    if (spec.homing) p.homing = spec.homing
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

/** Per-swing shaping applied by a committed attack's tell (#1, data/tells.ts):
 * a damage multiplier paying for the wind-up, and an optional melee arc override.
 * Absent (the player, and any legacy caller) → byte-identical to before. */
export interface AttackShaping {
  damageMult?: number
  arcDot?: number
}

/** Fire the entity's equipped weapon along its current `facing`. THE single fire
 * site: players (combatSystem) and NPCs (ai.ts) both route through here, so mods,
 * elements (onHit), pellets, projectile behavior and melee arcs work identically
 * for either. Sets `combat.cooldown` and returns whether a shot/swing happened
 * (false = an empty gun clicked). Ammo/durability are spent only for INVENTORY
 * weapons (a `weaponStack`); NPCs carry no inventory, so their loadout is innate
 * and never runs dry. Callers gate on `combat.cooldown <= 0` before calling. */
export const fireWeapon = (w: World, e: Entity, shaping?: AttackShaping): boolean => {
  if (!e.combat) return false
  const weapon = WEAPONS[e.combat.weapon] ?? WEAPONS.fists
  const stack = weaponStack(e)
  const rw = resolveWeapon(weapon, stack?.mods)
  const mult = shaping?.damageMult ?? 1
  if (weapon.kind === 'melee') {
    e.combat.cooldown = rw.cooldownTicks
    const damage = Math.round(rw.damage * (e.playerCtl ? PLAYER_MELEE_MULT : 1) * mult)
    const hit = meleeAttack(w, e, damage, weapon.range, rw.knockback, shaping?.arcDot)
    if (weapon.durability !== undefined && stack) wearMelee(e)
    if (hit) {
      if (rw.onHit) applyStatus(w, hit, rw.onHit.status, rw.onHit.ticks)
      runHitTriggers(w, hit, rw.triggers, e.id, hit.dead === true || (hit.health?.hp ?? 1) <= 0)
    }
    return true
  }
  // Ammo depletion is gated behind INFINITE_AMMO (testing toggle above). When ON,
  // `spendAmmo` is skipped entirely, so qty never drops and the gun never reads as
  // empty — it always fires. When OFF this is the original: an empty gun clicks
  // (no shot, no cooldown) and the dry-fire path stays reachable.
  if (stack && !INFINITE_AMMO && !spendAmmo(e)) return false
  e.combat.cooldown = rw.cooldownTicks
  const spec = projectileSpec(rw)
  // Rounded like the melee branch so a shaped shot carries a whole-number
  // damage figure — identical to `rw.damage` when unshaped (mult 1).
  const shot = mult === 1 ? rw.damage : Math.round(rw.damage * mult)
  for (let i = 0; i < rw.pellets; i++) {
    const offset = rw.pellets > 1 ? (i / (rw.pellets - 1) - 0.5) * rw.spread : 0
    spawnProjectile(w, e, shot, rw.projectileSpeed, weapon.range, offset, rw.onHit, spec, stack?.mods)
  }
  return true
}

/** Item classes the FIRE button diverts to item-USE instead of a weapon shot:
 * a consumable (bandage/medkit → heal, adrenaline → buff) or a throwable (lobbed).
 * When the active slot holds one of these, "shooting" uses it via the same
 * item-effect path as the dedicated Use button — no bullet is spawned. */
const isUsableItem = (itemId: string): boolean => {
  const c = itemClass(itemId)
  return c === 'consumable' || c === 'throwable'
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
    // FIRE button arbitration off the ACTIVE slot:
    //  1. a usable non-weapon in hand (bandage/consumable → heal, throwable →
    //     lob) is USED via the same item-effect path as the Use button — the
    //     "shooting uses my equipped item" rule. No bullet, no swing.
    //  2. otherwise fire the equipped weapon (gun/melee/fists) — unchanged.
    // Nothing to fire (an out-of-ammo gun) is a dry no-op: the dodge-roll fallback
    // lives on the USE button above, never on FIRE.
    const active = activeStack(e)
    if (active && isUsableItem(active.itemId)) {
      if (useHeld(w, e)) e.combat.cooldown = THROW_COOLDOWN
      continue
    }
    fireWeapon(w, e) // THE single fire-site: mods/elements/pellets fold in here
  }
}
