import { describe, expect, it } from 'vitest'
import { OVERSCAN_FRAC } from '../render/cameraModel'
import {
  DOWNED_COLOR,
  locatorMarkers,
  playerColor,
  pointMarker,
  playerLabel,
  projectToScreen,
  screenToWorld,
  type CameraState,
  type Teammate,
} from './locatorModel'

// TILE_PX = 32. A big level with the camera centred at (50,50) — deep enough
// inside that the edge clamp (halfW = 12.5, halfH = 9.375 tiles) never fires.
const cam = (over: Partial<CameraState> = {}): CameraState => ({
  x: 50,
  y: 50,
  zoom: 1,
  screenW: 800,
  screenH: 600,
  levelW: 100,
  levelH: 100,
  ...over,
})

describe('playerColor / playerLabel', () => {
  it('is stable and distinct per slot, and wraps past the palette', () => {
    expect(playerColor(0)).toBe(playerColor(0))
    expect(playerColor(0)).not.toBe(playerColor(1))
    // All 8 co-op slots (0..7) get distinct hues — no collisions in a full run.
    const colors = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(playerColor))
    expect(colors.size).toBe(8)
    // 8-colour palette → slot 8 wraps back to slot 0's colour.
    expect(playerColor(8)).toBe(playerColor(0))
  })
  it('handles negative slots without indexing off the palette', () => {
    expect(playerColor(-1)).toBe(playerColor(7))
    expect(typeof playerColor(-9)).toBe('string')
  })
  it('labels are 1-based and human-facing', () => {
    expect(playerLabel(0)).toBe('P1')
    expect(playerLabel(3)).toBe('P4')
  })
})

describe('projectToScreen', () => {
  it('maps the camera centre to screen centre', () => {
    const p = projectToScreen(50, 50, cam())
    expect(p).toEqual({ x: 400, y: 300 })
  })
  it('moves +x world east and +y world south by TILE_PX*zoom', () => {
    expect(projectToScreen(51, 50, cam())).toEqual({ x: 432, y: 300 })
    expect(projectToScreen(50, 51, cam())).toEqual({ x: 400, y: 332 })
    // zoom scales the tile size.
    expect(projectToScreen(51, 50, cam({ zoom: 2 }))).toEqual({ x: 464, y: 300 })
  })
  it('clamps the camera at the level edge with the SOFT (overscan) clamp, exactly like Camera.apply', () => {
    // Camera pushed hard into the top-left corner: halfW = 400/32 = 12.5, and
    // the soft clamp allows OVERSCAN_FRAC of the half-view past the edge, so
    // cx clamps to 12.5 - 0.4*12.5 = 7.5 (not the old hard 12.5 — that stale
    // duplicate clamp is exactly what put mission markers on empty ground).
    const p = projectToScreen(0, 0, cam({ x: 0, y: 0 }))
    expect(p.x).toBeCloseTo(400 + (0 - 12.5 * (1 - OVERSCAN_FRAC)) * 32) // = 160
    expect(p.y).toBeCloseTo(300 + (0 - 9.375 * (1 - OVERSCAN_FRAC)) * 32) // halfH = 300/32 = 9.375
  })
  it('centres a level smaller than the viewport instead of clamping', () => {
    // 5x5 level, 800px view → level*T (160) < screenW, so cx = levelW/2 = 2.5.
    const p = projectToScreen(2.5, 2.5, cam({ levelW: 5, levelH: 5, x: 999, y: 999 }))
    expect(p).toEqual({ x: 400, y: 300 })
  })
})

