/** Below this stick deflection the aim stick is treated as centred. */
export const AIM_DEADZONE = 0.15

export interface Aim {
  x: number
  y: number
}

/**
 * Pure aim-vector selection shared by every input source. A deflected aim stick
 * wins (twin-stick); otherwise fall back to the movement vector (aim-where-you-
 * move); a fully centred input returns (0,0) so the sim holds the last facing
 * instead of snapping to a default direction.
 */
export const selectAim = (moveX: number, moveY: number, aimX = 0, aimY = 0): Aim => {
  if (Math.hypot(aimX, aimY) > AIM_DEADZONE) return { x: aimX, y: aimY }
  if (Math.hypot(moveX, moveY) > 0.01) return { x: moveX, y: moveY }
  return { x: 0, y: 0 }
}
