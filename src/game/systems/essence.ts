// Essence bubbles: the prototype of loadout design C ("essences are things in
// the world"). Opt-in per run via `World.essences`, on top of sequenced
// casting (systems/modSequence). With the flag off nothing here runs.
//
// The rules, each one a function below:
//
//  VENT   A diver pops one entry out of the gun's rack (`InputCmd.still`, op 1)
//         and it hangs in the air at their feet as a PLANTED BUBBLE. Venting a
//         LIVE entry costs the weapon's wrap recharge, exactly as if the rack
//         had wrapped, so venting is never free fire rate. Venting a stowed
//         entry costs nothing. A diver may have two planted; a third pops the
//         oldest.
//  CATCH  Interact next to a bubble puts it back at the END of the rack. It does
//         not reset `castIndex` (the rule `applyModSwap` follows too). Anyone
//         can catch anyone's bubble. Walking over one does nothing.
//  LENS   A player's round that flies through a bubble picks up its essence as
//         a RIDER: one rider per round, one charge per rider. A round that
//         already carries that element gains nothing and spends nothing.
//         Charges are 3 + 3 per stack (max 9); the bubble pops at zero.
//  MINE   An NPC body that touches a Storm, Cold or Flame bubble bursts it:
//         shock / freeze / fire on everything within 1.5 tiles.
//  EXPIRY A planted bubble pops 600 ticks (20 s) after it was planted.
//
// Plus the one pair reaction in the slice, CONDUCTOR (cold + storm), which
// lives in interactions.shock: under this flag frozen bodies conduct like wet
// ones, and the arc shatters the ice.
//
// Determinism: every loop walks `w.entities` in array (ascending id) order,
// nothing draws from an RNG, and all timing is absolute ticks.

import { WEAPONS, type StatusApply } from '../data/items'
import { MODS, normalizeMods } from '../data/mods'
import {
  BUBBLE_RADIUS,
  BUBBLE_TTL_TICKS,
  BURST_RADIUS,
  CATCH_RANGE,
  MAX_PLANTED_PER_DIVER,
  burstOf,
  lensCharges,
} from '../data/essences'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { SIM_DT, type InputCmd } from '../types'
import { addEntity, type World } from '../world'
import { igniteCell } from './fire'
import { weaponStack } from './inventory'
import { freeze, shock } from './interactions'
import { liveEntries, sequenceShape, sequencing } from './modSequence'
import { resolveWeapon } from './resolveWeapon'
import { vlen } from '../simMath'
import { applyStatus } from './statusFx'

/** `InputCmd.still` op: plant the entry at your feet. */
export const STILL_PLANT = 1
/** `InputCmd.still` index meaning "the chamber that fires next" (the live
 * entry at `castIndex`): what a single vent button sends, so a player with no
 * rack UI can still vent the chamber the sequence strip highlights. */
export const STILL_NEXT = 0xff

/** Pack a still request into the InputCmd scalar: `(op << 8) | index`. */
export const packStill = (op: number, index: number): number => ((op & 0xff) << 8) | (index & 0xff)
export const unpackStill = (v: number): { op: number; index: number } => ({ op: (v >> 8) & 0xff, index: v & 0xff })

/** Is this run using essence bubbles? The flag only means anything on top of
 * sequenced casting: without a rack there is nothing to vent. */
export const essenceOn = (w: World): boolean => w.essences === 'bubbles' && sequencing(w)

/** Planted bubbles `diverId` owns, oldest first. */
const plantedBy = (w: World, diverId: number): Entity[] =>
  w.entities
    .filter((e) => e.bubble && !e.dead && e.bubble.ventedBy === diverId)
    .sort((a, b) => a.bubble!.plantedTick - b.bubble!.plantedTick || a.id - b.id)

const pop = (w: World, b: Entity, reason: 'spent' | 'expired' | 'capped' | 'burst'): void => {
  b.dead = true
  w.events.push({ type: 'bubblePop', entityId: b.id, modId: b.bubble!.mod.id, reason, x: b.pos.x, y: b.pos.y })
}

/**
 * Vent rack entry `requested` (a raw list index, so a stowed entry can be
 * vented; `STILL_NEXT` = the chamber that fires next)
 * of `e`'s wielded weapon into a planted bubble at its feet. Returns the bubble,
 * or null for an invalid request (no rack, index out of range, unknown mod),
 * which changes nothing.
 */
