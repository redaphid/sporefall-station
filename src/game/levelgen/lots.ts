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
 * Deterministic: fixed lot count per axis, jittered sizes.
 */
export const cutLots = (rng: Rng, total: number): Seg[] => {
  const interior = total - BORDER * 2
  const nLots = rng.int(3, 4)
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
