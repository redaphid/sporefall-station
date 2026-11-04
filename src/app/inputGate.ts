import { emptyInput, type InputCmd } from '../game/types'
import type { InputRecord } from '../net/protocol/messages'

/**
 * How far back, in input seqs, the host still remembers which records it has
 * folded. 256 seqs is 8.5 s of play at 30 Hz. A record older than that is stale
 * and its edges are dropped.
 */
export const EDGE_WINDOW = 256

/** Pure taps: no held state re-conveys them, so each one must reach the sim. */
const TAP_EDGES = 8 | 16

/** Taps waiting for a tick: a few seconds of tapping, far past any real blip. */
const MAX_QUEUED_TAPS = 16

/** One record's pure taps (roll, throw, hotbar, mod swap, draft pick). */
export interface Tap {
  seq: number
  /** Roll 8, Use/Throw 16. */
  edges: number
  hotbar: number
  modSwap?: number
  draftPick?: number
}

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
  /** Attack, interact and special edges folded since the last tick took them.
   * A held bit re-conveys these, so several may share one tick. */
  pendingEdges: number
  /** Records with pure taps, oldest seq first. A tick takes one: taps resent
   * together after a blip would otherwise merge, and a second throw, hotbar
   * change or mod swap would be lost. */
  taps: Tap[]
  /** `edgeSeen[seq % EDGE_WINDOW] === seq` iff that record's edges were folded. */
  edgeSeen: Int32Array
}

export const newInputState = (): InputState => ({
  lastInputSeq: 0,
  hasInput: false,
  latestCmd: { ...emptyInput(), aimX: 1 },
  pendingEdges: 0,
  taps: [],
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
  s.pendingEdges |= edges & ~TAP_EDGES
  if ((edges & TAP_EDGES) === 0 && cmd.hotbar < 0 && cmd.modSwap === undefined && cmd.draftPick === undefined) return
  const tap: Tap = { seq, edges: edges & TAP_EDGES, hotbar: cmd.hotbar }
  if (cmd.modSwap !== undefined) tap.modSwap = cmd.modSwap
  if (cmd.draftPick !== undefined) tap.draftPick = cmd.draftPick
  let at = s.taps.length
  while (at > 0 && isNewer(s.taps[at - 1].seq, seq)) at--
  s.taps.splice(at, 0, tap)
  if (s.taps.length > MAX_QUEUED_TAPS) s.taps.shift()
}

/** This tick's command: the newest held state, the attack/interact/special
 * edges folded since the last tick, and the oldest queued tap, each applied once. */
export const takeTickInput = (s: InputState): InputCmd => {
  const cmd: InputCmd = { ...s.latestCmd }
  cmd.attack ||= (s.pendingEdges & 1) !== 0
  cmd.interact ||= (s.pendingEdges & 2) !== 0
  cmd.special ||= (s.pendingEdges & 4) !== 0
  s.pendingEdges = 0
  const tap = s.taps.shift()
  cmd.roll = ((tap?.edges ?? 0) & 8) !== 0
  cmd.throwItem = ((tap?.edges ?? 0) & 16) !== 0
  cmd.hotbar = tap?.hotbar ?? -1
  delete cmd.modSwap
  delete cmd.draftPick
  if (tap?.modSwap !== undefined) cmd.modSwap = tap.modSwap
  if (tap?.draftPick !== undefined) cmd.draftPick = tap.draftPick
  return cmd
}
