/** Below this stick deflection the aim stick is treated as centred. */
export const AIM_DEADZONE = 0.15

// Touch firing model: deflecting the on-screen aim stick past this fraction
// both aims AND fires — it is touch's SOLE attack path (a phone has no trigger).
// Gamepads do NOT share this rule: they fire from buttons only (A/RB/L2/R2),
// so an axis reading can never shoot on a pad.
export const AIM_FIRE = 0.5

/** Touch fire rule: the aim stick past the fire threshold shoots. Pure +
 * exported so the fire path is unit-testable without the DOM. */
export const aimFires = (aimX: number, aimY: number): boolean => Math.hypot(aimX, aimY) > AIM_FIRE

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
