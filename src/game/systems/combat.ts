import { PLAYER_MELEE_MULT, SPECIAL_COOLDOWN_TICKS, throwGrenade } from '../player'
import { WEAPONS, type StatusApply, type WeaponDef } from '../data/items'
import { normalizeMods, type ResolvedTrigger } from '../data/mods'
import { NPCS } from '../data/npcs'
import { makeEntity, resistMult, type Entity, type ItemStack, type WeaponMod } from '../entity'
import type { EntityId, InputCmd } from '../types'
import { addEntity, emitFear, emitNoise, type World } from '../world'
import { applyStatus, isFrozen, isImmobilized, removeStatus } from './statusFx'
import { groupDamageMult } from './groupFx'
import { equipSlot, useHeld, wearMelee, weaponStack } from './inventory'
import { commitCrime } from './relationships'
import { destroyObject, isObject, resistsDamage } from './objects'
import { resolveWeapon, type ResolvedWeapon } from './resolveWeapon'
import { isRolling, tryStartRoll } from './roll'
import { applyModSwap, pelletShares, planCasts, recharging, sequenceShape, sequencing } from './modSequence'
import { spawnSporeBurst } from './spore'
import { vlen } from '../simMath'

const IFRAME_TICKS = 5
const FLASH_TICKS = 3
const THROW_COOLDOWN = 20

// NPC corpses no longer drop their weapon. The player carries ONE permanent
// weapon and cannot pick another up, so a dropped gun would be a dead sparkle
// the player walks over forever. Enemies keep their own arsenal (NPC_ARSENAL in
// populate.ts) — this removes only what the corpse leaves BEHIND, and with it
// the `w.rng.chance` draw that used to happen inside `kill`.

/** Interaction-matrix rule: a solid IMPACT on a frozen body SHATTERS the ice —
 * the frost breaks and the blow lands multiplied by this. Only impact (this
 * path) shatters; damage-over-time never routes through here, so a frozen agent
 * burned to death by fire dies normally and does not shatter. Grounded in
 * StatusEffects.cs (frozen death → IceGib) + the frozen one-hit backstab.
 *
 * It used to be an INSTANT KILL regardless of the blow's damage, and that is the
 * bug this number replaces. An execute keyed on a status rather than on a health
 * pool does not scale: measured through the real damage path with the 14-dmg
 * pistol (scripts/test/freeze-shatter-probe.mts), *every* body in the game died
 * in two shots — shot 1 freezes, shot 2 executes. The 320 hp Mireclaw Alpha went
 * from 30 shots / 17.4 s to 2 shots / 0.6 s, a 29x cut; the 95 hp brute 19 → 2;
 * the 120 hp hivespire 12 → 2. One rare mod deleted the entire hp axis of the
 * game's balance, boss phases included.
 *
 * A MULTIPLIER on the blow, not a flat payload, because damage in this engine is
 * already a pipeline — resist affinity, rally, the barrel's damage threshold,
 * lifesteal's payout — and a multiplied blow stays inside it. Three things fall
 * out for free: armour still means something (a brute eats 0.35 of the amplified
 * hit exactly as of a normal one), a heavier weapon shatters harder (a
 * sledgehammer's 26 beats a pistol's 14, which is what "a SOLID impact" should
 * mean), and lifesteal is bounded by construction — it pays on 5x a bullet, not
 * on the victim's whole 320 hp lifebar, which is the exploit the old instant-kill
 * return contract had to be hand-written to dodge.
 *
 * 5x is tuned off the grunt line, and it is a knob the owner should feel free to
 * turn. Pistol 14 → 70 on the shatter, on top of the 14 the freezing shot
 * already dealt: 84 across two shots, so everything up to ~84 effective hp still
 * pops in two (thug 40, cop 60, mender 44, lobber 58, breacher 62) and the
 * ice-gib death still plays. Above that it is a big bite, not an execute:
 * bouncer 90 and bellwether 90 survive on a sliver, brute 95 keeps 65, hivespire
 * 120 keeps 61, and the boss keeps 256 of 320 — frost is worth bringing to a
 * boss (it roughly halves the fight) without being the boss's off switch. */
