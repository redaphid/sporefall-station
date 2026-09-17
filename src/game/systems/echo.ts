// §4.2 ECHO — the boss that learns.
//
// PLAYER VERB: NEVER HIT IT THE SAME WAY TWICE. Echo's `resist` map is MUTABLE
// AT RUNTIME. Every point of damage it takes of a given kind raises its
// resistance to that kind; kinds it has not been hit with decay back toward
// their baseline. Hold one trigger and your damage falls off a cliff. Rotate —
// bullets, then fire — and it never gets the chance to settle.
//
// In co-op that makes an ELEMENT ROLE SPLIT: two players on the same damage kind
// share one resistance track and are, together, worse than one. Two on different
// kinds each get their own track and the tracks decay in parallel.
//
// ── Why this needs no new component ────────────────────────────────────────
// `resistMult(e, kind)` is `e.resist?.[kind] ?? 1` (entity.ts) — an ENTITY
// field, not an archetype one. `spawnNpc` already copies `NpcDef.resist` onto
// the entity with a spread, so every Echo owns its own table and adaptation is
// literally `boss.resist.burning -= step`. It serializes with the entity for
// free, so a mid-fight snapshot carries the learned resistances with no new
// schema.
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️  THE ONE RULE THIS FILE EXISTS TO ENFORCE: NEVER TOUCH AN IMMOBILIZE KEY.
// ════════════════════════════════════════════════════════════════════════════
// `combat.applyDamage` EXECUTES any frozen NPC outright via `shatter()`,
// regardless of hp, and `freezeRay` applies `frozen` for 120 ticks while dealing
// 0 damage. The only thing standing between that and a one-button boss delete is
// `resist.frozen === 0`, which `statusFx.applyImmobilize` now honours as genuine
// IMMUNITY (the freeze never lands, so the execute has no frozen body to find).
//
// An adaptive resist map is therefore one careless line away from re-opening the
// exploit the foundation branch just closed: if Echo ever moved `frozen` off 0 —
// in EITHER direction, by raising it OR by decaying it back toward a baseline —
// it becomes freezable and a single tap deletes 300hp.
//
// Four independent guards, because one is not enough for a hole this sharp:
//
//   1. ECHO_ADAPT_KINDS is an ALLOW-LIST, not a deny-list. A new element added
//      to `data/elements.ts` cannot silently become adaptable by existing.
//   2. `echoAdaptable` additionally refuses anything in `IMMOBILIZE_STATUSES`,
//      IMPORTED FROM statusFx rather than re-spelled here. That set is the
//      engine's own definition of "a status with a lockdown rule", so if a third
//      immobilize kind is ever added, Echo refuses it automatically, on the day
//      it lands, with no edit to this file.
//   3. `setResist` is the ONLY writer of `boss.resist` in this module, and both
//      the raise path and the decay path route through it — so a guard cannot be
//      bypassed by adding a new call site that forgets to check.
//   4. `resist.frozen: 0` on the NPCS row is never read as a "baseline to decay
//      toward", because `frozen` is not in ECHO_BASE_RESIST's adaptable set.
//
// `systems/echo.test.ts` asserts all four structurally AND drives the real
// freeze-ray-plus-impact sequence through `tickWorld` after Echo has eaten every
// damage kind it can adapt to.
//
// ── What the design doc got wrong about the rotation (see CORRECTIONS C5) ───
// §4.2 promises "six elements to rotate through". Checked against source:
//   - `frozen`, `wet` and `electrified` all have `dot: 0` in `data/elements.ts`.
//     They deal NO DAMAGE, so they can never be an adaptation axis — there is
//     nothing for Echo to learn from a status that removes no hp.
//   - `poisoned` has NO DELIVERER LEFT. Grep the engine: the id appears only in
//     the ELEMENTS table itself. `gasGrenade` and `chloroform`, the two items
//     that applied it, are RETIRED tombstones in the wire registry.
//   - `spore` is live but ENVIRONMENTAL — spore cells (`systems/spore.ts`) and
//     infection contact. No weapon delivers it.
// So the live player-facing rotation is PHYSICAL ↔ BURNING (flamethrower, the
// `incendiary` mod, or any fire you light), with `spore` as a situational third
// in a flooded room. `poisoned` is carried in the allow-list anyway because the
// mechanism is per-kind and costs nothing: the day a poison weapon ships, Echo
// adapts to it with no change here.
//
// DETERMINISM: every input is world STATE (entity hp, the damage ledger, the
// tick counter). No RNG is consumed — not one value, from any stream — and there
// is no wall-clock. Two worlds restored from one snapshot tick identically.

import { resistMult, type Entity } from '../entity'
import type { World } from '../world'
import { maybeRevealBoss } from './bossReveal'
import { IMMOBILIZE_STATUSES } from './statusFx'

