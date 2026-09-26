// Primer/Striker prototype (World.primerStriker): coats and reactions. The
// grammar is in data/reactions.ts. Everything here runs only on a world with
// the rule set; the call sites gate on `w.primerStriker`.
//
// Determinism: floods are breadth-first over w.entities in ascending id order,
// capped, and resolve inside the call that starts them. No RNG anywhere.

import {
  ARC_DAMAGE,
  BURN_TICKS,
  CHAIN_RADIUS,
  CRACK_MULT,
  FLOOD_CAP,
  FLOOD_FALLOFF,
  FREEZE_TICKS,
  MAGNET_HOP_FRAC,
  MAGNET_HOP_RADIUS,
  MAGNET_PULL,
  MAGNET_REACH,
  MAGNET_REST,
  SPARK_ZAP,
  STEAM_TICKS,
  SUBSTANCES,
  WILDFIRE_BURST,
  verbOf,
  type SubstanceId,
  type VerbId,
} from '../data/reactions'
import type { StatusApply } from '../data/items'
import { resistMult, type Entity } from '../entity'
import type { EntityId } from '../types'
import type { World } from '../world'
import { kill } from './combat'
import { addStatus, applyStatus, hasStatus, isFrozen, removeStatus } from './statusFx'
import { vlen } from '../simMath'

const WET = SUBSTANCES.soak.status
const OILED = SUBSTANCES.oil.status
const RIMED = SUBSTANCES.rime.status
const MAGNETISED = SUBSTANCES.magnet.status
export const STEAMED = 'steamed'

/** Can this body carry a coat? Live, has health, and is not a player: the
 * prototype has no friendly fire, so players never conduct or burn. */
const coatable = (e: Entity): boolean => !e.dead && e.health !== undefined && !e.playerCtl

export const isCoated = (e: Entity, substance: SubstanceId): boolean => hasStatus(e, SUBSTANCES[substance].status)

const reaction = (w: World, name: string, at: Entity, count: number): void => {
  w.events.push({ type: 'reaction', name, x: at.pos.x, y: at.pos.y, targetId: at.id, count })
}

/** Direct elemental damage, scaled by `resist[kind]` (so a boss set weak to
 * lightning takes double from every Spark source). Returns the hp taken. */
const hurt = (w: World, e: Entity, amount: number, kind: string): number => {
  if (!e.health || e.dead || e.playerCtl?.downed) return 0
  const dmg = Math.round(amount * resistMult(e, kind))
  if (dmg <= 0) return 0
  e.health.hp -= dmg
  e.health.lastHurtTick = w.tick
  w.events.push({ type: 'hit', x: e.pos.x, y: e.pos.y, targetId: e.id, amount: dmg })
  if (e.health.hp <= 0) kill(w, e)
  return dmg
}

/** Coat one body. Coats layer: a body can be wet AND oiled. */
export const coat = (w: World, e: Entity, substance: SubstanceId, source?: EntityId): void => {
  if (!coatable(e)) return
  const def = SUBSTANCES[substance]
  addStatus(w, e, def.status, def.ticks, source)
}

/** A Primer glob bursts at (x,y): coat every coatable body in `radius`. */
export const splashPrime = (
  w: World,
  x: number,
  y: number,
  prime: { substance?: SubstanceId; radius: number },
  ownerId: EntityId,
): number => {
  if (!prime.substance) return 0
  let n = 0
  let first: Entity | undefined
  for (const e of w.entities) {
    if (!coatable(e)) continue
    if (vlen(e.pos.x - x, e.pos.y - y) > prime.radius + e.radius) continue
    coat(w, e, prime.substance, ownerId)
    first ??= e
    n++
  }
  if (first) reaction(w, `coat.${prime.substance}`, first, n)
  return n
}

/** Breadth-first flood from `origin` through coatable bodies carrying `status`
 * within CHAIN_RADIUS of one another. Returns the members in visit order with
 * their hop depth. The origin is always first, coated or not. */
