# CLAUDE.md — working in this repo

Sporefall Station: a top-down co-op roguelite (Capacitor/Android, TypeScript,
pixi.js) played over Bluetooth LE with no cell service. This file orients an AI
agent working on the codebase. Human-facing setup lives in `README.md`.

## The overarching goal: an AI-native ECS

This engine is deliberately built to be **instrumentable by Claude and by tests**,
not only played by humans. Treat that as a design constraint on new work: prefer
changes that keep the world legible, reproducible, and manipulable by an agent.

The load-bearing property is **determinism**: the sim is a pure function of a
seeded PRNG plus a per-tick `InputCmd`. Same seed + same inputs → byte-identical
world, on every device and every replay. Preserve this. (`src/game/rng.ts` is
stock `mulberry32` — unmodified — wrapped with labelled sub-streams via
`fork(label)` and a resumable `state()`. Sim rate is `SIM_RATE = 30` Hz,
`src/game/types.ts`.)

What "AI-native" means here, concretely:

- **Reason about world state.** The world is plain objects (`src/game/world.ts`,
  `src/game/entity.ts`): `entities` array + `byId` map + seed/tick/floor/level/
  mission/events/alarm/fear/mode/… No opaque typed-array SoA — it is ordinary JSON.
- **Set state exactly & replay.** `serializeWorld`/`deserializeWorld`
  (`src/game/serialize.ts`) round-trip the world *including both PRNG stream
  positions* to/from `WorldJson`. `src/game/testkit.ts` (`loadFixture`, `runTicks`,
  `expectWorldEqual`) builds tests on top: load an exact state → run the real
  systems → assert. Fixtures live in `src/game/__fixtures__/`.
  > **Known gap — not a total round-trip.** `mode` and `revivesLeft` are **not
  > serialized**; a restored world silently reverts to `'normal'`/`REVIVES_PER_RUN`,
  > and the debug `load` verb overwrites a live session's values the same way. Both
  > decide permanent death (`combat.ts`: `w.mode === 'normal' && w.revivesLeft <= 0`),
  > so a casual run — or a normal run with the revive pool spent — does not replay
  > faithfully. Nothing in `serialize.test.ts` asserts either field.
- **Inspect from the browser console.** Every build — including the deployed site,
  with no dev flag — exposes `window.world` (live World) and `window.sporefall`
  (curated read-only namespace: entities/events/schema/serialize/…;
  `sporefall.help()` self-documents). **Installed only once a run has started**
  (`src/main.ts` bails before install if no session), so it is `undefined` while the
  start menu is up. Mutation via `sporefall.verb(...)` is gated on `?debug` **or
  `?e2e`**; ungated it returns a refusal string. An agent driving Chrome needs no
  hub for this — see `docs/ai-inspection.md`.
- **Inspect & mutate at runtime.** Under `?debug`, the webview dials out to a
  WebSocket hub (`tools/debug-hub`); a CLI (`tools/debug-cli`) and an MCP server
  (`tools/mcp-debug`, Streamable HTTP) expose verbs — entities/get/set/spawn/kill/
  teleport/state/events, plus world dump/load and tick-step. Implementation and
  verbs: `src/debug/`. Attach procedure: the **`.claude/skills/ecs-debug` skill**
  and `docs/` (a real JS debugger can attach to a headless run via `node --inspect`).
- **Communicate back to the player.** Drawing/labelling on screen and tap-to-inspect
  annotations run on the same substrate, so the agent can show what it reasons about.
- **Experiment with gameplay.** Compose deterministic scenarios (heists, set-pieces,
  emergent-mechanic tests), narrate them with annotations, and record annotated
  video/stills — see the **`.claude/skills/gameplay-experiments`** skill and
  `docs/gameplay-experiments.md`.
- **Reflect on entity types.** Components are ad-hoc optional fields on `Entity`; a
  reflection/schema verb enumerates what's present so an agent can reason about
  unfamiliar entities rather than relying on a hardcoded list.

## Non-negotiables when changing code

- **Determinism.** Never introduce `Date.now()` or `Math.random()` under `src/game/`
  (eslint enforces this). Use the world RNG (`src/game/rng.ts`) and the tick counter
  for anything time- or chance-based. Layout never crosses the wire — levels
  regenerate bit-exact from `seed+floor`.
