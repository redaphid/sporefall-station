import type { Entity } from '../entity'
import type { InputCmd } from '../types'
import type { World } from '../world'
import { hasStatus, isImmobilized, removeStatus } from './statusFx'

// Dodge-roll tuning (Enter-the-Gungeon flavour). Ticks are absolute-tick windows,
// so the whole mechanic is a pure function of world tick + input — no timers.
/** How long the roll lasts: the i-frame + speed-burst window (30 ticks = 1s). */
export const ROLL_TICKS = 12
/** Ticks AFTER the roll ends before another can start — the anti-chain gate. */
export const ROLL_COOLDOWN = 24
/** Burst speed while rolling (tiles/sec) — well above the ~4.5 walk speed so a
 * roll clearly repositions, still through the normal collision path (no clipping). */
export const ROLL_SPEED = 12
/** Stop, drop, and roll: each roll START smothers this many ticks off a burning
 * status. Tuned against the TYPICAL player ignition — the 240-tick weapon/item
 * burn (data/items `molotov`, data/mods `incendiary`): a fresh one dies in
 * exactly TWO rolls (roll 1 → 90 left, roll 2 lands after the 36-tick roll
 * cycle → out), and any burn in its last 5s dies in ONE. A FLAT chunk, not a
 * multiplier, so it's legible ("each roll smothers 5 seconds of fire") and
 * roll-spam can't cheese past zero — the douse clamps at extinguished and the
 * cooldown gates re-rolling anyway. */
export const DOUSE_TICKS = 150
/** Shake-off: pressing dodge while ELECTRIFIED can't start a roll (you're
 * immobilised), but each press chips this many ticks off the shock — a struggle
 * to break free. Edge-triggered (InputCmd.roll is one press each), a FLAT chunk
 * so it's legible ("mash to recover") and clamps at cleared; against the 30-tick
 * environmental zap and the 45-tick Tesla hit that's a few mashes to break out,
 * so it shortens the stun without trivially cancelling it. */
export const SHOCK_SHAKE_TICKS = 8

/** True while `e` is inside its active roll window at `tick` — the single source
 * of truth for i-frames (combat), the movement burst, and the render tumble. */
export const isRolling = (e: Entity, tick: number): boolean =>
  e.playerCtl?.roll !== undefined && tick < e.playerCtl.roll.untilTick

/**
 * Start/expire dodge-rolls. Runs BEFORE movement so a roll begun this tick already
 * bursts this tick, and BEFORE combat so a rolling player can't also attack.
 *
 * A roll starts only when the player presses roll AND is upright (not downed,
 * stunned, asleep, frozen/immobilised) AND is fully off cooldown (no chaining).
 * Direction is the current MOVE vector, or the facing when stationary. The roll
 * object is dropped once cooldown elapses so a resting player carries no state.
 */
export const rollSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  for (const e of w.entities) {
    const pc = e.playerCtl
    if (!pc) continue
    // Clear a spent roll (past its cooldown) so absence == "ready", keeping
    // snapshots clean and the ready-check a simple presence test.
    if (pc.roll && w.tick >= pc.roll.cooldownUntilTick) pc.roll = undefined
    if (e.dead || pc.downed) continue
    const cmd = inputs.get(pc.playerId)

    // Mash-out: a dodge press while ELECTRIFIED can't start a roll, but it shakes
    // off a bit of the shock (SHOCK_SHAKE_TICKS) — a struggle to break free. We
    // shorten the effect's ABSOLUTE expiry (snapshot-safe); once the remaining
    // shock is within one chunk the press clears it outright, so it can't
    // underflow past zero. Placed before BOTH the roll-in-progress gate and the
    // immobilise gate below — either would otherwise swallow the press and leave
    // an electrified player with no way to struggle free. One reduction per
    // press: InputCmd.roll is edge-triggered by every input source, so mashing
    // (not holding) is what drives it, mirroring how a roll itself is triggered.
    if (cmd?.roll && hasStatus(e, 'electrified')) {
      const shock = e.fx!.electrified
      if (shock.until - w.tick <= SHOCK_SHAKE_TICKS) removeStatus(e, 'electrified')
      else shock.until -= SHOCK_SHAKE_TICKS
      continue
    }

    // Already rolling, or still cooling down → ignore further roll presses.
    if (pc.roll) continue

    const stunned = e.status !== undefined && (e.status.stun > 0 || e.status.sleep > 0)
    if (stunned || isImmobilized(e)) continue
    if (!cmd || !cmd.roll) continue

    // Roll in the move direction; fall back to facing when the stick is centred.
    let dx = cmd.moveX
    let dy = cmd.moveY
    const len = Math.hypot(dx, dy)
    if (len > 0.01) {
      dx /= len
      dy /= len
    } else {
      dx = Math.cos(e.facing)
      dy = Math.sin(e.facing)
    }
    pc.roll = {
      untilTick: w.tick + ROLL_TICKS,
      cooldownUntilTick: w.tick + ROLL_TICKS + ROLL_COOLDOWN,
      dirX: dx,
      dirY: dy,
    }
    w.events.push({ type: 'roll', x: e.pos.x, y: e.pos.y, entityId: e.id })

    // Stop-drop-and-roll: the roll's START smothers a burning status. An instant,
    // once per roll — NOT a lingering aura, so a burn caught MID-roll sticks until
    // the next roll. Extinguishing deletes the effect before this tick's
    // elementSystem runs (rollSystem precedes it in tickWorld), so a burn doused
    // to zero deals no damage this tick; a merely-shortened burn keeps ticking.
    // Standing IN the flames re-ignites the same tick (fireSystem runs later) —
    // you have to roll OUT of the fire, as in life.
    const burn = e.fx?.burning
    if (burn !== undefined) {
      const remaining = burn.until - w.tick
      if (remaining <= DOUSE_TICKS) delete e.fx!.burning
      else burn.until -= DOUSE_TICKS
      w.events.push({
        type: 'burnDoused',
        x: e.pos.x,
        y: e.pos.y,
        entityId: e.id,
        remainingTicks: Math.max(0, remaining - DOUSE_TICKS),
      })
    }
  }
}
