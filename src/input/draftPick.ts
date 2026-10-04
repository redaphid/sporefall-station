// A tapped or clicked floor-draft card, waiting to ride out on the local
// player's next InputCmd. The pick is a sim input like any other, so the host
// applies it and replays see it; the UI never touches the loadout itself.

import type { InputSource } from './input'

export interface DraftPickSource extends InputSource {
  /** Take card `index` of the local player's hand on the next sampled command. */
  pick(index: number): void
}

export const withDraftPicks = (src: InputSource): DraftPickSource => {
  let queued: number | undefined
  return {
    pick(index) {
      if (Number.isInteger(index) && index >= 0 && index < 0xff) queued = index
    },
    sample() {
      const cmd = src.sample()
      if (queued !== undefined) {
        cmd.draftPick = queued
        queued = undefined
      }
      return cmd
    },
  }
}
