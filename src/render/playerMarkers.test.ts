import { describe, expect, it } from 'vitest'
import {
  DOWNED_COLOR,
  DOWNED_COLOR_INT,
  hexColor,
  playerColor,
  playerColorInt,
  playerLabel,
  SELF_LABEL,
  SLOT_COLORS,
} from './playerIdentity'
import {
  breathe,
  DOWNED_LABEL_COLOR,
  GROUND_SQUASH,
  labelRisePx,
  labelScale,
  markerOrder,
  markerStyle,
  PULSE_TICKS,
  reticleTicks,
  type MarkerSubject,
} from './playerMarkers'

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

  it('keeps the numeral UNIQUE past the palette, where the colour has collided', () => {
    // Two players sharing the slot-8/slot-0 hue must not also share the name
    // "P1", or the fallback cue collides at exactly the moment the colour did.
    expect(playerColorInt(8)).toBe(playerColorInt(0))
    expect(playerLabel(8)).not.toBe(playerLabel(0))
    expect(playerLabel(0)).toBe('P1')
    expect(playerLabel(7)).toBe('P8')
  })

  it('renders CSS hex the DOM can use, agreeing with the pixi int', () => {
    expect(hexColor(0x5aa9ff)).toBe('#5aa9ff')
    expect(hexColor(0x000fff)).toBe('#000fff') // zero-padded, not '#fff'
    expect(playerColor(0)).toBe(hexColor(SLOT_COLORS[0]))
    expect(DOWNED_COLOR).toBe(hexColor(DOWNED_COLOR_INT))
  })

  it('keeps every slot hue bright enough to survive total desaturation', () => {
    // The palette is the FAST path; if a hue collapsed into the floor in
    // greyscale the numeral would be doing all the work on its own.
    for (const c of SLOT_COLORS) expect(luma(c)).toBeGreaterThan(140)
  })
})

describe('markerStyle - you vs them', () => {
  it('gives the local player a form no teammate has', () => {
    expect(markerStyle(me(0), 0).reticle).toBe(true)
    for (let slot = 0; slot < 8; slot++) expect(markerStyle(mate(slot), 0).reticle).toBe(false)
  })

  it('names the local player YOU, never a numeral to be read', () => {
    expect(markerStyle(me(4), 0).label).toBe(SELF_LABEL)
    expect(markerStyle(mate(4), 0).label).toBe('P5')
  })

  it('draws the local player bigger and louder than any teammate', () => {
    const self = markerStyle(me(0), 0)
    const other = markerStyle(mate(1), 0)
    expect(self.radius).toBeGreaterThan(other.radius)
    expect(self.alpha).toBeGreaterThan(other.alpha)
    expect(self.width).toBeGreaterThan(other.width)
  })

  it('distinguishes YOU from a teammate with EVERY colour stripped out', () => {
    // The adversarial case: a player with no colour vision at all, and the two
    // markers deliberately drawn from the SAME slot hue. Identity then has to
    // survive on shape and glyph alone.
    const self = markerStyle(me(2), 0)
    const other = markerStyle(mate(2), 0)
    expect(self.reticle).not.toBe(other.reticle)
    expect(self.label).not.toBe(other.label)
    expect(self.radius).not.toBe(other.radius)
  })

  it('keeps your own slot hue on the inner rim, so you learn which colour is you', () => {
    // The off-screen arrows teammates see speak in slot colours; you can only
    // map "the teal arrow" onto yourself if your marker shows teal somewhere.
    expect(markerStyle(me(5), 0).innerColor).toBe(playerColorInt(5))
  })

  it('gives a teammate their slot hue on the ring', () => {
    for (let slot = 0; slot < 8; slot++) expect(markerStyle(mate(slot), 0).color).toBe(playerColorInt(slot))
  })
})