export const ventEntry = (w: World, e: Entity, requested: number): Entity | null => {
  const stack = weaponStack(e)
  const mods = stack?.mods
  const def = stack ? WEAPONS[stack.itemId] : undefined
  const shape = def ? sequenceShape(def) : undefined
  let index = requested
  if (requested === STILL_NEXT && mods && shape) {
    const live = liveEntries(mods, shape.slots)
    const at = stack!.castIndex ?? 0
    index = live[Number.isInteger(at) && at >= 0 && at < live.length ? at : 0] ?? -1
  }
  if (!stack || !mods || !Number.isInteger(index) || index < 0 || index >= mods.length) return null
  const entry = mods[index]
  if (!MODS[entry.id] || !(entry.stacks > 0)) return null
  const wasLive = shape !== undefined && liveEntries(mods, shape.slots).includes(index)
  mods.splice(index, 1)
  if (wasLive && shape) {
    // As if the rack wrapped: back to the first chamber, and the recharge runs.
    // Never shortens a recharge already running.
    stack.castIndex = 0
    if (shape.rechargeOnWrap > 0) stack.rechargeUntil = Math.max(stack.rechargeUntil ?? 0, w.tick + shape.rechargeOnWrap)
  }
  return plantBubble(w, e, entry, e.pos.x, e.pos.y)
}

/** Plant essence `entry` as a bubble at (x, y), owned by diver `e`, enforcing
 * the per-diver cap. The one constructor: venting and scenarios both use it. */
export const plantBubble = (w: World, e: Entity, entry: WeaponMod, x: number, y: number): Entity => {
  const mine = plantedBy(w, e.id)
  for (let i = 0; i <= mine.length - MAX_PLANTED_PER_DIVER; i++) pop(w, mine[i], 'capped')
  const stacks = Math.max(1, Math.floor(entry.stacks))
  const full = lensCharges(stacks)
  const charges = entry.charges !== undefined && entry.charges >= 1 && entry.charges <= full ? Math.floor(entry.charges) : full
  const b = makeEntity('pickup', `mod.${entry.id}`, x, y, BUBBLE_RADIUS)
  b.bubble = {
    mod: { id: entry.id, stacks },
    charges,
    expiresTick: w.tick + BUBBLE_TTL_TICKS,
    ventedBy: e.id,
    plantedTick: w.tick,
  }
  b.interact = { verb: 'pickup', range: CATCH_RANGE }
  addEntity(w, b)
  w.events.push({ type: 'bubblePlant', entityId: b.id, byId: e.id, modId: entry.id, x, y })
  return b
}

/** Catch bubble `b` back into `p`'s rack, at the end. A partly spent lens keeps
 * its remaining charges on the rack entry. Returns false if `p` has no gun. */
export const catchBubble = (w: World, p: Entity, b: Entity): boolean => {
  if (!b.bubble || b.dead) return false
  const stack = weaponStack(p)
  if (!stack) return false
  const { mod, charges } = b.bubble
  const entry: WeaponMod = { id: mod.id, stacks: mod.stacks }
  if (charges < lensCharges(mod.stacks)) entry.charges = charges
  ;(stack.mods ??= []).push(entry)
  b.dead = true
  w.events.push({ type: 'bubbleCatch', entityId: b.id, byId: p.id, modId: mod.id })
  return true
}

/** Distance from point (px,py) to the segment (ax,ay)-(bx,by). */
const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return vlen(px - (ax + t * dx), py - (ay + t * dy))
}

/** Fold a MODIFIER rider into a flying round, as if the mod had been in its cast:
 * stat mods rescale damage and speed, behavior mods add their bullet behavior.
 * Pellet count is the one thing a rider cannot change (the round already left). */
const foldModifierRider = (e: Entity, rider: WeaponMod): void => {
  const p = e.projectile!
  const speed = vlen(e.vel.x, e.vel.y)
  const rw = resolveWeapon(
    { id: 'rider', name: 'rider', kind: 'ranged', damage: p.damage, range: 1, cooldownTicks: 1, knockback: 0, projectileSpeed: speed },
    [rider],
  )
  p.damage = rw.damage
  if (speed > 0 && rw.projectileSpeed !== speed) {
    const k = rw.projectileSpeed / speed
    e.vel.x *= k
    e.vel.y *= k
  }
  const b = rw.behavior
  if (b.pierce) p.pierceLeft = (p.pierceLeft ?? 0) + b.pierce
  if (b.bounce) p.bounceLeft = (p.bounceLeft ?? 0) + b.bounce
  if (b.homing) p.homing = (p.homing ?? 0) + b.homing
  if (b.explodeRadius && b.explodeDamage) p.explode = { radius: b.explodeRadius, damage: b.explodeDamage }
  if (b.split) p.split = { count: b.split, damage: Math.max(1, Math.round(p.damage * 0.5)), speed: rw.projectileSpeed, ttl: Math.ceil(p.ttl / 2) }
  if (b.splinter) p.splinter = { count: b.splinter, damage: Math.max(1, Math.round(p.damage * 0.35)), speed: rw.projectileSpeed * 0.7, ttl: 6 }
  if (b.lifestealFrac) p.lifestealFrac = Math.max(p.lifestealFrac ?? 0, b.lifestealFrac)
  if (rw.triggers.length) p.triggers = [...(p.triggers ?? []), ...rw.triggers]
}

/**
 * The lens: projectile `e` just moved this tick; if its path crossed a planted
 * bubble, it picks up that bubble's essence. Only rounds fired by a player,
 * never thrown items or lobbed shells. One rider per round.
 */
