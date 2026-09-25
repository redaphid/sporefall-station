// THE regression suite for "the mission icon points at empty ground" (mission
// marker drift near map corners). The DOM overlays (mission 🎯 caret / edge
// arrow, teammate locator, tap-to-inspect) project world→screen through
// locatorModel; the world itself is drawn through Camera.apply. Those two
// transforms MUST agree everywhere — especially at map edges/corners, where the
// soft overscan clamp fires and any duplicated clamp math diverges by up to
// OVERSCAN_FRAC * half-view (20% of the screen per axis at the default 0.4).
import { describe, expect, it } from 'vitest'
import { Camera } from '../render/camera'
import { TILE_PX } from '../render/art'
import { projectToScreen, screenToWorld, type CameraState } from './locatorModel'

const SCREEN = { w: 800, h: 600 }
const LEVEL = { w: 64, h: 64 } // matches the game's LEVEL_W/H

/** Recording Container stand-in — apply() only touches scale + position. */
const recWorld = () => {
  const w = {
    pos: { x: 0, y: 0 },
    scale: {
      x: 1,
      set(v: number) {
        this.x = v
      },
    },
    position: {
      set(x: number, y: number) {
        w.pos.x = x
        w.pos.y = y
      },
    },
  }
  return w
}

/** Where Camera.apply ACTUALLY renders world point (wx,wy), in screen px. */
const renderedScreenPos = (camX: number, camY: number, zoom: number, wx: number, wy: number): { x: number; y: number } => {
  const c = new Camera()
  c.snapTo(camX, camY)
  c.snapZoom(zoom)
  const w = recWorld()
  c.update(1 / 60)
  c.apply(w as never, SCREEN.w, SCREEN.h, LEVEL.w, LEVEL.h)
  const T = TILE_PX * zoom
  return { x: w.pos.x + wx * T, y: w.pos.y + wy * T }
}

const camState = (x: number, y: number, zoom: number): CameraState => ({
  x,
  y,
  zoom,
  screenW: SCREEN.w,
  screenH: SCREEN.h,
  levelW: LEVEL.w,
  levelH: LEVEL.h,
})

// Camera pinned into all four map corners, the centre, and the edge midlines —
// the corner cases are where the overscan clamp maximally reshapes the view.
const CAMERA_SPOTS = [
  { name: 'NW corner', x: 1.5, y: 1.5 },
  { name: 'NE corner', x: LEVEL.w - 1.5, y: 1.5 },
  { name: 'SW corner', x: 1.5, y: LEVEL.h - 1.5 },
  { name: 'SE corner (the reported bug spot)', x: LEVEL.w - 1.5, y: LEVEL.h - 1.5 },
  { name: 'centre', x: LEVEL.w / 2, y: LEVEL.h / 2 },
  { name: 'east edge', x: LEVEL.w - 1.5, y: LEVEL.h / 2 },
  { name: 'south edge', x: LEVEL.w / 2, y: LEVEL.h - 1.5 },
] as const

const ZOOMS = [0.75, 1, 1.5, 2] as const

