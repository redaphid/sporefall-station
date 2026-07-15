import type { Entity } from '../entity'
import type { InputCmd } from '../types'
import type { World } from '../world'
import { isImmobilized } from './statusFx'

// Dodge-roll tuning (Enter-the-Gungeon flavour). Ticks are absolute-tick windows,
// so the whole mechanic is a pure function of world tick + input — no timers.
/** How long the roll lasts: the i-frame + speed-burst window (30 ticks = 1s). */
export const ROLL_TICKS = 12
/** Ticks AFTER the roll ends before another can start — the anti-chain gate. */
export const ROLL_COOLDOWN = 24
/** Burst speed while rolling (tiles/sec) — well above the ~4.5 walk speed so a
 * roll clearly repositions, still through the normal collision path (no clipping). */
export const ROLL_SPEED = 12

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
    // Already rolling, or still cooling down → ignore further roll presses.
    if (pc.roll) continue
    const stunned = e.status !== undefined && (e.status.stun > 0 || e.status.sleep > 0)
    if (stunned || isImmobilized(e)) continue
    const cmd = inputs.get(pc.playerId)
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
  }
}