- **Testing mandate.** Every feature gets strict, exhaustive, **adversarial** TDD
  that (1) sets world state exactly via `deserializeWorld`/`testkit`, (2) runs the
  actual systems (`tickWorld`/`runTicks`) and asserts on the result, and (3) where it
  affects play, produces an **output video** via the `e2e/` recorder (`record()` in
  `e2e/lib.mjs`). Cover adversarial/degenerate inputs, not just the happy path.
  A harness that has never been watched go red proves nothing — build in a way to
  break it on purpose (see `e2e/net-conditions.mts --self-test`).
- **The layer boundary.** `src/game/` must import no DOM/pixi/net — but eslint only
  **partly** enforces it: `eslint.config.js` blocks imports of `render`/`input`/`ui`/
  `net`/`pixi.js`, while **DOM is not fenced at all** (it arrives via the
  `document`/`window` globals) and `src/debug` is outside the list
  (`src/game/serialize.ts` imports it today). A `document.*` call in the sim will
  pass lint — hold this line by hand. Net code sends bit-exact snapshots; the host
  is authoritative, clients predict + rewind.
- **The debug surface is gated at runtime, not at build time.** `?debug`/`?e2e`
  enable mutation verbs on **any** build, the deployed site included; nothing strips
  them from a release bundle. Reads (`window.world`, `window.sporefall`) are always
  on, by design. Treat "is this a release build?" as no protection.

## Release / branch workflow

Features are built on `feat/*` branches (often by background subagents in git
worktrees) and **merged into `main`** — `main` is the release; phones pull/run it.
Gate every merge on `pnpm run build` (typecheck) + `pnpm exec vitest run` + `pnpm run lint`
all green, resolve conflicts (watch for *semantic* conflicts, not just textual),
re-run the full suite after each merge, then `git push origin main`.

> **That gate is yours alone — CI does not run it.** No workflow runs the full
> suite, `lint`, or `knip`. `deploy-web`/`preview-web` run exactly one test file
> (`src/render/themeManifestSync.test.ts`); `web-e2e` runs `e2e/run.sh`. `pnpm run
> build` (typecheck) does run in CI, via the deploy. So **a green tick does not mean
> the 3059 tests passed** — a merge that breaks them still deploys. Run them locally.

**Deploy state before you diagnose a deploy.** `main` is the release, and the live
build number is `git rev-list --count HEAD`. Check reality first — `gh run list`
plus `curl -s https://sporefall.hypnodroid.com/ota/check` — rather than trusting any
doc's account of what is broken. `HANDOFF.md` records the current state.

**Show your work in the PR body.** Before/after shots belong in the PR — but this
repo is private, so an in-repo image URL renders **broken** for the reviewer. Publish
with `pnpm run review:image <file.png>` and paste the markdown it prints; it serves
the image publicly from the Worker (`/review/*`, KV-backed, never in the game
bundle) and refuses to hand back a URL it hasn't re-fetched as real image bytes.
Honest contact sheets — failures included — are the point. See `docs/deploy.md` § D.

