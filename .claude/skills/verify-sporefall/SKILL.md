---
name: verify-sporefall
description: Launch this checkout's Sporefall Station web build on a port you own and drive it like a player to prove a change works. Covers the start menu, solo runs, ?scenario= deep links, the window.sporefall console surface, same-machine co-op, and ?state= links. Use it before you call a player-visible change done, or to reproduce a reported bug on the real page. Headless playtesting via scripts/playtest.mts (no browser) is the default for judging builds. claude-in-chrome gives a GPU-rendered world, one tab per agent, and deterministic playtesting via the held-input step verb. scripts/drive.mjs gives scripted headless sim and DOM assertions plus a video.
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

## Playtest headless (preferred for judging a build)

The sim is pure TypeScript, so a playtester needs no browser, no server, and no desktop.
Each playtester owns one state file, and every call is one verb against it:

```sh
pt() { npx tsx scripts/playtest.mts "$@"; }        # zsh does not word-split a $VAR command
pt run.json new --seed 31337                        # the real solo floor 1 (HostSession), prints `look`
pt run.json new --seed 5 --scenario armed --floor 3 # or any ?scenario= name; --sequenced for the wand flag
pt run.json look 10                                 # player build + nearby entities, nearest first (hp, fx, resist, ai mode)
pt run.json spawn npc brute 1.5 6                   # stage a situation with any debug verb
pt run.json addMod 222 incendiary
pt run.json step 90 '{"aimAt":223,"attack":true}'   # hold an input for 90 ticks (3 s); returns event counts
```

A run split across calls is byte-identical to one continuous run. The PRNG position is
saved with the world, and a unit test enforces this. `step` input fields are the same as in
Lane A below. If the `aimAt` target dies mid-burst, aim holds and the reply says
`aimAtGone`. Play in bursts of 15 to 90 ticks and `look` between them, like a player
reacting.

Measured example (seed 31337, a brute placed 4.5 tiles away): a plain pistol did 25 of 95
HP in 3 s against the brute's `physical: 0.35`. Adding `incendiary` did 52 more in the next
3 s and left it `burning`, while it closed in and took the player from 120 to 40. That is
the shape of evidence a fun or variety verdict should rest on.

Limits: there is no picture (take stills in Lane A), and co-op is one held player per call
(use `"player":N`).

## Drive

Choose the lane by what the proof needs to show.

**Lane A: claude-in-chrome (`mcp__claude-in-chrome__*`).** Use this for anything visual
(sprites, tiles, FX, layout, "does it look right") and for playtesting. It is the owner's
desktop Chrome with the real GPU (ANGLE/D3D11, RTX 4090), and it reaches the WSL server at
`http://localhost:<port>`. Every action takes a `tabId`, so parallel agents are safe as long
as each one owns its tab.

- `tabs_context_mcp` first. If it says the extension is not connected, stop and report it,
  because the owner has to open Chrome. Then `tabs_create_mcp`, and `navigate` your own tab
  to `http://localhost:4990/?mode=solo&seed=7&debug`. Close your tab with `tabs_close_mcp`
  when you finish.
- **Background tabs do not tick.** Chrome freezes the frame loop of any tab that is not in
  front, and only one tab per window is in front. Never wait on the live clock. Advance the
  sim yourself with the held-input step verb (below), which runs synchronously in any tab.
- Read the sim with `javascript_tool` and `window.sporefall.*`. `sporefall.help()` lists the API.
- **Stills need a visible tab in a visible window.** A hidden tab's WebGL canvas does not
  composite, so its screenshot shows the HUD over a black world. Check
  `document.hidden === false` before you take a still. If the whole Chrome window is
  minimized or covered, every tab reports hidden, and only the owner can fix that.
  Visible frames also tick the sim live, so a still is evidence of how things look, not a
  determinism checkpoint.
- Stills for a PR: `computer` `screenshot` with `save_to_disk: true`, then move the file into
  your evidence dir.
- GIFs: `gif_creator` records no frame for a scaled `screenshot` action. Use `wait` actions,
  clicks, and full-size screenshots as the frame clock. Every GIF frame plays for 300 ms,
  whatever the real time between two actions was, so the GIF's pace is not the game's.

**Playtesting with the held-input step verb** (`?debug` only). This advances the real sim
N ticks while holding one player's `InputCmd`, and returns what happened:

