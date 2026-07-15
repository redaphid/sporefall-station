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
     **Pages** → **Upload assets**. Name it **`backseat`** (must match
     `--project-name` in `deploy-web.yml` and `name` in `wrangler.toml`).
   - Or CLI, which also does the first deploy:
     ```bash
     pnpm install --frozen-lockfile
     pnpm run build            # produces dist/  (leave CAP_SERVER_URL unset!)
     pnpm exec wrangler login       # opens a browser to authorize your account
     pnpm exec wrangler pages deploy --project-name=backseat
     ```
2. **Create an API token** for CI: Cloudflare dashboard → **My Profile** →
   **API Tokens** → **Create Token** → template **"Edit Cloudflare Workers"**,
   or a custom token with **Account → Cloudflare Pages → Edit** permission.
3. **Find your Account ID:** dashboard → **Workers & Pages** (right sidebar), or
   `pnpm exec wrangler whoami`.
4. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` — the token from step 2 (Pages:Edit scope).
   - `CLOUDFLARE_ACCOUNT_ID` — from step 3.
5. Push to `main`. The deploy runs; the workflow log prints the deployment URL.
   Your stable URL is `https://backseat-sd8.pages.dev`.
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

**Approach:** on a `v*` tag, `release-apk.yml` sets up JDK 21 + Android SDK and
runs `scripts/build-apk.sh`. If the four signing secrets (below) are set it
decodes the keystore and builds a **signed** `assembleRelease` APK
(`pnpm run build:apk:release`); if they're absent it falls back to the debug
build so the release never breaks. Either way the APK is attached to a GitHub
Release with `softprops/action-gh-release@v2`.

### Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release appears at `.../releases/latest` with `backseat.apk`. The title says
`(signed APK)` or `(debug APK)` depending on whether the secrets were present.

### Signed release APK — one-time setup (#30)

The gradle wiring is already in place (`android/app/build.gradle`): the release
build reads its signing config from a gitignored `android/keystore.properties`
**or** from `ANDROID_KEYSTORE_*` env vars, and falls back to debug signing (with
a loud warning) if neither is present. You only need to **generate a key and set
the secrets** — the repo never contains the keystore or any password.

> **⚠️ The signing key must stay STABLE forever.** Android identifies an app by
> its signing certificate. If a future release is signed with a *different* key,
> every installed phone rejects the update ("App not installed" / signature
> mismatch) and users must uninstall + reinstall, losing local data. Generate
> the keystore **once**, back it up somewhere safe (a password manager /
> encrypted vault), and reuse it for every release. Losing it = the same forced
> uninstall for all users. `validity 10000` days (~27 yrs) keeps it usable long
> term.

**1. Generate a release keystore** (replace the placeholders; you'll be prompted
for the store + key passwords — they can be the same):

```bash
keytool -genkeypair -v \
  -keystore backseat-release.keystore \
  -alias backseat \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Backseat, O=hypnodroid, C=US"
# You'll be asked for a keystore password (and can reuse it for the key).
```

This makes `backseat-release.keystore` in your current dir. **Do not commit it.**
(`*.keystore`, `*.jks`, and `keystore.properties` are gitignored.)

**2a. Build locally (optional)** — create a gitignored `android/keystore.properties`:

```properties
storeFile=/absolute/path/to/backseat-release.keystore
storePassword=YOUR_STORE_PASSWORD
keyAlias=backseat
keyPassword=YOUR_KEY_PASSWORD
```

Then `pnpm run build:apk:release` → signed APK at
`android/app/build/outputs/apk/release/app-release.apk`. (Env vars
`ANDROID_KEYSTORE_FILE` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` /
`ANDROID_KEY_PASSWORD` work instead of the file, and are what CI uses.)

**2b. Set the CI secrets** — base64-encode the keystore and set all four secrets
with the `gh` CLI (run from the repo root; `-w0` = no line wraps on Linux; on
macOS use `base64 -i backseat-release.keystore`):

```bash
gh secret set ANDROID_KEYSTORE_BASE64   < <(base64 -w0 backseat-release.keystore)
gh secret set ANDROID_KEYSTORE_PASSWORD --body 'YOUR_STORE_PASSWORD'
gh secret set ANDROID_KEY_ALIAS         --body 'backseat'
gh secret set ANDROID_KEY_PASSWORD      --body 'YOUR_KEY_PASSWORD'
```

Verify they exist (values are never shown): `gh secret list`.

**3. Release.** Push a `v*` tag. The workflow decodes `ANDROID_KEYSTORE_BASE64`
to a temp file, exports the passwords/alias as env vars, builds
`assembleRelease`, and runs `apksigner verify` to confirm the APK is NOT
debug-signed before publishing. If any secret is missing it quietly ships the
debug APK instead.

### Migration: debug → release signing (one-time uninstall)

Everyone who already sideloaded a **debug** build must **uninstall it once**,
then install the first signed release. This is unavoidable: the signing
certificate changes from the shared Android debug key to your release key, and
Android refuses to update across a changed signature. After that first
reinstall, **all future signed releases install in place** (no uninstall) as
long as the key stays the same.

**Honest scope of what signing fixes:**

- ✅ In-place upgrades over previous **signed** releases (no uninstall).
- ✅ No "debug build" / Play Protect friction that debug-signed APKs trigger.
- ❌ It does **not** remove the first-time "allow installs from this source"
  prompt. That permission is inherent to *sideloading* any APK outside the Play
  Store and only the Play Store removes it. The user grants it once per source
  (browser / file manager), then it's remembered.
- Note: `versionCode` is currently a fixed `1`. `adb install -r` reinstalls the
  same version fine, but for Android to treat a new APK as an *upgrade* you must
  bump `versionCode` (and ideally `versionName`) in `android/app/build.gradle`
  before tagging. Keep it monotonically increasing.

### Secrets summary (APK)

| Secret | Needed for |
| --- | --- |
| `GITHUB_TOKEN` (built-in) | publishing the Release — nothing to add |
| `ANDROID_KEYSTORE_BASE64` | signed release — `base64 -w0` of the keystore |
| `ANDROID_KEYSTORE_PASSWORD` | signed release — keystore password |
| `ANDROID_KEY_ALIAS` | signed release — key alias (e.g. `backseat`) |
| `ANDROID_KEY_PASSWORD` | signed release — key password |

If the four `ANDROID_*` secrets are absent, the workflow still succeeds and
ships a debug APK. Nothing secret is ever committed — the keystore lives only in
the `ANDROID_KEYSTORE_BASE64` secret and your own backup.

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
- The manifest URL defaults to `https://backseat-sd8.pages.dev/ota/check`.
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
