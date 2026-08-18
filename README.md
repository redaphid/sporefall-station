# Sporefall Station

A top-down co-op roguelite for car rides with **zero cell service**: up to 4 players
over **Bluetooth LE**, one phone hosting the authoritative sim, everything bundled
offline in a Capacitor Android app.

> **Just want to play?** See **[docs/play.md](docs/play.md)** — play in a browser
> (always current) or install the Android app (install once, auto-updates).
> Shipping/CI setup lives in **[docs/deploy.md](docs/deploy.md)**.

Procedurally generated city floors ·
missions (steal the briefcase, take out the boss) · cops, crime and alarm ·
lockpicking, chloroform, grenades, downed-teammate revives.

## Play in a browser (dev)

```bash
pnpm install
pnpm run dev            # http://localhost:5173
```

- **Move** WASD/arrows · **Attack** J/Space · **Interact** K/E · **Ability** L/Shift
- URL params skip menus: `?mode=solo&seed=7`
- **Local co-op test**: open two tabs — `?mode=host&room=x` and
  `?mode=join&room=x` (BroadcastChannel transport with fake latency).

## Android build

### Just want the APK? Download it (no build needed)

Every push to `main` and every PR builds `app-debug.apk` in CI (the **android-apk**
workflow). Grab it without a toolchain:

- **From a workflow run:** GitHub → **Actions** → **android-apk** → newest green run →
  **Artifacts** → `sporefall-debug-apk`. Unzip → `app-debug.apk`.
- **From a Release:** publishing a GitHub Release attaches the APK as `sporefall.apk`.
  (Releases only get an APK once one is *published* — draft/absent releases show none.)

Then sideload: enable "install unknown apps", copy the `.apk` to the phone, tap it —
or `adb install -r app-debug.apk`.

### Build it yourself

Requires a **JDK 21+** (Capacitor 8 / AGP 8.13 compile at Java 21 — an older JDK fails
with `invalid source release: 21`) and the **Android SDK**.

```bash
pnpm install
pnpm run build:apk      # builds web -> cap sync -> gradle assembleDebug
pnpm run install:apk    # adb install -r ... to an attached phone
```

`build:apk` auto-locates a JDK 21+ and the Android SDK, so it works even when your
default `java` is older. Override either by exporting `JAVA_HOME` / `ANDROID_HOME`
first. The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

### 2-phone BLE test (the point of all this)

1. Install the APK on both phones, turn on airplane mode, **leave Bluetooth on**.
2. Phone A: **Host co-op** → wait in lobby.
3. Phone B: **Join co-op** → grant Bluetooth permissions → tap the host in
   the scan list → wait in lobby.
4. Phone A: **Start game**. Complete a mission, hit the exit, next floor.

Host = BLE peripheral (advertises the game service), clients = centrals.
Client inputs ride write-without-response; state comes back as directed notifications.

## Architecture (see `docs/` and the plan in git history)

- `src/game/` — pure deterministic-friendly sim: fixed 30Hz tick, seeded PRNG
  (levels regenerate bit-exact from `seed+floor` on every device — layout never
  crosses the wire), lite-ECS entities, systems as functions. No DOM/pixi/net imports
  (enforced by eslint).
