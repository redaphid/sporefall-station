// The between-floor DRAFT (ROUNDS-style "pick 1 of N cards"). A hand is two GUN
// cards (mods) and one YOU card (a trait, data/traits.ts). Each kind comes from
// its own RNG stream forked off (seed, floor), so the hand is a pure function of
// them, never perturbs the sim stream, and the gun cards are exactly the ones
// the draft dealt before YOU cards existed. Co-op-friendly: one shared hand per
// floor, everyone drafts together (no loser-shaming for kids).

import { MODS, modMaxStacks, stackMod, type ModDef, type ModRarity } from '../data/mods'
import type { WeaponDef } from '../data/items'
import { TRAITS } from '../data/traits'
import { SPAWN_GRACE_TICKS, type DraftHand, type Entity, type ItemStack, type TraitStack, type WeaponMod } from '../entity'
import { hashLabel, mulberry32, type Rng } from '../rng'
import { emptyInput, SIM_RATE, type InputCmd } from '../types'
import type { World } from '../world'
import { applyModPickup } from './inventory'
import { modVerdict, type ModVerdict } from './modEffect'
import { applyTraitPick, traitVerdict } from './traits'

/** Rarity weights for the weighted draw (ROUNDS gates power by rarity tier). */
const RARITY_WEIGHT: Record<ModRarity, number> = { common: 6, rare: 3, legendary: 1 }

/** One card of a hand: a GUN card (a mod id) or the YOU card (a trait id). */
export interface DraftCardRef {
  kind: 'mod' | 'trait'
  id: string
}

/** A hand's cards in the order the cursor walks them: the gun cards, then the
 * YOU card. The single definition of card order for the sim and the screen. */
export const handCards = (hand: Pick<DraftHand, 'offer' | 'trait'>): DraftCardRef[] => [
  ...hand.offer.map((id) => ({ kind: 'mod' as const, id })),
  ...(hand.trait !== undefined ? [{ kind: 'trait' as const, id: hand.trait }] : []),
]

export interface DraftCard {
  kind: 'mod' | 'trait'
  /** Position in `handCards`, which is what a tap must send. */
  index: number
  id: string
  name: string
  blurb: string
  icon: string
  rarity: ModRarity
  /** What the pick would do: on the drafter's gun for a GUN card, on the
   * drafter for the YOU card. */
  verdict?: ModVerdict
}

/** Gun cards per hand. The third slot went to the YOU card. */
export const GUN_CARDS = 2

/** Draw `count` DISTINCT mod ids from the registry, weighted by rarity, without
 * replacement — a pure function of the supplied RNG stream position. */
export const draftOffer = (rng: Rng, count = 3): string[] => {
  const remaining: ModDef[] = Object.values(MODS)
  const chosen: string[] = []
  while (chosen.length < count && remaining.length > 0) {
    const total = remaining.reduce((s, m) => s + RARITY_WEIGHT[m.rarity], 0)
    let r = rng.next() * total
    let idx = 0
    for (; idx < remaining.length - 1; idx++) {
      r -= RARITY_WEIGHT[remaining[idx].rarity]
      if (r <= 0) break
    }
    chosen.push(remaining[idx].id)
    remaining.splice(idx, 1)
  }
  return chosen
}

/** Draw ONE mod id, weighted by rarity, from the supplied RNG stream — the
 * single-card analogue of `draftOffer`, shared by the world mod-pickup placement
 * (populate.ts) so scattered pickups follow the same common/rare/legendary odds
 * as the draft. Pure in the RNG: same stream position → same id. */
export const weightedModId = (rng: Rng): string => weightedPick(Object.values(MODS), rng).id

/** One entry of a non-empty rarity-tiered table, weighted by rarity. */
const weightedPick = <T extends { rarity: ModRarity }>(all: readonly T[], rng: Rng): T => {
  const total = all.reduce((s, m) => s + RARITY_WEIGHT[m.rarity], 0)
  let r = rng.next() * total
  for (let i = 0; i < all.length - 1; i++) {
    r -= RARITY_WEIGHT[all[i].rarity]
    if (r <= 0) return all[i]
  }
  return all[all.length - 1]
}

