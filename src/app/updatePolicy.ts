// WHEN a downloaded update is allowed to take effect.
//
// This module is the ONE place that answers that question. Both platforms use
// it — the browser (service worker, src/app/webUpdate.ts) and the installed
// Android app (Capgo, src/app/ota.ts) — so "up to date" means the same thing
// everywhere and there is a single list to read, review and change.
//
// The rule the player experiences: **the update is automatic and they never tap
// anything.** It lands the moment they are somewhere a reload costs nothing —
// immediately if they are sitting in a menu, otherwise at the next natural
// break. It deliberately does NOT land the instant the download finishes,
// because that eventually falls mid-fight, and in co-op it would take their
// friends' session down with them.
//
// If that judgement were scattered across the codebase it would drift and
// someone would eventually get reloaded during a boss. So it lives here, as a
// short enumerated list next to the single predicate that reads it, and
// `updatePolicy.test.ts` asserts the NEGATIVE property: an update can never be
// applied at a moment outside that list.

/**
 * Every moment the app can report. Exhaustive on purpose: a new moment must be
 * added here, which forces an explicit safe/unsafe decision (and trips the
 * partition test below if nobody made one).
 */
export const UPDATE_MOMENTS = [
  /** The boot Solo/Host/Join picker. No run exists yet. */
  'modePicker',
  /** A co-op lobby, before the host has started the run. */
  'lobby',
  /** The floor just changed — the "FLOOR n" banner moment between levels. */
  'floorTransition',
  /** The run-over / downed / dead overlay is up; this run is already finished. */
  'runOver',
  /** Paused mid-run. Looks like a menu, but a live run is sitting behind it. */
  'paused',
  /** Actively playing. */
  'inRun',
] as const

export type UpdateMoment = (typeof UPDATE_MOMENTS)[number]

/**
 * THE list of moments at which applying an update is safe, in a solo/offline
 * session. Reloading at any of these costs the player nothing:
 *
 * - `modePicker` / `lobby` — no run is in progress at all.
 * - `floorTransition` — the run IS persisted (see `persistence.ts`: solo/host
 *   autosave + the "resumed" toast), so a reload here comes back into the same
 *   run on the same floor. This is the "natural break" in the truest sense.
 * - `runOver` — the run is over; there is nothing left to lose.
 *
 * Everything NOT on this list is unsafe. Notably `paused`: a pause overlay
 * looks like a menu but the run behind it is live and mid-floor.
 */
export const SAFE_MOMENTS = ['modePicker', 'lobby', 'floorTransition', 'runOver'] as const

/**
 * The much shorter list that also applies when OTHER PLAYERS share this
 * session over the network. Reloading tears this client off the link — and if
 * we are the host, it ends the run for everyone connected. A client has no
 * authoritative world to persist either, so it cannot resume the way solo can.
 *
 * So while a networked session is live, an update waits for the player to be
 * genuinely outside it. In practice that means the next cold start, which is
 * exactly what happens today and costs nobody anything.
 */
export const COOP_SAFE_MOMENTS = ['modePicker'] as const

/** Is this a moment at which a solo player can be reloaded for free? */
export const isSafeMoment = (moment: UpdateMoment): boolean =>
  (SAFE_MOMENTS as readonly UpdateMoment[]).includes(moment)

/** Is this a moment at which a player sharing a networked session can be reloaded? */
export const isCoopSafeMoment = (moment: UpdateMoment): boolean =>
  (COOP_SAFE_MOMENTS as readonly UpdateMoment[]).includes(moment)

/** Why an update was not applied. Every refusal names its cause so a failing
 * test (and a debug log) says what actually stopped it, not just "false". */
export type ApplyBlock =
  /** Nothing is downloaded and verified yet — the usual, boring case. */
  | 'not-staged'
  /** We already swapped; a second reload would be a loop. */
  | 'already-applied'
  /** A run is in progress and this is not a natural break. */
  | 'unsafe-moment'
  /** Other players are on the link; leaving now would take them with us. */
  | 'coop-session-live'

export type ApplyDecision = { readonly apply: true } | { readonly apply: false; readonly why: ApplyBlock }

/** Everything the decision depends on. No clocks, no globals — pure input. */
export interface UpdateGateState {
  /**
   * A COMPLETE update is downloaded and verified, and applying it is now a
   * local, atomic swap. Never set optimistically — see webUpdate.ts.
   */
  readonly staged: boolean
  /** We have already triggered the swap for this staged update. */
  readonly applied: boolean
  /** Where the player is right now. */
  readonly moment: UpdateMoment
  /** Other players sharing this session over the network (0 = solo / no link). */
  readonly peers: number
}

/**
 * The single decision. Fails closed: every path that is not an explicit,
 * enumerated "yes" is a "no" with a named reason.
 *
 * This is the swappable seam. Making updates immediate instead of
 * break-aligned is a change to THIS function and nothing else — no caller
 * knows how the choice is made.
 */
export const decideApply = (state: UpdateGateState): ApplyDecision => {
  if (!state.staged) return { apply: false, why: 'not-staged' }
  if (state.applied) return { apply: false, why: 'already-applied' }
  // The co-op rule is checked FIRST and is strictly narrower, so a networked
  // session can never widen its way into the solo list.
  if (state.peers > 0) {
    return isCoopSafeMoment(state.moment) ? { apply: true } : { apply: false, why: 'coop-session-live' }
  }
  if (!isSafeMoment(state.moment)) return { apply: false, why: 'unsafe-moment' }
  return { apply: true }
}

// ---------------------------------------------------------------------------
// Naming the moment
// ---------------------------------------------------------------------------
// This lives here, next to the list, rather than in main.ts — the mapping from
// "what the frame knows" to "which moment this is" is the same judgement as the
// list itself, and splitting the two is how they drift apart.

/** Everything needed to name the player's moment, without a RenderView. */
export interface MomentInputs {
  /** The run-over / downed / dead overlay is up (screens.ts `restartAffordance`). */
  readonly runOver: boolean
  /** We are inside the window just after the floor changed. */
  readonly floorChanging: boolean
  /** Paused mid-run. */
  readonly paused: boolean
}

/**
 * Name the moment the player is in. Pure, so the mapping is tested rather than
 * trusted. Anything this does not recognise is `inRun` — the unsafe default.
 */
export const momentOf = (i: MomentInputs): UpdateMoment => {
  if (i.runOver) return 'runOver'
  if (i.floorChanging) return 'floorTransition'
  if (i.paused) return 'paused'
  return 'inRun'
}

/**
 * How long after a floor change we still count as "between floors".
 *
 * A single frame would be a coin flip: an update that finished staging one
 * frame later would have to wait for the NEXT floor. This matches the on-screen
 * "FLOOR n" banner, so the swap lands while the player is reading it.
 */
export const FLOOR_TRANSITION_FRAMES = 120