- `src/net/` — transport abstraction (`BroadcastChannelTransport` dev,
  `BleHostTransport`/`BleClientTransport` device), length-prefixed stream framing,
  two-lane send queue (reliable FIFO + latest-wins snapshot slot, one packet in
  flight — BLE can't be flooded by construction), ~10-byte binary entity snapshots
  at 10Hz with per-peer interest filtering.
- `src/app/` — the solo/host/client seam: `HostSession` (solo = host with no peers),
  `NetHostSession`, `NetClientSession` (own-player prediction via the shared
  `moveAndCollide`, rewind-replay reconciliation, smoothing for remotes).
- `src/render/` — PixiJS v8, chunk-culled tilemap, sprite pool, DPR capped at 2.
  Ships **real sprite art**: themes under `public/themes/` (`swampspace-hires` by
  default) are fetched and baked by `themeLoader.ts`. `art.ts` is the procedural
  fallback — any sprite a theme fails to supply degrades to a drawn shape rather
  than crashing. See `docs/themes.md` and `docs/sprite-generation.md`.

## AI-native ECS

A first-class goal of this project: the engine is built to be **instrumentable by
Claude and by tests** — not just playable. The sim is a pure function of a seeded
PRNG plus a per-tick input command, so any moment of play is reproducible
bit-for-bit, which makes the world legible to an AI agent and to rigorous tests.

- **Set world state exactly, then run the systems.** `serializeWorld`/
  `deserializeWorld` (`src/game/serialize.ts`) round-trip the *entire* world —
  entities, events, mission, and the PRNG stream position — losslessly to/from
  JSON. `src/game/testkit.ts` (`loadFixture` · `runTicks` · `expectWorldEqual`)
  turns those JSON snapshots into fixtures: load an exact state, tick the real
  systems, assert on the result. Replays are byte-identical.
- **Live inspection & mutation.** Under `?debug`, the phone's webview dials out to a
  WebSocket debug hub; a CLI (`tools/debug-cli`) and an MCP server
  (`tools/mcp-debug`) expose verbs to read/get/set/spawn/kill/teleport entities,
  read events, dump/load a whole world, and step ticks — so Claude can reason about
  and alter runtime state. The `.claude/skills/ecs-debug` skill packages the attach
  procedure; see `CLAUDE.md`.
- **Claude → player communication & annotation** are on the same substrate
  (draw/label on screen, tap-to-inspect entities) so the agent can explain the world
  it's reasoning about.
- **Every feature is tested this way.** Strict, exhaustive, *adversarial* TDD that
  sets world state exactly, runs the systems, and — via the `e2e/` recorder
  (`record()` in `e2e/lib.mjs`, playwright + ffmpeg) — produces an **output video**
  of the scenario alongside the state assertions.

## Tests

```bash
pnpm test                              # 3059 unit/sim tests in 201 files (~3.5 min)
pnpm exec tsx scripts/test/mp-smoke.ts      # 2-tab co-op end-to-end (needs `pnpm run dev` running)
pnpm exec tsx scripts/test/dump-level.ts 7  # eyeball a generated city as ASCII
pnpm run e2e                           # deterministic recorded video + state-assert scenarios
npx tsx e2e/net-conditions.mts         # co-op over a modelled BLE link (see below)
```

Fixtures + exact-state replay live in `src/game/__fixtures__/` and `src/game/testkit.ts`.

> **CI does not run `pnpm test`.** The workflows run a typecheck+build, one single
> test file, and the `e2e/run.sh` proof. The full suite and `pnpm run lint` are a
> local gate only — a green tick on GitHub does not mean the tests passed.

### `e2e/net-conditions.mts` — the two-phone test, without two phones

Runs the real `NetHostSession` and `NetClientSession` against each other in one
Node process, over a link model that reproduces what BLE actually gives you:
180-byte packets, one packet in flight, added latency, jitter, per-packet loss and
range dropouts. **20 profiles** — clean, 200 ms latency, heavy jitter, 2/10/30%
loss, a congested slow link, 60-second soaks, ordered/reordering and immortal
controls, a 3-second blackout, and hard-drop rejoin with both the same and a new
peer id. Each asserts that the join completes, entity identity survives the wire,
entities inside the interest box arrive, positions converge within a
latency-scaled tolerance, globals converge, and the client never wedges.

```bash
npx tsx e2e/net-conditions.mts --self-test          # deliberately corrupt the wire; MUST fail
npx tsx e2e/net-conditions.mts --only loss-10pct    # a single profile
npx tsx e2e/net-conditions.mts                      # everything, ~11 min of link time
```

`--self-test` corrupts the archetype byte of every snapshot — leaving the
handshake intact, so the run still joins and plays and the failure has to come
from the comparator — and then **inverts the exit gate**: if the harness stays
green on a broken wire it exits non-zero and tells you every green result was
meaningless. Nothing in CI runs any of this; invoke it by hand.

## Reconnect after a drop

A mid-game link drop (BLE radios in cars do this) is survivable: the host parks
the avatar as a stunned "ghost" for 90 s and remembers a rejoin token; the client
auto-reconnects (`transport.reconnect()` on all three client transports) and
re-Hellos with `{slot, token}` to reclaim the same avatar mid-run. Proven
end-to-end by `scripts/test/reconnect-smoke.ts` (simulated drop over the dev
transport). Real-radio behavior still needs on-phone testing.

## Known gaps / next up

- BLE transports + reconnect are code-complete but not yet verified on physical
  phones (emulators have no Bluetooth).
- Remaining content ideas: shop/bribe economy, second mission per floor,
  real tileset via `art.ts` swap.
