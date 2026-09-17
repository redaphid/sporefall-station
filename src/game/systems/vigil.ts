// §4.1 THE VIGIL — the boss you are trying not to fight.
//
// PLAYER VERB: BE QUIET. Every loud tool that beats every other boss — the
// grenade, the breach, the machinegun, the fire — is what loses this one. The
// Vigil is VULNERABLE ONLY WHILE DORMANT (physical 1.5) and near-immune awake
// (0.15), so the fight is a noise budget: get in, do damage in silence, and back
// off before the meter trips. Killing it with a knife is slow and possible.
// Killing it with a grenade is impossible, because the grenade wakes it.
//
// Each wake is longer than the last, and the last one never ends.
//
// ── The contradiction this design had to resolve first ─────────────────────
// `systems/dormancy.ts` already implements a full wake vocabulary, and one of
// its triggers is `'damage'`: ANY hit within 20 ticks wakes a sleeper. A boss
// whose entire pitch is "hurt it while it sleeps" therefore wakes on the
// player's FIRST SHOT, every time, and the fight is unreachable.
//
// The resolution is that the Vigil opts OUT of that vocabulary completely — its
// NPCS row deliberately carries no `wakeOn`, so `wakeTrigger` returns undefined
// and `awakeningSystem` can never wake it. Waking is owned solely by this file,
// and it is driven by LOUDNESS, not by damage. Being hit is silent; being loud
// is what costs you. That inversion IS the boss.
//
// ── Why loudness is measured here instead of read from a noise event ───────
// The design doc asserts that `emitNoise` is already called by `fireWeapon`. IT
// IS NOT — in this engine `emitNoise` has exactly two callers, `combat.detonate`
// and a debug verb, so gunfire is SILENT to the noise system today. Making
// `fireWeapon` emit noise would have been a systemic change touching every
// dormant pod, every `investigate` goal and the whole hive stimulus field, to
// serve one boss.
//
// So the Vigil does its own hearing, locally: the shared stimulus field (which
// covers grenades, fire and spore, already graded and distance-attenuated) PLUS
// live projectiles in earshot, which is what makes gunfire loud for this boss
// and nothing else. Nothing outside this file changes behaviour.
//
// DETERMINISM: every input is world STATE (the noise list, fire/spore cells,
// projectile entities, the tick counter) — never `w.events`, which is cleared
// each tick and would not survive a mid-tick snapshot. No Date, no Math.random.

import type { Entity } from '../entity'
import type { World } from '../world'
import { maybeRevealBoss } from './bossReveal'
import { gatherStimuli, stimulusPull } from './stimulus'
import { vlen } from '../simMath'

/** Tiles the Vigil hears within. Slightly wider than its sight (9): it is a
 * thing that listens, and you should be able to be *seen* more safely than
 * *heard*. */
export const VIGIL_HEARING = 9

/** Loudness shed per tick when the room is quiet. The "back off and it settles"
 * half of the budget — without decay the meter would be a one-way ratchet and
 * retreating would buy nothing. */
export const VIGIL_NOISE_DECAY = 1.5

/** Loudness added per live projectile in earshot. Gunfire's whole cost is here:
 * one pot-shot is survivable, sustained fire is not. */
export const VIGIL_GUNSHOT_LOUDNESS = 5

/** Base meter capacity, tuned for a SOLO player (see `wakeThreshold`). A single
 * grenade's noise (intensity 4, TTL 90) crosses it in ~18 ticks; a knife never
 * does. */
export const VIGIL_WAKE_THRESHOLD = 45

/** Extra capacity per additional live player, as a fraction of the base.
 *
 * SOLO MUST STAY WINNABLE, and a fixed threshold breaks that from the other
 * direction than expected: a four-player party makes four players' worth of
 * incidental noise, so a meter sized for one would trip constantly and the
 * fight would be decided by party size rather than discipline. Scaling capacity
 * with the party keeps the SOLO number the tuned one while leaving co-op
 * genuinely quiet-able — and one loud player still spends everyone's budget,
 * which is the social mechanic the design is after. */
export const VIGIL_THRESHOLD_PER_EXTRA_PLAYER = 0.6

/** How long each successive wake lasts. Past the end of this table the Vigil
 * NEVER settles again — "the third does not end". */
export const VIGIL_WAKE_TICKS: readonly number[] = [150, 300]

/** `resist.physical` while dormant: a sleeping thing is soft. */
export const VIGIL_ASLEEP_RESIST = 1.5
/** `resist.physical` while awake: not a boss you beat, one you survive. */
export const VIGIL_AWAKE_RESIST = 0.15

/** Live, standing players — the party the meter is sized for. */
const livePlayers = (w: World): number => {
  let n = 0
  for (const e of w.entities) if (e.playerCtl && !e.dead && !e.playerCtl.downed) n++
  return n
}

/** The loudness the meter must reach to wake it, scaled by party size. Exported
 * so the HUD/tests read the same number the sim runs on rather than a copy. */
export const wakeThreshold = (w: World): number => {
  const players = Math.max(1, livePlayers(w))
  return VIGIL_WAKE_THRESHOLD * (1 + VIGIL_THRESHOLD_PER_EXTRA_PLAYER * (players - 1))
}

/** Is this Vigil past the end of its escalation table — awake for good? */
const permanentlyAwake = (e: Entity): boolean => (e.ai!.wakes ?? 0) > VIGIL_WAKE_TICKS.length

/** Is it awake right now? PRESENCE of `wakeUntil` is the state. */
export const vigilAwake = (e: Entity): boolean => e.ai?.wakeUntil !== undefined

