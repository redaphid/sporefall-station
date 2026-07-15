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

const axis = (pad: Gamepad, i: number): number => {
  const v = pad.axes[i]
  if (v === undefined) return 0
  return v
}

const dead = (v: number): number => (Math.abs(v) < DEADZONE ? 0 : v)

// 8-way hat encoded on one axis: -1..1 spans 8 directions clockwise from up.
// Rest sits outside that band (e.g. ~3.29), so anything past 1.1 means centred.
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

const hatDir = (v: number): [number, number] | null => {
  if (Math.abs(v) > 1.1) return null
  return HAT_DIRS[Math.round(((v + 1) / 2) * 7)]
}

export const readPad = (pad: Gamepad, profile: PadProfile): PadState => {
  let moveX = dead(axis(pad, profile.moveAxes[0]))
  let moveY = dead(axis(pad, profile.moveAxes[1]))

  const [up, down, left, right] = profile.dpad
  if (pressed(pad, left)) moveX = -1
  if (pressed(pad, right)) moveX = 1
  if (pressed(pad, up)) moveY = -1
  if (pressed(pad, down)) moveY = 1

  if (profile.hatAxis !== null) {
    const dir = hatDir(axis(pad, profile.hatAxis))
    if (dir) {
      moveX = dir[0]
      moveY = dir[1]
    }
  }

  const aimX = dead(axis(pad, profile.aimAxes[0]))
  const aimY = dead(axis(pad, profile.aimAxes[1]))

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
