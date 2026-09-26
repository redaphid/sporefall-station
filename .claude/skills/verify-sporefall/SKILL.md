---
name: verify-sporefall
description: Launch this checkout's Sporefall Station web build on a port you own and drive it like a player to prove a change works. Covers the start menu, solo runs, ?scenario= deep links, the window.sporefall console surface, same-machine co-op, and ?state= links. Use it before you call a player-visible change done, or to reproduce a reported bug on the real page. Two lanes. The soul-desktop Playwright MCP gives a GPU-rendered world and screenshots. scripts/drive.mjs gives scripted headless sim and DOM assertions plus a video.
---

# Verify Sporefall Station

The primary surface is the web build served from `dist/`. It is the same bundle the
phones run. The Android APK and real BLE need two phones, so this skill cannot drive
them. Say that in your report rather than claiming them.

All paths below are relative to the repo root. The helpers live in
`.claude/skills/verify-sporefall/scripts/`, which is abbreviated `$S` here.

## Launch

```sh
S=.claude/skills/verify-sporefall/scripts
$S/serve.sh start 4990        # vite build, then vite preview on 127.0.0.1:4990 (--strictPort)
SKIP_BUILD=1 $S/serve.sh start 4990   # reuse dist/ when nothing changed since the last build
```

`serve.sh start` finishes by running the doctor. Ready means every doctor line is `ok`.
Pick a different port per concurrent run. The e2e suites already use 4977, 4978, and
8123, so stay at 4990 and up.

The preview serves static `dist/` only. `?state=` links also need the Worker, which you
run with `pnpm exec wrangler dev --port 8787` (see [state links](features/state-links.md)).

## Doctor

```sh
$S/doctor.sh 4990
```

This check is read-only. It confirms four things. The pid this script recorded is alive.
The port answers. The served HTML references a bundle that exists in *this* checkout's
`dist/`, so it is not a stale preview from another worktree. And no `src/` file is newer
than the build. It also prints the build number the start menu shows (`564+`, where `+`
means a dirty tree). Run it first whenever a result looks wrong.

## Drive

Choose the lane by what the proof needs to show.

**Lane A: the soul-desktop Playwright MCP (`mcp__soul__playwright__*`).** Use this for
anything visual: sprites, tiles, FX, layout, and "does it look right". It is headed Chrome
on the Windows host with the real GPU (ANGLE/D3D11, RTX 4090). It reaches the WSL server
at `http://localhost:<port>`.

- `browser_navigate` to `http://localhost:4990/?mode=solo&seed=7`.
- Gate readiness with `browser_evaluate` on `() => window.world?.tick`. Do not rely on
  load events (see the gotcha below).
- Read the sim with `window.sporefall.*`. `sporefall.help()` lists the API.
- Use `browser_snapshot` for button refs, then `browser_click`. The start menu buttons
  are named `Solo run`, `Host co-op`, `Join co-op`, and `Settings`.
- Take screenshots with `browser_take_screenshot` and `filename: "verify-<feature>-<label>.png"`.
  The file lands in `D:\Projects\playwright-mcp\`, which is `/mnt/d/Projects/playwright-mcp/`
  from WSL. Move it into your evidence dir right away.
- This is one shared browser. You cannot run it side by side, and another session may be
  using it. Drive one tab, and leave it on `about:blank` when you finish.

**Lane B: `scripts/drive.mjs` (headless Playwright in WSL).** Use this for scripted,
repeatable assertions on sim state and the DOM, and for a video of the run. Under WSL the
headless GPU process crashes the tab once pixi requests a context, so the driver launches
with `--disable-gpu --disable-software-rasterizer`. The DOM HUD renders. **The world canvas
is black.** Never cite a Lane B still as visual proof.

```sh
$S/drive.mjs --name solo-from-menu --video \
  --open '/?seed=7' \
  --until "document.querySelector('[data-role=start-menu]')" --shot start-menu \
  --click 'Solo run' --until-tick 90 \
  --assert "sporefall.session().mode === 'solo' && sporefall.session().seed === 7" \
  --eval "({floor: sporefall.session().floor, npcs: sporefall.entities('npc').length})" \
  --shot in-run
```

Steps run in argv order. The full list is in the header of `drive.mjs`: `--open`,
`--reload`, `--click`, `--until-tick`, `--until`, `--eval`, `--assert`, `--shot`, and
`--wait-ms`. The exit code is 0 only if every `--assert` held and the page threw nothing.

Useful URL parameters: `mode=solo|host|join`, `seed=N`, `floor=N`, `scenario=<name>`
(from `src/game/scenarios.ts`), `script=<name>` (from `src/input/scripted.ts`),
`state=<id>`, `debug` (enables `sporefall.verb`), `transport=tabs`, `room`, `name`, and
`zoom`. The feature files say which ones apply.

## Evidence

Every Lane B run writes `e2e/output/verify/<timestamp>-<name>/`. It holds `run.json`
(every step with its result and sim tick, plus the verdict, page errors, and console
errors), numbered PNGs, and `<name>.mp4` when you pass `--video`. Put Lane A screenshots
in a directory of the same shape. `e2e/output*/` is gitignored. To show a reviewer an
image, publish it with `pnpm run review:image <png>`, because the repo is private.

Proof standards:

- Drive the path a player uses. Start from the start menu or the deep-link URL a player
  would open. `sporefall.verb` staging (`?debug`) is fine for setting up a situation, but
  the behavior you claim must come from the real systems running.
- Capture the action and the result. That means a still before and after, and the sim
  values that changed (`--eval` before and after, with ticks).
- Check side effects as well as pixels. For saves, read `localStorage['sporefall.savegame']`.
  For co-op, check both pages' `world.tick` and entity counts. For state links, compare
  the stored `/state/<id>` payload.
- Visual claims need Lane A stills. Sim claims need Lane B asserts or Lane A evaluates
  with values quoted.
- `?state=` links you hand the owner are captured against the **live site after deploy**
  (see the repo `CLAUDE.md`), not against this local build.

## Cleanup

```sh
$S/serve.sh stop 4990     # kills only the process group serve.sh recorded
$S/serve.sh status        # anything left over from this checkout
```

Stop any `wrangler dev` you started by its own pid. In the soul-desktop browser, navigate
the tab to `about:blank`. Cleanup never touches `e2e/output/verify/`, because that is
where the proof lives.

## Gotchas

- **DOMContentLoaded never fires on the start menu.** `main.ts` awaits the mode picker at
  top level, and the module blocks DCL until a mode is picked. `page.goto` with the default
  `load` or `domcontentloaded` hangs. The driver navigates on `commit`, and readiness
  comes from `--until`.
- **Headless WSL Chromium has no working WebGL.** The default flags and swiftshader both
  crash the tab. Use Lane A for anything rendered.
- **A saved run resumes.** After a plain `/`, picking Solo run continues the autosave in
  that browser profile rather than starting fresh. Lane B `--open` gets a fresh context
  every time. Lane A shares a profile, and even `?mode=solo&seed=7` resumed a seed-7 save
  there (it came up at tick 10769). For a fresh Lane A run, first `browser_evaluate`
  `() => localStorage.removeItem('sporefall.savegame')` on the origin, then navigate.
- **The service worker.** A preview origin that previously served an older build can hand
  back that build. Doctor checks the server, not the page. If behavior looks stale in
  Lane A, compare `sporefall.version()` with the doctor's build number.

## Feature map

[`features/README.md`](features/README.md) indexes one recipe per player-facing feature.
When a feature has several entry points, a proof covers all of them or names the ones it
skipped.
