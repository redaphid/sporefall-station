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

export const DEADZONE = 0.28

/** Analog trigger threshold: past half-travel counts as pressed. Matters for
 * L2/R2 fire — some pads report a trigger's travel only in `.value` and are
 * stingy with `.pressed`. The (0.5, 1] band is deliberate: the spec range is
 * 0..1, so a garbage reading (negative, NaN, or wildly out of range) can never
 * fake a press. */
const TRIGGER_PRESS = 0.5

/** Is button `i` down on this pad? Exported for padJoin (a press is a fact
 * about the pad regardless of which action its index maps to, so ANY press is
 * valid join intent) and for the remap capture (padCapture.ts), which must use
 * the EXACT same press definition as gameplay — a reading that can't fire an
 * action can't bind one either. */
export const buttonPressed = (pad: Gamepad, i: number): boolean => {
  const b = pad.buttons[i]
  if (!b) return false
  return b.pressed || (b.value > TRIGGER_PRESS && b.value <= 1)
}

const anyPressed = (pad: Gamepad, idxs: number[]): boolean => idxs.some((i) => buttonPressed(pad, i))

/** One axis reading, or undefined if the pad simply does not have that axis (or
 * reports garbage for it). Keeping "absent" distinct from "reads 0" matters:
 * a hat that isn't there and a hat pushed to some value are different facts,
 * and collapsing both to 0 is what pinned the player to a wall (see hatDir).
 * Exported for padJoin, which reads raw axes to judge join intent. */
export const axisValue = (pad: Gamepad, i: number): number | undefined => {
  const v = pad.axes[i]
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return v
}

/**
 * RADIAL deadzone with rescale, applied to a stick as a 2D pair — the feel fix
 * over per-axis clipping. Two properties matter:
 *
 *  1. **No snap at the deadzone edge.** Output magnitude ramps smoothly from 0
 *     at the deadzone rim to 1 at full tilt ((mag - DZ) / (1 - DZ)), instead of
 *     jumping from 0 to 0.28 the moment the stick crosses the rim.
 *  2. **No axis-aligned bias.** Per-axis clipping zeroes a small X component
 *     while keeping a large Y, snapping near-vertical pushes exactly vertical
 *     and making diagonals feel sticky. Judging the vector's magnitude keeps
 *     the direction the player actually pushed.
 *
 * Magnitude clamps to 1 so an out-of-spec driver (|v| > 1) can't overspeed. */
export const radialDeadzone = (x: number, y: number): { x: number; y: number } => {
  const mag = Math.hypot(x, y)
  if (mag < DEADZONE) return { x: 0, y: 0 }
  const k = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE)) / mag
  return { x: x * k, y: y * k }
}

/** A stick's axis pair read together and radially deadzoned. Missing/garbage
 * axes read centred. */
const stickPair = (pad: Gamepad, ix: number, iy: number): { x: number; y: number } =>
  radialDeadzone(axisValue(pad, ix) ?? 0, axisValue(pad, iy) ?? 0)

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

/**
 * A one-axis hat's NULL (neutral) value lands FAR outside the legal stick range.
 * "No direction" is evdev state 15 → 15*(2/7) - 1 = 3.2857, well past the spec's
 * [-1, 1]. A spec-conformant stick or trigger axis can never reach here, so a
 * reading past this threshold is positive proof the axis genuinely IS a hat. The
 * 1.1 floor sits just above the legal max of 1 (with float margin) and far below
 * 3.2857, so it catches the null without ever admitting a real analog axis. */
const HAT_NULL_MIN = 1.1

/**
 * Per-pad calibration latch for the speculative one-axis hat. THE FIX for the
 * "character keeps walking after the stick is released" bug on an 8BitDo Lite 2
 * (D-input) in desktop Chrome: that pad resolves to the `raw` profile, whose
 * `hatAxis: 9` is a documented GUESS. On this pad axis 9 is not a hat at all — it
 * rests at -1, which decodes to a phantom "up" and drives moveY = -1 forever.
 *
 * Statelessly, -1 is ambiguous: it is BOTH the hat's genuine "up" detent AND a
 * resting analog axis. So we calibrate: a real hat visits its null value (> 1.1,
 * unreachable by any analog axis) whenever it is centred, and we refuse to read
 * ANY hat direction until that null has been seen at least once. A resting
 * trigger/second-stick never reaches the null, so its -1 is never trusted — the
 * phantom direction is gone. A genuine hat proves itself the instant it rests at
 * centre, then decodes normally. Mirrors padJoin's neutral-proof rule.
 *
 * This is client-side calibration of raw pad → PadState. Replay determinism is
 * defined over the InputCmd stream we synthesise, not over raw getGamepads()
 * values, so a latch here changes nothing the sim sees twice. gamepadCoop owns
 * one latch per connected pad; a fresh (unproven) latch is the safe default for
 * a bare pure read. */
