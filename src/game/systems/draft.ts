// The between-floor mod DRAFT (ROUNDS-style "pick 1 of N cards"). The offer is a
// PURE, deterministic function of (seed, floor): every peer computes the same
// hand with no netcode, from a dedicated RNG stream forked off the seed — so it
// never perturbs the sim stream, yet replays byte-identically. Co-op-friendly:
// one shared hand per floor, everyone drafts together (no loser-shaming for kids).

import { MODS, modMaxStacks, type ModDef, type ModRarity } from '../data/mods'
import { SPAWN_GRACE_TICKS, type Entity, type ItemStack, type WeaponMod } from '../entity'
import { hashLabel, mulberry32, type Rng } from '../rng'
import { emptyInput, SIM_RATE, type InputCmd } from '../types'
import type { World } from '../world'
import { applyModPickup } from './inventory'

/** Rarity weights for the weighted draw (ROUNDS gates power by rarity tier). */
const RARITY_WEIGHT: Record<ModRarity, number> = { common: 6, rare: 3, legendary: 1 }

export interface DraftCard {
  id: string
  name: string
  blurb: string
  icon: string
  rarity: ModRarity
}

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
export const weightedModId = (rng: Rng): string => {
  const all = Object.values(MODS)
  const total = all.reduce((s, m) => s + RARITY_WEIGHT[m.rarity], 0)
  let r = rng.next() * total
  for (let i = 0; i < all.length - 1; i++) {
    r -= RARITY_WEIGHT[all[i].rarity]
    if (r <= 0) return all[i].id
  }
  return all[all.length - 1].id
}

/** The deterministic hand offered on clearing `floor` for a run `seed`. Uses a
 * dedicated `draft:<floor>` fork so it is reproducible and independent of the
 * sim RNG — identical on host and every client. */
export const floorDraftOffer = (seed: number, floor: number, count = 3): string[] =>
  draftOffer(mulberry32(hashLabel(seed >>> 0, `draft:${floor}`)), count)

/** Presentation data for a set of offered mod ids (kid-readable blurbs/icons). */
export const draftCards = (ids: readonly string[]): DraftCard[] =>
  ids
    .filter((id) => MODS[id])
    .map((id) => {
      const d = MODS[id]
      return { id: d.id, name: d.name, blurb: d.blurb, icon: d.icon, rarity: d.rarity }
    })

/** Append a picked mod onto a weapon's stack, stacking an existing one up to its
 * cap. Mutates and returns the stack's mod list. The single write path shared by
 * the draft UI and the `addMod` debug verb's intent. */
export const applyDraftPick = (stack: ItemStack, modId: string, stacks = 1): WeaponMod[] => {
  if (!MODS[modId]) throw new Error(`unknown mod: ${modId}`)
  const cap = modMaxStacks(modId)
  const mods = (stack.mods ??= [])
  const existing = mods.find((m) => m.id === modId)
  if (existing) existing.stacks = Math.min(cap, existing.stacks + stacks)
  else mods.push({ id: modId, stacks: Math.min(cap, stacks) })
  return mods
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
  const modId = e.playerCtl!.draft!.offer[index]
  delete e.playerCtl!.draft
  const res = applyModPickup(e, modId)
  // The drafter stood still while the fight went on; give them the landing grace again.
  if (e.health) e.health.iframes = Math.max(e.health.iframes, SPAWN_GRACE_TICKS)
  w.events.push({ type: 'draftPick', byId: e.id, modId, weapon: res?.weapon ?? 'none', maxed: res?.maxed ?? false, timedOut })
}

/** Deal the hand for the floor just cleared to every live player. Called when
 * a player takes the exit; everyone gets the same cards and picks on their own. */
export const dealFloorDraft = (w: World, clearedFloor: number): void => {
  const offer = floorDraftOffer(w.seed, clearedFloor)
  if (offer.length === 0) return
  for (const e of w.entities) {
    if (!e.playerCtl || e.dead) continue
    // A teammate took the exit before this player chose: keep what they were pointing at.
    if (e.playerCtl.draft) takeCard(w, e, e.playerCtl.draft.cursor, true)
    e.playerCtl.draft = { offer: [...offer], cursor: 0, until: w.tick + DRAFT_TICKS, held: PREV | NEXT | CONFIRM }
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
    const n = hand.offer.length
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
