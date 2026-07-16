import { aimFires } from './aim'
import type { PadProfile } from './padProfile'

/** Raw held state for one pad on one sample — no edge history, no seq. */
export interface PadState {
  moveX: number
  moveY: number
  aimX: number
  aimY: number
  attack: boolean
  interact: boolean
  special: boolean
  roll: boolean
  pause: boolean
  /** Held throw button — gamepadCoop edge-triggers it into InputCmd.throwItem. */
  throwItem: boolean
  /** Held weapon-cycle buttons — gamepadCoop edge-triggers them and resolves the
   * press into an absolute hotbar slot index. */
  hotbarPrev: boolean
  hotbarNext: boolean
}

const DEADZONE = 0.28

const pressed = (pad: Gamepad, i: number): boolean => {
  const b = pad.buttons[i]
  if (!b) return false
  return b.pressed
}

const anyPressed = (pad: Gamepad, idxs: number[]): boolean => idxs.some((i) => pressed(pad, i))

/** One axis reading, or undefined if the pad simply does not have that axis (or
 * reports garbage for it). Keeping "absent" distinct from "reads 0" matters:
 * a hat that isn't there and a hat pushed to some value are different facts,
 * and collapsing both to 0 is what pinned the player to a wall (see hatDir). */
const axisAt = (pad: Gamepad, i: number): number | undefined => {
  const v = pad.axes[i]
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return v
}

/** An analog stick axis, deadzoned. A missing/garbage axis is centred. */
const stick = (pad: Gamepad, i: number): number => {
  const v = axisAt(pad, i)
  if (v === undefined) return 0
  return Math.abs(v) < DEADZONE ? 0 : v
}

// The eight hat directions, clockwise from up.
const HAT_DIRS: [number, number][] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

/**
 * An 8-way hat squeezed onto a single axis, as evdev/Linux hats surface through
 * the browser on non-standard pads. The driver reports a 4-bit hat state and it
 * arrives normalised onto the axis as:
 *
 *     value = state * (2 / 7) - 1
 *
 * States 0-7 are the directions clockwise from up; state 15 means "no
 * direction" and lands way outside the stick band, at 3.2857 (= 15*2/7 - 1):
 *
 *   state | 0     1      2      3      4     5     6     7   | 15
 *   value | -1  -.714  -.429  -.143  .143  .429  .714   1    | 3.2857
 *
 * Two things fall out of that table which the previous decode got wrong:
 *
 *  1. **0 is not a valid hat value.** It sits at state 3.5 -- exactly halfway
 *     between down-right and down. The old code rounded any |v| <= 1.1 to the
 *     nearest state, so 0 became state 4 = DOWN. A pad with no axis 9 (or an
 *     axis 9 that rests at 0) therefore reported "down" on every single sample,
 *     forever. We reject non-integer states rather than special-casing 0, so
 *     this stays correct for every other between-states value too.
 *  2. Rest is not the only reading we must refuse. An axis that isn't a hat at
 *     all (a spare trigger, say) sweeps continuously through the -1..1 band and
 *     would otherwise decode as a stream of bogus directions.
 *
 * So: accept a value only when it lands within HAT_TOL of an exact state in
 * 0..7. Everything else -- rest, absent, NaN, a non-hat axis mid-sweep -- is
 * neutral. The strictness is deliberate and the cost is asymmetric: refusing a
 * real hat direction on an unknown pad loses the d-pad but the stick still
 * drives, while inventing one pins the player against a wall with no recourse.
 */
const HAT_STEP = 2 / 7
/** Tolerance in *state* units. A full step is 1.0 and the midpoint between two
 * states is 0.5, so 0.15 accepts real readings (which are exact to float
 * precision) while rejecting anything genuinely between two states. */
const HAT_TOL = 0.15

const hatDir = (v: number | undefined): [number, number] | null => {
  if (v === undefined) return null
  const state = (v + 1) / HAT_STEP
  const nearest = Math.round(state)
  if (nearest < 0 || nearest > 7) return null // rest (15), and anything off-scale
  if (Math.abs(state - nearest) > HAT_TOL) return null // not an exact hat state
  return HAT_DIRS[nearest]
}

export const readPad = (pad: Gamepad, profile: PadProfile): PadState => {
  let moveX = stick(pad, profile.moveAxes[0])
  let moveY = stick(pad, profile.moveAxes[1])

  const [up, down, left, right] = profile.dpad
  if (pressed(pad, left)) moveX = -1
  if (pressed(pad, right)) moveX = 1
  if (pressed(pad, up)) moveY = -1
  if (pressed(pad, down)) moveY = 1

  // The hat FILLS IN: it claims an axis nothing else has already moved, rather
  // than overwriting one. Precedence is by confidence, not by source -- a stick
  // reading and a button press are unambiguous facts about this pad, whereas
  // the hat only exists on profiles we could not map properly and its axis
  // index is a documented guess. So where they disagree, the thing we actually
  // know wins, and a bad guess can never take the controls away from a player
  // who is pushing a real input. Per-axis, so a diagonal hat still contributes
  // its Y while the stick holds X.
  if (profile.hatAxis !== null) {
    const dir = hatDir(axisAt(pad, profile.hatAxis))
    if (dir) {
      if (moveX === 0) moveX = dir[0]
      if (moveY === 0) moveY = dir[1]
    }
  }

  const aimX = stick(pad, profile.aimAxes[0])
  const aimY = stick(pad, profile.aimAxes[1])

  return {
    moveX,
    moveY,
    aimX,
    aimY,
    // Twin-stick parity with touch: the attack BUTTON fires, and so does
    // deflecting the aim stick past the shared fire threshold.
    attack: anyPressed(pad, profile.attack) || aimFires(aimX, aimY),
    interact: anyPressed(pad, profile.interact),
    special: anyPressed(pad, profile.special),
    roll: anyPressed(pad, profile.roll),
    pause: anyPressed(pad, profile.pause),
    throwItem: anyPressed(pad, profile.throw),
    hotbarPrev: anyPressed(pad, profile.hotbarPrev),
    hotbarNext: anyPressed(pad, profile.hotbarNext),
  }
}