export const SHATTER_DAMAGE_MULT = 5

/**
 * Resolve one blow. Returns the damage ACTUALLY APPLIED, or `null` if the blow
 * never landed at all.
 *
 * ⚠️ `null` and `0` mean different things, and conflating them breaks real
 * weapons. `null` = the blow was voided (i-frames, dodge-roll, downed, dead, an
 * object under its damage threshold) and NOTHING about it should happen. `0` =
 * it genuinely landed but took no hp — a pure-utility hit such as the freeze
 * ray, whose entire job is its status. Callers must test `!== null`, never
 * truthiness, or every 0-damage utility weapon silently stops working.
 *
 * The return value is load-bearing, not a convenience. It closes two defects
 * that were both symptoms of this function returning `void`:
 *
 *  - Everything a hit does BESIDES damage — applying an element, healing via
 *    lifesteal, firing a mod trigger — ran unconditionally, because no caller
 *    could tell this function had bailed out. i-frames, the dodge-roll and the
 *    downed state therefore suppressed the DAMAGE only: you could roll through a
 *    sledgehammer swing, take nothing, and be stunned anyway, which defeats the
 *    single counterplay the game offers against being locked down.
 *  - Effects that SCALE with damage had no way to read what was actually dealt,
 *    so lifesteal paid out on the bullet's INTENDED damage and never saw resist:
 *    a 0.35-armoured brute absorbed 65% of the blow while the shooter was paid
 *    in full.
 *
 * Returning the applied amount makes any future damage-scaled effect correct by
 * construction, rather than by remembering to patch it.
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
  // A frozen body SHATTERS on impact — but NOT a player. The frost breaks either
  // way; what differs is what the blow is worth.
  //
  // A player has no answer to an amplified blow: freeze is applied BY enemies
  // (freeze ray / freeze grenade, 120 ticks = four seconds) and immobilizes
  // completely, so the sequence "enemy freezes you, any enemy touches you, you
  // are downed" is unavoidable and reads as dying in one hit. Harmless while the
  // station ignored you; lethal now the alert escalation sends the whole floor
  // at you at once.
  //
  // So for a player the impact CRACKS THE ICE instead: the freeze breaks and the
  // blow lands as ORDINARY damage, unmultiplied. Costs you tempo and a hit, not
  // the run. The anti-chain-lock guard in statusFx then grants its usual
  // post-immobilize immunity, so you cannot be instantly re-frozen either.
  //
  // Everything else takes the blow times SHATTER_DAMAGE_MULT, and then keeps
  // falling through the ordinary damage pipeline below — resist, rally, the
  // object damage threshold, knockback, the hit event, the AI reaction, the
  // death path. That fall-through is the point of the fix: a shatter is a very
  // hard hit, not a separate lethality rule bolted alongside the hp system, so
  // it cannot outrun an hp pool the way the old instant kill did, and every
  // consumer downstream (lifesteal's payout, `destroyObject`'s loot and barrel
  // explosion, `kill`'s downed/corpse handling) sees a normal, if large, blow.
  let shattering = false
  if (isFrozen(target)) {
    removeStatus(target, 'frozen')
    if (!target.playerCtl) {
      shattering = true
      amount *= SHATTER_DAMAGE_MULT
    }
  }
  // Negative damage must NOT heal: clamp to 0 so a "negative hit" still registers
  // as a (harmless) blow — iframes, flash, knockback, event — but can never add hp.
  if (amount < 0) amount = 0
  // #78 damage affinity: armoured bodies shrug off impact, flammable ones don't.
  // Impact/explosion damage is 'physical'; missing table → ×1 (unchanged).
  // A RALLIED raider (a live leader in earshot) shrugs off a quarter of it.
  amount = Math.round(amount * resistMult(target, 'physical') * groupDamageMult(target, w.tick))
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
  const len = vlen(dx, dy) || 1
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
    // A PLAYER's landed blow on a group member is remembered for the group layer
    // (systems/groups.ts): it is what turns a hound pack manhunter.
    if (target.ai.group && w.byId.get(attackerId)?.playerCtl) target.ai.provokedBy = attackerId
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
    // The ice gib fires when the SHATTERING BLOW is the one that kills — not on
    // every frozen death. A frozen body finished off by something else (fire DoT,
    // a later unamplified shot after the frost already broke) dies as a corpse.
    // `shattered` marks a body that left ice instead of a corpse, so it is for
    // bodies only; an object's destruction visual is `destroyObject`'s business.
    if (shattering) {
      if (!isObject(target)) target.shattered = true
      w.events.push({ type: 'shatter', x: target.pos.x, y: target.pos.y, entityId: target.id })
    }
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
    const dist = vlen(dx, dy)
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
    const alen = vlen(adx, ady) || 1
    if ((adx / alen) * tx + (ady / alen) * ty < -0.2) finalDamage *= 3
    attacker.status.cloakUntil = w.tick // attacking breaks cloak
  }
  // Report the target ONLY if the blow actually landed. `fireWeapon`'s melee
  // branch applies the weapon's element and its mod triggers to whatever this
  // returns, so handing back a target whose damage was voided by i-frames, a
  // dodge-roll or the downed state is what let a sledgehammer stun a player who
  // had successfully rolled through the swing.
  //
  // `!== null`, NOT truthiness: a 0-damage melee weapon lands for 0 and must
  // still apply its status.
  return applyDamage(w, best, finalDamage, attacker.pos.x, attacker.pos.y, knockback, attacker.id) !== null
    ? best
    : null
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
    const dist = vlen(other.pos.x - x, other.pos.y - y)
    if (dist <= radius + other.radius) applyDamage(w, other, damage, x, y, 10, ownerId)
  }
  // Breach: a blast centred close enough blows a door open, locked or not —
  // the always-available alternative to picking (the player special IS a
  // grenade), so a mission door can never dead-end a run. Centre distance on
  // purpose (no door-radius bonus): a charge must be placed AT the door, so
  // one grenade can't take both bunker airlock doors (2 tiles apart) at once.
  for (const d of w.entities) {
    if (d.dead || !d.door || d.door.open) continue
    if (vlen(d.pos.x - x, d.pos.y - y) > radius) continue
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
 * (false = an empty gun clicked). Ammo/durability are spent only for INVENTORY
 * weapons (a `weaponStack`); NPCs carry no inventory, so their loadout is innate
 * and never runs dry. Callers gate on `combat.cooldown <= 0` before calling. */
