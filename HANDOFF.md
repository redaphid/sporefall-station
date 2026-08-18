# Deploy status — the Pages→Workers migration is DONE

**Verified 2026-08-18 against `origin/main` @ `4b62cb1` (build 424).**

> ### Read this first: the old version of this file was wrong
>
> Until now this document opened with *"`deploy-web` has **failed on every push to
> `main` since the migration**, so the deployed site and phone OTA are frozen at an
> old build (~324) while `main` is at build 355."*
>
> **That has been false since 2026-07-21.** It cost at least one agent real effort
> routing around a problem that did not exist. `deploy-web` ran **green on 24
> consecutive pushes** to `main` from 2026-07-21 through 2026-08-18T04:34Z, and the
> OTA endpoint has been serving current builds throughout. Every item on the old
> fix-checklist was already complete. The evidence is in the table below.
>
> If you are about to work around a broken deploy, **check `gh run list` first.**

## What is actually true

| Old claim | Reality | Evidence |
|---|---|---|
| No `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Both set | `gh secret list` → set `2026-07-21T08:23:55Z` / `08:47:12Z` |
| `SITE_URL` variable not set | Set | `gh variable list` → `SITE_URL = https://sporefall.hypnodroid.com`, `2026-07-21T08:23:56Z` |
| `capacitor.config.ts` points OTA at the old Pages URL | Points at the canonical origin | `capacitor.config.ts:16-17` |
| APK workflows never set `OTA_UPDATE_URL` | Both set it | `android-apk.yml:56`, `release-apk.yml:86,97` |
| Custom domain not moved | Live and serving | `wrangler.jsonc:13-16` (`custom_domain: true`) |
| Old repo's fate undecided | Archived | `gh repo view redaphid/mobile-streets-of-rogue` → `isArchived: true` |
| Deploy broken | 24 consecutive green runs | `gh run list --workflow=deploy-web.yml` |

Canonical origin: **`https://sporefall.hypnodroid.com`**. OTA manifest:
`POST /ota/check` → served by `src/worker/ota.ts`.

## The one thing that IS broken right now (owner action)

**GitHub Actions is blocked on billing.** Every workflow on the `4b62cb1` push
(#41) failed within seconds:

```
The job was not started because recent account payments have failed
or your spending limit needs to be increased.
```

- `deploy-web` run `32129937004` — failed in 2s
- `android-apk` run `32129937025` — failed in 3s
- `web-e2e`   run `32129936953` — failed in 5s

This is **not** a code or YAML failure. The Actions quota is exhausted and the
spending limit is **$0**, so GitHub refuses to *start* jobs.

**How the quota went:** a single run wedged in `Install Chromium for Playwright`
— normally ~26 seconds — and ran for **6 hours** until GitHub's own cap killed it,
burning roughly **18% of the monthly allowance** in one go. It ran that long
because **no job in any workflow sets `timeout-minutes`**, so the only limit in
play was the account-level one.

Only the owner can clear it: GitHub → Settings → Billing & plans (raise the
spending limit or wait for the monthly reset), then:

```bash
gh run rerun 32129937004 -R redaphid/sporefall-station
```

**A red badge on this repo may mean "billing", not "broken".** Check the
annotation before you debug anything: a job that fails in 2–5 seconds with *"The
job was not started…"* never ran your code.

### Job timeouts — still missing on `main`

`grep -rn timeout-minutes .github/workflows/` returns **nothing** at `4b62cb1`.
Any stuck step can drain the month again. A branch **`ci/job-timeouts`**
(`1bd6ddc`, on `origin`, **not merged**) adds job caps — deploy-web 20, preview-web
20, android-apk 25, release-apk 30, web-e2e 45, plus a 10-minute step cap. It is
unreviewed and unmerged; this is a description, not a statement that it is fixed.

**Expected healthy runtimes** (for judging "wedged" vs "slow"):

| Workflow | Typical | Notes |
|---|---|---|
| `deploy-web` | ~1m0s–1m15s | |
| `preview-web` | ~50s–1m5s | |
| `android-apk` | ~4m0s–4m30s | |
| `web-e2e` | ~12m (PR) – 25m (main) | the long pole; builds, records video, muxes |

Anything an order of magnitude past these is stuck, and every minute is billed.

**Consequence while it is blocked:** `main` is build **424**; the live site and OTA
still serve build **423** (i.e. `6c982ef`, one commit behind). The boss-brood spawn
fix in #41 is on `main` but has not reached any phone or browser.

```bash
# how to check this yourself
git rev-list --count origin/main                    # what main should serve
curl -s https://sporefall.hypnodroid.com/ota/check  # what it actually serves
```

The build number is `git rev-list --count HEAD` (`deploy-web.yml:70`) — a commit
count, matched to the number `vite.config.ts` bakes into the app. Not a tag, not a SHA.

## Still open: phones stranded on the retired Pages OTA

`https://backseat-sd8.pages.dev/ota/check` is **still live** and still answers:

```json
{"ok":true,"current":{"version":"324","url":"https://backseat-sd8.pages.dev/ota/324.zip"}}
```

Any APK installed before the migration polls that URL and is told build 324 is
current — forever. The "302-redirect the old endpoint at the new one" bridge was
never built. **Decide one of:**

- add the redirect on the old Pages project, so those installs self-heal; or
- accept it, and tell affected people to reinstall from
  `https://sporefall.hypnodroid.com/download`.

Nothing in this repo can fix it — the old Pages project is a separate deployment.

## Related

- `docs/deploy.md` — the full setup/verification reference.
- **CI does not run the test suite.** See `CLAUDE.md` § Release / branch workflow;
  a green tick does not mean `vitest`/`lint` passed.
