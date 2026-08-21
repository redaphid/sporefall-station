import type { CapacitorConfig } from '@capacitor/cli'

// Live-reload dev mode: set CAP_SERVER_URL to the laptop's LAN dev server
// (e.g. http://192.168.1.184:5173) before `cap sync` / building the APK, and
// the native webview loads straight from Vite with HMR — every save reloads on
// every phone on the network. Leave it unset for a normal offline build that
// serves the bundled `dist/`. `npm run dev:live` sets it for you.
const serverUrl = process.env.CAP_SERVER_URL

// Self-hosted OTA (over-the-air) web-bundle updates via @capgo/capacitor-updater.
// On launch the native app POSTs to this manifest endpoint (the Cloudflare Worker
// route, see src/worker/ota.ts); if a newer bundle is published it downloads it
// and swaps it in on the next launch. Override the host with OTA_UPDATE_URL at
// build time (CI sets it from the deploy origin).
// statsUrl is empty to disable Capgo's stats reporting (fully self-hosted).
const otaUpdateUrl =
  process.env.OTA_UPDATE_URL ?? 'https://sporefall.hypnodroid.com/ota/check'

const config: CapacitorConfig = {
  appId: 'com.hypnodroid.backseat',
  appName: 'Sporefall Station',
  webDir: 'dist',
  android: {
    // Game renders its own splash-free boot; keep the webview edge-to-edge.
    backgroundColor: '#0b0b12',
  },
  // Dev live-reload (CAP_SERVER_URL set): load straight from the laptop Vite
  // server and DISABLE OTA — never let the updater fight the dev server.
  // Production build (no CAP_SERVER_URL): serve the bundled dist/ and enable OTA.
  ...(serverUrl
    ? { server: { url: serverUrl, cleartext: true } }
    : {
        plugins: {
          CapacitorUpdater: {
            // PAIRED WITH src/app/ota.ts. CHANGING EITHER ONE ALONE IS A REGRESSION.
            //
            // Why not `true`: `true` means 'atBackground', where the plugin calls
            // setNextBundle() itself and swaps on the next backgrounding - a second
            // installer that knows nothing about the co-op/mid-run rules in
            // updatePolicy.ts, applying at exactly the moments that policy exists
            // to refuse. 'onlyDownload' is, per Capgo's docs, "Check and download
            // automatically, emit `updateAvailable`, and never set the next bundle
            // or apply an update automatically" - leaving the app the single
            // installer, as on the web.
            //
            // The trap that buys: since NOTHING is ever staged natively, a bare
            // `reload()` in ota.ts is not enough. Per reload()'s own docs, "If no
            // update is pending (no call to `next`), this simply reloads the
            // current bundle." It would re-render the CURRENT bundle, resolve
            // successfully, and install nothing - forever, with no error to catch.
            // So ota.ts MUST stage the bundle id off the `updateAvailable` event
            // explicitly (`set({ id })`). Do not "simplify" ota.ts back to a bare
            // reload() without also reverting this line to `true` in the SAME
            // commit - src/app/ota.test.ts fails if you do.
            autoUpdate: 'onlyDownload',
            // capgo v4+ renamed `autoUpdateUrl` → `updateUrl`; with the old key
            // the plugin silently fell back to Capgo's SaaS endpoint (which
            // rejects self-hosted apps with HTTP 429) and updates never arrived.
            updateUrl: otaUpdateUrl,
            statsUrl: '',
          },
        },
      }),
}

export default config
