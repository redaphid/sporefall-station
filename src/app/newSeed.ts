// "New Seed" is an APP-LAYER concern: the sim is a pure function OF a seed, so
// CHOOSING a fresh one lives here (never in `src/game/`, where Math.random is
// banned for determinism). `pickNewSeed` turns an app-layer random source into a
// 32-bit unsigned seed that is guaranteed DIFFERENT from the current run's seed,
// so "New Seed" always produces a visibly new level rather than replaying the old
// one. The random source is injected so the choice is unit-testable.

/** Largest value a run seed takes (matches `main.ts`'s initial-seed masking). */
const SEED_MASK = 0xffffffff

/**
 * Pick a fresh 32-bit seed distinct from `current`, drawing from `rand` (default
 * `Math.random` — app layer only). Retries a bounded number of times on the
 * astronomically unlikely collision, then falls back to a deterministic ±1 nudge
 * so the result is NEVER equal to `current` even for a degenerate `rand`.
 */
export const pickNewSeed = (current: number, rand: () => number = Math.random): number => {
  const cur = current >>> 0
  for (let i = 0; i < 8; i++) {
    const seed = (rand() * SEED_MASK) >>> 0
    if (seed !== cur) return seed
  }
  // Degenerate rand (always the same value / always 0): guarantee difference.
  return (cur + 1) >>> 0
}
