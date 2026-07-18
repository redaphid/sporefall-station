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
world, `?e2e` still exposes `window.__sor` / `window.__world` / `window.__debug`.
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
| `feature-combat` | `combat-stage` (3 thugs, hp 24, on the pistol lane) | `shooting` script | every pinned thug id is gone (killed + swept); player alive, not downed; no game over |
| `feature-fire` | `fire-stage` (lit crate row → flammable bystander, hp 12) | `burn` (no input) | the pinned bystander id is gone (burned to death ~tick 100); NO flammable civilian survives; player at full hp and hasn't moved; no game over |