/** The `ai.behavior` id that marks an entity as an Echo. Behaviour, not
 * archetype, for the same reason every other boss system does it: the brain is a
 * component, so a scenario or debug verb can make anything an Echo. */
export const ECHO_BEHAVIOR = 'echo'

/**
 * The damage kinds Echo may adapt to, and their BASELINE incoming multipliers.
 *
 * This table is duplicated as a literal on the `NPCS.echo` row (plus the
 * `frozen: 0` immunity, which is deliberately NOT here — see the header).
 * `echo.test.ts` pins the two against each other, which is the same
 * co-location-plus-assertion idiom `bosses.test.ts` uses for Mireclaw's phase
 * fractions: the sim and the data row must not be able to drift apart by hand.
 *
 * An ALLOW-LIST. Membership here is the first of the four guards that keep
 * `frozen`/`electrified` out of the adaptation entirely.
 */
export const ECHO_BASE_RESIST: Readonly<Record<string, number>> = {
  physical: 1,
  burning: 1,
  poisoned: 1,
  spore: 1,
}

/** The kinds Echo adapts to, in a FIXED order — part of determinism, never
 * reorder (it fixes the order the per-kind meter prints in, and the order the
 * ledger is folded). */
export const ECHO_ADAPT_KINDS: readonly string[] = ['physical', 'burning', 'poisoned', 'spore']

/**
 * The hard floor on any incoming multiplier: Echo is NEVER fully immune.
 *
 * The design doc suggests ~0.2. It is 0.25, and the extra 0.05 is load-bearing
 * rather than taste. Both damage sites round: `Math.round(amount * mult)`. At
 * 0.2 a 2-damage blow lands `round(0.4) = 0` — genuine immunity to an entire
 * class of weapon, which is precisely the property this constant exists to
 * forbid. At 0.25 the same blow lands `round(0.5) = 1`. 0.25 is the largest
 * floor the doc's intent tolerates and the smallest one at which every weapon
 * down to 2 damage still removes hp, so a fully-adapted Echo can always be
 * ground down by anything the party is holding.
 *
 * Never below a kind's own baseline either (`floorFor`): a baseline of 0 means
 * immunity, and adaptation must never RAISE a multiplier off 0.
 */
export const ECHO_MIN_MULT = 0.25

/**
 * How fast it learns, as multiplier lost per unit of (damage / max hp).
 *
 * Normalised by max hp on purpose: `populate.spawnNpc` ramps every archetype
 * +15% hp per floor, so a rate expressed in raw damage would make Echo learn
 * proportionally slower on every deeper floor and the fight would quietly
 * un-design itself. As a FRACTION of its own health bar, the cliff lands in the
 * same place on floor 2 and floor 9.
 *
 * 2.5 means "about 30% of its health bar, dealt with one kind, drives that kind
 * to the floor". With the starting pistol (14 damage on an 18-tick cooldown)
 * against the decay below, sustained single-kind fire settles at roughly ×0.39 —
 * a cliff you can feel within a magazine, not one that hits in three shots.
 */
export const ECHO_ADAPT_RATE = 2.5

/**
 * Multiplier recovered per tick, per kind, while that kind goes unused.
 *
 * 0.0025 is a full baseline→floor recovery in ~300 ticks (10s). This is the
 * number that makes ROTATION the answer rather than merely a nice idea, and the
 * ratio against `ECHO_ADAPT_RATE` is the whole balance of the fight:
 *
 *   - hammering ONE kind: it is re-hit faster than it recovers, so it converges
 *     near the floor and your dps collapses to roughly a quarter;
 *   - ALTERNATING two kinds: each track gets double the idle time, so both sit
 *     high and total dps is about twice the single-kind equilibrium.
 *
 * Without decay the resist map would be a one-way ratchet: every fight would end
 * at the floor no matter how the party played, rotation would buy nothing, and a
 * long fight could be stalled into an unwinnable wall. Decay is what makes the
 * boss teachable instead of merely punishing.
 */
export const ECHO_DECAY = 0.0025

/** The floor for one kind: never below the kind's own baseline, so a baseline of
 * 0 (immunity) is a fixed point that adaptation can never move off. */
const floorFor = (kind: string): number => Math.min(ECHO_BASE_RESIST[kind] ?? 1, ECHO_MIN_MULT)

/**
 * May Echo write this resist key at all? Guards 1 and 2 from the header, in one
 * predicate, used by BOTH the raise and the decay path.
 *
 * The `IMMOBILIZE_STATUSES` half is redundant TODAY — no immobilize kind is in
 * the allow-list — and that is exactly why it stays. It is the guard that still
 * holds after someone edits the allow-list in six months without reading this
 * file, and it derives from the engine's own definition rather than a copy.
 */
