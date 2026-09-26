// Scout Eye (a draft trait): the scout reads each nearby enemy's weak and tough
// spots over its head. Only the damage a player can deal is named, so every tag
// is a choice the player can act on: shoot, burn, or lure it into spores.
// Pure: the layer only draws what this returns.

import { NPCS } from '../game/data/npcs'
import type { Entity } from '../game/entity'
import { seesAffinities } from '../game/systems/traits'

/** The damage kinds a player deals, in the words a kid uses for them. */
const WORD: Record<string, string> = { physical: 'bullets', burning: 'fire', spore: 'spores' }

/** How far from the scout (tiles) enemies are read. Past it, no tag, so a
 * crowded screen is not buried in text. */
export const SCOUT_RANGE = 8

export type ScoutTone = 'weak' | 'tough' | 'immune'

export interface ScoutTag {
  id: number
  lines: { tone: ScoutTone; text: string }[]
}

const toneOf = (mult: number): ScoutTone | undefined =>
  mult <= 0 ? 'immune' : mult < 1 ? 'tough' : mult > 1 ? 'weak' : undefined

/** The tags `self` sees, one per living enemy in range with any non-neutral
 * affinity. A net client has no `resist` on its entities, so the archetype's
 * table stands in; nothing changes it after spawn. */
export const scoutTags = (entities: readonly Entity[], self: Entity | undefined): ScoutTag[] => {
  if (!self || !seesAffinities(self)) return []
  const out: ScoutTag[] = []
  for (const e of entities) {
    if (e.kind !== 'npc' || e.dead) continue
    if (Math.hypot(e.pos.x - self.pos.x, e.pos.y - self.pos.y) > SCOUT_RANGE) continue
    const resist = e.resist ?? NPCS[e.archetype]?.resist
    if (!resist) continue
    const by: Record<ScoutTone, string[]> = { weak: [], tough: [], immune: [] }
    for (const [kind, word] of Object.entries(WORD)) {
      const tone = toneOf(resist[kind] ?? 1)
      if (tone) by[tone].push(word)
    }
    const lines = (['weak', 'tough', 'immune'] as const).flatMap((tone) =>
      by[tone].length ? [{ tone, text: `${tone}: ${by[tone].join(', ')}` }] : [],
    )
    if (lines.length) out.push({ id: e.id, lines })
  }
  return out
}