describe('markerStyle - downed', () => {
  it('marks downed with a SHAPE (the X) as well as red', () => {
    expect(markerStyle(mate(1, true), 0).cross).toBe(true)
    expect(markerStyle(mate(1, false), 0).cross).toBe(false)
    expect(markerStyle(mate(1, true), 0).color).toBe(DOWNED_COLOR_INT)
  })

  it('says DOWN in the name too, so the cue never rests on colour alone', () => {
    expect(markerStyle(mate(1, true), 0).label).toBe('P2 DOWN')
    expect(markerStyle(me(0, true), 0).label).toContain('DOWN')
  })

  it('lets a downed teammate be as loud as you are - it is an emergency', () => {
    expect(markerStyle(mate(1, true), 0).alpha).toBeGreaterThan(markerStyle(mate(1, false), 0).alpha)
  })

  it('uses a HIGH-VALUE red for the name so it survives desaturation', () => {
    // Regression guard for a real, observed failure: the saturated ring red has
    // almost exactly the luminance of this game's lit floor, so in a greyscale
    // render the most urgent label on screen was the least readable one.
    expect(luma(DOWNED_LABEL_COLOR)).toBeGreaterThan(luma(DOWNED_COLOR_INT) + 60)
    expect(markerStyle(mate(1, true), 0).labelColor).toBe(DOWNED_LABEL_COLOR)
    expect(markerStyle(me(0, true), 0).labelColor).toBe(DOWNED_LABEL_COLOR)
  })

  it('still keeps the downed RING the saturated alarm red', () => {
    expect(markerStyle(mate(1, true), 0).color).toBe(DOWNED_COLOR_INT)
    expect(markerStyle(me(0, true), 0).color).toBe(DOWNED_COLOR_INT)
  })
})

describe('breathe - the pulse that is yours alone', () => {
  it('is deterministic and periodic, never wall-clock', () => {
    expect(breathe(0)).toBeCloseTo(0)
    expect(breathe(PULSE_TICKS / 2)).toBeCloseTo(1)
    expect(breathe(PULSE_TICKS)).toBeCloseTo(0)
    expect(breathe(7)).toBeCloseTo(breathe(7 + PULSE_TICKS))
  })

  it('stays inside 0..1 for fractional, huge and negative render times', () => {
    for (const t of [-1000, -0.5, 0.5, 12.3, 1e6]) {
      expect(breathe(t)).toBeGreaterThanOrEqual(0)
      expect(breathe(t)).toBeLessThanOrEqual(1)
    }
  })

  it('moves ONLY the local player, so a crowded screen has one moving marker', () => {
    const low = markerStyle(me(0), 0).radius
    const high = markerStyle(me(0), PULSE_TICKS / 2).radius
    expect(high).toBeGreaterThan(low)
    expect(markerStyle(mate(0), 0).radius).toBe(markerStyle(mate(0), PULSE_TICKS / 2).radius)
  })
})

describe('geometry', () => {
  it('squashes rings so they read as lying on the floor', () => {
    expect(GROUND_SQUASH).toBeGreaterThan(0)
    expect(GROUND_SQUASH).toBeLessThan(1)
  })

  it('puts the name on its own ring, not floating over the head', () => {
    // A name lifted clear of its own head lands on the head of whoever stands
    // behind - the bug that made `P3` look like it labelled an enemy. Staying
    // under a character height (48px) glues the name to its marker instead.
    const self = labelRisePx(markerStyle(me(0), 0), 32)
    const other = labelRisePx(markerStyle(mate(1), 0), 32)
    expect(other).toBeGreaterThan(0)
    expect(self).toBeGreaterThan(other) // the bigger ring pushes its name higher
    expect(self).toBeLessThan(48)
  })

  it('emits four CARDINAL ticks, pointing outward from the ring', () => {
    const ticks = reticleTicks(100, 200, 0.6, 32)
    expect(ticks).toHaveLength(4)
    for (const t of ticks) {
      const inner = Math.hypot(t.x1 - 100, t.y1 - 200)
      const outer = Math.hypot(t.x2 - 100, t.y2 - 200)
      expect(outer).toBeGreaterThan(inner)
    }
    // Two horizontal, two vertical - a compass rose, not a sparkle.
    expect(ticks.filter((t) => t.y1 === t.y2)).toHaveLength(2)
    expect(ticks.filter((t) => t.x1 === t.x2)).toHaveLength(2)
  })
})