export interface HatCalibration {
  proven: boolean
}
export const initialHatCalibration = (): HatCalibration => ({ proven: false })

/** Decode a one-axis hat, GATED on calibration (mutates `calib`). A reading in
 * the null region both PROVES the axis is a hat and reports "no direction". An
 * in-range detent decodes ONLY after proof has been seen; before then it is
 * neutral, so a resting non-hat axis can never invent a held direction. */
const hatDir = (v: number | undefined, calib: HatCalibration): [number, number] | null => {
  if (v === undefined) return null
  if (v > HAT_NULL_MIN) {
    calib.proven = true // only a real hat's null value reaches here
    return null
  }
  if (!calib.proven) return null // unproven: an in-range value may be a resting trigger/stick
  const state = (v + 1) / HAT_STEP
  const nearest = Math.round(state)
  if (nearest < 0 || nearest > 7) return null // off-scale / not a detent
  if (Math.abs(state - nearest) > HAT_TOL) return null // not an exact hat state
  return HAT_DIRS[nearest]
}

export const readPad = (
  pad: Gamepad,
  profile: PadProfile,
  hat: HatCalibration = initialHatCalibration(),
): PadState => {
  const move = stickPair(pad, profile.moveAxes[0], profile.moveAxes[1])
  let moveX = move.x
  let moveY = move.y

  const [up, down, left, right] = profile.dpad
  if (buttonPressed(pad, left)) moveX = -1
  if (buttonPressed(pad, right)) moveX = 1
  if (buttonPressed(pad, up)) moveY = -1
  if (buttonPressed(pad, down)) moveY = 1

  // The hat FILLS IN: it claims an axis nothing else has already moved, rather
  // than overwriting one. Precedence is by confidence, not by source -- a stick
  // reading and a button press are unambiguous facts about this pad, whereas
  // the hat only exists on profiles we could not map properly and its axis
  // index is a documented guess. So where they disagree, the thing we actually
  // know wins, and a bad guess can never take the controls away from a player
  // who is pushing a real input. Per-axis, so a diagonal hat still contributes
  // its Y while the stick holds X.
  if (profile.hatAxis !== null) {
    const dir = hatDir(axisValue(pad, profile.hatAxis), hat)
    if (dir) {
      if (moveX === 0) moveX = dir[0]
      if (moveY === 0) moveY = dir[1]
    }
  }

  // A profile with no aimAxes has no aim stick we are willing to name, so aim
  // reads centred. This is not "no aim": selectAim falls back to the movement
  // vector, and the fire buttons are untouched. See PadProfile.aimAxes for why
  // guessing here is unacceptable in a way that guessing a d-pad index is not.
  const aim = profile.aimAxes === null ? { x: 0, y: 0 } : stickPair(pad, profile.aimAxes[0], profile.aimAxes[1])
  const aimX = aim.x
  const aimY = aim.y

  return {
    moveX,
    moveY,
    aimX,
    aimY,
    // Firing is buttons only (A / RB / L2 / R2 on the shared map). The aim stick
    // aims and never fires — so no axis reading, proven or guessed, can shoot.
    attack: anyPressed(pad, profile.attack),
    interact: anyPressed(pad, profile.interact),
    special: anyPressed(pad, profile.special),
    roll: anyPressed(pad, profile.roll),
    pause: anyPressed(pad, profile.pause),
    throwItem: anyPressed(pad, profile.throw),
    hotbarPrev: anyPressed(pad, profile.hotbarPrev),
    hotbarNext: anyPressed(pad, profile.hotbarNext),
  }
}