/**
 * How loud the room is around this Vigil, this tick.
 *
 * Environmental stimuli take the MAX rather than a sum — a room full of fire is
 * one fire, and summing would make a spreading blaze grow super-linearly loud.
 * Projectiles ADD, because each bullet really is another shot being fired.
 */
const loudness = (w: World, boss: Entity): number => {
  let loud = 0
  for (const s of gatherStimuli(w)) {
    if (vlen(s.x - boss.pos.x, s.y - boss.pos.y) > VIGIL_HEARING) continue
    loud = Math.max(loud, stimulusPull(s, boss.pos.x, boss.pos.y))
  }
  for (const p of w.entities) {
    if (p.dead || !p.projectile) continue
    if (vlen(p.pos.x - boss.pos.x, p.pos.y - boss.pos.y) <= VIGIL_HEARING) loud += VIGIL_GUNSHOT_LOUDNESS
  }
  return loud
}

const wake = (w: World, boss: Entity): void => {
  const ai = boss.ai!
  const wakes = (ai.wakes ?? 0) + 1
  ai.wakes = wakes
  ai.dormant = false
  ai.mode = 'aggro'
  ai.thinkAt = w.tick // think (and act) as soon as the AI system next runs
  delete ai.noise // the budget resets; it is already awake
  // Past the table's end the duration is pinned to the longest, but
  // `permanentlyAwake` stops it ever settling — so the value is inert then.
  ai.wakeUntil = w.tick + (VIGIL_WAKE_TICKS[wakes - 1] ?? VIGIL_WAKE_TICKS[VIGIL_WAKE_TICKS.length - 1])
  boss.resist = { ...boss.resist, physical: VIGIL_AWAKE_RESIST }
  // Reuses the existing `woke` event rather than inventing one: it already
  // carries `by`, already reaches BLE clients as JSON pass-through, and already
  // has consumers. A new event type would be new wire surface for no gain.
  w.events.push({ type: 'woke', entityId: boss.id, by: 'noise' })
}

const settle = (w: World, boss: Entity): void => {
  const ai = boss.ai!
  delete ai.wakeUntil
  delete ai.noise
  delete ai.targetId
  ai.dormant = true
  ai.mode = 'idle'
  boss.resist = { ...boss.resist, physical: VIGIL_ASLEEP_RESIST }
  w.events.push({ type: 'aiGoal', entityId: boss.id, goal: 'dormant', prev: ai.goal ?? 'none' })
}

const accumulate = (w: World, boss: Entity): void => {
  const ai = boss.ai!
  const next = Math.max(0, (ai.noise ?? 0) + loudness(w, boss) - VIGIL_NOISE_DECAY)
  if (next >= wakeThreshold(w)) {
    wake(w, boss)
    return
  }
  // Rounded to keep the serialized number short, and DELETED at zero so a Vigil
  // nobody has been loud near carries no field at all (snapshot stability).
  if (next > 0) ai.noise = Math.round(next * 1000) / 1000
  else delete ai.noise
}

// ── Feedback: stealth without a visible meter is unfair ─────────────────────
// The annotation layer is explicitly INERT to the sim (no system reads it) and
// needs no new render code, which makes it the honest channel for this. The
// boss HUD's phase label is the other one, but it reads off hp, and for this
// boss hp is not the interesting number — the meter is.
const METER_WIDTH = 5
const ANNOTATION_PREFIX = 'vigil:'

const meterText = (w: World, boss: Entity): string => {
  if (vigilAwake(boss)) return 'AWAKE — BACK OFF'
  const frac = Math.min(1, (boss.ai!.noise ?? 0) / wakeThreshold(w))
  const filled = Math.min(METER_WIDTH, Math.floor(frac * METER_WIDTH))
  return `ASLEEP [${'|'.repeat(filled)}${'·'.repeat(METER_WIDTH - filled)}]`
}

/** Keep one label pinned to this Vigil, rewritten only when the text changes so
 * the annotation list is not churned every tick. */
const annotate = (w: World, boss: Entity): void => {
  const id = `${ANNOTATION_PREFIX}${boss.id}`
  const text = meterText(w, boss)
  const existing = w.annotations.find((a) => a.id === id)
  if (existing) {
    if (existing.text !== text) existing.text = text
    return
  }
  w.annotations.push({ id, kind: 'label', targetId: boss.id, text })
}

const clearMeter = (w: World, bossId: number): void => {
  const id = `${ANNOTATION_PREFIX}${bossId}`
  const i = w.annotations.findIndex((a) => a.id === id)
  if (i >= 0) w.annotations.splice(i, 1)
}

export const vigilSystem = (w: World): void => {
  for (const boss of w.entities) {
    if (boss.ai?.behavior !== 'vigil' || !boss.health) continue
    if (boss.dead) {
      clearMeter(w, boss.id) // the corpse takes its meter with it
      continue
    }
    // Nothing runs until the fight is WITNESSED — otherwise the Vigil spends its
    // escalating wake budget on noise nobody was in the room to make, which is
    // precisely how the Mireclaw once spent its whole brood before anyone
    // opened the door. See systems/bossReveal.ts.
    if (!maybeRevealBoss(w, boss)) continue

    if (vigilAwake(boss)) {
      if (!permanentlyAwake(boss) && w.tick >= boss.ai!.wakeUntil!) settle(w, boss)
    } else {
      accumulate(w, boss)
    }
    annotate(w, boss)
  }
}
