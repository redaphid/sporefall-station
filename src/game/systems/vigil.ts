// §4.1 THE VIGIL — the boss you are trying not to fight.
//
// PLAYER VERB: FIRE ON A CADENCE. The Vigil is VULNERABLE ONLY WHILE DORMANT
// (physical 1.5) and near-immune awake (0.15), so the fight is a noise budget:
// do damage without filling it, and back off before the meter trips. Paced
// pistol fire is sustainable forever. Holding the trigger is not, and the
// grenade wakes it outright.
//
// Each wake is longer than the last, and the last one never ends.
//
// ── THE VERB IS THE CADENCE, NOT THE WEAPON ────────────────────────────────
// This boss originally asked you to swap to a silent weapon. IT SHIPPED
// UNWINNABLE, because a player cannot swap: `PLAYER_START_WEAPON` is a pistol,
// `interaction.ts` refuses to let ANY melee or ranged item enter a player's
// inventory ("a player carries exactly one permanent weapon"), `wearMelee`
// returns early for a player so the one weapon never breaks, a gun never runs
// dry, and `InputCmd` has no drop/holster field — so there is no sequence of
// inputs that leaves a player holding anything but that pistol. The old
// counterplay ("kill it with a knife") described a game state that cannot
// occur. The scenario and its tests only passed because they hand-assigned a
// knife into `player.loadout`, walking around the one-weapon door.
//
// So the question the meter answers changed from WHICH WEAPON ARE YOU HOLDING
// to HOW ARE YOU FIRING THE ONE YOU HAVE. Same fight, same fiction — a thing
// that sleeps until you are careless — expressed in a verb the player can
// actually perform.
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
// HOT BARRELS in earshot, which is what makes gunfire loud for this boss and
// nothing else. Nothing outside this file changes behaviour.
//
// ── How a SHOT is charged without a "fired this tick" flag ─────────────────
// The shipped version added a flat loudness for every LIVE PROJECTILE in
// earshot, every tick. That is what made the fight unwinnable: one pistol
// bullet lives `ceil(range/speed*30)` = 22 ticks, so a single shot billed 22
// times over and crossed the whole wake threshold on its own, before it had
// even reached the boss. Airborne-count is a bad unit — it charges by flight
// time, which is distance, not by the act of shooting.
//
// The honest unit is PER SHOT. The Vigil cannot see the act of firing (`w.events`
// is cleared each tick and would not survive a mid-tick snapshot, so this file
// may never read it), and stamping a "last fired" tick on the entity would put a
// new field on every gun-carrier in every snapshot — `serialize.test.ts` pins a
// committed golden taken after ten ticks of held fire, and it would churn.
//
// But `combat.cooldown` ALREADY IS the record of the shot. It is set to the
// weapon's cadence at the fire site and ticks down to zero; a gun with cooldown
// left is a gun that just went off. So the Vigil charges a shot's worth of noise
// SPREAD ACROSS THE COOLDOWN IT CAUSED: `VIGIL_SHOT_LOUDNESS / cooldownTicks`
// per tick that the barrel is hot. Integrate that over one cycle and you get
// exactly one shot's charge, whatever the weapon and whatever the cadence — and
// the gaps between shots are the only thing that ever varies. No new field, no
// event read, no snapshot surface: a pure read of state that already exists.
//
// DETERMINISM: every input is world STATE (the noise list, fire/spore cells,
// weapon cooldowns, the tick counter) — never `w.events`, which is cleared each
// tick and would not survive a mid-tick snapshot. No Date, no Math.random.

import { WEAPONS } from '../data/items'
import type { Entity } from '../entity'
import type { World } from '../world'
import { maybeRevealBoss } from './bossReveal'
import { gatherStimuli, stimulusPull } from './stimulus'
import { vlen } from '../simMath'

/** Tiles the Vigil hears within. Slightly wider than its sight (9): it is a
 * thing that listens, and you should be able to be *seen* more safely than
 * *heard*. */
export const VIGIL_HEARING = 9

/** How far a GUNSHOT carries, as opposed to the 9 tiles it hears a room within.
 *
 * Deliberately wider than the pistol's own 10-tile range, and that is a balance
 * decision rather than a flourish: if a player could stand at 10 tiles and shoot
 * a boss that only hears to 9, the counterplay would collapse back into a
 * POSITIONING puzzle — park at max range, hold the trigger, win. The fight is
 * supposed to be about cadence, so the one gun a player owns must never be able
 * to out-range its ears. Backing off buys you decay, never free shots. */
export const VIGIL_GUNSHOT_EARSHOT = 12

/** Loudness shed per tick when the room is quiet. The "back off and it settles"
 * half of the budget — without decay the meter would be a one-way ratchet and
 * retreating would buy nothing. This number IS the fight's difficulty dial: it
 * sets the break-even cadence below, in a straight ratio against the cost of a
 * shot. */