describe('marker projection matches the rendered world transform (Camera.apply parity)', () => {
  for (const spot of CAMERA_SPOTS) {
    for (const zoom of ZOOMS) {
      it(`camera at ${spot.name}, zoom ${zoom}: projectToScreen == rendered position`, () => {
        // Probe assorted world points, including the exact camera target and
        // the map's extreme corners (exit tile country).
        const points = [
          { x: spot.x, y: spot.y },
          { x: LEVEL.w - 2 + 0.5, y: LEVEL.h - 2 + 0.5 }, // floor-1 exit tile centre
          { x: 1.5, y: 1.5 },
          { x: LEVEL.w / 2, y: LEVEL.h / 2 },
          { x: LEVEL.w - 5.25, y: LEVEL.h - 7.75 },
        ]
        for (const p of points) {
          const rendered = renderedScreenPos(spot.x, spot.y, zoom, p.x, p.y)
          const projected = projectToScreen(p.x, p.y, camState(spot.x, spot.y, zoom))
          // Camera.apply rounds the container to whole px; allow that 1px.
          expect(Math.abs(projected.x - rendered.x)).toBeLessThanOrEqual(1)
          expect(Math.abs(projected.y - rendered.y)).toBeLessThanOrEqual(1)
        }
      })
    }
  }

  it('screenToWorld inverts projectToScreen in the corner-clamped view too', () => {
    for (const spot of CAMERA_SPOTS) {
      const st = camState(spot.x, spot.y, 1)
      for (const p of [
        { x: LEVEL.w - 1.5, y: LEVEL.h - 1.5 },
        { x: 3.25, y: 60.5 },
      ]) {
        const s = projectToScreen(p.x, p.y, st)
        const back = screenToWorld(s.x, s.y, st)
        expect(back.x).toBeCloseTo(p.x, 6)
        expect(back.y).toBeCloseTo(p.y, 6)
      }
    }
  })

  it('REGRESSION: a target at the SE map corner gets its marker ON the target, not past it', () => {
    // Before the fix, the overlay re-derived the camera clamp WITHOUT the
    // overscan slack; with the camera pinned SE the marker sat a full
    // OVERSCAN_FRAC * half-view (160px x 120px at 800x600) south-east of the
    // real target — i.e. hovering over empty ground near the exit corner.
    const target = { x: LEVEL.w - 2 + 0.5, y: LEVEL.h - 2 + 0.5 }
    const spot = { x: LEVEL.w - 1.5, y: LEVEL.h - 1.5 }
    const rendered = renderedScreenPos(spot.x, spot.y, 1, target.x, target.y)
    const projected = projectToScreen(target.x, target.y, camState(spot.x, spot.y, 1))
    expect(Math.abs(projected.x - rendered.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(projected.y - rendered.y)).toBeLessThanOrEqual(1)
  })
})

// Storeys (stairs spec §3.5): on a multi-storey floor the clamp rect is the
// viewer's storey in the atlas (x0 = 80 for the loft), and the DOM projection
// must still agree with the render there, corners included.
describe('camera parity — the loft storey rect (x0 = 80)', () => {
  const X0 = 80
  const rendered = (camX: number, camY: number, zoom: number, wx: number, wy: number): { x: number; y: number } => {
    const c = new Camera()
    c.snapTo(camX, camY)
    c.snapZoom(zoom)
    const w = recWorld()
    c.update(1 / 60)
    c.apply(w as never, SCREEN.w, SCREEN.h, LEVEL.w, LEVEL.h, X0, 0)
    const T = TILE_PX * zoom
    return { x: w.pos.x + wx * T, y: w.pos.y + wy * T }
  }
  const spots = [
    { x: X0 + 1.5, y: 1.5 },
    { x: X0 + LEVEL.w - 1.5, y: LEVEL.h - 1.5 },
    { x: X0 + LEVEL.w / 2, y: LEVEL.h / 2 },
  ]
  for (const zoom of [0.5, 1, 2])
    for (const s of spots)
      it(`zoom ${zoom} at ${s.x},${s.y}: projection matches the render and never shows the gutter side`, () => {
        const cam: CameraState = { ...camState(s.x, s.y, zoom), levelX0: X0 }
        const p = projectToScreen(s.x, s.y, cam)
        const r = rendered(s.x, s.y, zoom, s.x, s.y)
        expect(p.x).toBeCloseTo(r.x, 6)
        expect(p.y).toBeCloseTo(r.y, 6)
        const back = screenToWorld(p.x, p.y, cam)
        expect(back.x).toBeCloseTo(s.x, 6)
        // The applied centre stays inside the loft's clamp band, never pulled
        // back toward x 0..63 (the old whole-level clamp would have).
        const centre = screenToWorld(SCREEN.w / 2, SCREEN.h / 2, cam)
        expect(centre.x).toBeGreaterThan(X0)
        expect(centre.x).toBeLessThan(X0 + LEVEL.w)
      })
})
