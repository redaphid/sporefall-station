// Relationships & disposition. Re-expressed from observed Streets of Rogue
// behavior (Relationships.cs DetermineRel / AddRelHate / the initial faction
// matrix), not ported. Every agent tracks a per-other-agent relationship: a
// numeric `hate` and the band it derives. Rules only ever change `hate`;
// `determineRel` re-derives the band, exactly as the game funnels every hate
// change back through DetermineRel.
//
// The threshold ladder (Relationships.cs DetermineRel ~L2953-3007):
//   hate <  0  -> Friendly
//   hate == 0  -> Neutral
//   0 < hate < 5 -> Annoyed
//   hate >= 5  -> Hostile   (the game's "Hateful" -> relStatus.Hostile)
//
// The initial faction matrix (SetupRelationshipOriginal): same faction backs
// its own (Friendly), cop vs gangster are sworn enemies (Hostile), everyone
// else starts Neutral. Committing a crime in view of a faction adds hate and
// re-derives — a witnessed crime flips neutrals hostile.

import type { Entity, Faction, RelStatus } from '../entity'
import { NPCS } from '../data/npcs'
import type { EntityId } from '../types'
import type { World } from '../world'
import { vlen } from '../simMath'

/** Hate a crime adds — the game's canonical AddRelHate(..., 5). */
export const CRIME_HATE = 5
/** How close an NPC must be to WITNESS a crime and react (tiles). */
export const LOS_RANGE = 10
const CRIME_TICKS = 15 * 30 // player stays "wanted" for 15s

/** Map a numeric hate to a disposition band — the DetermineRel thresholds. */
export const determineRel = (hate: number): RelStatus => {
  if (hate < 0) return 'Friendly'
  if (hate >= 5) return 'Hostile'
  if (hate > 0) return 'Annoyed'
  return 'Neutral'
}

/** Initial hate between two factions: same -> Friendly, cop/gang sworn enemies
 * -> Hostile, else Neutral. */
export const initialFactionHate = (a: Faction, b: Faction): number => {
  if (a === b) return -1
  if ((a === 'cop' && b === 'gang') || (a === 'gang' && b === 'cop')) return 5
  return 0
}

/** A faction's opening stance toward the (factionless) player: gangs are
 * hostile on sight, the law and civilians are neutral until provoked. */
export const initialPlayerHate = (f: Faction): number => (f === 'gang' ? 5 : 0)

/** This NPC's disposition toward `targetId` — its stored opinion, or the
 * faction-derived opening stance if it has none yet. */
export const dispositionToward = (e: Entity, targetId: EntityId): RelStatus => {
  const entry = e.ai?.rel?.[targetId]
  if (entry) return entry.code
  return determineRel(initialPlayerHate(e.ai?.faction ?? 'neutral'))
}

/** Add hate from `npc` toward `targetId` and re-derive the band. A dead agent
 * accrues nothing (Relationships.cs: a dead accruer is a no-op). */
export const addHate = (npc: Entity, targetId: EntityId, amount: number): void => {
  const ai = npc.ai
  if (!ai || npc.dead) return
  const rel = (ai.rel ??= {})
  const base = rel[targetId]?.hate ?? initialPlayerHate(ai.faction)
  const hate = base + amount
  rel[targetId] = { hate, code: determineRel(hate) }
}

/**
 * Turn the WHOLE floor hostile toward `target` — the deliberate, level-wide
 * escalation the boss-door breach triggers (missions.ts). Reuses the same
 * disposition + aggro machinery a witnessed crime drives, applied to every NPC
 * at once and unconditionally: max the alarm, push each NPC's hate past the
 * Hostile threshold, and lock them onto the target with a fresh memory so they
 * beeline in even from across the floor. Co-op allies (playerCtl) and corpses
 * are skipped — only faction/enemy NPCs flip. Idempotent per the caller's latch.
 */
export const raiseFloorAggro = (w: World, target: Entity): void => {
  w.alarm = 3
  for (const e of w.entities) {
    if (!e.ai || e.dead || e.playerCtl) continue
    addHate(e, target.id, CRIME_HATE) // base 0/5 + 5 → always >= 5 = Hostile
    e.ai.mode = 'aggro'
    e.ai.targetId = target.id
    e.ai.lastKnownTargetPos = { x: target.pos.x, y: target.pos.y }
    e.ai.thinkAt = w.tick // re-think this same tick
  }
}

/** A player attack on a civ/cop is a crime. Every NPC within sight that is an
 * ally of the victim (same faction) or the law (a cop) accrues hate toward the
 * attacker and, once hostile, turns to aggro them; witnessing civilians flee. */
export const commitCrime = (w: World, victim: Entity, attacker: Entity | undefined): void => {
  if (!attacker?.playerCtl || !victim.ai) return
  const vf = victim.ai.faction
  if (vf !== 'civ' && vf !== 'cop') return
  attacker.playerCtl.crimeUntilTick = w.tick + CRIME_TICKS

  for (const witness of w.entities) {
    if (!witness.ai || witness.dead || witness === victim) continue
    if (vlen(witness.pos.x - victim.pos.x, witness.pos.y - victim.pos.y) > LOS_RANGE) continue

    // Frightened civilians flee the attacker rather than fight.
    if (NPCS[witness.archetype]?.fleesOnDamage && witness.ai.faction === 'civ') {
      witness.ai.mode = 'flee'
      witness.ai.targetId = attacker.id
      witness.ai.thinkAt = w.tick
      continue
    }

    const ally = witness.ai.faction === vf
    const law = witness.ai.faction === 'cop'
    if (!ally && !law) continue

    addHate(witness, attacker.id, CRIME_HATE)
    if (law && w.alarm < 3) w.alarm++
    if (dispositionToward(witness, attacker.id) === 'Hostile') {
      witness.ai.mode = 'aggro'
      witness.ai.targetId = attacker.id
      witness.ai.lastKnownTargetPos = { x: attacker.pos.x, y: attacker.pos.y }
      witness.ai.thinkAt = w.tick
    }
  }
}
