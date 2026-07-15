// The between-floor mod DRAFT (ROUNDS-style "pick 1 of N cards"). The offer is a
// PURE, deterministic function of (seed, floor): every peer computes the same
// hand with no netcode, from a dedicated RNG stream forked off the seed — so it
// never perturbs the sim stream, yet replays byte-identically. Co-op-friendly:
// one shared hand per floor, everyone drafts together (no loser-shaming for kids).

import { MODS, modMaxStacks, type ModDef, type ModRarity } from '../data/mods'
import type { ItemStack, WeaponMod } from '../entity'
import { hashLabel, mulberry32, type Rng } from '../rng'

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