describe('locatorMarkers', () => {
  const self = { x: 50, y: 50 }

  it('returns nothing in solo (no teammates)', () => {
    expect(locatorMarkers(self, [], cam())).toEqual([])
  })

  it('marks a nearby teammate as on-screen with slot colour and label', () => {
    const mates: Teammate[] = [{ playerId: 1, x: 51, y: 50, downed: false }]
    const [m] = locatorMarkers(self, mates, cam())
    expect(m.onScreen).toBe(true)
    expect(m.color).toBe(playerColor(1))
    expect(m.label).toBe('P2')
    expect(m).toMatchObject({ sx: 432, sy: 300 })
  })

  it('turns a far teammate into an edge-pinned arrow with distance and rotation', () => {
    // Due east and far off the right edge.
    const mates: Teammate[] = [{ playerId: 2, x: 80, y: 50, downed: false }]
    const [m] = locatorMarkers(self, mates, cam())
    expect(m.onScreen).toBe(false)
    expect(m.dist).toBe(30)
    expect(m.angle).toBeCloseTo(0) // due east
    // Pinned to the right inset edge (screenW/2 - margin from centre), vertically centred.
    expect(m.sx).toBeCloseTo(800 - 28)
    expect(m.sy).toBeCloseTo(300)
  })

  it('rotates the arrow toward teammates in every quadrant', () => {
    const north = locatorMarkers(self, [{ playerId: 0, x: 50, y: 10, downed: false }], cam())[0]
    const south = locatorMarkers(self, [{ playerId: 0, x: 50, y: 90, downed: false }], cam())[0]
    expect(north.angle).toBeCloseTo(-Math.PI / 2)
    expect(south.angle).toBeCloseTo(Math.PI / 2)
  })

  it('handles several teammates at once', () => {
    const mates: Teammate[] = [
      { playerId: 1, x: 51, y: 50, downed: false }, // on-screen
      { playerId: 2, x: 80, y: 50, downed: false }, // off-screen
      { playerId: 3, x: 49, y: 50, downed: false }, // on-screen
    ]
    const out = locatorMarkers(self, mates, cam())
    expect(out).toHaveLength(3)
    expect(out.filter((m) => m.onScreen)).toHaveLength(2)
    expect(out.filter((m) => !m.onScreen)).toHaveLength(1)
  })

  it('treats a teammate exactly on the on-screen edge margin as on-screen', () => {
    // Place the teammate so its projected x lands exactly on the EDGE_MARGIN (28px).
    // sx = 400 + (wx-50)*32 = 28 → wx = 50 - 372/32.
    const edge = locatorMarkers(self, [{ playerId: 0, x: 50 - 372 / 32, y: 50, downed: false }], cam())[0]
    expect(edge.sx).toBeCloseTo(28)
    expect(edge.onScreen).toBe(true)
    // One pixel further out flips it to an off-screen arrow.
    const off = locatorMarkers(self, [{ playerId: 0, x: 50 - 373 / 32, y: 50, downed: false }], cam())[0]
    expect(off.onScreen).toBe(false)
  })

  it('gives a downed teammate the red high-priority colour and sorts it last (on top)', () => {
    const mates: Teammate[] = [
      { playerId: 1, x: 80, y: 50, downed: true }, // downed, off-screen
      { playerId: 2, x: 51, y: 50, downed: false }, // alive, on-screen
    ]
    const out = locatorMarkers(self, mates, cam())
    // Alive sorts first, downed last so its DOM paints on top.
    expect(out.map((m) => m.downed)).toEqual([false, true])
    const downed = out.find((m) => m.downed)!
    expect(downed.color).toBe(DOWNED_COLOR)
    expect(downed.color).not.toBe(playerColor(1))
  })

  it('degenerate zero-distance (teammate on top of self) stays on-screen at centre', () => {
    const [m] = locatorMarkers(self, [{ playerId: 1, x: 50, y: 50, downed: false }], cam())
    expect(m.dist).toBe(0)
    expect(m.onScreen).toBe(true)
    expect(m).toMatchObject({ sx: 400, sy: 300 })
    expect(Number.isFinite(m.angle)).toBe(true) // atan2(0,0) === 0, not NaN
  })

  it('skips teammates with non-finite positions (NaN guard)', () => {
    const mates: Teammate[] = [
      { playerId: 1, x: NaN, y: 50, downed: false },
      { playerId: 2, x: 51, y: Infinity, downed: false },
      { playerId: 3, x: 51, y: 50, downed: false },
    ]
    const out = locatorMarkers(self, mates, cam())
    expect(out.map((m) => m.playerId)).toEqual([3])
  })

  it('returns nothing when self position is non-finite', () => {
    expect(locatorMarkers({ x: NaN, y: 0 }, [{ playerId: 1, x: 1, y: 1, downed: false }], cam())).toEqual([])
  })

  it('never emits a NaN screen coordinate even on a zero-size viewport', () => {
    const mates: Teammate[] = [{ playerId: 1, x: 80, y: 50, downed: false }]
    const [m] = locatorMarkers(self, mates, cam({ screenW: 0, screenH: 0 }))
    expect(Number.isFinite(m.sx)).toBe(true)
    expect(Number.isFinite(m.sy)).toBe(true)
  })
})

describe('screenToWorld — inverse of projectToScreen (tap → world point)', () => {
  it('round-trips a world point through project → screen → world', () => {
    const c = cam()
    const p = projectToScreen(52, 48, c)
    const back = screenToWorld(p.x, p.y, c)
    expect(back.x).toBeCloseTo(52, 6)
    expect(back.y).toBeCloseTo(48, 6)
  })

  it('maps screen centre to the (clamped) camera centre', () => {
    const c = cam()
    const w = screenToWorld(c.screenW / 2, c.screenH / 2, c)
    expect(w.x).toBeCloseTo(50, 6)
    expect(w.y).toBeCloseTo(50, 6)
  })

  it('respects the edge clamp exactly (matches projectToScreen at a corner)', () => {
    // Camera pushed hard against the level edge so the clamp fires.
    const c = cam({ x: 0, y: 0 })
    const p = projectToScreen(3, 4, c)
    const back = screenToWorld(p.x, p.y, c)
    expect(back.x).toBeCloseTo(3, 6)
    expect(back.y).toBeCloseTo(4, 6)
  })
})

