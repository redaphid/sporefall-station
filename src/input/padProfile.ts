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
  pause: [8, 9, 10, 11],
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
