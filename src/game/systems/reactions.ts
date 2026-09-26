// Reactive wands (Design B), the hit-site half: an element landing on a body
// reads the status already there (the primer) and resolves one cell of the
// reaction table (data/reactions). Only reactive-wand runs call into this; every
// other run keeps the plain `applyDamage` + `applyStatus` hit path untouched.
//
// Order at the hit site matters: `applyDamage` shatters a frozen body, and a
// Thermal Crack must pre-empt that. So the outcome is decided FIRST, the blow
// is told whether it may shatter (only a bare impact may), and the outcome's
// effects run only if the blow landed, like every other on-hit effect.
//
// Determinism: no RNG, no clock. The chain is interactions.shock's flood, in
// entity order.

import type { StatusApply } from '../data/items'
import { isPrimer, PRIMER_ORDER, REACTIONS, THERMAL_CRACK_DAMAGE, type Incoming, type Outcome, type Primer } from '../data/reactions'
import { ELEMENTS } from '../data/elements'
import { NPCS } from '../data/npcs'
import { resistMult, type Entity } from '../entity'
import type { EntityId } from '../types'
import type { World } from '../world'
import { applyDamage, kill } from './combat'
import { shock } from './interactions'
import { addStatus, applyStatus, hasStatus, removeStatus } from './statusFx'

/** Is this run using reactive wands? */
export const reactiveWands = (w: World): boolean => w.modCasting === 'reactive'

/** The status on `e` that the next element reacts with, or 'none'. */
export const primerOf = (e: Entity): Primer | 'none' => PRIMER_ORDER.find((s) => hasStatus(e, s)) ?? 'none'

/** The table cell for an element (or a bare impact) landing on `e`. A status
 * outside the table (poison, stun) never reacts: it just applies. */
export const decideReaction = (e: Entity, onHit: StatusApply | undefined): { primer: Primer | 'none'; incoming: Incoming | string; outcome: Outcome } => {
  const primer = primerOf(e)
  const incoming = onHit ? onHit.status : 'impact'
  const outcome = incoming === 'impact' || isPrimer(incoming) ? REACTIONS[primer][incoming] : 'apply'
  return { primer, incoming, outcome }
}

/** Reaction damage that is not an impact (the crack's thaw burst): straight off
 * hp with the element's resist, no i-frames, like the shock arc. */
const reactionDamage = (w: World, e: Entity, amount: number, kind: string): void => {
  if (!e.health || e.dead || e.playerCtl?.downed) return
  const dmg = Math.round(amount * resistMult(e, kind))
  if (dmg <= 0) return
  e.health.hp -= dmg
  e.health.lastHurtTick = w.tick
  w.events.push({ type: 'hit', x: e.pos.x, y: e.pos.y, targetId: e.id, amount: dmg })
  if (e.health.hp <= 0) kill(w, e)
}

/** Run an outcome's effects on `e`. `byId` fired the incoming half. */
const resolveOutcome = (
  w: World,
  e: Entity,
  d: ReturnType<typeof decideReaction>,
  onHit: StatusApply | undefined,
  byId: EntityId,
): void => {
  let { outcome } = d
  // One arc per wet cluster per tick. A blast or a chip burst lands on every wet
  // body at once; without this each of them would re-flood the whole cluster
  // (n bodies, n floods, n² damage). A body the arc already reached this tick
  // just takes the status.
  if (outcome === 'chain' && w.events.some((ev) => ev.type === 'shock' && ev.targetId === e.id)) outcome = 'apply'
  if (outcome === 'apply') {
    if (onHit) applyStatus(w, e, onHit.status, onHit.ticks)
    return
  }
  // A shatter on a player is the ordinary crack-the-ice blow (combat.applyDamage),
  // not a reaction worth naming.
  if (outcome === 'shatter' && e.playerCtl) return
  w.events.push({ type: 'reaction', reaction: outcome, x: e.pos.x, y: e.pos.y, targetId: e.id, byId, primer: d.primer, incoming: d.incoming })
  switch (outcome) {
    case 'chain':
      // The existing wet + electric rule: the arc floods the wet cluster, each
      // wet body takes the electrocution damage (scaled by its electrified resist).
      shock(w, e)
      return
    case 'fizzle':
      // Fire into water: the fire is wasted and the water boils off.
      removeStatus(e, 'wet')
      return
    case 'thermalCrack':
      // Fire into ice: the ice breaks with a hard burst and leaves meltwater,
      // which re-primes the body for a chain.
      removeStatus(e, 'frozen')
      reactionDamage(w, e, THERMAL_CRACK_DAMAGE, 'frozen')
      addStatus(w, e, 'wet', ELEMENTS.wet.durationTicks)
      return
    case 'shatter': // the blow itself was multiplied in applyDamage
    case 'numb': // nothing lands; the ice (or the stun) holds
      return
  }
}

/**
 * A reactive-wand blow: `damage` of impact carrying `onHit` (or nothing, a
 * bare impact). Same contract as `applyDamage`: returns the damage applied, or
 * null when the blow never landed, in which case no reaction runs either.
 */
export const reactiveHit = (
  w: World,
  target: Entity,
  damage: number,
  fromX: number,
  fromY: number,
  knockback: number,
  attackerId: EntityId,
  onHit: StatusApply | undefined,
): number | null => {
  const d = decideReaction(target, onHit)
  // Only a round with NO element shatters ice. An element landing on ice reacts
  // (fire cracks it) or is numbed, and the ice takes the blow at face value.
  const dealt = applyDamage(w, target, damage, fromX, fromY, knockback, attackerId, onHit === undefined)
  if (dealt === null) return null
  // A body the impact killed is out of the reaction. A shatter is the exception:
  // it IS the blow, and naming it on the killing hit is the point.
  if (!target.dead || d.outcome === 'shatter') resolveOutcome(w, target, d, onHit, attackerId)
  return dealt
}

/** An element landing with no impact at all (a cracked chip's burst). */
export const landElement = (w: World, target: Entity, onHit: StatusApply, byId: EntityId): void => {
  if (target.dead) return
  resolveOutcome(w, target, decideReaction(target, onHit), onHit, byId)
}

/** Reactive wands: every body whose archetype has a `hide` re-soaks itself on
 * its clock while it is above its hp threshold. Runs only in reactive runs. */
export const hideSystem = (w: World): void => {
  for (const e of w.entities) {
    if (e.dead || !e.health || e.kind !== 'npc') continue
    const hide = NPCS[e.archetype]?.hide
    if (!hide || e.health.hp <= e.health.max * hide.untilHpFrac) continue
    // On the clock, or the moment something (a fizzle) dried it off.
    if (w.tick % hide.every === 0 || !hasStatus(e, hide.status)) addStatus(w, e, hide.status, hide.every + 1)
  }
}