describe('pointMarker (mission-objective / generic point locator)', () => {
  // cam(): centre (50,50), 800x600, TILE_PX 32 → visible half-extent 12.5 x 9.375
  // tiles; EDGE_MARGIN 28px insets the on-screen band.
  it('an on-screen point projects to its screen position with self-relative angle/dist', () => {
    const m = pointMarker({ x: 50, y: 50 }, { x: 52, y: 50 }, cam())
    expect(m).toMatchObject({ onScreen: true, sx: 464, sy: 300, dist: 2 })
    expect(m!.angle).toBeCloseTo(0) // due east
  })

  it('pins an off-screen point to each screen edge (E/W/N/S), inset by the margin', () => {
    const c = cam()
    const east = pointMarker({ x: 50, y: 50 }, { x: 90, y: 50 }, c)!
    expect(east.onScreen).toBe(false)
    expect(east.sx).toBe(800 - 28)
    expect(east.sy).toBe(300)
    const west = pointMarker({ x: 50, y: 50 }, { x: 10, y: 50 }, c)!
    expect(west.sx).toBe(28)
    const north = pointMarker({ x: 50, y: 50 }, { x: 50, y: 10 }, c)!
    expect(north.sy).toBe(28)
    expect(north.sx).toBe(400)
    const south = pointMarker({ x: 50, y: 50 }, { x: 50, y: 90 }, c)!
    expect(south.sy).toBe(600 - 28)
  })

  it('a diagonal off-screen point lands in the matching inset corner region', () => {
    const m = pointMarker({ x: 50, y: 50 }, { x: 90, y: 90 }, cam())!
    expect(m.onScreen).toBe(false)
    // 45° ray: hits the shorter (vertical) half-extent first → pinned at the
    // bottom edge, x short of the corner but past centre.
    expect(m.sy).toBe(600 - 28)
    expect(m.sx).toBeGreaterThan(400)
    expect(m.sx).toBeLessThanOrEqual(800 - 28)
    expect(m.angle).toBeCloseTo(Math.PI / 4)
  })

  it('all four corners point outward with the right angle sign', () => {
    const c = cam()
    for (const [tx, ty] of [
      [90, 90],
      [10, 90],
      [10, 10],
      [90, 10],
    ]) {
      const m = pointMarker({ x: 50, y: 50 }, { x: tx, y: ty }, c)!
      expect(m.onScreen).toBe(false)
      expect(Math.sign(Math.cos(m.angle))).toBe(Math.sign(tx - 50))
      expect(Math.sign(Math.sin(m.angle))).toBe(Math.sign(ty - 50))
    }
  })

  it('distance is measured from the FROM point (the player), rounded', () => {
    const m = pointMarker({ x: 0, y: 0 }, { x: 3, y: 4 }, cam())!
    expect(m.dist).toBe(5)
  })

  it('a point just inside the edge margin counts as off-screen (marker never clips)', () => {
    // 12.5 tiles ≈ the exact screen edge; 12 tiles = 16px from the edge < 28px margin.
    const m = pointMarker({ x: 50, y: 50 }, { x: 62, y: 50 }, cam())!
    expect(m.onScreen).toBe(false)
  })

  it('rejects non-finite inputs outright (never a NaN-positioned DOM node)', () => {
    expect(pointMarker({ x: NaN, y: 50 }, { x: 52, y: 50 }, cam())).toBeUndefined()
    expect(pointMarker({ x: 50, y: 50 }, { x: Infinity, y: 50 }, cam())).toBeUndefined()
    expect(pointMarker({ x: 50, y: 50 }, { x: 52, y: NaN }, cam())).toBeUndefined()
  })

  it('a degenerate zero-size screen still yields a finite anchor', () => {
    const m = pointMarker({ x: 50, y: 50 }, { x: 90, y: 50 }, cam({ screenW: 0, screenH: 0 }))!
    expect(Number.isFinite(m.sx)).toBe(true)
    expect(Number.isFinite(m.sy)).toBe(true)
  })

  it('the target sitting exactly ON the player still works (angle 0, dist 0, on-screen)', () => {
    const m = pointMarker({ x: 50, y: 50 }, { x: 50, y: 50 }, cam())!
    expect(m.onScreen).toBe(true)
    expect(m.dist).toBe(0)
  })
})
