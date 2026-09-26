import { describe, expect, it } from 'vitest'
import { generateLevel } from '../game/levelgen/generate'
import { STOREY_SIZE, Tile } from '../game/levelgen/level'
import { isLowTile, lowTileCount } from '../game/floorModifiers'
import { BROWNOUT_ALPHA, darknessRuns, easeTide, LAMP_INNER, LAMP_OUTER, lampDarkness, lowTileRuns, TIDE_ALPHA, TIDE_EASE_S } from './modifierLook'

describe('bog tide water', () => {
  it('covers exactly the ground-storey low tiles, as row runs', () => {
    for (const [seed, floor] of [[6, 2], [1, 3], [3, 5]]) {
      const lv = generateLevel(seed, floor)
      const runs = lowTileRuns(lv)
      let covered = 0
      for (const r of runs) {
        expect(r.x + r.w).toBeLessThanOrEqual(STOREY_SIZE)
        for (let x = r.x; x < r.x + r.w; x++) expect(isLowTile(lv.tiles[r.y * lv.w + x])).toBe(true)
        covered += r.w
      }
      expect(covered).toBe(lowTileCount(lv))
    }
  })

  it('a floor with no low ground draws no water', () => {
    const lv = generateLevel(6, 2)
    lv.tiles.fill(Tile.Floor)
    expect(lowTileRuns(lv)).toEqual([])
  })

  it('rises and drains over TIDE_EASE_S, clamped at both ends', () => {
    expect(easeTide(0, true, TIDE_EASE_S / 2)).toBeCloseTo(TIDE_ALPHA / 2)
    expect(easeTide(0, true, TIDE_EASE_S * 3)).toBe(TIDE_ALPHA)
    expect(easeTide(TIDE_ALPHA, false, TIDE_EASE_S * 3)).toBe(0)
    expect(easeTide(0, false, 1)).toBe(0)
  })
})

describe('brownout lamps', () => {
  it('is clear inside the lamp, fully dark past it, and monotonic between', () => {
    expect(lampDarkness(0)).toBe(0)
    expect(lampDarkness(LAMP_INNER)).toBe(0)
    expect(lampDarkness(LAMP_OUTER)).toBe(BROWNOUT_ALPHA)
    expect(lampDarkness(Infinity)).toBe(BROWNOUT_ALPHA)
    let prev = 0
    for (let d = 0; d < LAMP_OUTER + 2; d += 0.25) {
      expect(lampDarkness(d)).toBeGreaterThanOrEqual(prev)
      prev = lampDarkness(d)
    }
  })

  it('leaves a hole round each lamp and darkens the rest of the view', () => {
    const view = { x: 0, y: 0, w: 40, h: 20 }
    const runs = darknessRuns(view, [
      { x: 10.5, y: 10.5 },
      { x: 30.5, y: 10.5 },
    ])
    const alphaAt = (x: number, y: number): number => runs.find((r) => r.y === y && x >= r.x && x < r.x + r.w)?.alpha ?? 0
    expect(alphaAt(10, 10)).toBe(0)
    expect(alphaAt(30, 10)).toBe(0)
    expect(alphaAt(20, 0)).toBe(BROWNOUT_ALPHA)
    expect(alphaAt(0, 19)).toBe(BROWNOUT_ALPHA)
    for (const r of runs) {
      expect(r.w).toBeGreaterThan(0)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(40)
    }
  })

  it('with nobody standing to carry a lamp, the whole view is dark', () => {
    const runs = darknessRuns({ x: 0, y: 0, w: 8, h: 3 }, [])
    expect(runs).toEqual([0, 1, 2].map((y) => ({ x: 0, y, w: 8, alpha: BROWNOUT_ALPHA })))
  })
})
