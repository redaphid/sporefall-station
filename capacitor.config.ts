import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.hypnodroid.streetsofrogueish',
  appName: 'Streets of Rogue-ish',
  webDir: 'dist',
  android: {
    // Game renders its own splash-free boot; keep the webview edge-to-edge.
    backgroundColor: '#0b0b12',
  },
}

export default config
