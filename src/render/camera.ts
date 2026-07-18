import type { Container } from 'pixi.js'
import { TILE_PX } from './art'
import { decayShake, stackShake } from './juice'
import { anchoredCenter, clampZoom, smoothZoom, ZOOM_DEFAULT } from './zoomModel'

/** How long (s) a zoom gesture pauses player-follow so the anchored world point
 * really stays under the finger/cursor instead of being lerped away mid-gesture. */
const FOLLOW_HOLD_S = 0.3

/** Camera in world (tile) coordinates, applied as a container translation. */
export class Camera {
  x = 0
  y = 0
  /** View-only magnification (1 = native). Scales the world container; the sim
   * is untouched. Interpolates toward `target` each frame (see zoomModel). */
  zoom = 1
  private target = 1
  /** Screen-px anchor the current zoom change pivots around (null = screen centre). */
  private anchorX: number | null = null
  private anchorY = 0
  private followHold = 0
  private zoomDt = 0
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

  /** Current zoom TARGET — what wheel/pinch compound on top of. */
  get zoomTarget(): number {
    return this.target
  }

  /** Smoothly zoom toward `z`, keeping the world point under screen (ax,ay)
   * fixed; omit the anchor to pivot on the screen centre. View-only. */
  setZoom(z: number, ax?: number, ay?: number): void {
    this.target = clampZoom(z)
    if (ax !== undefined && ay !== undefined) {
      this.anchorX = ax
      this.anchorY = ay
      this.followHold = FOLLOW_HOLD_S
    } else {
      this.anchorX = null
    }
  }

  /** Jump straight to a zoom level (boot-time `?zoom=`, test hooks). */
  snapZoom(z: number): void {
    this.zoom = this.target = clampZoom(z)
    this.anchorX = null
  }

  resetZoom(): void {
    this.setZoom(ZOOM_DEFAULT)
  }

  follow(tx: number, ty: number, dt: number): void {
    // An in-flight anchored zoom owns the camera; player-follow resumes after.
    if (this.followHold > 0) return
    // Framerate-independent exponential lerp
    const k = 1 - Math.exp(-8 * dt)
    this.x += (tx - this.x) * k
    this.y += (ty - this.y) * k
  }

  shake(mag: number): void {
    // Additive stacking with a hard clamp (see juice.ts) so a burst of hits
    // adds up but can never fling the camera off-screen.
    this.shakeMag = stackShake(this.shakeMag, mag)
  }

  update(dt: number): void {
    this.zoomDt = dt
    this.followHold = Math.max(0, this.followHold - dt)
    if (this.shakeMag > 0) {
      // Render-side randomness is fine — this is not the sim.
      this.shakeX = (Math.random() * 2 - 1) * this.shakeMag
      this.shakeY = (Math.random() * 2 - 1) * this.shakeMag
      this.shakeMag = decayShake(this.shakeMag, dt)
    } else {
      this.shakeX = 0
      this.shakeY = 0
    }
  }

  /** Position the world container so the camera point sits at screen center. */
  apply(world: Container, screenW: number, screenH: number, levelW: number, levelH: number): void {
    // Step the zoom interpolation here (screen dims are needed for anchoring).
    if (this.zoom !== this.target) {
      const z1 = smoothZoom(this.zoom, this.target, this.zoomDt)
      if (this.anchorX !== null) {
        const c = anchoredCenter(this.x, this.y, this.zoom, z1, this.anchorX, this.anchorY, screenW, screenH)
        this.x = c.x
        this.y = c.y
      }
      this.zoom = z1
    }
    const T = TILE_PX * this.zoom
    if (world.scale.x !== this.zoom) world.scale.set(this.zoom)
    const halfW = screenW / 2 / T
    const halfH = screenH / 2 / T
    // Clamp so we don't show past level edges (unless level smaller than view)
    const cx = levelW * T > screenW ? Math.min(Math.max(this.x, halfW), levelW - halfW) : levelW / 2
    const cy = levelH * T > screenH ? Math.min(Math.max(this.y, halfH), levelH - halfH) : levelH / 2
    this.appliedX = cx
    this.appliedY = cy
    world.position.set(
      Math.round(screenW / 2 - (cx + this.shakeX) * T),
      Math.round(screenH / 2 - (cy + this.shakeY) * T),
    )
  }

  /** Visible world-pixel rect (in unscaled world units) for culling. */
  viewRect(screenW: number, screenH: number, out: { x: number; y: number; w: number; h: number }): void {
    const hw = screenW / 2 / this.zoom
    const hh = screenH / 2 / this.zoom
    out.x = this.appliedX * TILE_PX - hw - TILE_PX
    out.y = this.appliedY * TILE_PX - hh - TILE_PX
    out.w = hw * 2 + TILE_PX * 2
    out.h = hh * 2 + TILE_PX * 2
  }
}
