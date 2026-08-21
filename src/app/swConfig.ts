// The service worker's caching plan, as DATA.
//
// This lived inline in vite.config.ts, which put three load-bearing rules
// somewhere no test could reach. They are the kind of rule that is silently
// correct until the day it isn't, and under offline-first "isn't" is permanent:
//
//   1. The version endpoint must NEVER be cached by the service worker, or the
//      app can never observe that a new version exists. (`/ota/*`)
//   2. The APK download must never be answered with index.html.
//   3. The worker must never take over on its own — the swap is the app's
//      decision, made at a safe moment (see updatePolicy.ts).
//
// vite.config.ts now imports these, so `swConfig.test.ts` asserts the same
// values the build actually ships.

/**
 * The app shell precache: HTML, hashed JS/CSS, icons and the DEFAULT theme
 * chain (swampspace-hires falls back to swampspace, so offline play needs
 * both). Deliberately EXCLUDES public/sprites/** — 7.1 MB used only by the
 * legacy `city` theme and the dev asset-showcase page, picked up on demand by
 * the runtime rule below instead of bloating the install.
 *
 * Note there is no `ota/**` pattern, and there must never be one: precaching
 * the version manifest would freeze this client's idea of "current version".
 */
export const SW_GLOB_PATTERNS: readonly string[] = [
  'index.html',
  'manifest.webmanifest',
  'assets/**/*.{js,css}',
  'icons/**/*.{png,svg,ico}',
  'themes/index.json',
  'themes/swampspace-hires/**/*.{json,png,webp}',
  'themes/swampspace/**/*.{json,png,webp}',
]

/** Deep links and home-screen launches are navigations — serve the shell. */
export const SW_NAVIGATE_FALLBACK = 'index.html'

/**
 * ...but NEVER for these. `/ota/*` and `/ws/*` are Worker routes, and
 * `/download` is a real navigation to the APK — answering it with index.html
 * would hand people the game page instead of the app.
 */
export const SW_NAVIGATE_FALLBACK_DENYLIST: readonly RegExp[] = [
  /^\/ws\//,
  /^\/ota\//,
  /^\/download/,
  /^\/get$/,
  /^\/asset-showcase/,
]

/** The shape of a runtime-caching rule's matcher, as workbox calls it. */
export interface UrlMatch {
  readonly url: URL
  readonly sameOrigin: boolean
}

/**
 * Non-default themes and the legacy sprite pack: cached the first time they are
 * actually used, then available offline. Scoped to art paths ONLY — widening
 * this to the whole origin would swallow the version endpoint.
 */
export const SW_RUNTIME_CACHING = [
  {
    urlPattern: ({ url, sameOrigin }: UrlMatch): boolean =>
      sameOrigin && (url.pathname.startsWith('/sprites/') || url.pathname.startsWith('/themes/')),
    handler: 'CacheFirst' as const,
    options: {
      cacheName: 'sporefall-art-on-demand',
      expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
]

/**
 * Who decides when a newly installed worker takes over.
 *
 * **`skipWaiting: false` is the load-bearing half.** It used to be true, which
 * let the browser activate a new worker the instant it finished installing —
 * so an already-open tab was suddenly talking to a new worker and a new
 * precache while still running the OLD code, with `cleanupOutdatedCaches`
 * having just dropped the chunks that page might still ask for. That is the
 * half-old/half-new state this feature exists to prevent, and offline-first
 * makes it permanent rather than transient.
 *
 * With it false the new worker installs COMPLETELY and then waits. Nothing
 * changes for the running page until the app decides the moment is safe and
 * posts `SKIP_WAITING` — workbox emits that message listener automatically
 * when `skipWaiting` is false (verified in the built sw.js). The page then
 * reloads on `controllerchange`, which is what proves the swap really landed.
 *
 * **`clientsClaim: true` is safe here, and is kept on purpose.** It only takes
 * effect when a worker ACTIVATES, and with `skipWaiting: false` a worker can
 * only activate when we ask it to (or when every tab has closed). So it cannot
 * cause an early takeover. What it does do is control the page on a FIRST-EVER
 * install, where there is no previous worker to wait behind — without it, a
 * brand-new visitor would have a filled precache but an uncontrolled page, and
 * would not actually be offline-capable until their next launch.
 *
 * This is NOT a step toward retiring the worker. Retiring one requires shipping
 * `selfDestroying: true` FIRST; a plain revert makes /sw.js 404 into the SPA
 * fallback and pins installed clients to the old worker forever. See
 * docs/deploy.md.
 */
export const SW_TAKEOVER = { skipWaiting: false, clientsClaim: true } as const

/** Drop previous precache versions once the new worker activates. */
export const SW_CLEANUP_OUTDATED_CACHES = true
