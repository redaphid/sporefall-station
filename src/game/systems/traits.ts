// Reads a player's traits (data/traits.ts) for the systems that honour them.
// Each system asks one question at its own choke point: "is this body immune to
// burning?", "how hard does a hit shove it?". A body with no traits (every NPC,
// and every player before their first YOU card) answers with the neutral value.

import { TRAITS, type TraitDef } from '../data/traits'
import type { Entity, TraitStack } from '../entity'
import type { ModVerdict } from './modEffect'

interface Held {
  def: TraitDef
  stacks: number
}

const NONE: readonly Held[] = []

const held = (e: Entity): readonly Held[] => {
  const list = e.playerCtl?.traits
  if (!list || list.length === 0) return NONE
  const out: Held[] = []
  for (const t of list) if (TRAITS[t.id] && t.stacks > 0) out.push({ def: TRAITS[t.id], stacks: t.stacks })
  return out
}

/** How many times `e` has taken trait `id` (0 = not held). */
export const traitStacks = (e: Entity, id: string): number =>
  e.playerCtl?.traits?.find((t) => t.id === id)?.stacks ?? 0

/** A trait keeps `status` off `e` entirely. */
export const traitImmune = (e: Entity, status: string): boolean =>
  held(e).some((h) => h.def.immune?.includes(status))

type Scale = 'knockback' | 'roll' | 'shotNoise' | 'taunt'

/** The product of every held trait's `key` multiplier, compounded per stack. 1 = unchanged. */
export const traitScale = (e: Entity, key: Scale): number => {
  let k = 1
  for (const h of held(e)) if (h.def[key] !== undefined) k *= h.def[key] ** h.stacks
  return k
}

/** `e`'s own blasts skip it. */
export const ownBlastProof = (e: Entity): boolean => held(e).some((h) => h.def.ownBlastProof)

/** Statuses a melee attacker catches for landing a blow on `e`. */
export const meleeRetorts = (e: Entity): { status: string; ticks: number }[] =>
  held(e).flatMap((h) => (h.def.meleeRetort ? [h.def.meleeRetort] : []))

/** How well `e` revives a teammate: progress per tick and a reach multiplier. */
export const reviveHelp = (e: Entity): { rate: number; reach: number } => {
  let rate = 1
  let reach = 1
  for (const h of held(e)) {
    if (!h.def.revive) continue
    rate = Math.max(rate, h.def.revive.rate)
    reach = Math.max(reach, h.def.revive.reach)
  }
  return { rate, reach }
}

/** `e`'s screen shows each enemy's weak and tough spots. */
export const seesAffinities = (e: Entity | undefined): boolean =>
  e !== undefined && held(e).some((h) => h.def.sees === 'affinities')

/** Players still in the run: what a co-op trait needs more than one of. */
export const partySize = (entities: readonly Entity[]): number =>
  entities.reduce((n, e) => (e.playerCtl && !e.dead ? n + 1 : n), 0)

/** Whether held trait `id` acts in a run of `party` players. */
export const heldTraitVerdict = (id: string, party: number): ModVerdict =>
  TRAITS[id]?.coop && party < 2 ? { kind: 'inert', reason: 'needs a teammate' } : { kind: 'live' }

/** What taking trait `id` would do for a player holding `traits`, in a run of
 * `party` players. The same verdict vocabulary as a gun card's. */
export const traitVerdict = (traits: readonly TraitStack[] | undefined, id: string, party: number): ModVerdict => {
  const def = TRAITS[id]
  const stacks = traits?.find((t) => t.id === id)?.stacks ?? 0
  if (def && stacks >= def.maxStacks) return { kind: 'inert', reason: 'you have it' }
  return heldTraitVerdict(id, party)
}

/** Take trait `id`: a new trait joins the end of the list, a held one stacks up
 * to its cap. Statuses it makes `e` immune to end now. Returns the stack count
 * after the pick and whether it was already at the cap. */
export const applyTraitPick = (e: Entity, id: string): { stacks: number; maxed: boolean } => {
  const def = TRAITS[id]
  if (!def) throw new Error(`unknown trait: ${id}`)
  const ctl = e.playerCtl
  if (!ctl) throw new Error(`entity ${e.id} has no playerCtl`)
  const list = (ctl.traits ??= [])
  const have = list.find((t) => t.id === id)
  if (have && have.stacks >= def.maxStacks) return { stacks: have.stacks, maxed: true }
  if (have) have.stacks += 1
  else list.push({ id, stacks: 1 })
  for (const kind of def.immune ?? []) if (e.fx) delete e.fx[kind]
  return { stacks: have?.stacks ?? 1, maxed: false }
}
