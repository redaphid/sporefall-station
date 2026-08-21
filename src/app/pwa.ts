import { Capacitor } from '@capacitor/core'
import {
  createWebUpdater,
  isCriticalAsset,
  VERSION_ENDPOINT,
  type HttpProbe,
  type PrecacheEntry,
  type WebUpdater,
} from './webUpdate'
import { APP_VERSION } from './version'

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
 * How often a long-lived tab re-checks the origin for a newer version. Without
 * this a session that never navigates could sit on old code forever; with it, a
 * fresh deploy is picked up within the hour (and immediately on any re-focus).
 */
export const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000

/** Read the version endpoint. Rejects when offline — the caller expects that. */
const probeVersion = async (): Promise<HttpProbe> => {
  // `no-store` on OUR side too: the service worker already never caches this
  // path (swConfig.ts), and the Worker answers `cache-control: no-store`, but a
  // stale HTTP cache here would blind the check just as effectively.
  const res = await fetch(VERSION_ENDPOINT, { cache: 'no-store' })
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: await res.text(),
  }
}

/**
 * Read back what the new worker actually cached, so it can be checked before
 * anything is swapped in. Throws if the precache cannot be found or read —
 * which the updater treats as "do nothing", never as "looks fine".
 */
const readPrecache = async (): Promise<readonly PrecacheEntry[]> => {
  const names = await caches.keys()
  const name = names.find((n) => n.includes('precache'))
  if (name === undefined) throw new Error('no precache')
  const cache = await caches.open(name)
  const requests = (await cache.keys()).filter((r) => isCriticalAsset(r.url))
  return Promise.all(
    requests.map(async (request) => {
      const res = await cache.match(request)
      return { url: request.url, contentType: res?.headers.get('content-type') ?? null }
    }),
  )
}

/**
 * Register the offline service worker and start the background update loop.
 * Safe to call unconditionally — it no-ops on native (where Capgo owns
 * updates), in dev, and where service workers are unavailable, returning null.
 *
 * What changed, and why: the worker used to `skipWaiting`/`clientsClaim` its
 * way in the moment it installed, and the page was deliberately never reloaded
 * — so a player sat on old code until they next cold-started, and an already
 * open tab was briefly running old code against a new precache. Now the new
 * worker installs completely and WAITS, and the app swaps it in at a moment
 * where a reload costs nothing (updatePolicy.ts). The player never taps
 * anything and never gets yanked out of a run.
 */
export const registerPwa = (): WebUpdater | null => {
  const env: PwaEnv = {
    native: Capacitor.isNativePlatform(),
    supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    prod: import.meta.env.PROD,
  }
  if (!shouldRegisterSw(env)) return null

  let registration: ServiceWorkerRegistration | undefined
  const updater = createWebUpdater({
    probe: probeVersion,
    checkForWorker: async () => {
      await registration?.update()
    },
    waiting: () => registration?.waiting ?? null,
    precacheEntries: readPrecache,
    reload: () => location.reload(),
    appVersion: APP_VERSION,
  })

  const start = async (): Promise<void> => {
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    } catch {
      // Registration failing must never block the game — it just means this
      // session is online-only. Silent on purpose.
      return
    }
    const reg = registration

    // A worker can finish installing without us having asked (the browser does
    // its own periodic checks), so verify-and-stage on the install event too.
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') void updater.onWorkerInstalled()
      })
    })
    // The swap actually landed — now, and only now, is a reload meaningful.
    navigator.serviceWorker.addEventListener('controllerchange', () => updater.onControllerChange())

    // A worker may already have been waiting from a previous session.
    void updater.onWorkerInstalled()
    void updater.check()
    setInterval(() => void updater.check(), SW_UPDATE_INTERVAL_MS)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void updater.check()
    })
  }

  // Registering after load keeps the SW install off the critical boot path.
  if (document.readyState === 'complete') void start()
  else window.addEventListener('load', () => void start(), { once: true })
  return updater
}