export const VIGIL_NOISE_DECAY = 0.3

/** What ONE SHOT costs the budget, billed across the cooldown it caused (see the
 * header): each tick a ranged weapon in earshot is still hot adds
 * `VIGIL_SHOT_LOUDNESS / cooldownTicks`.
 *
 * ── THE ARITHMETIC, for the pistol the player actually carries ──────────────
 * Pistol: damage 14, cooldownTicks 18. The fire site sets cooldown 18 and
 * `statusSystem` decrements it BEFORE this system runs, so the Vigil reads
 * 17,16,…,1 and then 0 on the tick the next shot becomes legal: 17 hot ticks per
 * 18-tick cycle. A shot therefore bills 17 × (12/18) = 11.33.
 *
 *   ONE SHOT, ALONE     bills 11.33 while the barrel cools and sheds 5.1 of
 *     decay across the same 17 ticks, so it PEAKS AT 6.2 of 45 and is back to
 *     zero 21 ticks later. A pot-shot is free, which is the property the shipped
 *     version inverted: it billed a bullet once per tick of flight, so a single
 *     shot rang up 5 × 22 = 110 and tripped a 45 threshold ~13 ticks in — while
 *     that same bullet needs ~21 ticks just to cross the pistol's range. The
 *     Vigil woke before the player's first shot could land, every time.
 *   BREAK-EVEN CADENCE  11.33 / 0.3 decay = ~38 ticks (1.27 s). Fire slower than
 *     that and the meter is back at zero before the next shot — sustainable
 *     forever, at any range, with no other tool. Roughly every second shot the
 *     pistol would let you take. (Measured: at 38 ticks the meter never leaves
 *     its 6.2 peak; at 30 it creeps to 39 over a kill; at 24 it trips.)
 *   HELD TRIGGER (18)   +11.33 per shot against 18 × 0.3 = 5.4 of decay = +5.93
 *     net. 45 / 5.93 = 7.6 shots — measured, it sits up 135 ticks in, on the 8th.
 *     Four and a half seconds of holding it down. That window is the lesson
 *     rather than a punishment: you get to watch the meter fill and stop.
 *   THE QUIET KILL      the NPCS row's 260 hp at `resist.physical` 1.5 is
 *     round(14 × 1.5) = 21 a shot → 13 shots; on floor 2, after `spawnNpc`'s
 *     +15%-per-floor ramp (299 hp), 15. At a safe 45-tick cadence that is ~650
 *     ticks, ~22 s, and the meter never passes 6.2 of 45 — one seventh of the
 *     budget, not even one bar of the five. SOLO, PISTOL-ONLY, NO OTHER TOOL.
 *     `vigil.test.ts` kills it that way through the real `tickWorld` rather than
 *     asking you to trust this paragraph.
 *
 * A weapon MOD that retunes rate of fire shifts these slightly (the divisor here
 * is the base cadence, not the resolved one — reaching `resolveWeapon` needs
 * `weaponStack`, whose module imports `world.ts` and would close an import cycle
 * back into this one). The fight is tuned on the vanilla pistol, which is what a
 * player starts and finishes the run with. */
export const VIGIL_SHOT_LOUDNESS = 12

/** Base meter capacity, tuned for a SOLO player (see `wakeThreshold`). A single
 * grenade's noise (intensity 4, TTL 90) crosses it in ~13 ticks at the boss's
 * feet and ~28 at the edge of hearing — comfortably inside that noise's life,
 * from anywhere it can be heard at all. The grenade is still the loud option. */
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
 * HOT BARRELS add, because each gun really is another gun going off — which is
 * the co-op property the design wants: one player who will not stop shooting
 * spends the whole party's budget.
 */
const loudness = (w: World, boss: Entity): number => {
  let loud = 0
  for (const s of gatherStimuli(w)) {
    if (vlen(s.x - boss.pos.x, s.y - boss.pos.y) > VIGIL_HEARING) continue
    loud = Math.max(loud, stimulusPull(s, boss.pos.x, boss.pos.y))
  }
  for (const e of w.entities) {
    // A ranged weapon with cooldown left on it is a weapon that just fired. The
    // charge is amortized over the cadence, so it totals one shot per shot at any
    // rate of fire — see the header. MELEE is exempt, and not as an oversight:
    // the Vigil's own `claws` carry a cooldown too, and a boss that heard itself
    // swing would wake itself up the moment it started fighting.
    if (e.dead || !e.combat || e.combat.cooldown <= 0) continue
    const weapon = WEAPONS[e.combat.weapon]
    if (weapon?.kind !== 'ranged') continue
    if (vlen(e.pos.x - boss.pos.x, e.pos.y - boss.pos.y) > VIGIL_GUNSHOT_EARSHOT) continue
    loud += VIGIL_SHOT_LOUDNESS / Math.max(1, weapon.cooldownTicks)
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