describe('labelScale', () => {
  it('holds the name at a constant on-screen size while zoomed IN', () => {
    for (const z of [1, 2, 4]) expect(labelScale(z) * z).toBeCloseTo(1)
  })

  it('caps the compensation zoomed OUT, so eight names do not fuse into a stripe', () => {
    expect(labelScale(0.5)).toBe(1.6)
    expect(labelScale(0.5)).toBeLessThan(1 / 0.5)
    // ...but never lets the name shrink away with the world either.
    expect(labelScale(0.5)).toBeGreaterThan(1)
  })

  it('survives a degenerate zoom rather than emitting NaN/Infinity transforms', () => {
    for (const z of [0, -1, NaN]) expect(Number.isFinite(labelScale(z))).toBe(true)
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

// --- Absolute magnitudes. The relative invariants above (self > mate, downed
// loudest) all still hold when every marker is toned down to nothing, so they
// pass while the feature quietly disappears on screen. These pin the floor.
//
// ZOOM_MIN is 0.5 (zoomModel.ts), so one world px is half a CSS px in the
// zoomed-out "where is my crew" view — which is exactly the view the markers
// exist for, and the one that goes sub-pixel first.
describe('toned down, not toned out', () => {
  const ZOOM_MIN = 0.5
  const TILE_PX = 32

  it('keeps a teammate ring visible even when zoomed out AND cloaked', () => {
    const mateAlpha = markerStyle(mate(1), 0).alpha
    // Cloak multiplies the marker alpha by itself (~0.45), so an already-faint
    // ring compounds to nothing. 0.45 x 0.45 = 0.2 was the shipped low.
    expect(mateAlpha).toBeGreaterThanOrEqual(0.55)
    expect(mateAlpha * 0.45).toBeGreaterThan(0.25)
  })

  it('keeps a teammate stroke above a CSS pixel at ZOOM_MIN', () => {
    expect(markerStyle(mate(1), 0).width * ZOOM_MIN).toBeGreaterThanOrEqual(0.85)
  })

  it('never lets a downed teammate outshout YOU - that inverts "which one is me"', () => {
    const self = markerStyle(me(0), 0).alpha
    const downedMate = markerStyle(mate(1, true), 0).alpha
    // "As loud as yours" means EQUAL. Louder is a different bug wearing the
    // same words, and the alpha drives the name and shadow as well as the ring.
    expect(downedMate).toBeLessThanOrEqual(self)
    expect(downedMate).toBe(self)
  })

  it('keeps a downed teammate as loud as YOU, still louder than an upright one', () => {
    expect(markerStyle(mate(1, true), 0).alpha).toBeGreaterThan(markerStyle(mate(1), 0).alpha)
  })

  it('keeps the breathe SWELL perceptible, not merely non-zero', () => {
    // The swell is a fraction OF the radius, so shrinking the ring shrinks the
    // pulse too; cutting both at once left ~0.2 CSS px of movement, which reads
    // as a still marker. Guard the world-px travel, not just high > low.
    const low = markerStyle(me(0), 0).radius
    const high = markerStyle(me(0), PULSE_TICKS / 2).radius
    expect((high - low) * TILE_PX).toBeGreaterThanOrEqual(1)
  })

  it('does NOT drag the name down into the chest as the ring shrinks', () => {
    // The rise is measured from the FEET, so a smaller ring lowers the name.
    // The torso is drawn foot-28 .. foot-9: a name whose baseline falls much
    // below ~13px up is laid across the character it labels.
    expect(labelRisePx(markerStyle(me(0), 0), TILE_PX)).toBeGreaterThanOrEqual(13)
    expect(labelRisePx(markerStyle(mate(1), 0), TILE_PX)).toBeGreaterThanOrEqual(11)
  })
})
