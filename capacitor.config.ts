import type { CapacitorConfig } from '@capacitor/cli'

// Live-reload dev mode: set CAP_SERVER_URL to the laptop's LAN dev server
// (e.g. http://192.168.1.184:5173) before `cap sync` / building the APK, and
// the native webview loads straight from Vite with HMR — every save reloads on
// every phone on the network. Leave it unset for a normal offline build that
// serves the bundled `dist/`. `npm run dev:live` sets it for you.
const serverUrl = process.env.CAP_SERVER_URL

// Self-hosted OTA (over-the-air) web-bundle updates via @capgo/capacitor-updater.
// On launch the native app POSTs to this manifest endpoint (a free Cloudflare
// Pages Function, see functions/ota/check.ts); if a newer bundle is published it
// downloads it and swaps it in on the next launch. Override the host with
// OTA_UPDATE_URL at build time if the Pages project name differs.
// statsUrl is empty to disable Capgo's stats reporting (fully self-hosted).
const otaUpdateUrl =
  process.env.OTA_UPDATE_URL ?? 'https://backseat-sd8.pages.dev/ota/check'

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
            autoUpdate: true,
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
