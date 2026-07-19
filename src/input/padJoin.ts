import type { PadProfile } from './padProfile'
import { axisValue, buttonPressed, DEADZONE } from './readPad'

/**
 * Join intent for an UNJOINED pad: does this pad's owner want in?
 *
 * Two ways to say yes, matching "respond to gamepad input at all times":
 *
 *  1. **Any button.** A press on any index the profile maps (face, bumpers,
 *     triggers, Start/Back, stick clicks, d-pad) joins immediately. A press is
 *     a fact about the pad even when WHICH action the index maps to is a guess
 *     (raw pads), so every button is safe join intent. gamepadCoop keeps the
 *     joining input inert until it is physically released, so joining on the
 *     grenade/special button can never also throw the grenade.
 *  2. **A firm, sustained stick push** — but only on axes we can trust, and
 *     only once the axis pair has PROVEN it is a stick:
 *
 *     - Eligible pairs are the profile's moveAxes, plus aimAxes where the
 *       profile names them (standard/canonical; raw has aimAxes null and its
 *       aim axes NEVER count — they are as likely analog triggers as a stick).
 *     - **Neutral proof:** a pair only becomes join-eligible after it has been
 *       observed resting inside the deadzone at least once. An analog trigger
 *       misdescribed as a stick axis rests at -1 (full deflection!) from the
 *       moment it is touched and never visits neutral, so it can never join.
 *       Constant drift just outside the deadzone (±0.3) also never proves
 *       neutral — double insurance on top of the threshold below.
 *     - **Firm and sustained:** raw magnitude past STICK_JOIN_THRESHOLD for
 *       STICK_JOIN_SAMPLES consecutive samples. Drift and brush-touches sit
 *       far below the threshold; a deliberate push crosses it for far longer
 *       than three polls (~50ms at 60Hz).
 *
 *     The speculative one-axis hat (raw profile, axis 9) is deliberately NOT
 *     join intent: it is a guessed index, and a resting trigger at -1 there
 *     decodes as a valid "up" hat state — exactly the kind of phantom input
 *     the neutral-proof rule exists to exclude.
 *
 * Note the browser gates what we can see at all: Chromium/Firefox hide a pad
 * from navigator.getGamepads() until the user first interacts with it (a
 * fingerprinting protection; per MDN the surfacing interaction is "presses a
 * button or moves an axis", and Firefox requires it to happen with the page
 * visible). That first physical input may be consumed by the browser just to
 * EXPOSE the pad. Everything after exposure is ours: any button or a firm
 * stick push joins, inertly.
 */
export const STICK_JOIN_THRESHOLD = 0.5
export const STICK_JOIN_SAMPLES = 3

export interface JoinIntentState {
  /** Has each trusted pair been seen resting inside the deadzone? */
  moveProven: boolean
  aimProven: boolean
  /** Consecutive samples a proven pair has held past the join threshold. */
  sustain: number
}

export const initialJoinIntent = (): JoinIntentState => ({ moveProven: false, aimProven: false, sustain: 0 })

const pairMag = (pad: Gamepad, axes: [number, number]): number =>
  Math.hypot(axisValue(pad, axes[0]) ?? 0, axisValue(pad, axes[1]) ?? 0)

const BUTTON_GROUPS = (p: PadProfile): number[] => [
  ...p.attack,
  ...p.interact,
  ...p.special,
  ...p.roll,
  ...p.pause,
  ...p.throw,
  ...p.hotbarPrev,
  ...p.hotbarNext,
  ...p.dpad,
]

export interface JoinIntent {
  state: JoinIntentState
  join: boolean
}

/** One poll of an unjoined pad. Pure: previous tracker state in, next state +
 * "joins now" out. Call every sample so neutral proof accumulates. */
export const stepJoinIntent = (prev: JoinIntentState, pad: Gamepad, profile: PadProfile): JoinIntent => {
  if (BUTTON_GROUPS(profile).some((i) => buttonPressed(pad, i))) return { state: prev, join: true }

  const moveMag = pairMag(pad, profile.moveAxes)
  const aimMag = profile.aimAxes === null ? 0 : pairMag(pad, profile.aimAxes)
  const moveProven = prev.moveProven || moveMag < DEADZONE
  const aimProven = profile.aimAxes !== null && (prev.aimProven || aimMag < DEADZONE)
  const deflected =
    (moveProven && moveMag > STICK_JOIN_THRESHOLD) || (aimProven && aimMag > STICK_JOIN_THRESHOLD)
  const sustain = deflected ? prev.sustain + 1 : 0
  return { state: { moveProven, aimProven, sustain }, join: sustain >= STICK_JOIN_SAMPLES }
}
