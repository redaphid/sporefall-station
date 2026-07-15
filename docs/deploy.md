# Deploy & Release setup

How the game ships, and the one-time setup **you** (the repo owner) must do.
CI can't do these steps — they need secrets and account access.

Two independent channels:

| Channel | Workflow | Trigger | Output |
| --- | --- | --- | --- |
| Web (Cloudflare Pages) | `.github/workflows/deploy-web.yml` | push to `main` | a play URL + an OTA bundle, always current |
| Android APK | `.github/workflows/release-apk.yml` | push a `v*` tag | APK on a GitHub Release |

The web deploy also ships **OTA updates** to installed APKs (see section C) —
so a push to `main` updates both the browser version and the phones.

There is also `android-apk.yml`, which builds a debug APK on every push/PR and
keeps a rolling `latest` prerelease. Tagged releases are handled only by
`release-apk.yml`.

---

## A. Cloudflare Pages web deploy

**Approach:** `cloudflare/wrangler-action@v3` running `wrangler pages deploy`.
This is Cloudflare's current recommended path — the old `cloudflare/pages-action`
is **deprecated** and points at wrangler-action. The build output dir (`dist`)
comes from `wrangler.toml` (`pages_build_output_dir = "dist"`).

- SPA fallback + cache/security headers: `public/_redirects` and
  `public/_headers` (Vite copies them into `dist/`).
- PWA (Add-to-Home-Screen): `public/manifest.webmanifest` + `public/icons/*`,
  linked from `index.html`.

### One-time setup

1. **Create the Pages project** (Direct Upload). Either:
   - Dashboard: Cloudflare dashboard → **Workers & Pages** → **Create** →
     **Pages** → **Upload assets**. Name it **`streets-of-rogue-ish`** (must match
     `--project-name` in `deploy-web.yml` and `name` in `wrangler.toml`).
   - Or CLI, which also does the first deploy:
     ```bash
     npm ci
     npm run build            # produces dist/  (leave CAP_SERVER_URL unset!)
     npx wrangler login       # opens a browser to authorize your account
     npx wrangler pages deploy --project-name=streets-of-rogue-ish
     ```
2. **Create an API token** for CI: Cloudflare dashboard → **My Profile** →
   **API Tokens** → **Create Token** → template **"Edit Cloudflare Workers"**,
   or a custom token with **Account → Cloudflare Pages → Edit** permission.
3. **Find your Account ID:** dashboard → **Workers & Pages** (right sidebar), or
   `npx wrangler whoami`.
4. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — the token from step 2 (Pages:Edit scope).
   - `CLOUDFLARE_ACCOUNT_ID` — from step 3.
5. Push to `main`. The deploy runs; the workflow log prints the deployment URL.
   Your stable URL is `https://streets-of-rogue-ish.pages.dev`.
6. **Update the play URL** in `docs/play.md` and `README.md` if the project name
   differs.

> **Important — `CAP_SERVER_URL`:** the web deploy must build with
> `CAP_SERVER_URL` **unset/empty**. When set, `capacitor.config.ts` points the
> app at a laptop dev server; a static Cloudflare deploy must serve its own
> bundled `dist/`. The workflow sets `CAP_SERVER_URL: ""` explicitly.

### Secrets summary (web)

| Secret | Where | Scope |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub repo secret | Account → Cloudflare Pages → Edit |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub repo secret | — |

Nothing secret is committed. `wrangler.toml` holds only the project name and
build dir.

---

## B. Android APK release

**Approach:** on a `v*` tag, `release-apk.yml` sets up JDK 21 + Android SDK,
runs `scripts/build-apk.sh` (via `npm run build:apk`), and attaches the APK to a
GitHub Release with `softprops/action-gh-release@v2`. Uses the built-in
`GITHUB_TOKEN` — **no extra secret needed** for the debug flow.

### Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release appears at `.../releases/latest` with `streets-of-rogue-ish.apk`.

### Signed release APK (TODO — #30 slice 1)

Currently the workflow ships the **debug** APK. A debug build installs and
plays but is signed with the throwaway debug key, so it can't upgrade in place
over a release build and isn't OTA-ready. To switch to a signed release:

1. Generate a keystore (keep it **out of git**):
   ```bash
   keytool -genkey -v -keystore release.keystore -alias rogueish \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Wire `android/app/build.gradle` `release { signingConfig ... }` to read from
   env vars / a gitignored `keystore.properties`.
3. Add a release build (`assembleRelease`) producing a signed `app-release.apk`.
4. Base64-encode the keystore and add these GitHub repo secrets:
   - `ANDROID_KEYSTORE_BASE64` — `base64 -w0 release.keystore`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
5. In `release-apk.yml`, decode the keystore before building:
   ```yaml
   - name: Decode keystore
     run: echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > android/app/release.keystore
   ```
   then build the release variant and attach `app-release.apk`.

Remove the `TODO(#30)` markers in `release-apk.yml` once this is done.

### Secrets summary (APK)

| Secret | Needed for |
| --- | --- |
| `GITHUB_TOKEN` (built-in) | debug release (current) — nothing to add |
| `ANDROID_KEYSTORE_BASE64` | signed release (TODO) |
| `ANDROID_KEYSTORE_PASSWORD` | signed release (TODO) |
| `ANDROID_KEY_ALIAS` | signed release (TODO) |
| `ANDROID_KEY_PASSWORD` | signed release (TODO) |

---

## C. OTA updates (install once, auto-update)

Installed APKs silently update their **web bundle** (JS/HTML/CSS) on launch —
the Expo-like flow — with no reinstall. Native/plugin changes still need a new
APK (channel B). This is **fully self-hosted and free**: everything rides on the
same Cloudflare Pages project as the web deploy.

**How it works**

- Plugin: [`@capgo/capacitor-updater`](https://github.com/Cap-go/capacitor-updater)
  (MIT, self-hostable), configured in `capacitor.config.ts` with
  `autoUpdate: true` + `autoUpdateUrl` and `statsUrl: ''`. The plugin config is
  only added when `CAP_SERVER_URL` is **unset**, so dev live-reload is never
  affected.
- On each launch (when online) the native app POSTs to `/ota/check`, a Cloudflare
  **Pages Function** (`functions/ota/check.ts`). It reads the published version
  from `/ota/version.json` and replies `{ version, url }` if the installed bundle
  is older, else `{ message: 'up-to-date' }`.
- `deploy-web.yml` builds the app, zips it to `dist/ota/<version>.zip`, and writes
  `dist/ota/version.json`, then deploys everything. Version = git tag or short SHA.
- The app downloads a newer bundle in the background and swaps it in on the next
  launch. `src/app/ota.ts` calls `notifyAppReady()` so the native side keeps the
  new bundle (and auto-rolls-back if a bundle fails to boot).
- **Offline-safe:** if the check or download fails, the installed bundle just
  keeps running — no user-visible delay, no crash.

**Setup / config**

- No extra secrets. OTA reuses the same Cloudflare Pages project and the
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from section A. Cloudflare
  Pages Functions are included free.
- The manifest URL defaults to `https://streets-of-rogue-ish.pages.dev/ota/check`.
  If your Pages project name or domain differs, set **both**:
  - Build-time env `OTA_UPDATE_URL` (baked into the APK by `capacitor.config.ts`)
    → point it at `https://<your-domain>/ota/check`.
  - Repo **variable** `SITE_URL` (Settings → Secrets and variables → Actions →
    Variables) → `https://<your-domain>` so the manifest's bundle `url` matches.
- Publish an OTA update: just push to `main` (the web deploy does it). To ship a
  web fix to phones without a new APK, that's all you do.

> Guard: OTA only carries the **web** bundle. Anything touching native code or
> plugins (e.g. BLE) must go out as a new signed APK (channel B).

---

## Sources

- Cloudflare `pages-action` is deprecated, use `wrangler-action`:
  https://github.com/cloudflare/pages-action
- `cloudflare/wrangler-action` (Pages deploy usage):
  https://github.com/cloudflare/wrangler-action
- Capgo self-hosted auto-update (on-premise manifest `{version,url}`, POST
  request, `notifyAppReady` rollback):
  https://github.com/cap-go/capacitor-updater/wiki/Auto-update-on-premise