export const fireWeapon = (w: World, e: Entity): boolean => {
  if (!e.combat) return false
  const weapon = WEAPONS[e.combat.weapon] ?? WEAPONS.fists
  const stack = weaponStack(e)
  // Sequenced casting (opt-in run rule). A weapon with no mods has nothing to
  // sequence and takes the default path below, unchanged.
  if (sequencing(w) && stack?.mods && stack.mods.length > 0) return fireSequenced(w, e, weapon, stack)
  const rw = resolveWeapon(weapon, stack?.mods)
  if (weapon.kind === 'melee') {
    e.combat.cooldown = rw.cooldownTicks
    const damage = Math.round(rw.damage * (e.playerCtl ? PLAYER_MELEE_MULT : 1))
    const hit = meleeAttack(w, e, damage, weapon.range, rw.knockback)
    if (weapon.durability !== undefined && stack) wearMelee(e)
    if (hit) {
      if (rw.onHit) applyStatus(w, hit, rw.onHit.status, rw.onHit.ticks, e.id)
      runHitTriggers(w, hit, rw.triggers, e.id, hit.dead === true || (hit.health?.hp ?? 1) <= 0)
    }
    return true
  }
  // No ammo: a gun always fires. There is no magazine, no depletion and no
  // dry-fire click — firing costs nothing, so the only thing gating a shot is
  // the cooldown the caller already checked.
  e.combat.cooldown = rw.cooldownTicks
  const spec = projectileSpec(rw)
  for (let i = 0; i < rw.pellets; i++) {
    const offset = rw.pellets > 1 ? (i / (rw.pellets - 1) - 0.5) * rw.spread : 0
    spawnProjectile(w, e, rw.damage, rw.projectileSpeed, weapon.range, offset, rw.onHit, spec, stack?.mods)
  }
  return true
}