const flood = (w: World, origin: Entity, status: string): { e: Entity; depth: number }[] => {
  const out: { e: Entity; depth: number }[] = [{ e: origin, depth: 0 }]
  const seen = new Set<Entity>([origin])
  for (let i = 0; i < out.length && out.length < FLOOD_CAP; i++) {
    const cur = out[i]
    for (const n of w.entities) {
      if (out.length >= FLOOD_CAP) break
      if (seen.has(n) || !coatable(n) || !hasStatus(n, status)) continue
      if (vlen(cur.e.pos.x - n.pos.x, cur.e.pos.y - n.pos.y) > CHAIN_RADIUS) continue
      seen.add(n)
      out.push({ e: n, depth: cur.depth + 1 })
    }
  }
  return out
}

const falloff = (depth: number): number => FLOOD_FALLOFF ** depth

/** Spark on a wet body: the arc floods every connected wet body. */
const arc = (w: World, target: Entity): void => {
  const members = flood(w, target, WET)
  for (const { e, depth } of members) {
    applyStatus(w, e, 'electrified', 45)
    hurt(w, e, ARC_DAMAGE * falloff(depth), 'electrified')
    removeStatus(e, WET)
  }
  reaction(w, 'arc', target, members.length)
}

/** Flame (or a Spark igniting oil): fire floods every connected oiled body. */
const wildfire = (w: World, target: Entity, name: string): void => {
  const members = flood(w, target, OILED)
  for (const { e, depth } of members) {
    applyStatus(w, e, 'burning', BURN_TICKS)
    hurt(w, e, WILDFIRE_BURST * falloff(depth), 'burning')
    removeStatus(e, OILED)
  }
  reaction(w, name, target, members.length)
}

/** Frost on a wet body: every connected wet body freezes solid. */
const flashFreeze = (w: World, target: Entity): void => {
  const members = flood(w, target, WET)
  for (const { e } of members) {
    applyStatus(w, e, 'frozen', FREEZE_TICKS)
    removeStatus(e, WET)
  }
  reaction(w, 'flashFreeze', target, members.length)
}

/** A verb landing on a magnetised body hops ONCE to every other magnetised body
 * in reach, at reduced strength, and spends the magnet on all of them. */
const magnetHop = (w: World, target: Entity, verb: VerbId): void => {
  if (!hasStatus(target, MAGNETISED)) return
  if (verb !== 'spark' && verb !== 'flame' && verb !== 'frost') return
  const hopped: Entity[] = []
  for (const e of w.entities) {
    if (hopped.length >= FLOOD_CAP) break
    if (e === target || !coatable(e) || !hasStatus(e, MAGNETISED)) continue
    if (vlen(e.pos.x - target.pos.x, e.pos.y - target.pos.y) > MAGNET_HOP_RADIUS) continue
    hopped.push(e)
  }
  for (const e of hopped) {
    if (verb === 'spark') {
      applyStatus(w, e, 'electrified', 45)
      hurt(w, e, ARC_DAMAGE * MAGNET_HOP_FRAC, 'electrified')
    } else if (verb === 'flame') {
      applyStatus(w, e, 'burning', BURN_TICKS)
      hurt(w, e, WILDFIRE_BURST * MAGNET_HOP_FRAC, 'burning')
    } else {
      applyStatus(w, e, 'frozen', FREEZE_TICKS)
    }
    removeStatus(e, MAGNETISED)
  }
  removeStatus(target, MAGNETISED)
  reaction(w, 'magnetHop', target, hopped.length)
}

/** Steam: the flame boils the water off. No burn; the body loses its target and
 * cannot fight while it lasts (ai.ts reads STEAMED). */
const steam = (w: World, target: Entity): void => {
  removeStatus(target, WET)
  addStatus(w, target, STEAMED, STEAM_TICKS)
  if (target.ai) {
    target.ai.targetId = undefined
    target.ai.waypoint = undefined
    target.ai.mode = 'wander'
  }
  reaction(w, 'steam', target, 1)
}

/**
 * A Striker round landed on `target` carrying `onHit` (or nothing, a plain
 * round). Replaces the plain `applyStatus(onHit)` of the default hit path on a
 * Primer/Striker world. Call it only for a blow that actually landed.
 */