export const echoAdaptable = (kind: string): boolean =>
  kind in ECHO_BASE_RESIST && !IMMOBILIZE_STATUSES.has(kind)

/** Multipliers are rounded to 4dp before storage. Float drift is deterministic,
 * so this is not a correctness fix — it keeps the serialized entity short and
 * keeps a snapshot diff readable instead of a wall of 0.6000000000000001. */
const round4 = (n: number): number => Math.round(n * 10000) / 10000

/**
 * THE ONLY WRITER of `boss.resist` in this module (guard 3).
 *
 * Every mutation — learn and forget alike — funnels through here, so the
 * immobilize refusal cannot be bypassed by a future call site that forgets to
 * check. Clamped into `[floorFor(kind), baseline]` on the way in, so no caller
 * can push a multiplier out of range even by getting its own arithmetic wrong.
 */
const setResist = (boss: Entity, kind: string, value: number): void => {
  if (!echoAdaptable(kind)) return // frozen/electrified can NEVER be written. See the header.
  const base = ECHO_BASE_RESIST[kind]
  const clamped = Math.min(base, Math.max(floorFor(kind), value))
  ;(boss.resist ??= {})[kind] = round4(clamped)
}

/**
 * Record damage ACTUALLY DEALT to a possible Echo, for this tick's adaptation.
 *
 * Called from the three (and only three) sites that remove hp through a resist
 * multiplier: the physical multiply in `combat.applyDamage`, the `dealt`
 * computation on the frozen/shatter path there, and the DOT tick in
 * `fire.elementSystem`. Each calls it immediately AFTER subtracting hp, so what
 * is recorded is the damage that landed — post-resist, post-rounding — not what
 * the attacker intended. That matters: adaptation driven by intended damage
 * would keep accelerating as the boss got tougher, and the equilibrium the decay
 * rate is tuned against would not exist.
 *
 * Takes no `World`: it is a pure accumulation onto the victim. That keeps
 * `combat.ts` and `fire.ts` importing a leaf-ish module and is what makes the
 * tap free of any import cycle back through the systems that call it.
 *
 * Deliberately does NOT adapt on the spot. The ledger is folded once per tick by
 * `echoSystem`, which is where the `maybeRevealBoss` gate lives — so damage dealt
 * to an Echo nobody has laid eyes on yet is DISCARDED rather than learned from.
 */
export const echoRecordDamage = (e: Entity, kind: string, amount: number): void => {
  if (!(amount > 0)) return // 0-damage utility hits teach it nothing; negatives are not healing
  if (e.ai?.behavior !== ECHO_BEHAVIOR) return
  if (!echoAdaptable(kind)) return
  const ledger = (e.ai.echoHits ??= {})
  ledger[kind] = (ledger[kind] ?? 0) + amount
}

// ── Legibility: "why is my gun suddenly bad" ────────────────────────────────
// A boss that silently quarters your damage is indistinguishable from a bug.
// The boss HUD's phase label is per-boss data now and says the VERB ("ROTATE
// YOUR DAMAGE"), but it reads off hp and cannot show WHICH kind has gone stale.
// The annotation layer can: it is explicitly inert to the sim (no system reads
// it), rides along in world state so it replays and reaches BLE clients, and
// needs no new render code. So the live per-kind read-out lives there, pinned to
// Echo's body, exactly as the Vigil's noise meter does.

const METER_WIDTH = 3
const ANNOTATION_PREFIX = 'echo:'

/**
 * Hard budget for the meter's text, in characters.
 *
 * Sim-authored annotations are STREAMED TO BLE CLIENTS, and the wire caps
 * annotation text (`MAX_WIRE_ANNOTATION_TEXT`): text over the cap is dropped on
 * the joiner's phone SILENTLY, so a co-op player would simply never see the one
 * read-out that explains why their gun stopped working.
 *
 * Duplicated as a local number rather than imported, deliberately: `src/game/`
 * must not import `src/net/` (eslint-enforced), and the sim cannot take a
 * dependency on the wire's constants without breaking that boundary. The
 * invariant is pinned by `echo.test.ts` instead, which asserts the text fits in
 * every reachable adaptation state rather than trusting arithmetic done by hand.
 *
 * Budget check, worst case (all four kinds fully learned):
 *   'ADAPTED GUN[|||] FIRE[|||] TOX[|||] SPR[|||]' = 44 chars.
 */
export const ECHO_METER_MAX_TEXT = 48

/** Short, all-caps tags for the meter — kept to 3–4 characters because four of
 * them plus their bars have to fit the wire budget above with room to spare.
 * Exported so the wire-cap test builds the worst-case label from the SAME tags
 * the sim prints, rather than from a copy that could drift under it. */
