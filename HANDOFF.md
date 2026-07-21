# HANDOFF — finish the Pages→Workers migration & restore continuous deployment

**Status (2026-07-21):** the repo migrated from Cloudflare **Pages** to **Workers**,
but deployment was left half-wired. `deploy-web` has **failed on every push to
`main` since the migration**, so the deployed site and phone OTA are frozen at an
old build (~324) while `main` is at build **355**. `android-apk` and `web-e2e` CI
are green; only the web/OTA deploy is broken.

This doc is the checklist to move the domain over, set the Cloudflare secrets, and
get CD working again. It complements the one-time setup in [`docs/deploy.md`](docs/deploy.md).

---

## Unblock a phone RIGHT NOW (no deploy needed)

The `android-apk` workflow already builds a current debug APK on every push. Its
**bundle is build 355** (hi-res toggle, modded enemies, art, perf — everything).
Install it directly:

    https://github.com/redaphid/sporefall-station/releases/download/latest/ecs-game.apk

This sidesteps the broken OTA chain. (That APK still bakes the *old* OTA URL — see
§3 — so it won't self-update until §3 is done, but the installed build is current.)

---

## Why it's broken (diagnosis)

| # | Problem | Evidence |
|---|---------|----------|
| 1 | New repo has **no `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets** | `gh secret list -R redaphid/sporefall-station` is empty; deploy log: *"necessary to set a CLOUDFLARE_API_TOKEN environment variable"* |
| 2 | **`SITE_URL` repo variable not set** → OTA manifest + APK links use a placeholder | `deploy-web.yml` uses `vars.SITE_URL` (falls back to `https://sporefall-station.workers.dev`) |
| 3 | **OTA URL mismatch**: `capacitor.config.ts` defaults `OTA_UPDATE_URL` to the *old Pages* endpoint `https://backseat-sd8.pages.dev/ota/check`; OTA now lives in the Worker (`src/worker/ota.ts` → `<origin>/ota/check`). The old Pages `functions/ota/check.ts` was removed. | Installed APKs (incl. CI `latest`) poll the dead Pages URL |
| 4 | **`android-apk.yml` never sets `OTA_UPDATE_URL`** at build time → APKs bake the wrong (default) OTA URL | no `OTA_UPDATE_URL` in the workflow |
| 5 | The **old repo** (`redaphid/mobile-streets-of-rogue`) had a working Pages deploy + a **Pages-scoped** token; `main` was force-migrated to Workers code, so its `deploy-web` now fails too (a Pages token can't deploy a Worker) | old-repo `deploy-web` run `29811078682` = failure |

The `deploy-web.yml` workflow itself is **correct** (`apiToken:`/`accountId:` are
wired from secrets via `cloudflare/wrangler-action@v3`). The failures are missing
secrets/variables and the OTA-origin mismatch — not YAML bugs.

---

## Fix checklist

### 1. Cloudflare secrets  (owner — these are credentials; do them yourself)

1. **Create a Workers API token:** Cloudflare dashboard → *My Profile* → *API
   Tokens* → *Create Token* → template **"Edit Cloudflare Workers"** (scope
   *Workers Scripts: Edit*). Pages-scoped tokens will NOT work for the Worker deploy.
2. **Account ID:** `npx wrangler whoami` (after `npx wrangler login`) or dashboard →
   *Workers & Pages* (right sidebar).
3. **First manual deploy** (creates the Worker + RoomDO Durable Object; prints the
   `*.workers.dev` origin you'll need in §2):
   ```bash
   pnpm install --frozen-lockfile
   pnpm run build            # leave CAP_SERVER_URL unset → produces dist/
   npx wrangler login
   npx wrangler deploy
   ```
4. **Set the CI secrets on the new repo:**
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN  -R redaphid/sporefall-station   # paste the token
   gh secret set CLOUDFLARE_ACCOUNT_ID -R redaphid/sporefall-station   # paste the account id
   ```

### 2. Move the domain over

**Canonical origin (decided):** `https://sporefall.hypnodroid.com`

1. **Move the custom domain to the Worker:** dashboard → *Workers & Pages* →
   `sporefall-station` → *Settings* → *Domains & Routes* → **Add custom domain** →
   `sporefall.hypnodroid.com`. If this hostname is still attached to the old Pages
   project, **remove it from the old Pages project first** (a hostname can attach to
   only one service).
2. **Point CI at it** — set the `SITE_URL` repo *variable* (Settings → Secrets and
   variables → Actions → **Variables**), which `deploy-web.yml` uses to build the
   OTA manifest and the `/download` APK links:
   ```bash
   gh variable set SITE_URL -R redaphid/sporefall-station --body https://sporefall.hypnodroid.com
   ```
3. Update the play URL in `docs/play.md` and `README.md` to `https://sporefall.hypnodroid.com`.

### 3. Repoint OTA so installed phones self-update again

The APK must poll `https://sporefall.hypnodroid.com/ota/check`, not the old Pages URL.

1. **Change the build-time default:** in `capacitor.config.ts` set the
   `otaUpdateUrl` fallback to `https://sporefall.hypnodroid.com/ota/check` (currently
   `https://backseat-sd8.pages.dev/ota/check`).
2. **Have the APK build pass it:** add `OTA_UPDATE_URL: https://sporefall.hypnodroid.com/ota/check`
   (or `${{ vars.SITE_URL }}/ota/check`) to `android-apk.yml` **and**
   `release-apk.yml` build env, so tagged + rolling APKs bake the right endpoint.
3. **Rebuild + reinstall the APK once.** After that, OTA works and future `main`
   pushes update phones automatically.
4. *(Optional bridge)* to keep phones on the OLD APK (build ≤324, baked to the
   Pages URL) updatable: keep a minimal Cloudflare Pages project at
   `backseat-sd8.pages.dev` whose `/ota/check` **302-redirects** to
   `https://sporefall.hypnodroid.com/ota/check`. Otherwise those installs are stranded and must
   be re-installed from the APK link above.

### 4. Re-enable CI (after §1–§3)

```bash
# re-run the last failed web deploy (or just push any commit to main)
gh run rerun 29809609068 -R redaphid/sporefall-station
# verify it goes green and serves build 355
gh run list --workflow=deploy-web.yml -R redaphid/sporefall-station --limit 3
```

### 5. Decide the old repo's fate

`redaphid/mobile-streets-of-rogue` `main` was fast-forwarded to the Workers code
(`d580a37`), which broke its Pages deploy. Either:
- **Revert** it to keep the Pages deploy as a fallback OTA source for stranded old
  installs: `git push old-origin d580a37~1:main --force-with-lease` (its last-good
  Pages build was `dbd0ecb`), **or**
- **Archive/retire** it and rely solely on the Workers origin + fresh APKs.

---

## Done when

- [ ] `deploy-web` is green on push to `main`.
- [ ] `https://sporefall.hypnodroid.com` serves build **355** (check the version line on the start menu).
- [ ] `https://sporefall.hypnodroid.com/ota/check` returns a manifest for the current bundle.
- [ ] A phone with a **freshly-installed** APK OTA-updates on next launch.
- [ ] `SITE_URL` variable + both Cloudflare secrets set on `redaphid/sporefall-station`.
- [ ] Old-repo decision made (§5).

## Key files

- `docs/deploy.md` — canonical one-time setup (the source this condenses).
- `.github/workflows/deploy-web.yml` — the failing Worker deploy (wiring is correct; needs secrets + `SITE_URL`).
- `.github/workflows/android-apk.yml`, `release-apk.yml` — APK builds (need `OTA_UPDATE_URL`).
- `wrangler.jsonc` — Worker config (name `sporefall-station`, assets `./dist`, `/ws/*` + `/ota/*` routes, RoomDO).
- `capacitor.config.ts` — the baked `otaUpdateUrl` default.
- `src/worker/ota.ts` — the Worker OTA route that replaced the old Pages Function.
