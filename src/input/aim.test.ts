import { describe, expect, it } from 'vitest'
import { AIM_DEADZONE, padAimReticles, pointerAim, RETICLE_FAR, RETICLE_NEAR, selectAim } from './aim'

describe('selectAim', () => {
  it('uses the aim stick when it is deflected past the deadzone', () => {
    const a = selectAim(1, 0, 0, -0.9)
    expect(a).toEqual({ x: 0, y: -0.9 })
  })

  it('ignores an aim stick still inside the deadzone', () => {
    const a = selectAim(1, 0, 0.05, 0.05)
    expect(a).toEqual({ x: 1, y: 0 })
  })

  it('falls back to the movement vector when there is no aim input', () => {
    const a = selectAim(-0.7, 0.3)
    expect(a).toEqual({ x: -0.7, y: 0.3 })
  })

  it('returns a centred (0,0) vector when neither stick is deflected', () => {
    const a = selectAim(0, 0)
    expect(a).toEqual({ x: 0, y: 0 })
  })
})

describe('pointerAim — the mouse as a continuous aim device', () => {
  it('points from the player toward the cursor as a unit vector', () => {
    const a = pointerAim(100, 100, 200, 100) // cursor due-right
    expect(a.x).toBeCloseTo(1, 6)
    expect(a.y).toBeCloseTo(0, 6)
  })

  it('resolves an ARBITRARY off-axis angle, not one of the 8 compass headings', () => {
    // Cursor 100px right, 30px down → atan2(30,100) ≈ 16.7°, nowhere near a
    // 45°-multiple. The vector must preserve that exact heading.
    const a = pointerAim(0, 0, 100, 30)
    const deg = (Math.atan2(a.y, a.x) * 180) / Math.PI
    expect(deg).toBeCloseTo(16.699, 2)
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(1, 6) // normalized
  })

  it('a sweep of cursor positions yields correspondingly different, non-bucketed headings', () => {
    const degs = [5, 22.5, 61, 100, 143, 199, 271, 340].map((d) => {
      const r = (d * Math.PI) / 180
      const a = pointerAim(0, 0, Math.cos(r) * 50, Math.sin(r) * 50)
      return ((Math.atan2(a.y, a.x) * 180) / Math.PI + 360) % 360
    })
    degs.forEach((got, i) => expect(got).toBeCloseTo([5, 22.5, 61, 100, 143, 199, 271, 340][i], 3))
    expect(new Set(degs.map((d) => Math.round(d))).size).toBe(8) // all distinct
  })

  it('screen +y (down) maps to world +y (down) with no axis flip', () => {
    const a = pointerAim(0, 0, 0, 50) // cursor below the player on screen
    expect(a.y).toBeCloseTo(1, 6)
  })

  it('returns (0,0) when the cursor rests exactly on the player (fallback to move)', () => {
    expect(pointerAim(42, 42, 42, 42)).toEqual({ x: 0, y: 0 })
  })
})

describe('padAimReticles', () => {
  const state = (aimX: number, aimY: number) => ({
    aimX,
    aimY,
  })
  const player = (playerId: number, x: number, y: number, dead = false) => ({ pos: { x, y }, playerId, dead })

  it('shows no reticle for an unjoined pad', () => {
    expect(padAimReticles([{ slot: null, state: state(1, 0) }], [player(0, 5, 5)])).toEqual([])
  })
  it('shows no reticle for a centred aim stick', () => {
    expect(padAimReticles([{ slot: 0, state: state(0, 0) }], [player(0, 5, 5)])).toEqual([])
  })
  it('shows no reticle inside the aim deadzone', () => {
    expect(padAimReticles([{ slot: 0, state: state(AIM_DEADZONE * 0.9, 0) }], [player(0, 5, 5)])).toEqual([])
  })
  it('places the reticle FAR out along the aim direction at full tilt', () => {
    const r = padAimReticles([{ slot: 0, state: state(1, 0) }], [player(0, 10, 5)])
    expect(r).toHaveLength(1)
    expect(r[0].x).toBeCloseTo(10 + RETICLE_FAR, 5)
    expect(r[0].y).toBeCloseTo(5, 5)
  })
  it('eases the distance with stick magnitude (half tilt lands between NEAR and FAR)', () => {
    const r = padAimReticles([{ slot: 0, state: state(0, 0.5) }], [player(0, 10, 5)])
    const dist = RETICLE_NEAR + (RETICLE_FAR - RETICLE_NEAR) * 0.5
    expect(r[0].x).toBeCloseTo(10, 5)
    expect(r[0].y).toBeCloseTo(5 + dist, 5)
  })
  it('clamps an out-of-spec magnitude to FAR', () => {
    const r = padAimReticles([{ slot: 0, state: state(3, 0) }], [player(0, 0, 0)])
    expect(r[0].x).toBeCloseTo(RETICLE_FAR, 5)
  })
  it('anchors to the pad-slot player, not another player', () => {
    const r = padAimReticles([{ slot: 1, state: state(1, 0) }], [player(0, 0, 0), player(1, 20, 20)])
    expect(r[0].x).toBeCloseTo(20 + RETICLE_FAR, 5)
  })
  it('shows nothing for a dead player', () => {
    expect(padAimReticles([{ slot: 0, state: state(1, 0) }], [player(0, 5, 5, true)])).toEqual([])
  })
  it('shows nothing when the slot has no player entity', () => {
    expect(padAimReticles([{ slot: 3, state: state(1, 0) }], [player(0, 5, 5)])).toEqual([])
  })
  it('produces one reticle per aiming pad', () => {
    const pads = [
      { slot: 0, state: state(1, 0) },
      { slot: 1, state: state(0, -1) },
      { slot: 2, state: state(0, 0) },
    ]
    const r = padAimReticles(pads, [player(0, 0, 0), player(1, 10, 10), player(2, 20, 20)])
    expect(r).toHaveLength(2)
  })
})
