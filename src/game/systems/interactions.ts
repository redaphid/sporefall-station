// The element INTERACTION matrix — the cross-element combinations that make the
// genre emergent. Re-expressed from observed Streets of Rogue behavior, not
// ported. The rules that live here:
//
//   WET + ELECTRIC ⇒ CHAIN. Electrocuting a wet body arcs through the connected
//     puddle: every wet body it can reach is electrified too, and each wet body
//     takes electrocution damage. Grounded in StatusEffects.cs (~L8133): an
//     agent gaining "Electrocuted" while `underWater || spillWater` takes
//     ChangeHealth(-20) (-30 fully underwater). A DRY electrocuted agent on DRY
//     GROUND is only immobilized (CantDoAnything), taking no water damage.
//
//   …AND THE WATER ITSELF CONDUCTS. A `water` hazard cell (systems/water.ts) is
//     a conductor in its own right, so the charge does not need a chain of
//     bodies to travel: shock a puddle and it floods the whole connected pool,
//     electrocuting everything standing anywhere in it. This is what makes
//     "shoot the ground, not the boss" a real verb, and it is the half of the
//     mechanic the reference had all along — `spillWater` is a property of the
//     FLOOR you are standing on, not of your own soaking.
//
//     CONDUCTION IS SYMMETRIC, ON PURPOSE. A player standing in a puddle they
//     are shooting into is electrocuted by their own shot. There is no "water
//     conducts, but politely not to you" exemption, because an asymmetric
//     physics rule is exactly the special case this engine avoids — and because
//     the danger IS the mechanic. What makes it FAIR is elsewhere and already
//     built: `electrified` is in IMMOBILIZE_STATUSES, so every arc routes
//     through `statusFx.applyImmobilize` and inherits no-refresh-while-active, a
//     post-lock immunity window and diminishing returns across a hot chain — a
//     player standing in water under sustained fire always gets actionable free
//     ticks to walk out. The other protections hold unchanged: a DOWNED body
//     conducts but can never be re-killed by an arc (#52).
//
// The matrix's other two rules live where their trigger is: SHATTER-on-impact in
// combat.applyDamage (a hit on a frozen body), and IMMOBILIZE (frozen/electrified
// ⇒ CantDoAnything) as `isImmobilized`, gated in movement/combat/ai. Fire↔frost
// needs no code: burn is damage-over-time (elementSystem), never an impact, so a
// frozen body burns to death normally and does not shatter — matching the
// reference (there is NO "fire thaws a living frozen agent" rule).
//
// Determinism: the chain is a breadth-first flood with a fixed visit order —
// bodies in ascending entity-id order (w.entities order), cells in water.NEIGHBORS
// order — with no randomness, and it fully resolves within the call that starts it.

import { ELEMENTS } from '../data/elements'
import type { Entity } from '../entity'
import type { World } from '../world'
import { kill } from './combat'
import { addStatus, isWet } from './statusFx'
import { NEIGHBORS } from './water'
import { vlen } from '../simMath'

/** hp a wet body loses per electrocution (StatusEffects.cs spillWater case). */
export const ELEC_DAMAGE = 20
/** How close two wet bodies must be for the arc to jump between them (tiles).
 * Diagonal-inclusive (√2 < 1.6) — bodies conduct by touching. Water conducts
 * orthogonally instead (water.NEIGHBORS): a pool connects through shared EDGES,
 * so a diagonal gap is a real break in the circuit a player can read and use. */
const CHAIN_RADIUS = 1.6

export const freeze = (w: World, e: Entity): void => addStatus(w, e, 'frozen', ELEMENTS.frozen.durationTicks)

export const wet = (w: World, e: Entity): void => addStatus(w, e, 'wet', ELEMENTS.wet.durationTicks)

const near = (a: Entity, b: Entity): boolean => vlen(a.pos.x - b.pos.x, a.pos.y - b.pos.y) <= CHAIN_RADIUS

/** A hazard CELL (fire / spore cloud / water) rather than a body. These ride the
 * same entity list as everything else, so the flood has to skip them explicitly:
 * a puddle standing in itself would otherwise qualify as a conductive "body",
 * collect an `electrified` fx entry, and serialize + render as a shocked actor. */
const isHazardCell = (e: Entity): boolean =>
  e.fire !== undefined || e.spore !== undefined || e.water !== undefined

/** One step of the flood: a body that has taken the charge, or a flooded cell
 * the charge is running through. */
type Charge = { kind: 'body'; e: Entity } | { kind: 'cell'; tx: number; ty: number }

/** Deal one electrocution to a body that has taken the charge. */
const electrocute = (w: World, e: Entity): void => {
  // A downed body is out of the fight — shock damage can't re-kill it (#52). It
  // still CONDUCTS (the caller keeps flooding through it), it just can't be
  // farmed for a second kill.
  if (!e.health || e.playerCtl?.downed) return
  e.health.hp -= ELEC_DAMAGE
  // This is the one damage site that bypasses combat.applyDamage, so stamp the
  // last-hurt tick here too — an arc still counts as being harmed for regen.
  e.health.lastHurtTick = w.tick
  w.events.push({ type: 'shock', x: e.pos.x, y: e.pos.y, targetId: e.id })
  if (e.health.hp <= 0) kill(w, e)
}

