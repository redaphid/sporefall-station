import { Capacitor } from '@capacitor/core'
import { CapacitorUpdater } from '@capgo/capacitor-updater'

// Over-the-air (OTA) web-bundle updates.
//
// The heavy lifting is done natively by @capgo/capacitor-updater with
// `autoUpdate: true` (configured in capacitor.config.ts): on each app launch,
// while online, it POSTs to our self-hosted manifest endpoint, and if a newer
// bundle exists it downloads it in the background and swaps it in on the next
// launch. It is inherently non-blocking and offline-safe — if the check or
// download fails, the currently installed bundle just keeps running.
//
// The only thing the JS layer must do is confirm it booted successfully, so the
// native side doesn't auto-roll-back to the previous bundle. That's this.
//
// No-op on the web (Cloudflare Pages) and in dev live-reload — there is no
// native updater there, and the config omits the plugin entirely when
// CAP_SERVER_URL is set.
export const notifyOtaReady = async (): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return
  try {
    await CapacitorUpdater.notifyAppReady()
  } catch {
    // Plugin missing / offline — bundled version runs, no user-visible impact.
  }
}
