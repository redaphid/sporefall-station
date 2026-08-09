// The generic status/element framework. Effects attach to an entity's `fx`
// component, tick, and expire on their own; reapplying one restarts its clock.
// Each entry stores an ABSOLUTE expiry tick (`until = world.tick + duration`),
// never a mutable countdown — so expiry is a pure function of world.tick and a
// mid-effect snapshot restores with nothing to fix up. Mirrors brain's `fx`.

import type { Entity, Fx } from '../entity'
import type { EntityId } from '../types'
import type { World } from '../world'

// ── Anti-chain-lock for immobilize statuses ────────────────────────────────
// `electrified` (stunGun, 45t on a 24t cooldown) and `frozen` (freeze ray/grenade,
// 120t) are CantDoAnything states. Left naive, `addStatus` REFRESHES the expiry on
// every hit — so a single attacker firing faster than the effect's duration (24 < 45)
// resets it forever: ZERO free ticks, an inescapable perma-lock. The fix, centralized
// here, gives every immobilize application three guarantees, all tick-based (no
// Date/Math.random — determinism preserved) and stored on `Entity.lockout` so it
// snapshots/replays byte-for-byte:
//
//  1. NO REFRESH while active. A hit landing during the current lock is IGNORED —
//     it can't extend the window — so the first lock always runs exactly its own
//     duration and no more.
//  2. POST-IMMOBILIZE IMMUNITY (`IMMOBILIZE_IMMUNE_TICKS`). When a lock ends, the
//     SAME immobilize can't re-start for a short window → a guaranteed block of free
//     ticks every cycle. Against a 24t-cooldown stunGun this alone turns a perma-lock
//     into a ~45-on / ~27-free sawtooth (was 0 free).
//  3. DIMINISHING RETURNS. Successive locks in one "hot" chain are halved by tier
//     (45 → 22 → 11 → 5 → 2 → 1 → 0), so sustained pressure converges: the victim's
//     immobilized time per cycle shrinks toward nothing while free time grows. A hit
//     after the chain cools (`IMMOBILIZE_CHAIN_TICKS` of no hits) starts fresh at full
//     duration — so a single, isolated stun still bites for its whole intended length.
//
// Scoped to immobilize kinds ONLY: DOTs (burning, poisoned, spore) and buffs (wet,
// hasted) keep the plain refresh-on-reapply behaviour. Legacy `stun`/`sleep` ride
// their own per-tick timers (applyStatus, below) and are untouched.

/** Statuses that fully immobilize (CantDoAnything) and get the anti-chain-lock. */
export const IMMOBILIZE_STATUSES: ReadonlySet<string> = new Set(['electrified', 'frozen'])

/** Ticks of guaranteed immunity after an immobilize ends, during which the SAME
 * immobilize cannot re-start. The counterplay floor: a 24t-cooldown attacker can't
 * re-lock instantly, so the victim always gets actionable free ticks. ~0.6s @30tps. */
export const IMMOBILIZE_IMMUNE_TICKS = 18

/** Ticks a lock chain stays "hot" after its active window ends. Hits within it are
 * diminished (halved per tier); after it the chain cools and re-locks at full. 3s. */
export const IMMOBILIZE_CHAIN_TICKS = 90

/** Diminished grant for the `tier`-th lock of a hot chain: full at tier 1, then
 * halved each tier (45 → 22 → 11 → …), flooring to 0 (a no-op lock) once tiny. */
const diminishedGrant = (baseTicks: number, tier: number): number =>
  tier <= 1 ? baseTicks : Math.floor(baseTicks / 2 ** (tier - 1))