/**
 * Run the charge outward from `start` until it can reach nothing new.
 *
 * COST: each body is visited once and each water cell once. The per-body arc
 * still costs a radius scan of `w.entities` (unchanged), but the per-cell step
 * is O(1) against a bodies-by-cell index built once here — so a big pool does
 * NOT turn the flood quadratic. The pool itself is bounded anyway:
 * `water.MAX_WATER_CELLS` caps live cells at 24, which is the same budget
 * argument that caps them for the snapshot.
 */
const floodCharge = (w: World, start: Charge): void => {
  const lw = w.level.w
  const keyAt = (x: number, y: number): number => Math.floor(y) * lw + Math.floor(x)

  // Index the live water cells and the bodies standing in each, ONCE. Bodies go
  // in in `w.entities` order, i.e. ascending id, so each bucket drains in the
  // same order the old flat scan would have produced.
  const waterCells = new Set<number>()
  const bodiesByCell = new Map<number, Entity[]>()
  for (const e of w.entities) {
    if (e.dead) continue
    if (e.water) {
      waterCells.add(keyAt(e.pos.x, e.pos.y))
      continue
    }
    if (isHazardCell(e)) continue
    const k = keyAt(e.pos.x, e.pos.y)
    const bucket = bodiesByCell.get(k)
    if (bucket) bucket.push(e)
    else bodiesByCell.set(k, [e])
  }

  /** A body carries the charge if it is SOAKED or if it is standing in a puddle.
   * The second half is what makes a dry body on wet ground a conductor rather
   * than a dead end — and it takes effect the instant the cell is flooded,
   * without waiting for waterSystem to hand out the `wet` status next tick. */
  const conducts = (e: Entity): boolean => isWet(e) || waterCells.has(keyAt(e.pos.x, e.pos.y))

  const seenBodies = new Set<Entity>()
  const seenCells = new Set<number>()
  const queue: Charge[] = [start]

  while (queue.length) {
    const node = queue.shift()!

    if (node.kind === 'cell') {
      const key = node.ty * lw + node.tx
      // Dry ground is not a conductor: shooting a bare floor tile does nothing.
      if (seenCells.has(key) || !waterCells.has(key)) continue
      seenCells.add(key)
      // Everything standing in this cell takes the charge…
      for (const b of bodiesByCell.get(key) ?? []) {
        if (!seenBodies.has(b) && !b.dead) queue.push({ kind: 'body', e: b })
      }
      // …and the current runs on through the connected pool.
      for (const [dx, dy] of NEIGHBORS) {
        const nk = (node.ty + dy) * lw + (node.tx + dx)
        if (waterCells.has(nk) && !seenCells.has(nk)) {
          queue.push({ kind: 'cell', tx: node.tx + dx, ty: node.ty + dy })
        }
      }
      continue
    }

    const e = node.e
    if (seenBodies.has(e) || e.dead) continue
    seenBodies.add(e)
    addStatus(w, e, 'electrified', ELEMENTS.electrified.durationTicks)
    if (!conducts(e)) continue // dry body on dry ground: immobilized only, no arc
    electrocute(w, e)
    // Arc to touching conductive bodies (the original body-to-body chain).
    for (const n of w.entities) {
      if (seenBodies.has(n) || n.dead || isHazardCell(n) || !conducts(n) || !near(e, n)) continue
      queue.push({ kind: 'body', e: n })
    }
    // …and down into the puddle under its feet, if it is standing in one.
    const key = keyAt(e.pos.x, e.pos.y)
    if (waterCells.has(key) && !seenCells.has(key)) {
      queue.push({ kind: 'cell', tx: Math.floor(e.pos.x), ty: Math.floor(e.pos.y) })
    }
  }
}

/**
 * Zap `origin`: it becomes electrified (immobilized), and if it conducts — it is
 * wet, OR it is standing in water — the shock floods everything electrically
 * connected to it: wet bodies within CHAIN_RADIUS, the puddle under its feet,
 * the rest of that pool, and every body standing anywhere in it. Each body
 * reached takes ELEC_DAMAGE. A dry body on dry ground is still a dead end.
 *
 * Passing a water CELL entity (the debug `shock` verb aimed at a puddle) seeds
 * the flood from that cell, which is the obvious reading of "shock the puddle".
 */
export const shock = (w: World, origin: Entity): void => {
  const start: Charge =
    origin.water !== undefined && !origin.dead
      ? { kind: 'cell', tx: Math.floor(origin.pos.x), ty: Math.floor(origin.pos.y) }
      : { kind: 'body', e: origin }
  floodCharge(w, start)
}

/**
 * Electrify the GROUND at a tile — "shoot the ground, not the boss". A no-op on
 * a dry tile; on a flooded one it charges the whole connected pool and everyone
 * standing in it, the shooter included if they are standing in their own puddle.
 */
export const shockCell = (w: World, tx: number, ty: number): void => {
  floodCharge(w, { kind: 'cell', tx, ty })
}