/**
 * The sequenced-casting fire path (systems/modSequence). One trigger pull plans
 * up to `castsPerTrigger` casts from the weapon's stored `castIndex`; each cast
 * resolves the base weapon with ONLY its own mods (its modifiers plus at most
 * one payload), so every projectile carries at most one element. A multi-cast
 * gun splits its pellets between casts, laid out left to right across the fan
 * in cast order. Running off the end of the list wraps the index and locks the
 * weapon for `rechargeOnWrap` ticks. Returns false (no shot) while recharging.
 */
const fireSequenced = (w: World, e: Entity, weapon: WeaponDef, stack: ItemStack): boolean => {
  if (recharging(stack, w.tick)) return false
  const shape = sequenceShape(weapon)
  const plan = planCasts(stack.mods, shape, stack.castIndex ?? 0)
  // Every entry unknown/empty: nothing live, fire the bare weapon.
  const casts = plan.casts.length > 0 ? plan.casts : [{ mods: [] as WeaponMod[], positions: [] as number[] }]
  stack.castIndex = plan.nextIndex
  let cooldown = 1
  if (weapon.kind === 'melee') {
    const rw = resolveWeapon(weapon, casts[0].mods)
    cooldown = rw.cooldownTicks
    const damage = Math.round(rw.damage * (e.playerCtl ? PLAYER_MELEE_MULT : 1))
    const hit = meleeAttack(w, e, damage, weapon.range, rw.knockback)
    if (weapon.durability !== undefined) wearMelee(e)
    if (hit) {
      if (rw.onHit) applyStatus(w, hit, rw.onHit.status, rw.onHit.ticks, e.id)
      runHitTriggers(w, hit, rw.triggers, e.id, hit.dead === true || (hit.health?.hp ?? 1) <= 0)
    }
  } else {
    // Shares are fixed per cast slot (castsPerTrigger), so a pull cut short by
    // a wrap fires only the groups it cast: the thin last blast marks the wrap.
    const shares = pelletShares(weapon.pellets ?? 1, shape.castsPerTrigger)
    const resolved = casts.map((c, g) => resolveWeapon({ ...weapon, pellets: shares[g] }, c.mods))
    const total = resolved.reduce((n, rw) => n + rw.pellets, 0)
    let k = 0
    for (let g = 0; g < casts.length; g++) {
      const rw = resolved[g]
      cooldown = Math.max(cooldown, rw.cooldownTicks)
      const spec = projectileSpec(rw)
      for (let j = 0; j < rw.pellets; j++, k++) {
        const offset = total > 1 ? (k / (total - 1) - 0.5) * rw.spread : 0
        spawnProjectile(w, e, rw.damage, rw.projectileSpeed, weapon.range, offset, rw.onHit, spec, casts[g].mods)
      }
    }
  }
  if (plan.wrapped && shape.rechargeOnWrap > 0) {
    cooldown = Math.max(cooldown, shape.rechargeOnWrap)
    stack.rechargeUntil = w.tick + cooldown
  }
  e.combat!.cooldown = cooldown
  return true
}

/** Player attack + ability inputs. NPC attacks happen in the AI system. */
export const combatSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  for (const e of w.entities) {
    if (!e.playerCtl || !e.combat || e.dead || e.playerCtl.downed) continue
    // Sequenced mods: a reorder request is applied before the action gates, so a
    // swap asked for mid-roll or while stunned is not silently dropped.
    if (sequencing(w)) {
      const swap = inputs.get(e.playerCtl.playerId)?.modSwap
      if (swap !== undefined) applyModSwap(e, swap)
    }
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
    // FIRE ALWAYS FIRES THE WEAPON. The old arbitration ("a usable item in the
    // active slot makes FIRE use it instead") existed only because weapons and
    // items shared one hotbar, so you could always cycle back to the gun. With a
    // single permanent weapon that is no longer selectable, `activeSlot` is purely
    // the held-item cursor and there is nothing to cycle back TO — that rule would
    // leave a player holding a grenade permanently unable to shoot. Items go on
    // the USE/Throw button above, which is where they now exclusively live.
    fireWeapon(w, e) // THE single fire-site: mods/elements/pellets fold in here
  }
}