/** Land an immobilize under the anti-chain-lock rules (see the block comment). */
const applyImmobilize = (w: World, e: Entity, kind: string, durationTicks: number, source?: EntityId, brittle?: boolean): void => {
  const fx = (e.fx ??= {})
  const lockout = (e.lockout ??= {})
  const track = lockout[kind]
  const hot = track !== undefined && w.tick < track.chainUntil
  const immobilizedNow = w.tick < (fx[kind]?.until ?? 0)
  const immuneNow = track !== undefined && w.tick < track.guardUntil
  if (immobilizedNow || immuneNow) {
    // Can't (re)immobilize right now: grant NO new lock time, but keep the chain
    // hot so the diminishing tier carries to the next legal application.
    if (track) track.chainUntil = w.tick + IMMOBILIZE_CHAIN_TICKS
    return
  }
  // Free to start a fresh lock — diminished if the chain is still hot.
  const tier = hot ? track.tier + 1 : 1
  const grant = diminishedGrant(durationTicks, tier)
  const endTick = w.tick + Math.max(grant, 0)
  if (grant > 0) fx[kind] = brittle ? { until: endTick, source, brittle } : { until: endTick, source }
  else delete fx[kind] // a fully-diminished lock is a no-op; leave nothing immobilizing
  lockout[kind] = { tier, guardUntil: endTick + IMMOBILIZE_IMMUNE_TICKS, chainUntil: endTick + IMMOBILIZE_CHAIN_TICKS }
}

/** Attach `kind` to `e`, expiring `durationTicks` from now. Non-immobilize effects
 * refresh an existing entry; immobilize kinds route through the anti-chain-lock rules
 * (`applyImmobilize`). Dead entities gain nothing; non-positive durations no-op. */
export const addStatus = (
  w: World,
  e: Entity,
  kind: string,
  durationTicks: number,
  source?: EntityId,
  /** Only meaningful for `frozen` — see StatusEntry.brittle. Defaults to false, so
   * any NEW freeze source is control until it deliberately opts into the execute. */
  brittle?: boolean,
): void => {
  if (e.dead) return
  if (!(durationTicks > 0)) return
  if (IMMOBILIZE_STATUSES.has(kind)) return applyImmobilize(w, e, kind, durationTicks, source, brittle)
  const fx: Fx = (e.fx ??= {})
  fx[kind] = brittle ? { until: w.tick + durationTicks, source, brittle } : { until: w.tick + durationTicks, source }
}

export const removeStatus = (e: Entity, kind: string): void => {
  if (e.fx) delete e.fx[kind]
}

export const hasStatus = (e: Entity, kind: string): boolean => e.fx !== undefined && e.fx[kind] !== undefined

/** Apply one status to one entity — the single place item/element effects land.
 * `sleep` and `slip`/`stun` route to the proven legacy per-tick timers (which
 * already immobilize and wake-on-damage); everything else is an fx effect. */
export const applyStatus = (w: World, e: Entity, status: string, ticks: number, brittle?: boolean): void => {
  if (status === 'sleep') {
    if (e.status) e.status.sleep = ticks
    return
  }
  if (status === 'slip' || status === 'stun') {
    if (e.status) e.status.stun = ticks
    return
  }
  addStatus(w, e, status, ticks, undefined, brittle)
}

export const isFrozen = (e: Entity): boolean => hasStatus(e, 'frozen')

/** Frozen SOLID by a thrown freeze grenade, so a blow shatters the body outright.
 * A Cryo Rounds freeze is deliberately NOT brittle — the execute belongs to the
 * limited consumable, not to a permanent, free, every-other-shot weapon effect. */
export const isBrittleFrozen = (e: Entity): boolean => e.fx?.frozen?.brittle === true

export const isWet = (e: Entity): boolean => hasStatus(e, 'wet')

/** Frozen or electrified: the game's `CantDoAnything` states — a body that can
 * neither move nor act until the status runs out. Movement, combat and AI all
 * gate on this. */
export const isImmobilized = (e: Entity): boolean => hasStatus(e, 'frozen') || hasStatus(e, 'electrified')

/** Expire every effect whose tick has arrived. Pure function of world.tick, so
 * it behaves identically whether the world ran unbroken or was restored. */
export const statusFxSystem = (w: World): void => {
  for (const e of w.entities) {
    if (e.fx) {
      for (const kind of Object.keys(e.fx)) {
        if (e.fx[kind].until <= w.tick) delete e.fx[kind]
      }
    }
    // Prune anti-chain-lock trackers once their chain has fully cooled — the next
    // immobilize then starts a fresh chain (tier 1, full duration).
    if (e.lockout) {
      for (const kind of Object.keys(e.lockout)) {
        if (e.lockout[kind].chainUntil <= w.tick) delete e.lockout[kind]
      }
    }
  }
}
