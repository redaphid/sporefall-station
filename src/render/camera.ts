import type { Container } from 'pixi.js'
import { TILE_PX } from './art'

/** Camera in world (tile) coordinates, applied as a container translation. */
export class Camera {
  x = 0
  y = 0
  private shakeMag = 0
  private shakeX = 0
  private shakeY = 0
  /** Camera center actually applied last frame (after edge clamping). */
  private appliedX = 0
  private appliedY = 0

  snapTo(x: number, y: number): void {
    this.x = x
    this.y = y
  }

  follow(tx: number, ty: number, dt: number): void {
    // Framerate-independent exponential lerp
    const k = 1 - Math.exp(-8 * dt)
    this.x += (tx - this.x) * k
    this.y += (ty - this.y) * k
  }

  shake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag)
  }

  update(dt: number): void {
    if (this.shakeMag > 0.001) {
      // Render-side randomness is fine — this is not the sim.
      this.shakeX = (Math.random() * 2 - 1) * this.shakeMag
      this.shakeY = (Math.random() * 2 - 1) * this.shakeMag
      this.shakeMag *= Math.exp(-6 * dt)
    } else {
      this.shakeX = 0
      this.shakeY = 0
    }
  }

  /** Position the world container so the camera point sits at screen center. */
  apply(world: Container, screenW: number, screenH: number, levelW: number, levelH: number): void {
    const halfW = screenW / 2 / TILE_PX
    const halfH = screenH / 2 / TILE_PX
    // Clamp so we don't show past level edges (unless level smaller than view)
    const cx = levelW * TILE_PX > screenW ? Math.min(Math.max(this.x, halfW), levelW - halfW) : levelW / 2
    const cy = levelH * TILE_PX > screenH ? Math.min(Math.max(this.y, halfH), levelH - halfH) : levelH / 2
    this.appliedX = cx
    this.appliedY = cy
    world.position.set(
      Math.round(screenW / 2 - (cx + this.shakeX) * TILE_PX),
      Math.round(screenH / 2 - (cy + this.shakeY) * TILE_PX),
    )
  }

  /** Visible world-pixel rect for culling. */
  viewRect(screenW: number, screenH: number, out: { x: number; y: number; w: number; h: number }): void {
    out.x = this.appliedX * TILE_PX - screenW / 2 - TILE_PX
    out.y = this.appliedY * TILE_PX - screenH / 2 - TILE_PX
    out.w = screenW + TILE_PX * 2
    out.h = screenH + TILE_PX * 2
  }
}
