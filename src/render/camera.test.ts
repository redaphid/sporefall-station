import { describe, expect, it } from 'vitest'
import type { Container } from 'pixi.js'
import { screenToWorld, type CameraState } from '../ui/locatorModel'
import { Camera } from './camera'
import { ZOOM_MAX, ZOOM_MIN } from './zoomModel'

// Minimal Container stand-in — apply() only touches scale + position.
const fakeWorld = (): Container =>
  ({
    scale: {
      x: 1,
      set(v: number) {
        this.x = v
      },
    },
    position: { set() {} },
  }) as unknown as Container

const SCREEN = { w: 800, h: 600 }
const LEVEL = { w: 400, h: 400 }

const camState = (c: Camera): CameraState => ({
  x: c.x,
  y: c.y,
  zoom: c.zoom,
  screenW: SCREEN.w,
  screenH: SCREEN.h,
  levelW: LEVEL.w,
  levelH: LEVEL.h,
})

/** One render frame: update + apply, like renderer.draw does. */
const frame = (c: Camera, world: Container, dt = 1 / 60): void => {
  c.update(dt)
  c.apply(world, SCREEN.w, SCREEN.h, LEVEL.w, LEVEL.h)
}

describe('Camera zoom target + smoothing', () => {
  it('interpolates smoothly to the target — no snapping — and settles exactly', () => {
    const c = new Camera()
    c.snapTo(100, 100)
    const w = fakeWorld()
    c.setZoom(2)
    frame(c, w)
    expect(c.zoom).toBeGreaterThan(1)
    expect(c.zoom).toBeLessThan(2) // mid-flight, not snapped
    for (let i = 0; i < 300; i++) frame(c, w)
    expect(c.zoom).toBe(2)
  })

  it('setZoom clamps; snapZoom is immediate and clamps', () => {
    const c = new Camera()
    c.setZoom(999)
    expect(c.zoomTarget).toBe(ZOOM_MAX)
    c.snapZoom(0.0001)
    expect(c.zoom).toBe(ZOOM_MIN)
    expect(c.zoomTarget).toBe(ZOOM_MIN)
  })

  it('an anchored zoom keeps the world point under the anchor through the WHOLE interpolation', () => {
    const c = new Camera()
    c.snapTo(100, 100)
    const w = fakeWorld()
    const anchor = { x: 620, y: 110 }
    const before = screenToWorld(anchor.x, anchor.y, camState(c))
    c.setZoom(3, anchor.x, anchor.y)
    for (let i = 0; i < 300; i++) {
      frame(c, w)
      const now = screenToWorld(anchor.x, anchor.y, camState(c))
      expect(now.x).toBeCloseTo(before.x, 6)
      expect(now.y).toBeCloseTo(before.y, 6)
    }
    expect(c.zoom).toBe(3)
  })

  it('zooming back out through the same anchor returns pixel-for-pixel', () => {
    const c = new Camera()
    c.snapTo(100, 100)
    const w = fakeWorld()
    const startX = c.x
    c.setZoom(2.5, 700, 500)
    for (let i = 0; i < 300; i++) frame(c, w)
    c.setZoom(1, 700, 500)
    for (let i = 0; i < 300; i++) frame(c, w)
    expect(c.zoom).toBe(1)
    expect(c.x).toBeCloseTo(startX, 6)
  })

  it('follow is held during an anchored zoom, then resumes', () => {
    const c = new Camera()
    c.snapTo(100, 100)
    const w = fakeWorld()
    c.setZoom(2, 0, 0)
    const heldX = c.x
    c.follow(200, 200, 1 / 60)
    expect(c.x).toBe(heldX) // gesture owns the camera
    for (let i = 0; i < 60; i++) frame(c, w) // ~1s ≫ hold window
    const beforeFollow = c.x
    c.follow(200, 200, 1 / 60)
    expect(c.x).toBeGreaterThan(beforeFollow) // follow is back
  })

  it('an unanchored zoom (reset) never blocks follow', () => {
    const c = new Camera()
    c.snapTo(100, 100)
    c.resetZoom()
    c.follow(200, 200, 1 / 60)
    expect(c.x).toBeGreaterThan(100)
  })

  it('hitstop (dt=0 update) freezes the zoom interpolation instead of stepping it', () => {
    const c = new Camera()
    c.snapTo(100, 100)
    const w = fakeWorld()
    c.setZoom(2)
    frame(c, w)
    const mid = c.zoom
    frame(c, w, 0) // frozen frame
    expect(c.zoom).toBe(mid)
  })
})
