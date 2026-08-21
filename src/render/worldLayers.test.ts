import { describe, it, expect } from 'vitest'
import { WORLD_LAYER_ORDER, layerDepth, paintsUnder } from './worldLayers'

describe('world layer order', () => {
  it('keeps player markers ABOVE entities, so furniture cannot swallow a ring', () => {
    // The regression this exists to catch: with markers below the y-sorted
    // entity layer, a desk one tile south of a downed teammate hides the red
    // ring, the X and the "P2 DOWN" label — the whole revive cue.
    expect(paintsUnder('entities', 'playerMarkers')).toBe(true)
  })

  it('keeps player markers BELOW every combat layer, so they cannot out-shout a threat', () => {
    for (const combat of ['statusFx', 'bullets', 'effects']) {
      expect(paintsUnder('playerMarkers', combat)).toBe(true)
    }
  })

  it('keeps the tilemap at the bottom — it is the floor', () => {
    expect(layerDepth('tilemap')).toBe(0)
    for (const above of WORLD_LAYER_ORDER.slice(1)) {
      expect(paintsUnder('tilemap', above)).toBe(true)
    }
  })

  it('mounts every layer exactly once', () => {
    expect(new Set(WORLD_LAYER_ORDER).size).toBe(WORLD_LAYER_ORDER.length)
  })

  it('reports an unmounted layer rather than silently ordering it', () => {
    expect(layerDepth('nope')).toBe(-1)
    expect(paintsUnder('nope', 'entities')).toBe(false)
    expect(paintsUnder('entities', 'nope')).toBe(false)
  })
})
