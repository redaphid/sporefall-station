# Exact-world-state TDD + auto video (#50)

Every feature gets a test that **sets world state EXACTLY, runs the REAL systems,
and produces an output video**. This is the reusable recipe that bridges three
existing pieces:

1. **`?world=<fixture>` boot injection** (`src/main.ts`) — replaces the freshly
   built world with a deserialized snapshot *before the loop starts*.
2. **`?script=<name>` input timeline** (`src/input/scripted.ts`) — a fixed
   per-tick input plan; makes the run bit-for-bit deterministic.
3. **`record()` harness** (`e2e/lib.mjs`) — drives the real pixi build headless,
   snaps stills at fixed SIM ticks, asserts final world state, muxes webm→mp4 and
   verifies the mp4 is real.

The whole run is reproducible: the fixture pins the seed + entities, the script
pins the input. No wall-clock, no RNG drift.

## How `?world=` works

`?world=<fixtureName>` loads `src/game/__fixtures__/<fixtureName>.json` (bundled
by Vite via `import.meta.glob` in `src/game/fixtures.ts`), runs
`deserializeWorld`, swaps it into the `HostSession`, and calls
`renderer.setLevel` on the restored level. The level itself is *regenerated from
the snapshot's seed+floor* and checksum-verified, so a fixture stays tiny (no
tiles) and a seed/floor drift fails loudly instead of drawing the wrong map.

It composes with everything: `?script=` then plays from tick 0 of the injected
world, `?e2e` still exposes `window.__sporefall` / `window.__world` / `window.__debug`.
Absent `?world=`, boot is unchanged.

**Inline snapshots** (no committed file): pass `?world=@inline&e2e=1`; boot
exposes `window.__loadWorld(json)` and *waits* for it before ticking. The recipe
calls it via `page.evaluate` right after navigation.

## Add a video test for a new feature

### 1. Author an exact-state fixture

Generate it deterministically (fixed seed + fixed setup), like
`scripts/test/gen-feature-fixtures.mts`. Build a world exactly how you want it at
tick 0, then `serializeWorld` it into `src/game/__fixtures__/<name>.json`:

```ts
const w = createWorld(SEED, 1)
populateWorld(w); setupFloor(w)
spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
applyScenario(w, 'fire')      // or hand-place exactly the entities you need
// ...tweak to taste (e.g. lower a victim's hp so the beat lands on-screen)...
writeFileSync(`${dir}<name>.json`, JSON.stringify(serializeWorld(w), null, 2) + '\n')
```

Regenerate all fixtures with `pnpm run gen:fixtures`. A `fixtures.test.ts` unit
test asserts each committed feature fixture deserializes + round-trips, so a
stale golden fails `vitest` (no browser needed).

### 2. Declare the video test

Create `e2e/feature-<name>.mjs` using the recipe (`e2e/record-feature.mjs`):

```js
import { recordFeature } from './record-feature.mjs'

await recordFeature({
  name: 'feature-frost',
  world: 'frost-stage',          // committed fixture NAME (or an inline WorldJson object)
  script: 'shooting',            // a SCRIPTS[...] timeline (omit for a static beat)
  stills: [                      // screenshots at fixed SIM ticks
    { tick: 20,  label: '01-injected' },
    { tick: 200, label: '02-impact' },
  ],
  readState: () => {             // runs IN-PAGE; read from window.__world
    const w = window.__world
    return { gameOver: w.gameOver, ids: w.entities.map((e) => e.id) }
  },
  expect: (s) => [               // ADVERSARIAL post-run assertions; truthy = failure
    s.gameOver && 'unexpected game over',
  ],
})
```

Assertions run in Node, so cross-check against fixture-derived truth (read the
`.json` with `fs` and pin specific entity ids / positions) to keep them exact and
non-trivial — see `e2e/feature-combat.mjs` and `e2e/feature-fire.mjs`.

If the feature needs input, add a timeline to `SCRIPTS` in
`src/input/scripted.ts` (an empty `[{ ticks: N }]` wait is fine for
systems-only beats like fire).

### 3. Run it

```
pnpm run e2e:features            # all e2e/feature-*.mjs
pnpm run e2e:feature:fire        # just the fire one
```

The script (`e2e/run-features.sh`) builds, serves the bundle on its own port,
runs the tests, and writes `e2e/output/feature-<name>.mp4` (+ labeled stills).
**Requires the preview server + ffmpeg** — it is NOT part of the vitest unit path
(`pnpm exec vitest run` stays green without a browser). Wire it into CI as a separate
job that has Chromium + ffmpeg available.

## The two backfilled features

| Test | Fixture | Drives | Adversarial final-state assertions |
|------|---------|--------|-------------------------------------|
| `feature-combat` | `combat-stage` (3 mutants, hp 24, on the pistol lane) | `shooting` script | every pinned mutant id is gone (killed + swept); player alive, not downed; no game over |
| `feature-fire` | `fire-stage` (lit crate row → flammable bystander, hp 12) | `burn` (no input) | the pinned bystander id is gone (burned to death ~tick 100); NO flammable civilian survives; player at full hp and hasn't moved; no game over |

