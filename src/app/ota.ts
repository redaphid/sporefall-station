import { Capacitor } from '@capacitor/core'
import { CapacitorUpdater } from '@capgo/capacitor-updater'
import { decideApply, type UpdateMoment } from './updatePolicy'

// Over-the-air (OTA) web-bundle updates for the INSTALLED ANDROID APP.
//
// The heavy lifting is done natively by @capgo/capacitor-updater with
// `autoUpdate: true` (configured in capacitor.config.ts): on each app launch,
// while online, it POSTs to our self-hosted manifest endpoint (/ota/check —
// the SAME endpoint the browser reads, see src/worker/ota.ts), and if a newer
// bundle exists it downloads it in the background. It is inherently
// non-blocking and offline-safe: if the check or download fails, the currently
// installed bundle just keeps running.
//
// Atomicity is the plugin's: it downloads the whole zip, verifies it, and only
// then registers it as a bundle. A partial download never becomes something the
// app can boot into, and `notifyAppReady()` below closes the loop — a bundle
// that fails to start is rolled back to the previous one automatically.
//
// What this file adds is WHEN it goes live. Left alone, the plugin swaps on the
// next background/launch, which is why players had to relaunch to see a change.
// Now the same policy the browser uses (updatePolicy.ts) applies it at the next
// moment where a reload costs nothing — so both platforms mean the same thing
// by "up to date" and neither asks the player to do anything.

/** Applies a downloaded native bundle at a safe moment. Null on web/dev. */
export interface NativeUpdater {
  /** A verified bundle is downloaded and ready to be swapped in. */
  readonly staged: boolean
  /** Tell the updater where the player is. It applies if (and only if) it may. */
  reportMoment(moment: UpdateMoment, peers: number): void
}

/**
 * Confirm this bundle booted successfully, so the native side keeps it instead
 * of auto-rolling-back to the previous one.
 *
 * No-op on the web and in dev live-reload — there is no native updater there,
 * and the config omits the plugin entirely when CAP_SERVER_URL is set.
 */
export const notifyOtaReady = async (): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return
  try {
    await CapacitorUpdater.notifyAppReady()
  } catch {
    // Plugin missing / offline — bundled version runs, no user-visible impact.
  }
}

/**
 * Start watching for a downloaded bundle. Returns null off-native.
 *
 * Note this is additive, not a replacement: the plugin's own "apply on next
 * background" behaviour is untouched, so if this path never fires the app still
 * updates exactly as it does today. All it does is bring the swap forward to
 * the next natural break instead of making the player relaunch.
 */
export const startNativeUpdates = (): NativeUpdater | null => {
  if (!Capacitor.isNativePlatform()) return null

  let staged = false
  let applied = false
  // Most conservative default: never apply before the app has said where the
  // player is (mirrors webUpdate.ts).
  let moment: UpdateMoment = 'inRun'
  let peers = 0

  const applyIfAllowed = (): void => {
    if (!decideApply({ staged, applied, moment, peers }).apply) return
    applied = true
    // Applies the pending bundle and reloads the webview. Nothing may run
    // after this — the JS context is replaced.
    void CapacitorUpdater.reload().catch(() => {
      // Could not swap: the current bundle keeps running and the plugin's own
      // next-background path still applies it later. Nothing to show anyone.
      applied = false
    })
  }

  // `updateAvailable` fires once the bundle is downloaded AND verified — never
  // mid-download, so there is no partial state to guard against here.
  void CapacitorUpdater.addListener('updateAvailable', () => {
    staged = true
    // A player sitting in the menu when the download lands should not have to
    // move for it to apply.
    applyIfAllowed()
  }).catch(() => {
    // No plugin (dev live-reload) — updates simply never stage. Silent.
  })

  return {
    get staged(): boolean {
      return staged
    },
    reportMoment(next: UpdateMoment, nextPeers: number): void {
      moment = next
      peers = nextPeers
      applyIfAllowed()
    },
  }
}