/** The deterministic gun cards offered on clearing `floor` for a run `seed`.
 * Uses a dedicated `draft:<floor>` fork so it is reproducible and independent of
 * the sim RNG — identical on host and every client. */
export const floorDraftOffer = (seed: number, floor: number, count = GUN_CARDS): string[] =>
  draftOffer(mulberry32(hashLabel(seed >>> 0, `draft:${floor}`)), count)

/** The YOU card for clearing `floor`: one trait, weighted by rarity, drawn from
 * its own `trait:<floor>` fork so it moves neither the gun cards nor the sim. */
export const floorTraitOffer = (seed: number, floor: number): string | undefined => {
  const all = Object.values(TRAITS)
  return all.length === 0 ? undefined : weightedPick(all, mulberry32(hashLabel(seed >>> 0, `trait:${floor}`))).id
}

/** The weapon a draft pick would land on. */
export interface DraftLoadout {
  weapon: WeaponDef
  mods: readonly WeaponMod[]
  sequenced: boolean
}

/** What picking `id` would do to `loadout`'s weapon. A mod already at its stack
 * cap is a no-op pick (applyDraftPick clamps it). */
const draftVerdict = (loadout: DraftLoadout, id: string): ModVerdict => {
  const held = loadout.mods.find((m) => m.id === id)
  if (held && held.stacks >= modMaxStacks(id)) return { kind: 'inert', reason: 'already maxed' }
  return modVerdict(loadout.weapon, loadout.mods, id, loadout.sequenced)
}

/** The drafter as the YOU card judges it: what they already hold, and how
 * many players are in the run (a co-op trait does nothing alone). */
export interface DraftYou {
  traits?: readonly TraitStack[]
  party: number
}

/** `self` as the YOU card judges them, among the run's `entities`. */
export const draftYou = (self: Entity | undefined, entities: readonly Entity[]): DraftYou | undefined =>
  self?.playerCtl ? { traits: self.playerCtl.traits, party: entities.filter((e) => e.playerCtl && !e.dead).length } : undefined

/** Presentation data for a hand (kid-readable blurbs/icons), each card with what
 * it would do: GUN cards on `loadout`, the YOU card on `you`, when given.
 * Unknown ids are dropped; each card keeps its `handCards` index. */
export const draftCards = (hand: Pick<DraftHand, 'offer' | 'trait'>, loadout?: DraftLoadout, you?: DraftYou): DraftCard[] =>
  handCards(hand).flatMap(({ kind, id }, index): DraftCard[] => {
    const d = kind === 'mod' ? MODS[id] : TRAITS[id]
    if (!d) return []
    const card: DraftCard = { kind, index, id: d.id, name: d.name, blurb: d.blurb, icon: d.icon, rarity: d.rarity }
    if (kind === 'mod' && loadout) card.verdict = draftVerdict(loadout, id)
    if (kind === 'trait' && you) card.verdict = traitVerdict(you.traits, id, you.party)
    return [card]
  })

/** Append a picked mod onto a weapon's stack, stacking an existing one up to its
 * cap. Mutates and returns the stack's mod list. The single write path shared by
 * the draft UI and the `addMod` debug verb's intent. */
export const applyDraftPick = (stack: ItemStack, modId: string, stacks = 1): WeaponMod[] => {
  if (!MODS[modId]) throw new Error(`unknown mod: ${modId}`)
  return stackMod((stack.mods ??= []), modId, stacks)
}

/** How long a hand stays open before it takes the card under the cursor. The
 * sim never pauses for a draft, so this bounds how long one player can stand
 * out of the fight (or a dropped client's avatar can stand in it). */
export const DRAFT_TICKS = 20 * SIM_RATE

const PREV = 1
const NEXT = 2
const CONFIRM = 4
const STICK = 0.5

