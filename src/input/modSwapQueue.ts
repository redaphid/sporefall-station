// Reorder requests from the sequence UI (HUD strip, pause-menu loadout) waiting
// to ride out on the local player's next InputCmd.
//
// A reorder is a player INPUT, not a UI-side edit: it must reach the sim through
// the same per-tick command stream as everything else so recordings, replays
// and the host all see it. The UI only queues it here; `withModSwaps` hands out
// one request per sampled command. While a solo run is paused no command is
// sampled, so queued swaps apply on the first tick after resume.

import { packModSwap } from '../game/systems/modSequence'
import type { InputSource } from './input'

export interface ModSwapQueue {
  /** Queue a swap of mod-list entries `a` and `b` (raw list indices). */
  push(a: number, b: number): void
  /** Swaps queued but not yet handed to a command, oldest first. */
  pending(): readonly { a: number; b: number }[]
  /** Next packed request, or undefined when none is queued. */
  take(): number | undefined
  clear(): void
}

/** Bound on queued swaps, so a stuck UI cannot build an unbounded backlog. */
const MAX_PENDING = 16

export const createModSwapQueue = (): ModSwapQueue => {
  const q: { a: number; b: number }[] = []
  return {
    push(a, b) {
      if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 0 || b < 0 || a > 255 || b > 255) return
      if (q.length < MAX_PENDING) q.push({ a, b })
    },
    pending: () => q,
    take() {
      const next = q.shift()
      return next ? packModSwap(next.a, next.b) : undefined
    },
    clear() {
      q.length = 0
    },
  }
}

/** Wrap an input source so each sampled command carries at most one queued
 * swap. Commands with nothing queued are returned untouched. */
export const withModSwaps = (src: InputSource, queue: ModSwapQueue): InputSource => ({
  sample() {
    const cmd = src.sample()
    const swap = queue.take()
    if (swap !== undefined) cmd.modSwap = swap
    return cmd
  },
})

/** Apply queued swaps to a copy of a mod list, for previewing the order the
 * player has asked for before the sim has applied it (e.g. while paused). */
export const previewSwaps = <T>(mods: readonly T[], swaps: readonly { a: number; b: number }[]): T[] => {
  const out = [...mods]
  for (const { a, b } of swaps) {
    if (a >= out.length || b >= out.length) continue
    const t = out[a]
    out[a] = out[b]
    out[b] = t
  }
  return out
}
