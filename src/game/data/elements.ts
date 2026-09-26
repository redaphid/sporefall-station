// Data-driven element table. `dot` is hp lost per tick while the effect is
// active, applied generically by elementSystem. The damage is the least of it:
// each element has a VERB (#87), and the verb lives where its trigger is.
//   frozen      holds — immobilized, shatters on impact     (statusFx, combat)
//   burning     panics — runs from its lighter, lights what it brushes
//                                                           (statusFx, behaviors.decide, fire)
//   electrified jumps — stuns, leaps to the nearest NPC, floods the wet
//                                                           (interactions.shock)
//   spore       blinds — sees only arm's reach, loses you   (goals.perceives)
//   wet         douses fire and conducts shock              (statusFx, interactions)
//   poisoned    no verb and no source in play: a cut candidate.
// Control verbs (holds, jumps' stun, panics) share one lockout guard in statusFx,
// so no pair of elements keeps a body out of the fight longer than one can alone.

export interface ElementDef {
  id: string
  /** hp lost per damage tick while active (0 = no damage-over-time). */
  dot: number
  /** ticks between damage ticks — burning gnaws on a timer, not every frame. */
  interval: number
  /** default lifetime in ticks when the effect is applied. */
  durationTicks: number
}

export const ELEMENTS: Record<string, ElementDef> = {
  burning: { id: 'burning', dot: 2, interval: 9, durationTicks: 600 },
  frozen: { id: 'frozen', dot: 0, interval: 30, durationTicks: 90 },
  wet: { id: 'wet', dot: 0, interval: 30, durationTicks: 150 },
  electrified: { id: 'electrified', dot: 0, interval: 30, durationTicks: 30 },
  poisoned: { id: 'poisoned', dot: 1, interval: 15, durationTicks: 120 },
  // Bog spores: a choking damage-over-time laid by a spore hazard cell (a
  // ruptured spore-sac or a Spore Node's bloom). Softer than fire but stickier —
  // a longer tail, so a spore-flooded room keeps gnawing after you leave it.
  spore: { id: 'spore', dot: 1, interval: 12, durationTicks: 150 },
}