export const lensPass = (w: World, e: Entity): void => {
  const p = e.projectile
  if (!p || p.rider || p.arc || p.onLand) return
  if (!w.byId.get(p.ownerId)?.playerCtl) return
  const ax = e.pos.x - e.vel.x * SIM_DT
  const ay = e.pos.y - e.vel.y * SIM_DT
  for (const b of w.entities) {
    if (!b.bubble || b.dead) continue
    if (segDist(b.pos.x, b.pos.y, ax, ay, e.pos.x, e.pos.y) > b.radius + e.radius) continue
    const mod = b.bubble.mod
    const element = MODS[mod.id]?.onHit
    // Already carries this element: nothing to gain, so nothing is spent.
    if (element && p.onHit?.status === element.status) continue
    const rider: WeaponMod = { id: mod.id, stacks: mod.stacks }
    p.rider = rider
    if (!element) foldModifierRider(e, rider)
    // Provenance for the renderer and the wire: the round now reads as both.
    p.mods = normalizeMods([...(p.mods ?? []), rider])
    b.bubble.charges -= 1
    w.events.push({ type: 'lens', entityId: e.id, bubbleId: b.id, modId: mod.id })
    if (b.bubble.charges <= 0) pop(w, b, 'spent')
    return
  }
}

/** Status application order on a hit carrying two elements: cold lands first,
 * so a storm on the same round finds the body frozen (Conductor) whichever of
 * the two was the rider. */
const ELEMENT_ORDER: Record<string, number> = { frozen: 0, burning: 1, electrified: 3 }

/**
 * Apply a landed round's elements under essence bubbles: its own `onHit` plus
 * its rider's, cold first. An electric hit runs the full `shock` (arc through
 * wet and frozen bodies, resist-scaled), which is what makes "weak to
 * lightning" mean something.
 */
export const applyHitElements = (
  w: World,
  target: Entity,
  onHit: StatusApply | undefined,
  rider: WeaponMod | undefined,
  /** The target was frozen when the round struck (before the impact broke the ice). */
  wasFrozen = false,
): void => {
  const list: StatusApply[] = []
  if (onHit) list.push(onHit)
  const extra = rider ? MODS[rider.id]?.onHit : undefined
  if (extra && extra.status !== onHit?.status) list.push(extra)
  list.sort((a, b) => (ELEMENT_ORDER[a.status] ?? 2) - (ELEMENT_ORDER[b.status] ?? 2))
  for (const s of list) {
    applyStatus(w, target, s.status, s.ticks)
    if (s.status === 'electrified') shock(w, target, wasFrozen)
  }
}

/** Bodies a burst touches: live players and NPCs, never objects or props. */
const isBody = (e: Entity): boolean => !e.dead && !!e.health && (e.kind === 'npc' || e.kind === 'player')

/** Burst `b` as a mine. */
const burst = (w: World, b: Entity): void => {
  const verb = burstOf(b.bubble!.mod.id)
  pop(w, b, 'burst')
  if (verb === 'ignite') {
    const cx = Math.floor(b.pos.x)
    const cy = Math.floor(b.pos.y)
    const r = Math.ceil(BURST_RADIUS)
    for (let ty = cy - r; ty <= cy + r; ty++) {
      for (let tx = cx - r; tx <= cx + r; tx++) {
        if (isSolidTile(w.level, tx, ty)) continue
        if (vlen(tx + 0.5 - b.pos.x, ty + 0.5 - b.pos.y) > BURST_RADIUS) continue
        igniteCell(w, tx, ty)
      }
    }
    return
  }
  const hit = w.entities.filter((o) => isBody(o) && vlen(o.pos.x - b.pos.x, o.pos.y - b.pos.y) <= BURST_RADIUS + o.radius)
  for (const o of hit) {
    if (verb === 'freeze') freeze(w, o)
    else if (verb === 'shock') shock(w, o)
  }
}

/** One tick of essence bubbles: vents from input, then mines, then expiry. */
export const essenceSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  if (!essenceOn(w)) return
  for (const e of w.entities) {
    if (!e.playerCtl || e.dead || e.playerCtl.downed) continue
    const still = inputs.get(e.playerCtl.playerId)?.still
    if (still === undefined || !Number.isInteger(still) || still < 0) continue
    const { op, index } = unpackStill(still)
    if (op === STILL_PLANT) ventEntry(w, e, index)
  }
  for (const b of w.entities) {
    if (!b.bubble || b.dead) continue
    if (burstOf(b.bubble.mod.id)) {
      const trigger = w.entities.find(
        (o) => o.kind === 'npc' && isBody(o) && vlen(o.pos.x - b.pos.x, o.pos.y - b.pos.y) <= b.radius + o.radius,
      )
      if (trigger) {
        burst(w, b)
        continue
      }
    }
    if (w.tick >= b.bubble.expiresTick) pop(w, b, 'expired')
  }
}
