import { emptyInput, type InputCmd } from '../game/types'
import type { InputRecord } from '../net/protocol/messages'

/**
 * How far back, in input seqs, the host still remembers which records it has
 * folded. 256 seqs is 8.5 s of play at 30 Hz. A record older than that is stale
 * and its edges are dropped.
 */
export const EDGE_WINDOW = 256

/**
 * One remote player's input as the host holds it. Continuous state (move, aim,
 * held buttons) and edges (taps) are gated separately:
 *
 * - `latestCmd` takes a record only if its seq is newer than `lastInputSeq`.
 *   An older record is stale movement, and applying it would walk the avatar back.
 * - Edges fire once per record seq, whatever order the records arrive in. A
 *   reliable roll can arrive after a later unreliable input, and a redundant
 *   bundle repeats records the host already folded. `edgeSeen` tells them apart.
 */
export interface InputState {
  /** Newest seq whose continuous state is in `latestCmd`. The snapshot acks it. */
  lastInputSeq: number
  /** Lets any first seq through. */
  hasInput: boolean
  latestCmd: InputCmd
  /** Edge bits folded since the last tick took them. */
  pendingEdges: number
  /** Hotbar slot tapped since the last tick (-1 = none). */
  pendingHotbar: number
  pendingModSwap?: number
  pendingDraftPick?: number
  /** `edgeSeen[seq % EDGE_WINDOW] === seq` iff that record's edges were folded. */
  edgeSeen: Int32Array
}

export const newInputState = (): InputState => ({
  lastInputSeq: 0,
  hasInput: false,
  latestCmd: { ...emptyInput(), aimX: 1 },
  pendingEdges: 0,
  pendingHotbar: -1,
  edgeSeen: new Int32Array(EDGE_WINDOW).fill(-1),
})

/** Forward distance from `from` to `to` on the u16 seq ring. */
const ahead = (to: number, from: number): number => (to - from) & 0xffff

const isNewer = (seq: number, than: number): boolean => {
  const d = ahead(seq, than)
  return d !== 0 && d < 0x8000
}

/** Records may arrive in any order and any number of times. */
export const foldInputRecord = (s: InputState, { cmd, edges }: InputRecord): void => {
  const seq = cmd.seq & 0xffff
  if (!s.hasInput || isNewer(seq, s.lastInputSeq)) {
    // Slide the window: forget the slots the newest seq just moved past, so a
    // seq that comes round again after the u16 wrap is never mistaken for a repeat.
    const span = s.hasInput ? Math.min(ahead(seq, s.lastInputSeq), EDGE_WINDOW) : EDGE_WINDOW
    for (let i = 1; i <= span; i++) {
      const k = (s.lastInputSeq + i) & 0xffff
      if (s.edgeSeen[k % EDGE_WINDOW] === k) s.edgeSeen[k % EDGE_WINDOW] = -1
    }
    s.hasInput = true
    s.lastInputSeq = seq
    s.latestCmd = cmd
  } else if (ahead(s.lastInputSeq, seq) >= EDGE_WINDOW) {
    return
  }
  const slot = seq % EDGE_WINDOW
  if (s.edgeSeen[slot] === seq) return
  s.edgeSeen[slot] = seq
  s.pendingEdges |= edges
  if (cmd.hotbar >= 0) s.pendingHotbar = cmd.hotbar
  if (cmd.modSwap !== undefined) s.pendingModSwap = cmd.modSwap
  if (cmd.draftPick !== undefined) s.pendingDraftPick = cmd.draftPick
}

/** This tick's command: the newest held state plus every edge folded since the
 * last tick, each applied once. Clears the edges. */
export const takeTickInput = (s: InputState): InputCmd => {
  const cmd: InputCmd = { ...s.latestCmd }
  cmd.attack ||= (s.pendingEdges & 1) !== 0
  cmd.interact ||= (s.pendingEdges & 2) !== 0
  cmd.special ||= (s.pendingEdges & 4) !== 0
  cmd.roll = (s.pendingEdges & 8) !== 0
  cmd.throwItem = (s.pendingEdges & 16) !== 0
  cmd.hotbar = s.pendingHotbar
  delete cmd.modSwap
  delete cmd.draftPick
  if (s.pendingModSwap !== undefined) cmd.modSwap = s.pendingModSwap
  if (s.pendingDraftPick !== undefined) cmd.draftPick = s.pendingDraftPick
  s.pendingEdges = 0
  s.pendingHotbar = -1
  s.pendingModSwap = undefined
  s.pendingDraftPick = undefined
  return cmd
}
