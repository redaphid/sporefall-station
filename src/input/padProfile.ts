/**
 * How to read one pad, resolved from its id + mapping. Controllers report
 * wildly different button orders, so every read goes through a profile instead
 * of hard-coded indices.
 *
 * Three profiles:
 *   - standard : `mapping === 'standard'`. The W3C layout — precise indices.
 *                Xbox, PlayStation, and an 8bitdo Zero 2 in X-input mode all
 *                land here, so X-input is the recommended Zero 2 mode.
 *   - zero2    : a non-standard 8bitdo. Permissive face-button sets plus a hat
 *                axis, because the Zero 2's dinput/switch modes vary by firmware.
 *   - generic  : any other non-standard pad — same permissive shape.
 *
 * The zero2/generic indices are a documented BEST GUESS and need a real-device
 * check (see the controllers overlay, which shows live indices). Movement is
 * read from stick + d-pad buttons + hat simultaneously (see readPad), so a pad
 * moves regardless of which of those its mode actually populates.
 */
export type PadKind = 'standard' | 'zero2' | 'generic'

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
  /** Right stick → aim (twin-stick). W3C standard puts it on axes 2/3. */
  aimAxes: [number, number]
  hatAxis: number | null
}

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

const permissive = (kind: PadKind): PadProfile => ({
  kind,
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
  aimAxes: [2, 3],
  hatAxis: 9,
})

const isEightBitDo = (id: string): boolean => /8bitdo|zero/i.test(id)

export const padProfile = (pad: Pick<Gamepad, 'id' | 'mapping'>): PadProfile => {
  if (pad.mapping === 'standard') return STANDARD
  if (isEightBitDo(pad.id)) return permissive('zero2')
  return permissive('generic')
}
