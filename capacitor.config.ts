import type { CapacitorConfig } from '@capacitor/cli'

// Live-reload dev mode: set CAP_SERVER_URL to the laptop's LAN dev server
// (e.g. http://192.168.1.184:5173) before `cap sync` / building the APK, and
// the native webview loads straight from Vite with HMR — every save reloads on
// every phone on the network. Leave it unset for a normal offline build that
// serves the bundled `dist/`. `npm run dev:live` sets it for you.
const serverUrl = process.env.CAP_SERVER_URL

const config: CapacitorConfig = {
  appId: 'com.hypnodroid.streetsofrogueish',
  appName: 'Streets of Rogue-ish',
  webDir: 'dist',
  android: {
    // Game renders its own splash-free boot; keep the webview edge-to-edge.
    backgroundColor: '#0b0b12',
  },
  ...(serverUrl
    ? { server: { url: serverUrl, cleartext: true } }
    : {}),
}

export default config