const intents = (cmd: InputCmd): number =>
  (cmd.moveX <= -STICK || cmd.moveY <= -STICK ? PREV : 0) |
  (cmd.moveX >= STICK || cmd.moveY >= STICK ? NEXT : 0) |
  (cmd.attack || cmd.interact ? CONFIRM : 0)

const takeCard = (w: World, e: Entity, index: number, timedOut: boolean): void => {
  const card = handCards(e.playerCtl!.draft!)[index]
  delete e.playerCtl!.draft
  // The drafter stood still while the fight went on; give them the landing grace again.
  if (e.health) e.health.iframes = Math.max(e.health.iframes, SPAWN_GRACE_TICKS)
  if (card.kind === 'trait') {
    // An id this build does not know closes the hand as a spent pick.
    const res = TRAITS[card.id] ? applyTraitPick(e, card.id) : { stacks: 0, maxed: true }
    w.events.push({ type: 'traitPick', byId: e.id, traitId: card.id, stacks: res.stacks, maxed: res.maxed, timedOut })
    return
  }
  const res = applyModPickup(e, card.id)
  w.events.push({ type: 'draftPick', byId: e.id, modId: card.id, weapon: res?.weapon ?? 'none', maxed: res?.maxed ?? false, timedOut })
}

/** Deal the hand for the floor just cleared to every live player. Called when
 * a player takes the exit; everyone gets the same cards and picks on their own. */
export const dealFloorDraft = (w: World, clearedFloor: number): void => {
  const offer = floorDraftOffer(w.seed, clearedFloor)
  const trait = floorTraitOffer(w.seed, clearedFloor)
  if (offer.length === 0 && trait === undefined) return
  for (const e of w.entities) {
    if (!e.playerCtl || e.dead) continue
    // A teammate took the exit before this player chose: keep what they were pointing at.
    if (e.playerCtl.draft) takeCard(w, e, e.playerCtl.draft.cursor, true)
    e.playerCtl.draft = {
      offer: [...offer],
      ...(trait !== undefined ? { trait } : {}),
      cursor: 0,
      until: w.tick + DRAFT_TICKS,
      held: PREV | NEXT | CONFIRM,
    }
  }
}

/**
 * Run every open hand for one tick and return the inputs the rest of the sim
 * should see. A drafting player's command steers the hand (move = cursor,
 * attack/interact = take, `draftPick` = take that card) and is replaced by a
 * neutral one, so the drafter stands still and cannot fire; they are also
 * invulnerable until they pick. Everyone else plays on: nobody waits.
 */
export const draftSystem = (w: World, inputs: Map<number, InputCmd>): Map<number, InputCmd> => {
  let out = inputs
  for (const e of w.entities) {
    const hand = e.playerCtl?.draft
    if (!hand || e.dead) continue
    const n = handCards(hand).length
    if (n === 0) {
      delete e.playerCtl!.draft
      continue
    }
    if (!(hand.cursor >= 0 && hand.cursor < n)) hand.cursor = 0
    const cmd = inputs.get(e.playerCtl!.playerId)
    const now = cmd ? intents(cmd) : 0
    const pressed = now & ~hand.held
    hand.held = now
    if (pressed & PREV) hand.cursor = (hand.cursor + n - 1) % n
    if (pressed & NEXT) hand.cursor = (hand.cursor + 1) % n
    const direct = cmd?.draftPick
    if (direct !== undefined && Number.isInteger(direct) && direct >= 0 && direct < n) takeCard(w, e, direct, false)
    else if (pressed & CONFIRM) takeCard(w, e, hand.cursor, false)
    else if (w.tick >= hand.until) takeCard(w, e, hand.cursor, true)
    else if (e.health) e.health.iframes = Math.max(e.health.iframes, 2)
    if (out === inputs) out = new Map(inputs)
    out.set(e.playerCtl!.playerId, { ...emptyInput(), seq: cmd?.seq ?? 0, aimX: 0, aimY: 0 })
  }
  return out
}
