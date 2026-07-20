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

describe('soft edge clamp (corner-spawn framing)', () => {
  // A player standing in the map's NW corner must NOT be pinned to the screen
  // corner under the HUD stack: the clamp allows OVERSCAN_FRAC of the half-view
  // past the level edge, so the corner sits well inside the frame.
  const recWorld = () => {
    const w = {
      pos: { x: 0, y: 0 },
      scale: { x: 1, set(v: number) { this.x = v } },
      position: { set(x: number, y: number) { w.pos.x = x; w.pos.y = y } },
    }
    return w
  }

  it('frames a corner player OVERSCAN_FRAC of the half-view inside the screen', () => {
    const c = new Camera()
    c.snapTo(1.5, 1.5) // world corner (tiles)
    const w = recWorld()
    c.update(1 / 60)
    c.apply(w as never, SCREEN.w, SCREEN.h, LEVEL.w, LEVEL.h)
    const T = 32 // TILE_PX at zoom 1
    const playerScreenX = w.pos.x + 1.5 * T
    const playerScreenY = w.pos.y + 1.5 * T
    // Hard clamp would put the player 48px from the corner; the soft clamp
    // must pull it in by OVERSCAN_FRAC * halfView (= 160px at 800x600).
    expect(playerScreenX).toBe(48 + (SCREEN.w / 2) * Camera.OVERSCAN_FRAC)
    expect(playerScreenY).toBe(48 + (SCREEN.h / 2) * Camera.OVERSCAN_FRAC)
  })

  it('mid-map framing is unchanged: no overscan bias away from the player', () => {
    const c = new Camera()
    c.snapTo(200, 200) // deep inside the 400x400 level
    const w = recWorld()
    c.update(1 / 60)
    c.apply(w as never, SCREEN.w, SCREEN.h, LEVEL.w, LEVEL.h)
    const T = 32
    expect(w.pos.x + 200 * T).toBe(SCREEN.w / 2) // player dead-centre
    expect(w.pos.y + 200 * T).toBe(SCREEN.h / 2)
  })
})

describe('follow smoothness — no pixel-snap jitter (rotoscope regression)', () => {
  // The bug: apply() snapped the world CONTAINER origin to whole screen pixels
  // while every sprite inside sits at a sub-pixel world position. A followed
  // player is ~screen-static with the world scrolling under it, so the
  // round-vs-subpixel residual sawtoothed the player ±0.5px EVERY frame — most
  // visible once the crisp rotoscoped walk cycle shipped. The container must now
  // carry the exact sub-pixel transform; a fixed world point's ON-SCREEN
  // position must be a MONOTONIC function of a monotonically-advancing player,
  // i.e. it may never move backward while the player moves strictly forward.
  const recWorld = () => {
    const w = {
      pos: { x: 0, y: 0 },
      scale: { x: 1, set(v: number) { this.x = v } },
      position: { set(x: number, y: number) { w.pos.x = x; w.pos.y = y } },
    }
    return w
  }

  const TILE_PX = 32 // == art.TILE_PX at zoom 1; screen px per world tile

  // Drive follow+update+apply exactly as renderer.draw does, tracking the
  // on-screen position of the followed world point across the frame sequence.
  const followScreenTrack = (speedTilesPerS: number, dt: number): number[] => {
    const c = new Camera()
    c.snapTo(200, 200) // deep mid-map: no edge clamp interferes
    const w = recWorld()
    let px = 200 // player world-x (tiles), advancing strictly forward
    const track: number[] = []
    for (let f = 0; f < 400; f++) {
      px += speedTilesPerS * dt
      c.follow(px, 200, dt)
      c.update(dt)
      c.apply(w as never, SCREEN.w, SCREEN.h, LEVEL.w, LEVEL.h)
      // Where the player (a fixed sub-pixel world point) actually lands on screen.
      track.push(w.pos.x + px * TILE_PX)
    }
    return track
  }

  it('the followed player never jitters backward while walking forward (multiple speeds/framerates)', () => {
    for (const speed of [1.2, 3, 3.7, 6]) {
      for (const dt of [1 / 60, 1 / 45, 1 / 90]) {
        const track = followScreenTrack(speed, dt)
        // Skip the initial catch-up transient; assert monotonic thereafter.
        for (let i = 51; i < track.length; i++) {
          const step = track[i] - track[i - 1]
          expect(
            step,
            `backward jitter at f=${i} speed=${speed} dt=${dt.toFixed(4)} (step=${step.toFixed(3)}px)`,
          ).toBeGreaterThanOrEqual(-1e-9)
        }
      }
    }
  })

  it('a converged follow leaves the container at the EXACT sub-pixel transform (no ±0.5px snap)', () => {
    const c = new Camera()
    c.snapTo(200, 200)
    const w = recWorld()
    // A deliberately sub-pixel target: 200 + 0.3/32 tile => 0.3px off the grid.
    const tx = 200 + 0.3 / 32
    for (let i = 0; i < 400; i++) {
      c.follow(tx, 200, 1 / 60)
      c.update(1 / 60)
      c.apply(w as never, SCREEN.w, SCREEN.h, LEVEL.w, LEVEL.h)
    }
    // Container must hold the fractional offset, not a rounded integer.
    expect(w.pos.x).toBeCloseTo(SCREEN.w / 2 - tx * TILE_PX, 6)
    expect(Number.isInteger(w.pos.x)).toBe(false)
  })
})