export const strike = (w: World, target: Entity, onHit: StatusApply | undefined): void => {
  // A body this very round killed still reacts: its coat carries the verb on
  // (a Spark that finishes a wet thug still arcs through the rest of the pack).
  const verb = verbOf(onHit)
  // Players are not coatable, so nothing reacts on them: the plain verb lands.
  if (target.playerCtl) {
    if (onHit) applyStatus(w, target, onHit.status, onHit.ticks)
    return
  }
  switch (verb) {
    case 'spark': {
      applyStatus(w, target, onHit!.status, onHit!.ticks)
      hurt(w, target, SPARK_ZAP, 'electrified')
      if (hasStatus(target, OILED)) wildfire(w, target, 'ignite')
      if (hasStatus(target, WET)) arc(w, target)
      break
    }
    case 'flame': {
      if (hasStatus(target, WET)) return steam(w, target)
      if (hasStatus(target, RIMED)) {
        removeStatus(target, RIMED)
        coat(w, target, 'soak')
        reaction(w, 'melt', target, 1)
        return
      }
      if (hasStatus(target, OILED)) wildfire(w, target, 'wildfire')
      else applyStatus(w, target, onHit!.status, onHit!.ticks)
      break
    }
    case 'frost': {
      if (hasStatus(target, OILED)) {
        reaction(w, 'fizzle', target, 1) // cold on oil: nothing happens, the oil stays
        return
      }
      if (hasStatus(target, RIMED)) {
        removeStatus(target, RIMED)
        // Deep freeze: skip the anti-chain-lock's diminishing return for this lock.
        if (target.lockout) delete target.lockout.frozen
        removeStatus(target, 'frozen')
        applyStatus(w, target, 'frozen', FREEZE_TICKS)
        reaction(w, 'deepFreeze', target, 1)
      }
      if (hasStatus(target, WET)) flashFreeze(w, target)
      else if (!isFrozen(target)) applyStatus(w, target, onHit!.status, onHit!.ticks)
      break
    }
    case 'wash': {
      applyStatus(w, target, onHit!.status, onHit!.ticks)
      removeStatus(target, 'burning') // the jet puts a fire out
      return
    }
    case 'impact':
      return // the crack (impact on rime) is resolved before the blow; see crackBlow
  }
  magnetHop(w, target, verb)
}

/** Impact on a rimed body CRACKS: the blow is CRACK_MULT stronger and ignores
 * physical armour. Returns the damage to pass to applyDamage (which re-applies
 * the physical resist, so this pre-divides it), or undefined when it does not
 * crack. A frozen body shatters instead (combat.applyDamage), so no crack. */
export const crackBlow = (target: Entity, onHit: StatusApply | undefined, damage: number): number | undefined => {
  if (verbOf(onHit) !== 'impact' || target.playerCtl) return undefined
  if (!hasStatus(target, RIMED) || isFrozen(target)) return undefined
  const r = resistMult(target, 'physical')
  return r > 0 ? (damage * CRACK_MULT) / r : damage * CRACK_MULT
}

/** Spend the rime after a crack that landed. */
export const cracked = (w: World, target: Entity): void => {
  removeStatus(target, RIMED)
  reaction(w, 'crack', target, 1)
}

/** Magnetised bodies drift toward the centre of the other magnetised bodies in
 * reach, which is what turns a spread-out room into ONE clump (pulling toward
 * the nearest body instead would pair them off). Runs before movement. */
export const magnetSystem = (w: World): void => {
  const mags = w.entities.filter((e) => coatable(e) && hasStatus(e, MAGNETISED))
  if (mags.length < 2) return
  const pulls: { e: Entity; x: number; y: number }[] = []
  for (const e of mags) {
    if (e.hive) continue // rooted
    let sx = 0
    let sy = 0
    let n = 0
    for (const o of mags) {
      if (o === e || vlen(o.pos.x - e.pos.x, o.pos.y - e.pos.y) > MAGNET_REACH) continue
      sx += o.pos.x
      sy += o.pos.y
      n++
    }
    if (n === 0) continue
    const dx = sx / n - e.pos.x
    const dy = sy / n - e.pos.y
    const d = vlen(dx, dy)
    if (d <= MAGNET_REST) continue
    pulls.push({ e, x: (dx / d) * MAGNET_PULL, y: (dy / d) * MAGNET_PULL })
  }
  // Apply after measuring, so the result does not depend on iteration order.
  for (const p of pulls) {
    p.e.vel.x += p.x
    p.e.vel.y += p.y
  }
}
