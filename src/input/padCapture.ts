/**
 * "Press a button…" capture for the remap UI: watches every connected pad and
 * resolves to the first NEW button press. Pure state machine — the caller
 * (settingsPanel) owns the polling interval and the clock, so tests drive it
 * with fabricated pads and timestamps.
 *
 * Safety properties, each load-bearing:
 *   - AXES ARE NEVER READ. A raw pad's analog triggers rest at -1 on an axis
 *     once touched; if axes could bind, a resting trigger would "press"
 *     forever. Only `pad.buttons` exists to this machine.
 *   - Press definition is readPad's own `buttonPressed` (pressed flag, or
 *     value in (0.5, 1]) — a reading that can't fire an action in gameplay
 *     can't bind one here, including a garbage button value of -1 or 3.
 *   - Buttons already down on the FIRST poll are baselined: a held fire
 *     button, or the finger still on whatever opened capture, binds nothing
 *     until released and pressed again. A pad that APPEARS mid-capture is not
 *     baselined — Chrome only exposes a pad after a button press, and that
 *     press is exactly the one the user means ("no controller detected —
 *     press any button on it").
 *   - Terminal: once bound or timed out, every later poll returns the same
 *     result; a bounce on the next frame can't rebind.
 */

import { buttonPressed } from './readPad'

export const CAPTURE_TIMEOUT_MS = 8000

export type CaptureStatus =
  | { phase: 'no-pads' }
  | { phase: 'waiting' }
  | { phase: 'bound'; button: number }
  | { phase: 'timed-out' }

export interface ButtonCapture {
  poll(pads: readonly (Gamepad | null)[], now: number): CaptureStatus
}

export const createButtonCapture = (timeoutMs: number = CAPTURE_TIMEOUT_MS): ButtonCapture => {
  let startedAt: number | null = null
  let polledOnce = false
  const baseline = new Map<number, Set<number>>()
  let done: CaptureStatus | null = null

  const poll = (pads: readonly (Gamepad | null)[], now: number): CaptureStatus => {
    if (done) return done
    if (startedAt === null) startedAt = now
    if (now - startedAt >= timeoutMs) {
      done = { phase: 'timed-out' }
      return done
    }

    const live = pads.filter((p): p is Gamepad => p !== null && p !== undefined)
    for (const pad of live) {
      let base = baseline.get(pad.index)
      if (base === undefined) {
        // First sight of this pad. On the first poll its held buttons are
        // stale state from before capture; later, the pad's arrival IS the
        // press (Chrome gamepad exposure), so baseline empty and fall through.
        base = polledOnce ? new Set() : new Set(pad.buttons.map((_, i) => i).filter((i) => buttonPressed(pad, i)))
        baseline.set(pad.index, base)
        if (!polledOnce) continue
      }
      for (let i = 0; i < pad.buttons.length; i++) {
        if (!buttonPressed(pad, i)) {
          base.delete(i) // released: a re-press now counts
          continue
        }
        if (base.has(i)) continue // held since before capture — inert
        done = { phase: 'bound', button: i }
        return done
      }
    }
    polledOnce = true
    return live.length === 0 ? { phase: 'no-pads' } : { phase: 'waiting' }
  }

  return { poll }
}
