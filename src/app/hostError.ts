/**
 * Turning a failed host start into something a player can read — and report.
 *
 * Hosting is the one path with no way to announce its own failure. The BLE plugin
 * rejects for causes the player can often fix themselves (Bluetooth off, a
 * permission denied, no advertiser on the device), but createSession is awaited
 * without a catch, so the rejection went nowhere and the lobby sat on
 * "Waiting for players…" forever while nothing was on the air.
 *
 * We keep the plugin's OWN words. A generic "hosting failed" is useless to someone
 * standing in a field with no signal and no way to ask; the plugin's message names
 * the actual cause.
 */

const FALLBACK = "Can't host: Bluetooth failed without saying why"

/** Player-facing one-liner for whatever the host start path threw. */
export const hostFailureMessage = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const detail = raw.trim().replace(/\s+/g, ' ')
  return detail ? `Can't host: ${detail}` : FALLBACK
}