**Keep release notes current.** Each merge to `main` should update
`src/ui/releaseNotes.ts` — prepend a single one-line, player-facing summary of
the change (punchy, no internal/tooling churn) and trim the list. That file is the
source of truth for the "what's new" line under the version number on the start
menu, so the menu always reflects recent builds. Skip it only for pure internals
with nothing a player would notice.
`src/ui/releaseNotes.test.ts` enforces the shape: **≤ 44 characters per line**,
**≤ 4 entries**, no newlines, no untrimmed whitespace. (Player-facing copy — not a
developer changelog. Don't file findings here.)

## Map of the codebase

| Path | What |
|---|---|
| `src/game/` | Deterministic sim: world, entities, systems, rng, serialize, testkit, fixtures, `spawnPlacement.ts` |
| `src/app/` | Session seam: `hostSession.ts` (solo=host, no peers), `netHost.ts`, `netClient.ts`; also `inspect.ts`, `wakeLock.ts`, `ota.ts`, `pwa.ts` |
| `src/net/` | Transport abstraction (BroadcastChannel dev · BLE host/client · **WebSocket** `transport/wsTransport.ts`), framing, protocol |
| `src/worker/` | Cloudflare Worker: `index.ts` router, `roomDO.ts` (WS relay Durable Object), `ota.ts`, `reviewImages.ts` |
| `src/render/` | pixi.js v8 renderer, effects, camera |
| `src/ui/` | HUD, screens/overlays, menus (DOM), `frameErrorModel.ts`, `releaseNotes.ts` |
| `src/input/` | Keyboard, touch/twin-stick, gamepad co-op, scripted (`?script=`) input |
| `src/debug/` | Live debug channel, verbs, record/replay, harness |
| `tools/` | `debug-hub` (WS), `debug-cli`, `mcp-debug` (MCP), `debug-harness`, `tween` (analysis) |
| `e2e/` | Playwright + ffmpeg deterministic video recorder + scenario assertions; **`net-conditions.mts`** (see below) |
| `scripts/test/` | Debug/exploratory harness scripts (not unit tests; no `test_` prefix) |

## Two things that will otherwise cost you an hour

**`e2e/net-conditions.mts` is the best co-op test in the repo and nothing runs it.**
No `package.json` script, no CI job, no other reference — you must invoke it by
hand. It runs the real `NetHostSession`/`NetClientSession` against each other over
a modelled BLE link (180-byte packets, one in flight, latency/jitter/loss/dropouts)
across **20 profiles**, and asserts identity, interest coverage, position
convergence, global-state convergence and liveness. Crucially it can prove itself:

```bash
npx tsx e2e/net-conditions.mts --self-test          # MUST go red (inverted gate)
npx tsx e2e/net-conditions.mts --only ble-typical   # one profile
npx tsx e2e/net-conditions.mts                      # all 20, ~11 min of link time
```

Reach for it before claiming a netcode change is safe. `e2e/ws-multiplayer.mjs` is
**not** a substitute: it pushes whole messages through a 64 KB WebSocket, so it
never fragments and never exercises the reassembly path that every real two-phone
snapshot takes.

**This Windows machine cannot build an APK.** No JDK, no Android SDK (`java`/`javac`
absent, `JAVA_HOME`/`ANDROID_HOME` unset, no `android/local.properties`). The Gradle
wrapper is committed, so `gradlew.bat` *looks* runnable — it is not. The toolchain
exists only in CI: take APKs from the `android-apk` artifact or
`https://sporefall.hypnodroid.com/download`.
`pnpm run e2e:ws*` also fails here — `e2e/ws-lib.mjs` spawns the extension-less
`node_modules/.bin/wrangler` (a POSIX script; Windows needs the sibling `.CMD`) and
dies with an ENOENT that reads like a broken relay. Fix exists, unmerged, on
`feat/ws-online`.

## Measured analyses (read before re-deriving them)

Two docs record real measurements rather than opinion. Both carry open findings.

- `docs/protocol-resilience.md` — what the wire already self-heals and what it does
  not. Verdicts: gRPC/protobuf would be **2.1× larger** than the current 10-byte
  entity records; FEC/parity is not worth it anywhere (framing already loses <1
  message per dropped packet). **Open bug:** the client-side input-sequence u16
  wrap fires at **36.4 minutes** of continuous play and pins the reconcile backlog
  — host side is fixed, client side is not, and nothing tests it. Numbers measured
  at `c189558`; re-measure before citing.
- `docs/tweening-dropped-states.md` — why remote teammates stuttered. The old
  smoothing produced a **3.3× apparent-speed sawtooth at *zero* packet loss**, so
  this was never only a lossy-link problem. Fixed by #40 (`netClient.ts`
  client-side velocity inference, `PROJECT_CAP_TICKS = 4.5`, i.e. 150 ms of
  extrapolation; past the cap the target freezes and the sprite eases to rest
  rather than running through walls). Velocity is **inferred, never transmitted** —
  2 extra bytes/entity would push a typical snapshot from 2 BLE packets to 3.

Prefer Context7 MCP for current library docs (Capacitor, pixi.js, playwright, MCP
SDK) rather than relying on memory — these APIs move.
