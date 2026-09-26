// #87 — overhead cues for the two element verbs that have no look of their own.
// Frozen (frost shader + ice tint) and electrified (lightning shader + yellow
// tint) already read on the body. Burning PANIC and spore BLINDNESS did not:
// a panicking NPC wore the same ember tint as any burning one, and a blinded
// NPC the same spore tint as a spore-resistant one. These marks say which verb
// is holding the target. Pure: the layer only draws what this returns.

import type { Entity } from '../game/entity'
import { sporeBlinded } from '../game/systems/goals'
import { panicAt } from '../game/systems/statusFx'

export type Verb = 'panic' | 'blind'

export interface VerbMark {
  id: number
  verb: Verb
}

/** Which verb marks each living NPC wears at `tick`, in entity order. An NPC
 * can wear both (burning and choking); panic comes first. */
export const verbMarks = (entities: readonly Entity[], tick: number): VerbMark[] => {
  const out: VerbMark[] = []
  for (const e of entities) {
    if (e.dead || !e.ai || e.playerCtl) continue
    if (panicAt(e, tick)) out.push({ id: e.id, verb: 'panic' })
    if (sporeBlinded(e)) out.push({ id: e.id, verb: 'blind' })
  }
  return out
}
