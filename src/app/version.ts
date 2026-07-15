import { Capacitor } from '@capacitor/core'

// Replaced by Vite's `define` at build time (see vite.config.ts). Falls back to
// 'dev' when the define didn't run (e.g. a bare tsx invocation).
declare const __APP_VERSION__: string

/** The build version of the CODE currently running (git short SHA). An OTA
 * update ships its own bundle, so this reflects the live build — from the APK
 * or from an over-the-air update. */
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

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
