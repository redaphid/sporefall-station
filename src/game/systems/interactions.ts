// The element INTERACTION matrix — the cross-element combinations that make the
// genre emergent. Re-expressed from observed Streets of Rogue behavior, not
// ported. The rules that live here:
//
//   WET + ELECTRIC ⇒ CHAIN. Electrocuting a wet body arcs through the connected
//     puddle: every wet body it can reach is electrified too, and each wet body
//     takes electrocution damage. Grounded in StatusEffects.cs (~L8133): an
//     agent gaining "Electrocuted" while `underWater || spillWater` takes
//     ChangeHealth(-20) (-30 fully underwater). A DRY electrocuted agent is only
//     immobilized (CantDoAnything), taking no water damage — so the arc conducts
//     through wet bodies only and a dry body is a dead end.
//
// The matrix's other two rules live where their trigger is: SHATTER-on-impact in
// combat.applyDamage (a hit on a frozen body), and IMMOBILIZE (frozen/electrified
// ⇒ CantDoAnything) as `isImmobilized`, gated in movement/combat/ai. Fire↔frost
// needs no code: burn is damage-over-time (elementSystem), never an impact, so a
// frozen body burns to death normally and does not shatter — matching the
// reference (there is NO "fire thaws a living frozen agent" rule).
//
// Determinism: the chain is a breadth-first flood over w.entities in ascending
// id order, no randomness; it fully resolves within the call that starts it.

import { ELEMENTS } from '../data/elements'
import type { Entity } from '../entity'
import type { World } from '../world'
import { kill } from './combat'
import { addStatus, isWet } from './statusFx'

/** hp a wet body loses per electrocution (StatusEffects.cs spillWater case). */
const ELEC_DAMAGE = 20
/** How close two wet bodies must be for the arc to jump between them (tiles). */
const CHAIN_RADIUS = 1.6

/** Freeze `e`. `brittle` opts into the shatter-on-impact execute and defaults to
 * OFF, so a new freeze source is control until it deliberately asks to be a kill
 * button — only the thrown freeze grenade does. See StatusEntry.brittle. */
export const freeze = (w: World, e: Entity, brittle = false): void =>
  addStatus(w, e, 'frozen', ELEMENTS.frozen.durationTicks, undefined, brittle)

export const wet = (w: World, e: Entity): void => addStatus(w, e, 'wet', ELEMENTS.wet.durationTicks)

const near = (a: Entity, b: Entity): boolean => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) <= CHAIN_RADIUS

/** Zap `origin`: it becomes electrified (immobilized), and if it is wet the
 * shock floods the connected wet cluster — every reachable wet body is
 * electrified and takes electrocution damage. A dry origin is a dead end. */
export const shock = (w: World, origin: Entity): void => {
  const seen = new Set<Entity>()
  const queue: Entity[] = [origin]
  while (queue.length) {
    const e = queue.shift()!
    if (seen.has(e) || e.dead) continue
    seen.add(e)
    addStatus(w, e, 'electrified', ELEMENTS.electrified.durationTicks)
    if (!isWet(e)) continue // dry: immobilized only, no water damage, no arc
    if (e.health && !e.playerCtl?.downed) {
      // A downed body is out of the fight — shock damage can't re-kill it (#52).
      e.health.hp -= ELEC_DAMAGE
      // This is the one damage site that bypasses combat.applyDamage, so stamp the
      // last-hurt tick here too — an arc still counts as being harmed for regen.
      e.health.lastHurtTick = w.tick
      w.events.push({ type: 'shock', x: e.pos.x, y: e.pos.y, targetId: e.id })
      if (e.health.hp <= 0) kill(w, e)
    }
    for (const n of w.entities) {
      if (seen.has(n) || n.dead || !isWet(n) || !near(e, n)) continue
      queue.push(n)
    }
  }
}
