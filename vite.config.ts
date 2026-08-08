import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

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
  plugins: [
    // Offline-first on the WEB. The Android APK gets its offline story from the
    // bundled dist/ inside the app + Capgo OTA; the browser/home-screen install
    // gets it from this service worker. Registration is deliberately NOT
    // injected into index.html (`injectRegister: null`) — src/app/pwa.ts owns it
    // so it can be skipped on native, where a SW would cache the old web bundle
    // and fight the OTA updater.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      // index.html/manifest/icons already live in the repo; don't let the plugin
      // synthesize a second manifest that would fight public/manifest.webmanifest.
      manifest: false,
      workbox: {
        // Emit ONE self-contained sw.js instead of sw.js + workbox-<hash>.js.
        // That keeps the cache-control story to a single rule: exactly one file
        // must stay revalidated so a new deploy is discoverable (public/_headers).
        inlineWorkboxRuntime: true,
        // The app shell + hashed JS/CSS + icons, plus the DEFAULT theme chain
        // (swampspace-hires falls back to swampspace, so offline play needs
        // both). Deliberately EXCLUDES public/sprites/** — 7.1 MB used only by
        // the legacy `city` theme and the dev asset-showcase page; it is picked
        // up on demand by the runtime cache below instead of bloating install.
        globDirectory: 'dist',
        globPatterns: [
          'index.html',
          'manifest.webmanifest',
          'assets/**/*.{js,css}',
          'icons/**/*.{png,svg,ico}',
          'themes/index.json',
          'themes/swampspace-hires/**/*.{json,png,webp}',
          'themes/swampspace/**/*.{json,png,webp}',
        ],
        // Deep links (`/?mode=solo&seed=7`) and home-screen launches are
        // navigations — serve the precached shell for them when offline.
        navigateFallback: 'index.html',
        // ...but NEVER for the Worker routes or the self-hosted APK: /download
        // is a real navigation that must reach the network, and swallowing it
        // would hand people index.html instead of the .apk.
        navigateFallbackDenylist: [/^\/ws\//, /^\/ota\//, /^\/download/, /^\/get$/, /^\/asset-showcase/],
        // A new deploy must be able to reach an installed client: take over as
        // soon as the new SW installs, and drop every previous cache version.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Non-default themes and the legacy sprite pack: cached the first
            // time they're actually used, then available offline.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && (url.pathname.startsWith('/sprites/') || url.pathname.startsWith('/themes/')),
            handler: 'CacheFirst',
            options: {
              cacheName: 'sporefall-art-on-demand',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Keep `pnpm run dev` a plain, cache-free Vite server — a SW in dev
        // serves yesterday's bundle and eats hours.
        enabled: false,
      },
    }),
  ],
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
