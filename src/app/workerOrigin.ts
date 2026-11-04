// Where the Worker lives, as seen from wherever this bundle is running. Static
// on the boot path (the online relay needs it), so it stays tiny and DOM-free.

import { SITE_ORIGIN } from './version'

/** Hostnames that only ever mean "this machine". */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Is this page being served by a NATIVE SHELL out of its own bundled assets,
 * rather than by the site?
 *
 * The Android APK is the case that matters. `capacitor.config.ts` sets no
 * `androidScheme`, so Capacitor's default applies and the webview serves the
 * bundled `dist/` from `https://localhost` -- a real origin, with a real
 * successful `fetch`, that resolves to files inside the APK. A request built
 * from `location.origin` there never reaches the Worker; it hits the app's own
 * SPA fallback and comes back as 200 + index.html.
 *
 * PORTLESS ON PURPOSE. `vite dev` (localhost:5173) and `wrangler dev`
 * (localhost:8787) are localhost too, and they must keep resolving to
 * THEMSELVES: wrangler genuinely serves `/state` and `/ws`, and vite has the
 * `?stateOrigin=` and `?ws=` overrides. Only a portless localhost -- plus
 * `capacitor://localhost` and a `file://` document, whose origin is the literal
 * string `"null"` -- is a native shell.
 */
const isNativeShellOrigin = (origin: string): boolean => {
  if (!origin || origin === 'null') return true
  try {
    const url = new URL(origin)
    return LOCAL_HOSTS.has(url.hostname) && url.port === ''
  } catch {
    return true
  }
}

/**
 * The Worker's origin: the page's own in a browser, and the origin the bundle
 * was BUILT for (`SITE_ORIGIN`, baked in by Vite from capacitor.config.ts's OTA
 * URL) inside the native shell, where the page origin names the APK's assets.
 */
export const workerOrigin = (origin: string, siteOrigin: string = SITE_ORIGIN): string =>
  siteOrigin && isNativeShellOrigin(origin) ? siteOrigin : origin
