import type { Entity } from '../entity'
import { SIM_DT, type InputCmd } from '../types'
import { isBlocked, type World } from '../world'

export const PLAYER_SPEED = 4.5 // tiles/sec
const FRICTION = 12 // knockback velocity decay per second

/**
 * Move a circle through the tile grid with axis-separated slide collision.
 * Shared by host sim and client prediction — must stay dependency-free.
 */
const EPS = 1e-4
/** Max displacement per collision sub-step; keeps the boundary snap exact. */
const MAX_STEP = 0.25

export const moveAndCollide = (
  e: Entity,
  dx: number,
  dy: number,
  blocked: (tx: number, ty: number) => boolean,
): void => {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP))
  const sx = dx / steps
  const sy = dy / steps
  for (let i = 0; i < steps; i++) stepAxes(e, sx, sy, blocked)
}

const stepAxes = (
  e: Entity,
  dx: number,
  dy: number,
  blocked: (tx: number, ty: number) => boolean,
): void => {
  if (dx !== 0) {
    const nx = e.pos.x + dx
    if (circleFits(nx, e.pos.y, e.radius, blocked)) {
      e.pos.x = nx
    } else {
      // Try snapping flush against the tile boundary we hit.
      const sx =
        dx > 0 ? Math.ceil(e.pos.x + e.radius) - e.radius - EPS : Math.floor(e.pos.x - e.radius) + e.radius + EPS
      const between = dx > 0 ? sx > e.pos.x && sx < nx : sx < e.pos.x && sx > nx
      if (between && circleFits(sx, e.pos.y, e.radius, blocked)) e.pos.x = sx
    }
  }
  if (dy !== 0) {
    const ny = e.pos.y + dy
    if (circleFits(e.pos.x, ny, e.radius, blocked)) {
      e.pos.y = ny
    } else {
      const sy =
        dy > 0 ? Math.ceil(e.pos.y + e.radius) - e.radius - EPS : Math.floor(e.pos.y - e.radius) + e.radius + EPS
      const between = dy > 0 ? sy > e.pos.y && sy < ny : sy < e.pos.y && sy > ny
      if (between && circleFits(e.pos.x, sy, e.radius, blocked)) e.pos.y = sy
    }
  }
}

const circleFits = (
  x: number,
  y: number,
  r: number,
  blocked: (tx: number, ty: number) => boolean,
): boolean => {
  const minTx = Math.floor(x - r)
  const maxTx = Math.floor(x + r)
  const minTy = Math.floor(y - r)
  const maxTy = Math.floor(y + r)
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!blocked(tx, ty)) continue
      // Circle vs tile AABB overlap
      const cx = Math.max(tx, Math.min(x, tx + 1))
      const cy = Math.max(ty, Math.min(y, ty + 1))
      const ddx = x - cx
      const ddy = y - cy
      if (ddx * ddx + ddy * ddy < r * r) return false
    }
  }
  return true
}

export const movementSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  const blocked = (tx: number, ty: number): boolean => isBlocked(w, tx, ty)
  for (const e of w.entities) {
    if (e.dead) continue
    if (e.status && (e.status.stun > 0 || e.status.sleep > 0)) continue

    let ix = 0
    let iy = 0
    if (e.playerCtl && !e.playerCtl.downed) {
      const cmd = inputs.get(e.playerCtl.playerId)
      if (cmd) {
        const len = Math.hypot(cmd.moveX, cmd.moveY)
        if (len > 0.01) {
          const norm = len > 1 ? 1 / len : 1
          ix = cmd.moveX * norm
          iy = cmd.moveY * norm
          e.facing = Math.atan2(iy, ix)
        }
      }
    }

    const speed = e.playerCtl ? PLAYER_SPEED : 0
    const dx = (ix * speed + e.vel.x) * SIM_DT
    const dy = (iy * speed + e.vel.y) * SIM_DT
    if (dx !== 0 || dy !== 0) moveAndCollide(e, dx, dy, blocked)

    // Knockback decay
    const decay = Math.max(0, 1 - FRICTION * SIM_DT)
    e.vel.x *= decay
    e.vel.y *= decay
    if (Math.abs(e.vel.x) < 0.01) e.vel.x = 0
    if (Math.abs(e.vel.y) < 0.01) e.vel.y = 0
  }
}
