import { describe, expect, it } from 'vitest'
import { DOWNED_COLOR, DOWNED_COLOR_INT, hexColor, playerColor, playerColorInt, SLOT_COLORS } from './playerIdentity'
import { GROUND_SQUASH, markerOrder, markerStyle, type MarkerSubject } from './playerMarkers'

const mate = (slot: number, downed = false): MarkerSubject => ({ slot, self: false, downed })
const me = (slot: number, downed = false): MarkerSubject => ({ slot, self: true, downed })

/** Rec.601 relative luminance 0..255 — the "how bright is this in greyscale"
 * number that decides whether a marker survives a colour-vision deficiency. */
const luma = (c: number): number => 0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff)

describe('playerIdentity', () => {
  it('gives all 8 slots a distinct, stable colour', () => {
    const colors = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(playerColorInt))
    expect(colors.size).toBe(8)
    expect(playerColorInt(3)).toBe(playerColorInt(3))
  })

  it('wraps out-of-range and negative slots instead of throwing', () => {
    expect(playerColorInt(8)).toBe(playerColorInt(0))
    expect(playerColorInt(-1)).toBe(playerColorInt(7))
    expect(playerColorInt(-9)).toBe(playerColorInt(7))
    expect(Number.isFinite(playerColorInt(1e9))).toBe(true)
  })

  it('renders CSS hex the DOM can use, agreeing with the pixi int', () => {
    expect(hexColor(0x5aa9ff)).toBe('#5aa9ff')
    expect(hexColor(0x000fff)).toBe('#000fff') // zero-padded, not '#fff'
    expect(playerColor(0)).toBe(hexColor(SLOT_COLORS[0]))
    expect(DOWNED_COLOR).toBe(hexColor(DOWNED_COLOR_INT))
  })

  it('keeps every slot hue bright enough to survive total desaturation', () => {
    // The palette is the FAST path — with reticle/ticks/label gone, colour
    // (plus the tiny self/downed shape cues) is now doing ALL the work.
    for (const c of SLOT_COLORS) expect(luma(c)).toBeGreaterThan(140)
  })
})

describe('markerStyle - you vs them', () => {
  it('draws the local player white, a teammate in their slot hue', () => {
    expect(markerStyle(me(2)).color).toBe(0xffffff)
    for (let slot = 0; slot < 8; slot++) expect(markerStyle(mate(slot)).color).toBe(playerColorInt(slot))
  })

  it('draws the local player very slightly bigger and louder than a teammate — the only shape cue left', () => {
    const self = markerStyle(me(0))
    const other = markerStyle(mate(1))
    expect(self.radius).toBeGreaterThan(other.radius)
    expect(self.alpha).toBeGreaterThan(other.alpha)
    expect(self.width).toBeGreaterThan(other.width)
  })

  it('keeps rings genuinely tiny — a mark at the feet, not a halo', () => {
    // Regression guard for the actual complaint: earlier sizes (0.62 / 0.46
    // tiles) visibly covered the character. These must stay well under that.
    expect(markerStyle(me(0)).radius).toBeLessThan(0.3)
    expect(markerStyle(mate(0)).radius).toBeLessThan(0.3)
  })
})

describe('markerStyle - downed', () => {
  it('marks downed with a SHAPE (the X) as well as red — the one non-colour cue kept', () => {
    expect(markerStyle(mate(1, true)).cross).toBe(true)
    expect(markerStyle(mate(1, false)).cross).toBe(false)
    expect(markerStyle(me(0, true)).cross).toBe(true)
    expect(markerStyle(mate(1, true)).color).toBe(DOWNED_COLOR_INT)
  })

  it('lets a downed teammate be as loud as you are - it is an emergency', () => {
    expect(markerStyle(mate(1, true)).alpha).toBeGreaterThan(markerStyle(mate(1, false)).alpha)
    expect(markerStyle(mate(1, true)).alpha).toBeGreaterThanOrEqual(markerStyle(me(0)).alpha)
  })

  it('still keeps the downed RING the saturated alarm red for both self and teammates', () => {
    expect(markerStyle(mate(1, true)).color).toBe(DOWNED_COLOR_INT)
    expect(markerStyle(me(0, true)).color).toBe(DOWNED_COLOR_INT)
  })
})

describe('geometry', () => {
  it('squashes rings so they read as lying on the floor', () => {
    expect(GROUND_SQUASH).toBeGreaterThan(0)
    expect(GROUND_SQUASH).toBeLessThan(1)
  })
})

describe('markerOrder', () => {
  it('paints downed last, so the emergency is never buried', () => {
    const out = markerOrder([mate(1, true), mate(2), me(0)])
    expect(out[out.length - 1].downed).toBe(true)
  })

  it('paints you above ordinary teammates', () => {
    const out = markerOrder([me(0), mate(1), mate(2)])
    expect(out[out.length - 1].self).toBe(true)
  })

  it('is stable frame to frame - markers must never flicker in z', () => {
    const crew = [mate(3), mate(1), me(0), mate(2)]
    expect(markerOrder(crew)).toEqual(markerOrder(crew.slice().reverse()))
  })

  it('does not mutate its input', () => {
    const crew = [mate(3), me(0)]
    markerOrder(crew)
    expect(crew[0].slot).toBe(3)
  })

  it('handles an empty crew', () => {
    expect(markerOrder([])).toEqual([])
  })
})
