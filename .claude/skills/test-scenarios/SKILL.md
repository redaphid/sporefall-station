---
name: test-scenarios
description: >-
  Add a playable scenario to the start menu's "Test scenarios" list (src/playable):
  an authored set-piece world, a test fixture made playable, a `?scenario=` preset,
  or a real run start (seed + floor + loadout), each with a subtitle, an action
  screenshot captured at the meaningful tick, a "what it tests / what to look for"
  description and a determinism test. Use when shipping a mechanic the owner should
  be able to play without going through floor 1, when asked to "make a test
  scenario", "make this playable", or when a new mechanic test sets up a world.
---

# Test scenarios

The owner tests new work on his phone. The start menu's **Test scenarios** button
opens a list of cards; **Play** boots `./?play=<id>` straight into that world
(solo, his own autosave untouched; Main menu from inside lands back on the list).
Every card is also a test: the registry test boots it, replays its demo twice and
asserts the beat the card promises.

**Rule: every new mechanic test that sets up a world registers it as playable.**
If you wrote a world for a test, the owner should be able to play that same world.

## The shape (one file per scenario, no merge fights)

`src/playable/entries/<id>.ts`, `export default { ... } satisfies Playable`
(types in `src/playable/types.ts`):

| field | what |
|---|---|
| `id` | kebab-case, equal to the file name |
| `title` / `subtitle` | the card; subtitle one short line (60 chars max) |
| `tests` | what mechanic or system it exercises, in player words |
| `lookFor` | what to watch for while playing it; say so if a known issue shows (`#182`) |
| `section` | `new` (New today), `systems`, `builds` (weapon builds), `areas` (areas & floors) |
| `tags` | chips: system, enemies, weapon (display names: "Rivet Driver", not `rivetDriver`) |
| `start` | where the world comes from, below |
| `shot` | `{ tick, zoom? }`: the sim tick of the action for the card picture |
| `demo` | optional scripted player (`BotPlan`, `src/scenes/bot.ts`): route, range, `fireFrom`, `throwAt`, `dwell`. The capture and the test drive the same bot |

`start` kinds:

- **`fixture`**: a committed `WorldJson` in `src/game/__fixtures__/`. Use for authored
  set-pieces (a generator in `scripts/playable/<id>.mts`, see below), crafted saves, and
  the fixture a mechanic test already asserts on.
- **`preset`**: `{ preset, seed, floor? }`, a `?scenario=` stage from `src/game/scenarios.ts`.
- **`run`**: `{ seed, floor, loadout?, hp? }`, a real run start. Floor N is reached through
  the normal progression (`nextFloor`), and the exit goes on to N+1, so it plays on as a run.
  Prefer this for weapon builds and areas/floors: variety, no upkeep.

Set-piece vs run start: a set-piece shows one mechanic in a controlled room (pin its
beat in the test); a run start is a real floor with a build (pin that it boots on the
right floor with the right kit, and that it replays).

## Add one, end to end

1. **Storyboard first** (CLAUDE.md rule): a short strip on the draw board `sporefall-hub`
   (frame `ts-...` in a free area) of what the player does and sees. Pick the moment
   for the card picture here.
2. **The world.** For a set-piece copy a generator in `scripts/playable/` (helpers in
   `lib.mts`: `stage(rows)`, `room(w,h,sx,sy,floor)`, `npc`, `asleep`, `arm`, `save`),
   then `pnpm exec tsx scripts/playable/<id>.mts`. It writes the fixture. Every
   generator must be played by an entry (the registry test checks). For a run start or
   preset there is no world file.
3. **The entry** in `src/playable/entries/<id>.ts`. Check the mechanic exists on `main`
   first, and use the current weapon ids (`src/game/data/items.ts`).
4. **Tune with the probe**: `node scripts/playable/probe.mjs <id> [ticks]` runs the demo
   headless and prints deaths, hits, buds, aggro flips and player hp per tick. Pick
   `shot.tick` a few ticks after the beat (not the spawn frame).
5. **The test.** `src/playable/playable.test.ts` already boots, round-trips and replays
   every entry. Add one `it` under "plays the beat its card promises" asserting the beat
   AND that `shot.tick` falls on it (see the existing ones). Adversarial: assert the
   thing that would be wrong if the mechanic broke, not just "no crash".
6. **Capture**: `pnpm run build && node scripts/playable/capture.mjs <id>` (or `--all`;
   `--tick N --zoom Z` to try values). Headless Chromium boots `?play=<id>&demo&e2e=1`,
   gates the sim at exactly `shot.tick`, zooms, writes `public/playable/<id>.webp`
   (800x450, about 30-50 KB) and a 3x nearest crop to `e2e/output/playable/<id>-zoom.png`.
7. **Zoom-check by eye** (CLAUDE.md rule): open the webp and the crop. Is the action in
   frame and not under the HUD? Is the subject big enough to read on a phone card? If
   not, move the player/cast or the zoom and capture again.
8. **Gates**: `pnpm run build`, `pnpm run lint`, `pnpm exec vitest run src/playable src/ui/testScenarios.test.ts`.
9. **Preview** (done = deployed): push `preview/<name>`, wait for `preview-web`, open
   `https://sporefall.hypnodroid.com/betas/<name>/`, tap Test scenarios, Play the new
   card, confirm it boots (headless Playwright from the repo, never the owner's browser).

## Making existing tests playable

A test that builds its world from a fixture (`loadFixture('<name>')`) can be made
playable with an entry whose `start` is `{ kind: 'fixture', fixture: '<name>' }`. Write
the description as player-facing text from the test's intent, not its assertion text.
If the fixture is too small or ends in a second, give it a playable room (a generator)
or skip it. Bulk screenshots: `node scripts/playable/capture.mjs --all`.

## Files

- `src/playable/types.ts`, `registry.ts` (glob over `entries/`), `start.ts` (start -> World)
- `src/ui/testScenarios.ts` (the list page), `src/ui/menu.ts` (the button)
- `src/main.ts`: `?play=<id>` boots it; `&demo` hands player 0 to the entry's bot
- `scripts/playable/`: generators, `probe.mjs`, `capture.mjs`
