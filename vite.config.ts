import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
// The caching plan lives in src/ as plain data so it can be unit-tested — three
// of its rules are load-bearing and silently breakable (swConfig.test.ts).
import {
  SW_CLEANUP_OUTDATED_CACHES,
  SW_GLOB_PATTERNS,
  SW_NAVIGATE_FALLBACK,
  SW_NAVIGATE_FALLBACK_DENYLIST,
  SW_RUNTIME_CACHING,
  SW_TAKEOVER,
} from './src/app/swConfig'
import { SITE_ORIGIN } from './capacitor.config'
import { BETAS_PREFIX, resolveBetaSlug } from './src/app/betaSlug'

// BETA BUILD SWITCH. `BETA_SLUG=<branch name> pnpm run build` produces a bundle
// meant to be served from https://<origin>/betas/<slug>/ instead of the root —
// see src/worker/betas.ts and docs/deploy.md § "Betas".
//
// THIS IS THE LOAD-BEARING LINE OF THE WHOLE FEATURE. Vite has no `base` by
// default, so a normally-built bundle's index.html asks for `/assets/index-<hash>.js`
// at the ROOT. Served under /betas/foo/, that request leaves the beta's path
// entirely and is answered by PRODUCTION's assets — a 200, the right-looking
// page, and the wrong JavaScript. Nothing about the response says so. Setting
// `base` rewrites those references to /betas/foo/assets/…, which is exactly what
// the beta CI job asserts on the built index.html before it publishes anything.
//
// The value goes through the same resolveBetaSlug() the publish script and the
// Worker use, so the path baked into the bundle cannot disagree with the path
// its bytes were stored under. A BETA_SLUG that sanitizes to nothing is a hard
// failure: silently building a root-based bundle here is the bug.
//
// BETA_PR is the OTHER input, and it WINS when set: a beta published for a pull
// request lives at /betas/pr-<number>/ rather than under the branch's last
// segment, because every open PR publishes automatically now and two PRs whose
// branches end in the same word must not overwrite each other. See
// src/app/betaSlug.ts and .github/workflows/preview-web.yml.
const betaSlug = ((): string | null => {
  const pr = (process.env.BETA_PR ?? '').trim()
  const branch = (process.env.BETA_SLUG ?? '').trim()
  if (pr === '' && branch === '') return null
  const slug = resolveBetaSlug({ pr, branch })
  if (slug === null)
    throw new Error(
      pr === ''
        ? `BETA_SLUG=${JSON.stringify(branch)} does not sanitize to a usable beta slug`
        : `BETA_PR=${JSON.stringify(pr)} is not a usable pull request number`,
    )
  return slug
})()

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
  // '/' for production; '/betas/<slug>/' for a beta build. import.meta.env.BASE_URL
  // carries it into the bundle, which is where src/app/betaSlug.ts reads it back
  // out to namespace multiplayer rooms — one value, so the assets and the rooms
  // can never disagree about which build this is.
  base: betaSlug === null ? '/' : `${BETAS_PREFIX}${betaSlug}/`,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    // The origin this bundle is DEPLOYED to. The browser rarely needs it
    // (`location.origin` is already the site), but the native Android
    // webview serves the bundled dist/ from Capacitor's `https://localhost`,
    // so anything that must reach the Worker has to be told the real host at
    // build time. Single-sourced from capacitor.config.ts's OTA URL.
    __SITE_ORIGIN__: JSON.stringify(SITE_ORIGIN),
  },
  plugins: [
    // Offline-first on the WEB. The Android APK gets its offline story from the
    // bundled dist/ inside the app + Capgo OTA; the browser/home-screen install
    // gets it from this service worker. Registration is deliberately NOT
    // injected into index.html (`injectRegister: null`) — src/app/pwa.ts owns it
    // so it can be skipped on native, where a SW would cache the old web bundle
    // and fight the OTA updater.
    VitePWA({
      // NO SERVICE WORKER IN A BETA BUILD. A service worker's blast radius is
      // its scope, and a beta is same-origin with the live game: a sw.js served
      // from /betas/<slug>/ could only ever fight the production worker for the
      // player's cache, and the registration call asks for scope '/' anyway
      // (src/app/pwa.ts), which would let a branch build hijack production for
      // an installed player. Not generating one at all is the only version of
      // this with no sharp edge; src/app/pwa.ts independently refuses to
      // register under a beta base, so neither half alone can cause it.
      disable: betaSlug !== null,
      // 'prompt', not 'autoUpdate': the browser must NOT activate a new worker
      // on its own. src/app/webUpdate.ts downloads in the background and swaps
      // at a safe moment (src/app/updatePolicy.ts) — the player still never
      // taps anything, it just doesn't happen mid-fight. See SW_TAKEOVER.
      registerType: 'prompt',
      injectRegister: null,
      // index.html/manifest/icons already live in the repo; don't let the plugin
      // synthesize a second manifest that would fight public/manifest.webmanifest.
      manifest: false,
      workbox: {
        // Emit ONE self-contained sw.js instead of sw.js + workbox-<hash>.js.
        // That keeps the cache-control story to a single rule: exactly one file
        // must stay revalidated so a new deploy is discoverable (public/_headers).
        inlineWorkboxRuntime: true,
        globDirectory: 'dist',
        // Every value below is defined and unit-tested in src/app/swConfig.ts.
        // `skipWaiting`/`clientsClaim` are BOTH false in SW_TAKEOVER: a new
        // worker installs completely, then waits for the app to swap it in at a
        // safe moment. That is what makes the update atomic from the page's
        // point of view — read the note on SW_TAKEOVER before changing it.
        globPatterns: [...SW_GLOB_PATTERNS],
        navigateFallback: SW_NAVIGATE_FALLBACK,
        navigateFallbackDenylist: [...SW_NAVIGATE_FALLBACK_DENYLIST],
        ...SW_TAKEOVER,
        cleanupOutdatedCaches: SW_CLEANUP_OUTDATED_CACHES,
        runtimeCaching: [...SW_RUNTIME_CACHING],
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
