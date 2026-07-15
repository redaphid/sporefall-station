export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number
  /** True with probability p. */
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
  /** Independent stream derived from this seed + label. Safe to call in any order. */
  fork(label: string): Rng
  /** The internal counter AFTER the last draw. Capture it and pass back as the
   * `state` arg to `mulberry32(seed, state)` to resume this exact stream position
   * — the one hook that makes a serialized world byte-identical on the next tick. */
  state(): number
}

/** FNV-1a string hash, for deriving fork seeds. Exported so a deserialized world
 * can recover a forked stream's seed (`sim:<floor>`) to resume it. */
export const hashLabel = (seed: number, label: string): number => {
  let h = 0x811c9dc5 ^ seed
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export const mulberry32 = (seed: number, state?: number): Rng => {
  const baseSeed = seed >>> 0
  // Resume from a saved counter when given (0 is a valid position, so `??` — not `||`).
  let s = state ?? baseSeed
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    fork: (label) => mulberry32(hashLabel(baseSeed, label)),
    state: () => s,
  }
}
