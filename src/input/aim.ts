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

/** Reticle distance from the player, in tiles: eases from NEAR at the deadzone
 * rim to FAR at full stick tilt, so the reticle telegraphs both direction and
 * how hard the stick is pushed. */
export const RETICLE_NEAR = 1.1
export const RETICLE_FAR = 2.9

export interface Reticle {
  x: number
  y: number
}

/** A player entity the reticle can anchor to: just its position and lane. */
export interface ReticleAnchor {
  pos: { x: number; y: number }
  playerId: number
  dead?: boolean
}

/**
 * World-space aim reticles for every joined pad whose RIGHT STICK is deflected
 * past the aim deadzone — the on-screen proof that twin-stick aim is live and
 * pointing where the player thinks it is. Pure (pads + player positions in,
 * tile-space points out) so it's unit-testable; the renderer just draws them.
 * Movement-fallback aim (aim-where-you-move) deliberately shows NO reticle:
 * it tracks the walk direction, and pinning a marker to it reads as noise.
 */
export const padAimReticles = (
  pads: readonly { slot: number | null; state: { aimX: number; aimY: number } }[],
  players: readonly ReticleAnchor[],
): Reticle[] => {
  const out: Reticle[] = []
  for (const p of pads) {
    if (p.slot === null) continue
    const mag = Math.hypot(p.state.aimX, p.state.aimY)
    if (mag <= AIM_DEADZONE) continue
    const anchor = players.find((e) => e.playerId === p.slot && !e.dead)
    if (!anchor) continue
    const dist = RETICLE_NEAR + (RETICLE_FAR - RETICLE_NEAR) * Math.min(1, mag)
    out.push({ x: anchor.pos.x + (p.state.aimX / mag) * dist, y: anchor.pos.y + (p.state.aimY / mag) * dist })
  }
  return out
}