```js
sporefall.verb('step 30 {"moveX":1,"moveY":0}')                      // walk right for 1 s
sporefall.verb(`step 45 {"aimAt":${id},"attack":true}`)              // re-aims at entity `id` every tick
sporefall.verb('step 1 {"modSwap":258}')                             // edge fields fire on tick 1 only
// => {"tick":…,"advanced":45,"player":<entity id>,"events":{"hit":6,"death":1,"shock":2,…}}
```

Held every tick: `moveX`, `moveY`, `aimX`, `aimY` (clamped to -1..1), `attack`, and
`special`. First tick only: `interact`, `throwItem`, `roll`, `hotbar`, and `modSwap`
(`packModSwap(a,b) = a<<8|b`). `player` picks a playerId (default: the lowest), and
`aimAt` takes an entity id. Unknown fields, bad types, and missing entities throw and
advance nothing. Play in short bursts (15 to 60 ticks), then read `sporefall.entities(...)`
and `sporefall.player()` before deciding the next move, the way a person reacts. Stage a
situation with `spawn`, `teleport`, and `addMod` first if the test needs one.

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

The preview serves `http://`, so it never shows the browser's HTTPS-only rules, such as the
block on `ws://` sockets from an HTTPS page. To test those rules, add
`--origin https://sporefall.hypnodroid.com`. The page then loads at that origin, and the
driver answers every HTTP request to it from your preview. The driver closes every
WebSocket to that host, so a run never joins the real relay. Requests to other origins
still go to the network.

```sh
$S/drive.mjs --origin https://sporefall.hypnodroid.com --name https-debug \
  --open '/?mode=solo&seed=1&debug' --until-tick 90 \
  --assert "JSON.parse(sporefall.verb('state')).seed === 1"
```

Useful URL parameters: `mode=solo|host|join`, `seed=N`, `floor=N`, `scenario=<name>`
(from `src/game/scenarios.ts`), `script=<name>` (from `src/input/scripted.ts`),
`state=<id>`, `debug` (enables `sporefall.verb`), `transport=tabs`, `room`, `name`, and
`zoom`. The feature files say which ones apply.

## Evidence

Every Lane B run writes `e2e/output/verify/<timestamp>-<name>/`. It holds `run.json`
(every step with its result and sim tick, plus the verdict, page errors, console errors,
and every console line in `consoleLog`), numbered PNGs, and `<name>.mp4` when you pass
`--video`. Put Lane A screenshots
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

Stop any `wrangler dev` you started by its own pid. Close every claude-in-chrome tab you
created. Cleanup never touches `e2e/output/verify/`, because that is
where the proof lives.

## Gotchas

- **DOMContentLoaded never fires on the start menu.** `main.ts` awaits the mode picker at
  top level, and the module blocks DCL until a mode is picked. `page.goto` with the default
  `load` or `domcontentloaded` hangs. The driver navigates on `commit`, and readiness
  comes from `--until`.
- **`?debug` on the live HTTPS site needs the fix for issue #129.** Before that fix, the
  debug channel dialed `ws://` from the HTTPS page, the browser threw `SecurityError`, and
  the page stayed blank at tick 0. Build 658, live on 2026-09-25, has the bug. Every
  build that includes the fix works. On those builds, the console logs
  `[debug] hub unavailable: this page is HTTPS…`, the game runs, and `sporefall.verb`
  works. An HTTPS page never dials the hub, by design, so the CLI and MCP reach only
  games served over `http://`. If `?debug` on the live site shows tick 0 and a
  `SecurityError`, the deployed build predates the fix. Open `?e2e=1` instead, which also
  enables `sporefall.verb`.
- **Headless WSL Chromium has no working WebGL.** The default flags and swiftshader both
  crash the tab. Use Lane A for anything rendered.
- **Lane A tabs freeze in the background.** See Lane A. Drive time with `step`, never with
  waits.
- **A saved run resumes.** After a plain `/`, picking Solo run continues the autosave in
  that browser profile rather than starting fresh. Lane B `--open` gets a fresh context
  every time. A URL with `?seed=N` always starts seed N and never reads or writes the save,
  so a seeded run cannot be resumed by a reload either, and a fresh Lane A run needs no
  cleanup. To exercise the autosave, start the run without `seed=`. Plain `/` and
  `?mode=solo` resume whatever the profile saved, and Lane A shares the owner's profile.
- **The service worker serves the old build.** After a rebuild on the same port, a Lane A
  tab can still run the previous bundle. Compare the page's `index-*.js` script with the
  doctor line, and if they differ, unregister the worker and clear its caches:
  `for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k)`, then reload.

## Feature map

[`features/README.md`](features/README.md) indexes one recipe per player-facing feature.
When a feature has several entry points, a proof covers all of them or names the ones it
skipped.
