import type { Entity } from '../entity'
import type { World } from '../world'

// Passive "rest" regeneration. Hold a player COMPLETELY still (no movement intent
// and no residual knockback velocity) AND keep them unharmed for a sustained
// window, and they slowly heal back up to full. The instant they move OR take a
// hit, the streak breaks and the whole wait restarts. Per-player: each player's
// stillness/damage clock is its own, so co-op partners regen independently.
//
// Determinism: purely a function of world tick + per-entity fields (intent, vel,
// health.lastHurtTick, playerCtl.regenCalm). No RNG, no wall-clock — same seed +
// inputs → identical heals on every replay.

/** A body counts as "still" when BOTH its movement intent and its knockback
 * velocity are below this magnitude. Movement zeroes intent exactly when there is
 * no stick input, and clamps residual knockback velocity to 0 once it drops under
 * 0.01, so at true rest both are exactly 0 — this epsilon just tolerates float
 * dust. A dodge-roll (intent = roll heading) or any knockback keeps a body moving. */
export const REGEN_STILL_EPS = 1e-3

/** Consecutive ticks of BOTH stillness AND no damage required before regen begins
 * — 75 ticks = 2.5s at 30 tps. Tune UP for a longer "earn it" pause, DOWN for a
 * more forgiving rest. */
export const REGEN_CALM_TICKS = 75

/** Once regenerating, heal every this-many ticks — 6 ticks = 5 heals/sec. */
export const REGEN_INTERVAL_TICKS = 6

/** HP restored per heal interval. With the defaults above this is ~10 hp/s, so a
 * 120-hp player recovers from near-death to full in ~12s of unbroken rest. Tune
 * this (or the interval) for how fast resting pays off. */
export const REGEN_HP_PER_INTERVAL = 2

/** Completely still: no movement intent this tick and (near-)zero velocity. */
const isStill = (e: Entity): boolean =>
  Math.hypot(e.intent.x, e.intent.y) < REGEN_STILL_EPS &&
  Math.hypot(e.vel.x, e.vel.y) < REGEN_STILL_EPS

/**
 * Passive regen tick. Runs AFTER every damage source (combat/projectiles/fire/
 * spore/status/shock) so `health.lastHurtTick === w.tick` reliably means "hurt
 * this tick", and after movement so intent/velocity reflect the final rest state.
 */
export const regenSystem = (w: World): void => {
  for (const e of w.entities) {
    if (!e.playerCtl || !e.health || e.dead) continue

    // A downed body is bleeding out under the revive economy, not resting; a hit
    // this tick or any motion breaks the streak. Any of these → reset the clock.
    const hurtThisTick = e.health.lastHurtTick === w.tick
    if (e.playerCtl.downed || hurtThisTick || !isStill(e)) {
      // Absent (not 0) when broken → an active player serializes byte-for-byte as
      // before this feature; JSON drops the undefined key.
      if (e.playerCtl.regenCalm !== undefined) e.playerCtl.regenCalm = undefined
      continue
    }

    const calm = (e.playerCtl.regenCalm ?? 0) + 1
    e.playerCtl.regenCalm = calm
    if (calm < REGEN_CALM_TICKS) continue // still earning the rest
    if (e.health.hp >= e.health.max) continue // full — a no-op (keep the clock ticking)
    // First heal lands exactly at REGEN_CALM_TICKS, then every REGEN_INTERVAL_TICKS.
    if ((calm - REGEN_CALM_TICKS) % REGEN_INTERVAL_TICKS !== 0) continue
    e.health.hp = Math.min(e.health.max, e.health.hp + REGEN_HP_PER_INTERVAL)
  }
}
