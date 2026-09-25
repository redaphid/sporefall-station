/**
 * Turning a failed join into something a player can read — and report.
 *
 * The mirror image of `hostError.ts`, for the other half of the handshake. The
 * join path had the same silent-failure shape and one worse detail: the lobby UI
 * was not created until AFTER the BLE connect, so a connect that threw (or, more
 * often, one that hung until our own timeout fired) left the joining player
 * staring at a blank screen with no status line to write a message into. There
 * was nowhere to put the bad news.
 *
 * As with hosting, we keep the underlying words. "Bluetooth is off — turn it on
 * and try again" tells someone standing in a field what to do; "join failed"
 * tells them to give up.
 */

const FALLBACK = "Can't join: Bluetooth failed without saying why"

/** Player-facing one-liner for whatever the join path threw. */
export const joinFailureMessage = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const detail = raw.trim().replace(/\s+/g, ' ')
  return detail ? `Can't join: ${detail}` : FALLBACK
}
