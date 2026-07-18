import { describe, expect, it } from 'vitest'
import { projectToScreen, screenToWorld, type CameraState } from '../ui/locatorModel'
import {
  anchoredCenter,
  clampZoom,
  pinchZoom,
  smoothZoom,
  wheelZoomFactor,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
} from './zoomModel'

// A big level with the camera deep inside so the edge clamp in project/unproject
// never fires — anchoring math is exact away from level borders.
const cam = (over: Partial<CameraState> = {}): CameraState => ({
  x: 100,
  y: 100,
  zoom: 1,
  screenW: 800,
  screenH: 600,
  levelW: 400,
  levelH: 400,
  ...over,
})

describe('clampZoom', () => {
  it('clamps both ends and passes the interior through', () => {
    expect(clampZoom(ZOOM_MIN - 5)).toBe(ZOOM_MIN)
    expect(clampZoom(0)).toBe(ZOOM_MIN)
    expect(clampZoom(ZOOM_MAX + 100)).toBe(ZOOM_MAX)
    expect(clampZoom(1.7)).toBe(1.7)
    expect(clampZoom(ZOOM_MIN)).toBe(ZOOM_MIN)
    expect(clampZoom(ZOOM_MAX)).toBe(ZOOM_MAX)
  })
  it('rejects garbage (NaN/Infinity) with the default, never propagating it', () => {
    expect(clampZoom(NaN)).toBe(ZOOM_DEFAULT)
    expect(clampZoom(Infinity)).toBe(ZOOM_MAX)
    expect(clampZoom(-Infinity)).toBe(ZOOM_MIN)
  })
})

describe('wheelZoomFactor', () => {
  it('scroll up zooms in, scroll down zooms out, zero is identity', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
    expect(wheelZoomFactor(0)).toBe(1)
  })
  it('accumulates multiplicatively: N notches compose, in/out are exact inverses', () => {
    const one = wheelZoomFactor(-100)
    let z = 1
    for (let i = 0; i < 5; i++) z *= wheelZoomFactor(-100)
    expect(z).toBeCloseTo(one ** 5, 12)
    // Wheel down the same amount undoes wheel up exactly.
    expect(wheelZoomFactor(-137) * wheelZoomFactor(137)).toBeCloseTo(1, 12)
  })
  it('normalises line- and page-mode deltas to pixel scale', () => {
    // 3 lines ≈ 48px, 1 page ≈ 120px — same formula after normalisation.
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48, 0), 12)
    expect(wheelZoomFactor(1, 2)).toBeCloseTo(wheelZoomFactor(120, 0), 12)
  })
})

describe('pinchZoom', () => {
  it('scales zoom by the finger-spread ratio', () => {
    expect(pinchZoom(1, 100, 200)).toBe(2)
    expect(pinchZoom(2, 100, 50)).toBe(1)
    expect(pinchZoom(1.5, 80, 80)).toBe(1.5)
  })
  it('clamps at both ends', () => {
    expect(pinchZoom(1, 10, 10000)).toBe(ZOOM_MAX)
    expect(pinchZoom(1, 10000, 10)).toBe(ZOOM_MIN)
  })
  it('degenerate spreads (0 or negative) return the clamped start zoom, never NaN', () => {
    expect(pinchZoom(1.3, 0, 50)).toBe(1.3)
    expect(pinchZoom(1.3, 50, 0)).toBe(1.3)
    expect(pinchZoom(99, 0, 0)).toBe(ZOOM_MAX)
  })
})

describe('smoothZoom', () => {
  it('moves toward the target without overshooting, from either side', () => {
    const up = smoothZoom(1, 2, 1 / 60)
    expect(up).toBeGreaterThan(1)
    expect(up).toBeLessThan(2)
    const down = smoothZoom(2, 1, 1 / 60)
    expect(down).toBeLessThan(2)
    expect(down).toBeGreaterThan(1)
  })
  it('converges and snaps exactly to the target (no eternal asymptote)', () => {
    let z = 1
    for (let i = 0; i < 300; i++) z = smoothZoom(z, 3, 1 / 60)
    expect(z).toBe(3)
  })
  it('dt=0 (hitstop) freezes the interpolation', () => {
    expect(smoothZoom(1.5, 3, 0)).toBe(1.5)
  })
})

describe('anchoredCenter — the world point under the anchor never moves', () => {
  const zoomPairs: [number, number][] = [
    [1, 2],
    [2, 1],
    [0.5, 3.7],
    [ZOOM_MIN, ZOOM_MAX],
    [ZOOM_MAX, ZOOM_MIN],
  ]
  const anchors = [
    { ax: 400, ay: 300 }, // screen centre
    { ax: 0, ay: 0 }, // corner
    { ax: 800, ay: 600 }, // opposite corner
    { ax: 123, ay: 517 }, // arbitrary
  ]
  it('holds the anchored world point invariant across every zoom step and anchor', () => {
    for (const [z0, z1] of zoomPairs) {
      for (const { ax, ay } of anchors) {
        const before = cam({ zoom: z0 })
        const world = screenToWorld(ax, ay, before)
        const c = anchoredCenter(before.x, before.y, z0, z1, ax, ay, before.screenW, before.screenH)
        const after = cam({ x: c.x, y: c.y, zoom: z1 })
        const back = projectToScreen(world.x, world.y, after)
        expect(back.x).toBeCloseTo(ax, 8)
        expect(back.y).toBeCloseTo(ay, 8)
      }
    }
  })
  it('a centre anchor never moves the camera at all', () => {
    const c = anchoredCenter(100, 100, 1, 3, 400, 300, 800, 600)
    expect(c.x).toBe(100)
    expect(c.y).toBe(100)
  })
  it('identity zoom step is a no-op for any anchor', () => {
    const c = anchoredCenter(100, 100, 2, 2, 13, 570, 800, 600)
    expect(c.x).toBe(100)
    expect(c.y).toBe(100)
  })
})

describe('world↔screen round-trips across the zoom range', () => {
  it('projectToScreen(screenToWorld(p)) === p at every zoom', () => {
    for (const zoom of [ZOOM_MIN, 0.75, 1, 1.5, 2, 3, ZOOM_MAX]) {
      const c = cam({ zoom })
      for (const [sx, sy] of [
        [0, 0],
        [400, 300],
        [800, 600],
        [17, 593],
      ]) {
        const w = screenToWorld(sx, sy, c)
        const s = projectToScreen(w.x, w.y, c)
        expect(s.x).toBeCloseTo(sx, 8)
        expect(s.y).toBeCloseTo(sy, 8)
      }
    }
  })
  it('round-trips still agree when the edge clamp is active (small level, zoomed out)', () => {
    // 20×15-tile level, 800×600 screen at zoom 0.5 → level smaller than the view:
    // the projection pins to the level centre; round-trip must still be exact.
    const c = cam({ x: 2, y: 2, zoom: 0.5, levelW: 20, levelH: 15 })
    const w = screenToWorld(100, 100, c)
    const s = projectToScreen(w.x, w.y, c)
    expect(s.x).toBeCloseTo(100, 8)
    expect(s.y).toBeCloseTo(100, 8)
  })
})
