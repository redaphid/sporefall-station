/**
 * How to read one pad, resolved from its mapping + the SHAPE of its axes array.
 * Controllers report wildly different button orders, so every read goes through
 * a profile instead of hard-coded indices.
 *
 * Three profiles:
 *   - standard  : `mapping === 'standard'`. The W3C layout, vouched for by the
 *                 browser. Xbox, PlayStation, and an 8bitdo Zero 2 in X-input
 *                 mode all land here, so X-input is the recommended Zero 2 mode.
 *   - canonical : `mapping === ''` but the pad is shaped like Chromium's Android
 *                 canonical mapper made it. Same indices as standard (see below).
 *   - raw       : `mapping === ''` and NOT that shape — a genuinely unmapped pad,
 *                 in practice desktop Linux/evdev. Indices are the driver's, so
 *                 they are a documented BEST GUESS; see the controllers overlay,
 *                 which shows live indices for a real-device check.
 *
 * ## Why `mapping === ''` does not mean "unmapped" on Android
 *
 * It is tempting to read an empty `mapping` as "the browser knows nothing, so
 * guess". On Android that is simply false, and believing it caused two shipped
 * bugs (a pad that ran south forever, and a pad that fired constantly).
 *
 * Chromium's `UnknownGamepadMappings` (device/gamepad/android/java/src/org/
 * chromium/device/gamepad/GamepadMappings.java) is the fallback for a pad it
 * does not recognise. It STILL writes every value into `CanonicalAxisIndex` /
 * `CanonicalButtonIndex` slots — the W3C order. All it does differently is
 * override `isStandard()` to return false, which is what empties `mapping`. So
 * `mapping === ''` on Android means "best-effort canonical, but the browser will
 * not vouch for it" — NOT "raw". Three consequences we rely on:
 *
 *  1. **There is no axis 9.** `GamepadDevice` allocates the exposed array as
 *     `new float[CanonicalAxisIndex.COUNT]` — exactly 4, always. That is why an
 *     axis count of exactly 4 identifies the canonical shape.
 *  2. **Hats arrive as BUTTONS 12-15**, never as an axis: `mapHatAxisToDpadButtons`
 *     converts AXIS_HAT_X/Y into the canonical d-pad buttons (and a pad with a
 *     digital d-pad uses `mapCommonDpadButtons`, same destination).
 *  3. **Triggers arrive as BUTTONS 6/7**, never as an axis. Axes 2/3 are written
 *     only from a real right stick, and left zero-filled when there isn't one.
 *     So on the canonical shape, axes 2/3 are the right stick or they are (0,0)
 *     — they can never be a trigger pair resting at -1.
 *
 * Point 3 is what makes `aimAxes: [2, 3]` SAFE here, and it is exactly what is
 * NOT true of a raw pad — hence `aimAxes: null` on raw, below.
 *
 * ## The known soft spot
 *
 * An axis count of 4 is necessary for the canonical shape but not, strictly,
 * sufficient: a genuinely raw pad that happened to expose exactly 4 axes with
 * triggers on 2/3 (a left stick + two analog triggers and no right stick) would
 * be read as canonical and could fire on its own. No such pad is known — a raw
 * pad with analog triggers virtually always exposes a right stick too, putting
 * it at 6+ axes — and the alternative defences are worse: sampling resting values
 * at connect time reads a lie (a trigger reports 0 until first touched and only
 * then rests at -1), and motion-gating each axis would put mutable state inside
 * an otherwise pure read. If such a pad ever turns up, gate `CANONICAL` on
 * `buttons.length` too: Chromium's canonical mapper reports exactly 16 or 17
 * buttons (`getButtonsLength()` → `CanonicalButtonIndex.COUNT`, minus one when
 * the pad has no meta button), which a raw pad has no reason to match.
 */
export type PadKind = 'standard' | 'canonical' | 'raw'