export const ECHO_KIND_TAG: Record<string, string> = {
  physical: 'GUN',
  burning: 'FIRE',
  poisoned: 'TOX',
  spore: 'SPR',
}

/** How far this kind has been learned, 0 (baseline) .. 1 (floored). */
const adaptedFrac = (boss: Entity, kind: string): number => {
  const base = ECHO_BASE_RESIST[kind]
  const span = base - floorFor(kind)
  if (span <= 0) return 0 // an immune kind has nothing to learn — never print a full bar
  return Math.min(1, Math.max(0, (base - resistMult(boss, kind)) / span))
}

const meterText = (boss: Entity): string => {
  const bars: string[] = []
  for (const kind of ECHO_ADAPT_KINDS) {
    const frac = adaptedFrac(boss, kind)
    if (frac <= 0) continue // an untouched kind is not news; showing four empty bars is noise
    const filled = Math.min(METER_WIDTH, Math.floor(frac * METER_WIDTH))
    bars.push(`${ECHO_KIND_TAG[kind] ?? kind}[${'|'.repeat(filled)}${'·'.repeat(METER_WIDTH - filled)}]`)
  }
  // Before the first hit there is nothing to report but the rule itself — which
  // is the most useful thing it can say at that moment.
  const text = bars.length ? `ADAPTED ${bars.join(' ')}` : 'ADAPTS TO REPEATED DAMAGE'
  // Clamped by CONSTRUCTION, not by arithmetic: the tags above are sized to fit
  // with room to spare, but a fifth adaptable kind added later must degrade to a
  // truncated label rather than to a mark the BLE client silently discards.
  return text.length <= ECHO_METER_MAX_TEXT ? text : text.slice(0, ECHO_METER_MAX_TEXT)
}

/** Keep one label pinned to this Echo, rewritten only when the text actually
 * changes — the bars are quantised to 4 steps, so the annotation list is not
 * churned on every tick of decay. */
const annotate = (w: World, boss: Entity): void => {
  const id = `${ANNOTATION_PREFIX}${boss.id}`
  const text = meterText(boss)
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

/**
 * Fold this tick's damage ledger into the resist map: LEARN the kinds that hurt
 * it, FORGET the ones that did not.
 *
 * Runs in `tickWorld` after every system that can remove hp this tick (combat,
 * projectiles, fire/spore placement and the element DOT), so the ledger it reads
 * is the tick's final accounting rather than a mid-update snapshot.
 *
 * Exactly one of learn-or-forget happens per kind per tick, which is what makes
 * "hold the trigger" and "back off" opposite forces rather than a race: a kind
 * that landed damage this tick cannot also decay on the same tick.
 */
export const echoSystem = (w: World): void => {
  for (const boss of w.entities) {
    if (boss.ai?.behavior !== ECHO_BEHAVIOR || !boss.health) continue
    if (boss.dead) {
      clearMeter(w, boss.id) // the corpse takes its read-out with it
      continue
    }
    // Nothing runs until the fight is WITNESSED. A boss that acts before it is
    // seen spends its whole kit on an empty room — the Mireclaw burned its
    // entire brood cap that way before anyone opened the door. For Echo the
    // failure is quieter and worse: a stray fire or a spore cell drifting
    // through the boss room would teach it, unopposed, for the whole approach,
    // and the party would walk in to a boss that had already learned the floor.
    // Damage dealt before the entrance is DISCARDED, not banked.
    if (!maybeRevealBoss(w, boss)) {
      if (boss.ai.echoHits) delete boss.ai.echoHits
      continue
    }
    const maxHp = boss.health.max
    const ledger = boss.ai.echoHits
    for (const kind of ECHO_ADAPT_KINDS) {
      const dealt = ledger?.[kind] ?? 0
      if (dealt > 0 && maxHp > 0) {
        // LEARN: lose multiplier in proportion to the share of its own health
        // bar this kind just took.
        setResist(boss, kind, resistMult(boss, kind) - ECHO_ADAPT_RATE * (dealt / maxHp))
      } else {
        // FORGET: creep back toward baseline. `setResist` clamps at the
        // baseline, so an untouched kind sits exactly at it rather than drifting
        // above and making Echo progressively more fragile over a long fight.
        setResist(boss, kind, resistMult(boss, kind) + ECHO_DECAY)
      }
    }
    // Deleted rather than emptied, every tick: an Echo that took no damage this
    // tick carries no ledger field at all, so a snapshot of a calm moment is
    // byte-identical to one taken before the feature existed.
    if (ledger) delete boss.ai.echoHits
    annotate(w, boss)
  }
}
