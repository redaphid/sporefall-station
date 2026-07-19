/**
 * How to read one pad, resolved from its mapping + the SHAPE of its axes array.
 *
 * There is ONE button map — the W3C standard layout, defined once in `BUTTONS`
 * below. The three profiles differ only in how much of the pad's ANALOG data
 * they are willing to trust:
 *
 *   - standard  : `mapping === 'standard'`. The W3C layout, vouched for by the
 *                 browser. Xbox, PlayStation, and an 8bitdo Zero 2 in X-input
 *                 mode all land here, so X-input is the recommended Zero 2 mode.
 *   - canonical : `mapping === ''` but the pad is shaped like Chromium's Android
 *                 canonical mapper made it. Same indices as standard (see below).
 *   - raw       : `mapping === ''` and NOT that shape — a genuinely unmapped pad,
 *                 in practice desktop Linux/evdev. The button indices are the
 *                 driver's, so the shared map is a documented BEST GUESS there
 *                 (the W3C order is as good a guess as any — it is the order
 *                 browsers themselves map unknown pads into); the controllers
 *                 overlay (F9 / ?pads=1) shows live indices for a real-device
 *                 check. What raw must NOT do is trust analog axes it cannot
 *                 prove: no aim stick (see `aimAxes`), and movement axes are
 *                 read defensively (deadzone, hat-neutrality in readPad).
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
 * sufficient: a genuinely raw pad that happened to expose exactly 4 axes would
 * be read as canonical and its axes 2/3 trusted as an aim stick. No such pad is
 * known — a raw pad with analog triggers virtually always exposes a right stick
 * too, putting it at 6+ axes. If one ever turns up, gate `CANONICAL` on
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
  /** Dodge-roll button (edge in gamepadCoop). */
  roll: number[]
  pause: number[]
  /** Throw the held item / grenade (edge). */
  throw: number[]
  /** Cycle to the previous / next hotbar weapon (edge); gamepadCoop turns the
   * press into an absolute slot index. */
  hotbarPrev: number[]
  hotbarNext: number[]
  dpad: [number, number, number, number]
  moveAxes: [number, number]
  /** Right stick → aim (twin-stick), or null when we do not know which axes the
   * aim stick is on. NEVER guess this: a raw pad's axes 2/3 are as likely to be
   * analog triggers — which rest at -1 once touched — as a right stick, and a
   * resting trigger pair read as aim would pin the player's aim to a constant
   * up-left with no recourse (selectAim prefers a deflected aim stick over the
   * movement vector). null costs that pad twin-stick aim while aim-where-you-move
   * and the fire buttons keep working. */
  aimAxes: [number, number] | null
  /** An 8-way hat squeezed onto one axis, as evdev surfaces it. Real on desktop
   * Linux; provably absent on Android (see the file header), so only `raw` has it. */
  hatAxis: number | null
}

/** Chromium's exposed axis count for the Android canonical mapping, from
 * `new float[CanonicalAxisIndex.COUNT]`: LEFT_STICK_X/Y + RIGHT_STICK_X/Y. */
const CANONICAL_AXIS_COUNT = 4

/**
 * THE button map (W3C standard indices, verified against the spec's Standard
 * Gamepad layout — w3.org/TR/gamepad — and Chromium's CanonicalButtonIndex).
 * This is the single place button bindings live — every profile shares it.
 *
 *   0  A  (bottom face)   attack
 *   1  B  (right face)    interact
 *   2  X  (left face)     special
 *   3  Y  (top face)      special
 *   4  LB (L1)            dodge-roll
 *   5  RB (R1)            attack
 *   6  LT (L2, trigger)   attack  — the explicit fire trigger
 *   7  RT (R2, trigger)   attack
 *   8  Back/Select/View   throw held item
 *   9  Start/Menu         pause
 *   10 L3 (stick click)   hotbar prev
 *   11 R3 (stick click)   hotbar next
 *   12-15 d-pad up/down/left/right (movement)
 *   16 Home/Guide — deliberately unmapped (the OS/browser owns it)
 *
 * Axes (standard): 0/1 left stick X/Y (movement), 2/3 right stick X/Y (aim).
 *
 * Firing is BUTTONS ONLY (A / RB / L2 / R2, all held-to-fire); the aim stick
 * aims and never fires. Join is NOT a button list any more: any mapped button
 * or a firm, proven stick push joins an unassigned pad (rules in padJoin.ts),
 * and gamepadCoop keeps the joining input inert until it is released.
 */
const BUTTONS = {
  attack: [0, 5, 6, 7],
  interact: [1],
  special: [2, 3],
  roll: [4],
  pause: [9],
  throw: [8],
  hotbarPrev: [10],
  hotbarNext: [11],
  dpad: [12, 13, 14, 15] as [number, number, number, number],
}

/**
 * A fresh copy of the REMAPPABLE slice of THE button map — the defaults the
 * user remap layer (remap.ts) overlays. Deliberately excludes `dpad`
 * (movement — remapping it would let a face button move the player, which the
 * touch/stick model never allows); join is not remappable either — it is not a
 * button list at all (any input joins, padJoin.ts). Axes are not here at all:
 * only BUTTONS are remappable, ever — the raw-pad safety invariant (no
 * unproven axis may fire) must not acquire a user-configurable hole.
 */
export const defaultButtons = () => ({
  attack: [...BUTTONS.attack],
  interact: [...BUTTONS.interact],
  special: [...BUTTONS.special],
  roll: [...BUTTONS.roll],
  pause: [...BUTTONS.pause],
  throw: [...BUTTONS.throw],
  hotbarPrev: [...BUTTONS.hotbarPrev],
  hotbarNext: [...BUTTONS.hotbarNext],
})

const STANDARD: PadProfile = {
  kind: 'standard',
  ...BUTTONS,
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
 * A genuinely unmapped pad (desktop Linux/evdev). Buttons use the same shared
 * map — a best guess there, checkable live in the controllers overlay. The two
 * differences are about analog trust:
 *   - no aim stick (see PadProfile.aimAxes — not a guess we are allowed to make)
 *   - a speculative one-axis hat on axis 9, real on desktop Linux and impossible
 *     on Android. readPad treats a missing axis, a resting hat, and any
 *     non-exact-state value as NO direction and lets the hat fill in only axes
 *     the stick and d-pad leave centred, so the guess costs nothing when it is
 *     wrong and wins a working d-pad when it is right.
 */
const RAW: PadProfile = {
  ...STANDARD,
  kind: 'raw',
  aimAxes: null,
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
