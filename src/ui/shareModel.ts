/**
 * The "Share state" button, as a pure state machine.
 *
 * DOM-free so the part that is easy to get wrong is the part that is tested.
 * Two specific failures are designed out here rather than hoped away:
 *
 *   • FAKE SUCCESS. `shareState` refuses to upload a capture that does not
 *     replay to itself byte-for-byte, and the upload itself can 500. Neither
 *     may ever paint as "copied". A link he believes he has and does not is
 *     worse than a visible error, because he finds out from the person he sent
 *     it to, an hour later. So there is no optimistic state: the button reports
 *     what actually happened, including the server's own words.
 *   • A SILENT CLIPBOARD. `navigator.clipboard.writeText` needs a secure
 *     context, and the transient user activation from the tap may well have
 *     expired by the time capture → self-check → gzip → upload returns
 *     (seconds, not milliseconds). A refused copy is therefore a STATE, not an
 *     ignored rejection: the URL is offered to select, and the button becomes a
 *     plain Copy that retries inside a FRESH gesture.
 */

import { SIM_DT } from '../game/types'

/** Longest error text worth putting on a phone screen; the rest is elided. */
const MAX_ERROR_CHARS = 200

export type ShareState =
  | { phase: 'idle' }
  /** Capture + self-check + upload in flight. Taps are swallowed while here. */
  | { phase: 'pending' }
  | { phase: 'shared'; url: string; rewindTicks: number; copied: boolean }
  | { phase: 'failed'; message: string }

export const initialShare = (): ShareState => ({ phase: 'idle' })

export const shareStarted = (): ShareState => ({ phase: 'pending' })

export const shareSucceeded = (url: string, rewindTicks: number, copied: boolean): ShareState => ({
  phase: 'shared',
  url,
  rewindTicks,
  copied,
})

export const shareFailed = (err: unknown): ShareState => ({ phase: 'failed', message: shareErrorMessage(err) })

/**
 * Outcome of a RETRIED clipboard write against the link already uploaded.
 *
 * Carries the original capture's `rewindTicks` forward rather than rebuilding
 * the state from what the retry knows (nothing but a URL and a boolean). Losing
 * it would make the status line announce "no run-up" for a link that has plenty
 * — a lie about the payload, not a cosmetic slip.
 */
export const shareCopyRetried = (s: ShareState, copied: boolean): ShareState =>
  s.phase === 'shared' ? { ...s, copied } : s

/**
 * The REAL reason, trimmed to fit — never "something went wrong".
 *
 * Both failures worth seeing already name themselves ("refusing to share a
 * state that does not reproduce itself: …", "upload failed: 500 …"), and those
 * two sentences are the difference between a fix and a bug report that says
 * "the button didn't work".
 */
export const shareErrorMessage = (err: unknown): string => {
  let raw: string
  try {
    raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  } catch {
    raw = ''
  }
  const text = raw.trim()
  if (!text) return 'unknown error'
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text
}

/**
 * What the NEXT tap should do. `'copy'` re-attempts the clipboard against the
 * URL already uploaded — a retry must never re-capture and re-upload, both
 * because it costs a second KV write and because the interesting world is the
 * one from the first tap, not the one several seconds later.
 */
export const shareAction = (s: ShareState): 'share' | 'copy' | 'none' =>
  s.phase === 'pending' ? 'none' : s.phase === 'shared' && !s.copied ? 'copy' : 'share'

export const shareButtonLabel = (s: ShareState): string => {
  switch (s.phase) {
    case 'pending':
      return 'Capturing…'
    case 'failed':
      return '🔗 Try again'
    case 'shared':
      return s.copied ? '🔗 Share again' : '📋 Copy link'
    case 'idle':
      return '🔗 Share state'
  }
}

/**
 * How much run-up the link carries, in the units he thinks in. Zero is STATED,
 * not hidden: a capture with no lead-in opens on the aftermath rather than on
 * the bug happening, and knowing that changes what he says when he sends it.
 */
export const runUpText = (ticks: number): string =>
  ticks > 0 ? `${(ticks * SIM_DT).toFixed(1)}s of run-up` : 'no run-up — opens on the captured frame'

/** The line under the button, or null when there is nothing honest to say. */
export const shareStatusText = (s: ShareState): string | null => {
  switch (s.phase) {
    case 'idle':
      return null
    case 'pending':
      return 'Capturing the world, checking it replays, uploading…'
    case 'failed':
      return `Share failed — ${s.message}`
    case 'shared':
      return s.copied
        ? `Copied to the clipboard (${runUpText(s.rewindTicks)}).`
        : `Uploaded (${runUpText(s.rewindTicks)}), but the clipboard refused. ` +
            'Tap Copy link, or long-press the link below.'
  }
}

/** The URL to offer for manual selection, or null when there isn't one yet. */
export const shareUrl = (s: ShareState): string | null => (s.phase === 'shared' ? s.url : null)
