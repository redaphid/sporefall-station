import { Capacitor } from '@capacitor/core'

// Replaced by Vite's `define` at build time (see vite.config.ts). Falls back to
// 'dev' when the define didn't run (e.g. a bare tsx invocation).
declare const __APP_VERSION__: string

/** The build version of the CODE currently running (git short SHA). An OTA
 * update ships its own bundle, so this reflects the live build — from the APK
 * or from an over-the-air update. */
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

// Also replaced by Vite's `define` at build time, single-sourced from the OTA
// URL in capacitor.config.ts so the hostname exists in one place only.
declare const __SITE_ORIGIN__: string

/**
 * The public origin this bundle was BUILT for (`https://sporefall.hypnodroid.com`
 * in a real deploy) -- as opposed to `location.origin`, the origin it happens to
 * be RUNNING at.
 *
 * In a browser the two are the same and this is uninteresting. In the Android
 * APK they are not: Capacitor serves the bundled `dist/` from its own
 * `https://localhost`, so `location.origin` addresses the app's own packaged
 * files and any request built from it never leaves the phone. Code that must
 * reach the Cloudflare Worker has to use this instead.
 *
 * EMPTY when the define didn't run (e.g. a bare `tsx` invocation). Callers must
 * treat empty as "no better answer than `location.origin`" rather than building
 * a URL out of it -- deliberately not defaulted to a literal hostname here,
 * which would be the second copy this constant exists to prevent.
 */
export const SITE_ORIGIN: string = typeof __SITE_ORIGIN__ !== 'undefined' ? __SITE_ORIGIN__ : ''

/**
 * The OTA bundle version applied by @capgo/capacitor-updater (native only).
 * `'builtin'` = running the APK's own bundled assets; anything else = an OTA
 * update is live. Returns null on web/dev or if the plugin isn't answering.
 */
export const otaBundleVersion = async (): Promise<string | null> => {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    const cur = await CapacitorUpdater.current()
    return cur?.bundle?.version ?? null
  } catch {
    return null
  }
}
