import { Capacitor } from '@capacitor/core'

// Offline-first for the WEB build (browser tab + "Add to Home Screen" install).
//
// The Android APK does NOT use this: it ships dist/ inside the app and updates
// via Capgo OTA (src/app/ota.ts). A service worker in the native WebView would
// precache the OLD web bundle and then keep serving it after the updater swapped
// in a new one — the cache would silently out-vote OTA. So the SW is web-only.
//
// The sw.js itself is generated at build time by vite-plugin-pwa (see
// vite.config.ts): it precaches the app shell, the hashed JS/CSS, the icons and
// the default theme chain, so a cold launch with the radio off still boots into
// a playable solo run.

/** Everything about the host that decides whether a service worker belongs here. */
export type PwaEnv = {
  /** Running inside the Capacitor Android shell (APK), where OTA owns updates. */
  native: boolean
  /** `serviceWorker` present — false in old browsers and non-secure contexts. */
  supported: boolean
  /** A production build; the dev server intentionally ships no sw.js. */
  prod: boolean
}

/**
 * Pure decision, so the guard rails are testable without a DOM or a real
 * registration. Kept separate from the imperative call below on purpose.
 */
export const shouldRegisterSw = (env: PwaEnv): boolean => !env.native && env.supported && env.prod

/**
 * How often a long-lived tab re-checks the origin for a newer service worker.
 * Without this a session that never navigates could sit on old code forever;
 * with it, a fresh deploy is picked up within the hour (and immediately on any
 * tab re-focus).
 */
export const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Register the offline service worker. Safe to call unconditionally — it
 * no-ops on native, in dev, and where service workers are unavailable.
 *
 * Note we deliberately do NOT force-reload the page when a new worker takes
 * over. `skipWaiting`/`clientsClaim` mean the new bundle is installed and
 * active right away, but yanking the page out from under someone mid-run is a
 * worse bug than being one version behind for the rest of a car ride: the new
 * code is what boots on the next launch.
 */
export const registerPwa = (): void => {
  const env: PwaEnv = {
    native: Capacitor.isNativePlatform(),
    supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    prod: import.meta.env.PROD,
  }
  if (!shouldRegisterSw(env)) return

  const start = async (): Promise<void> => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      // Re-check on an interval and whenever the player comes back to the tab,
      // so a deploy reaches installed clients without waiting for a cold start.
      setInterval(() => void reg.update(), SW_UPDATE_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void reg.update()
      })
    } catch {
      // Registration failing must never block the game — it just means this
      // session is online-only.
    }
  }

  // Registering after load keeps the SW install off the critical boot path.
  if (document.readyState === 'complete') void start()
  else window.addEventListener('load', () => void start(), { once: true })
}