## `?state=<id>` — shareable debug links

`?world=` needs the fixture to be in the bundle, so it cannot be sent to anyone.
`?state=<id>` is the shareable sibling: the same exact-world injection, but the
snapshot is fetched from the Worker instead of read out of `dist/`.

**Capture** (needs `?debug`, which arms the rewind ring):

```js
await sporefallShare('respawned inside a wall')
// -> { id, url, bytes, rawBytes, rewindTicks }
```

**Open** the printed URL. A shared link boots straight into SOLO (no menu), and
it does not open on a frozen frame: it restores the world from ~1 s *before* the
capture and replays the recorded inputs forward at normal speed, so the viewer
watches the bug happen and then takes control at the captured moment. An
on-screen banner says a replay is running and when control is handed over.

### It verifies itself

Replaying from T−1 s with the recorded inputs must land *exactly* on the state
captured at T. That comparison runs on every capture (`shareState` refuses to
upload a payload that fails) and again on every load. On success the banner goes
green; on failure it goes red and names the first tick and field that drifted —
`window.__stateReplay` carries the same verdict for automation. A debug tool that
quietly shows something plausible and wrong is worse than none.

Divergence is almost always a piece of state the snapshot forgot. The classic is
the **PRNG cursor** (`WorldJson.rng`/`baseRng`): drop it and the level looks
identical and then every AI roll, spawn and loot drop differs.

### Storage

`POST /state` (gzipped payload) → KV, 30-day TTL, returns a 16-char unguessable
id; `GET /state/<id>` → JSON. Both in `src/worker/worldStore.ts`, and `/state/*`
is in `run_worker_first` so a missing id is a real 404 and never the SPA's
200 + `index.html`.

Scope: shared states restore into **single-player**. Rehydrating a *multiplayer*
session onto one machine (peers, slot ownership, per-client prediction) is a
different problem and is deliberately not attempted.

```
pnpm run e2e:state    # full browser round-trip against `wrangler dev`
```

## Authored worlds and crafted saves

The engine starts from state, not from a seed. `worldFromState({ level, ... })`
(`src/game/world.ts`) takes the level as data. `worldFromSeed(seed, floor)` is
the generator that builds that state from seed+floor, and `createWorld(seed,
floor)` chains the two for the app and most tests. The next floor of any run,
authored or not, is still generated from `World.seed`.

A level is written as text, one glyph per tile (`src/game/levelgen/levelText.ts`):

```ts
const w = worldFromState({
  level: levelFromJson({
    rows: [
      '##########',
      '#..@..#..#',
      '#.....#..#',
      '#........#',
      '####E#####',
    ],
  }),
})
```

Legend: `#` wall, `.` floor, `+` tiled floor, `=` hall, `%` plating, `x` grate,
`~` bog, `,` grass, `-` sidewalk, `:` street, `H` hull, `E` exit, `^`/`v` stairs,
`1`-`4` bevelled wall corners (NW, NE, SE, SW), `@` the player spawn (a floor tile).
`spawn`, `exit`, `buildings`, `theme` and the complex/storey fields are optional
JSON fields beside `rows`. Without an `E` the level has no exit.

**One save format.** `serializeWorld` writes the level into `WorldJson.level`
whenever it is not what seed+floor generates (an authored level, or a generated
one a scenario carved). An untouched generated level still travels as
`levelChecksum` only, so seeded snapshots, fixtures and `?state=` links are
byte-identical to before. Tests, crafted saves and share links all use this one
format. A hand-edited `level.rows` needs no checksum fix-up.

**Crafting a save to play on a phone.** Copy `scripts/saves/castle-siege.mts`,
draw the rows, place the player (weapon, mods) and the enemies, and run it with
`pnpm exec tsx`. It writes `src/game/__fixtures__/<name>.json`. Fixtures ship in
the bundle, so after deploy the save plays at
`https://sporefall.hypnodroid.com/?world=<name>`. That URL boots straight into
solo and does not touch the player's own autosave. The JSON is the save, so you
can also edit it by hand. Pin it with a test like `src/game/saves.test.ts`.

To share a crafted save as a `?state=` link: open `/?world=<name>`, play a
second or two, then press Share state in the pause menu (or run
`await sporefallShare('<label>')`). Links live 30 days in KV and are capped at
512 KiB gzipped; the castle with its run-up measured 3.5 KiB. Do not stage with
the `step` debug verb before sharing: the rewind ring does not record ticks that
`step` advances, so the capture fails its own replay check.

Authored worlds are single-player. Net clients still regenerate the level from
seed+floor, so a host must not load an authored world into a co-op session.
