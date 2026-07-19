import type { Rng } from '../rng'

/** Width of the road ring around the map edge. */
export const BORDER = 2
/** Width of streets between lots. */
export const STREET_W = 3

export interface Seg {
  start: number
  size: number
}

/**
 * Partition one axis of the map interior into lot segments separated by streets.
 * Deterministic: lot count per axis drawn from [minLots, maxLots], jittered sizes.
 */
export const cutLots = (rng: Rng, total: number, minLots = 3, maxLots = 4): Seg[] => {
  const interior = total - BORDER * 2
  const nLots = rng.int(minLots, maxLots)
  const space = interior - (nLots - 1) * STREET_W
  const base = Math.floor(space / nLots)
  const sizes = Array.from({ length: nLots }, (_, i) => base + (i < space - base * nLots ? 1 : 0))
  for (let i = 0; i < nLots - 1; i++) {
    const d = rng.int(-2, 2)
    if (sizes[i] + d >= 8 && sizes[i + 1] - d >= 8) {
      sizes[i] += d
      sizes[i + 1] -= d
    }
  }
  const segs: Seg[] = []
  let pos = BORDER
  for (const size of sizes) {
    segs.push({ start: pos, size })
    pos += size + STREET_W
  }
  return segs
}

/** Narrow alley · standard street · wide boulevard (tile widths). */
export const ALLEY_W = 2
export const BOULEVARD_W = 5

/**
 * Themed-floor lot cutter: like `cutLots`, but each street between lots rolls
 * its own width — occasional wide boulevards and tight alleys, so districts
 * stop reading as a uniform grid. Falls back to uniform streets if the varied
 * widths would squeeze any lot under the 8-tile minimum, so connectivity and
 * buildable lots are always preserved. Floor 1 never calls this (frozen).
 */
export const cutLotsVaried = (rng: Rng, total: number, minLots = 3, maxLots = 4): Seg[] => {
  const interior = total - BORDER * 2
  const nLots = rng.int(minLots, maxLots)
  // One roll per gap, drawn unconditionally so the stream position is stable.
  const gaps = Array.from({ length: nLots - 1 }, () => {
    const r = rng.next()
    return r < 0.18 ? BOULEVARD_W : r < 0.42 ? ALLEY_W : STREET_W
  })
  let gapSum = gaps.reduce((s, g) => s + g, 0)
  if (interior - gapSum < nLots * 8) {
    gaps.fill(STREET_W)
    gapSum = (nLots - 1) * STREET_W
  }
  const space = interior - gapSum
  const base = Math.floor(space / nLots)
  const sizes = Array.from({ length: nLots }, (_, i) => base + (i < space - base * nLots ? 1 : 0))
  for (let i = 0; i < nLots - 1; i++) {
    const d = rng.int(-2, 2)
    if (sizes[i] + d >= 8 && sizes[i + 1] - d >= 8) {
      sizes[i] += d
      sizes[i + 1] -= d
    }
  }
  const segs: Seg[] = []
  let pos = BORDER
  for (let i = 0; i < nLots; i++) {
    segs.push({ start: pos, size: sizes[i] })
    pos += sizes[i] + (gaps[i] ?? 0)
  }
  return segs
}
