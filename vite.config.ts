import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

// Baked into the bundle at build time so the running CODE can show its own
// version. A simple INCREMENTING INTEGER (the git commit count) so it's obvious
// which build is newer — "build 248" beats a SHA for a human at a glance. Lives
// in the JS bundle, so an OTA update carries its own number — it reflects the
// live build whether from the APK or an over-the-air update. The OTA manifest
// (deploy-web.yml) uses the same commit count so the two line up. '+' marks a
// dirty working tree (a local build with uncommitted changes).
const appVersion = (() => {
  try {
    const count = execSync('git rev-list --count HEAD').toString().trim()
    const dirty = execSync('git status --porcelain').toString().trim() ? '+' : ''
    return count + dirty
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
    // This repo's testing mandate leans on exhaustive property sweeps (hundreds
    // of worldgens per test). Under the 5s default they pass in isolation but
    // FLAKE by timeout whenever several agents/suites share the machine — a
    // different sweep failing each run. 60s keeps hangs bounded without letting
    // load turn green tests red.
    testTimeout: 60000,
  },
})