export interface PadProfile {
  kind: PadKind
  attack: number[]
  interact: number[]
  special: number[]
  /** Dodge-roll button(s) — the left shoulder/trigger, clear of attack/aim. */
  roll: number[]
  pause: number[]
  /** Throw the held item / grenade (edge). A free button clear of attack/roll. */
  throw: number[]
  /** Cycle to the previous / next hotbar weapon (edge). Two distinct free buttons;
   * gamepadCoop turns the press into an absolute slot index. */
  hotbarPrev: number[]
  hotbarNext: number[]
  join: number[]
  dpad: [number, number, number, number]
  moveAxes: [number, number]
  /** Right stick → aim (twin-stick), or null when we do not know which axes the
   * aim stick is on. NEVER guess this: aim past AIM_FIRE also ATTACKS, so a wrong
   * guess does not merely misaim, it fires forever. A raw pad's axes 2/3 are as
   * likely to be analog triggers — which rest at -1, for hypot 1.41, well past the
   * 0.5 threshold — as a right stick. null costs that pad twin-stick aim while
   * aim-where-you-move and the attack button keep working; a bad guess costs the
   * player the game with no recourse. */
  aimAxes: [number, number] | null
  /** An 8-way hat squeezed onto one axis, as evdev surfaces it. Real on desktop
   * Linux; provably absent on Android (see the file header), so only `raw` has it. */
  hatAxis: number | null
}

/** Chromium's exposed axis count for the Android canonical mapping, from
 * `new float[CanonicalAxisIndex.COUNT]`: LEFT_STICK_X/Y + RIGHT_STICK_X/Y. */
const CANONICAL_AXIS_COUNT = 4

const STANDARD: PadProfile = {
  kind: 'standard',
  attack: [0, 5, 7],
  interact: [1],
  special: [2, 3],
  roll: [4, 6], // LB / LT
  pause: [9],
  // Face buttons (0-3) and all four shoulders (4-7) are already bound above, so
  // the newly-mapped verbs take the remaining free buttons on a W3C standard pad:
  //   throw   → Back/Select (8)
  //   cycle   → left-stick click L3 (10, prev) / right-stick click R3 (11, next)
  // Stick-clicks aren't glamorous but they're the only conflict-free pair here;
  // real-device tuning may prefer LB/RB, but those collide with roll/attack.
  throw: [8],
  hotbarPrev: [10],
  hotbarNext: [11],
  join: [0, 1, 2, 3, 9],
  dpad: [12, 13, 14, 15],
  moveAxes: [0, 1],
  aimAxes: [2, 3],
  hatAxis: null,
}

/**
 * A pad Chromium mapped canonically but would not vouch for. The indices are
 * already W3C-correct (see the file header), so the right thing to do is trust
 * them — this profile is STANDARD, relabelled. The label is kept because the
 * distinction is real and worth surfacing in the controllers overlay: these
 * indices are Chromium's best effort, not a guarantee.
 */
const CANONICAL: PadProfile = { ...STANDARD, kind: 'canonical' }

/**
 * A genuinely unmapped pad. Every index here is a BEST GUESS and stays one — we
 * have no evidence about this pad's layout, so this profile deliberately keeps
 * the permissive button spread it always had rather than pretending a raw evdev
 * pad is W3C-shaped. The one thing it must not do is guess an aim stick.
 */
const RAW: PadProfile = {
  kind: 'raw',
  attack: [0, 1],
  interact: [2, 3],
  special: [4, 5],
  roll: [6, 7],
  // Pause narrowed from the old greedy [8,9,10,11] guess to Start (9) — matching
  // the standard profile — so 8/10/11 are free for the new verbs, laid out like
  // standard: throw on 8, cycle on 10 (prev) / 11 (next). All BEST GUESS: the
  // controllers overlay shows live indices for a real-device check.
  pause: [9],
  throw: [8],
  hotbarPrev: [10],
  hotbarNext: [11],
  join: [0, 1, 2, 3, 4, 5],
  dpad: [12, 13, 14, 15],
  moveAxes: [0, 1],
  // Not a guess we are allowed to make — see PadProfile.aimAxes.
  aimAxes: null,
  // Kept, and kept only here: the one-axis hat is real on desktop Linux (a dev
  // environment for this project) and cannot exist on Android. readPad treats a
  // missing axis, a resting hat, and any non-exact-state value as NO direction
  // and lets the hat fill in only axes the stick and d-pad leave centred, so the
  // guess costs nothing when it is wrong and wins a working d-pad when it is right.
  hatAxis: 9,
}

/**
 * Which profile reads this pad. Note this needs the pad's `axes`, not just its
 * id/mapping: the axis COUNT is the only honest signal separating Chromium's
 * canonical Android shape from a raw pad, and it beats matching on id — a name
 * regex is a guess about a device, whereas the array length is a fact about the
 * data we were actually handed.
 */
export const padProfile = (pad: Pick<Gamepad, 'id' | 'mapping' | 'axes'>): PadProfile => {
  if (pad.mapping === 'standard') return STANDARD
  if (pad.axes?.length === CANONICAL_AXIS_COUNT) return CANONICAL
  return RAW
}
