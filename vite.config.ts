import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

// Baked into the bundle at build time so the running CODE can show its own
// version (git short SHA, '+' when the tree was dirty). Because it lives in the
// JS bundle, an OTA update carries its own value — so it reflects the live build
// whether it came from the APK or an over-the-air update.
const appVersion = (() => {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim()
    const dirty = execSync('git status --porcelain').toString().trim() ? '+' : ''
    return sha + dirty
  } catch {
    return 'dev'
  }
})()

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: { host: true },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
