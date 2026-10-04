# District identity: resume plan

Status (2026-10-04): planning only. No census screenshots were taken, no ComfyUI
job was queued, and no code changed. The session was wound down at the
owner's request. This file is the resume point.

## Problem

The owner played floors 1-2 and said: "I don't notice anything new about the
levels." The four city districts (#154, #164) changed data: layout, enemies,
names and a faint grade (`DISTRICT_TINT` in `src/render/complexLook.ts`). They
still draw the old city tiles and props, so they look like the old city. The
art list in `docs/design/districts.md` ("Art the districts would use") was
never generated.

Goal: a player on a phone can tell the district at a glance.

## Base: stack on #157

PR #157 (`art/indoor-tiles`, unmerged at the time of writing) already built what this work needs:

- `scripts/assets/indoor_kit.py`: the sweep, gate, sheet, pick and ship
  verbs on Ragnarok. `ship` embeds each raw's ComfyUI `prompt` and `workflow`
  chunks in the shipped PNG, and `src/render/themeIndoorFlows.test.ts` checks
  them.
- `scripts/assets/floor_metrics.py`: the floor busyness gate (spread16, edge16)
  and the cast-separation gate (below, lit).
- `src/render/indoorSkin.ts`: a skin layer. A tile name such as `floor` or
  `wall` draws as another key (`deck`, `bulkhead`) on some levels, and an
  entity art key draws as other prop art (`indoor:<artKey>`). Each skin falls
  back to the plain art when the pack has none.

A district skin is the same idea, keyed on `level.theme` instead of
`level.complex`. Generalise `indoorSkin.ts` into one skin table rather than
adding a second mechanism. Start the branch after #157 merges. If it has not
merged, use `origin/art/indoor-tiles` plus a merge of `origin/main`. On
2026-10-04 that merge conflicted only in `src/render/theme.ts` and
`docs/themes.md`.

## Floor-1 seeds per district

These come from `openingDistricts(seed)[0]` in `src/game/levelgen/floors.ts`
on main at `280b40cf`:

| District | `ThemeName` | Floor-1 seeds |
|---|---|---|
| Still Row | `stillworks` | 1, 3, 4, 8 |
| Culture Beds | `culturebeds` | 2, 5, 7, 13 |
| Moorings | `moorings` | 6, 19, 20, 24 |
| Concourse | `concourse` | 12, 15, 23, 28 |

## Step 1: census and "before" shots

- Use `node scripts/own-chrome.mjs launch` to start Chrome, and kill it with
  `node scripts/own-chrome.mjs kill <lockfile>`. Never use 9222, and never
  kill Chrome by name.
- Serve this checkout with the verify-sporefall `serve.sh` on a private port.
  Open `/?mode=solo&seed=<S>&debug` for each district above.
- For each district, take one gameplay-zoom shot near a square and one near a
  lot edge.
- Count the tiles on floor 1 for each district by type (Floor, Wall, Bog,
  Grass, boardwalk ring, yard), and count its props by archetype. The skin
  should spend its effort on the tiles that cover the most screen.

## Step 2: art targets for each district

Each district gets a ground skin, a wall skin, 2-4 signature props and a
stronger grade. Every ground tile stays quiet, and the detail goes on walls
and props.

| District | Ground (replaces) | Wall | Signature props | Palette (distinct from the others and from the indoor deck's warm grey) |
|---|---|---|---|---|
| Concourse | `drowned-basin` (Bog in squares and courts), plus a yellowed paved slab for yards | `waterline-wall`: hand-painted high-water stripes over faded company lettering | `payout-counter` (a scrip counter with a grille and a tally slot, **never an ATM**), `weigh-scale` | Yellowed ivory and ochre stone, dull brass |
| Moorings | `jetty-plank` (replaces the boardwalk ring) | `stilt-shack`: lashed plate and airlock fabric | `mooring-cleat`, `net-rack` | Dark wet wood brown with a cold teal water cast |
| Still Row | `settling-pond` (Bog in yards, with a brass drain ring and an oily sheen) | Riveted copper and brass still-house plate | `essence-still`, `cage-rack`, `cargo-sled` | Ember brown and oxidised copper |
| Culture Beds | `furrow` (replaces Grass in beds) | Low lab plaster with moss stains | `culture-bed`, `grow-lamp` (the frame's one hot light), `irrigation-trough` | Olive moss and black substrate |

Each prop also needs an archetype in `src/game/data/objects.ts`, an entry in
`PROP_NAMES`, and placement in the district squares. Retarget the existing
square props through the skin where possible: benches and tally tables become
counters, and bio-planters become culture beds. That costs no sim change.

## Step 3: generation

- **Checkpoint.** Use only `SDXL1.0\juggernautXL_ragnarokBy.safetensors`, for
  every job, props included. Put all jobs in one queue so the checkpoint never
  swaps.
- **Shared GPU.** Check `curl localhost:8188/queue` first and queue behind any
  #157 work. Keep each batch to 4 images or fewer. On 2026-10-04 one #157 deck
  render took about 40 s, so 16 assets at 8 seeds each is roughly 85 minutes.
- **VLM gate.** It uses Ollama at `127.0.0.1:18436` with `qwen3-vl:8b`. The
  `11434` instance does not have that model. Run the VLM between generation
  phases, never at the same time as generation.
- **Seed budget.** Use 8 seeds per prop and 6-8 per tile, at fixed seed bases.
  Rate each sweep by its yield, not by its best pick.

## Step 4: gates (ship only gated picks)

- **Ground tiles.** `floor_metrics.py` must give spread16 ≤ 7.0 and edge16 ≤ 6.5
  on a 4x4 field. The cast must sit at body-below ≥ 10 and lit ≥ 40. The chroma
  gate (≤ 8) is for the indoor deck only. District ground keeps its hue, so
  report chroma and hue for each district and check that the four hues and the
  deck's differ.
- **Props and walls.** Run the indoor_kit harness (the silhouette envelope
  against the prop it replaces, and the cast palette floor). Then run the VLM
  check: the image must not read as a figure, a grave or a boulder, and the
  subject it names must be on the job's accept list. The `payout-counter` deny
  list must include `atm`, `cash machine` and `bank`.
- **Flows.** Every shipped PNG carries its flow. The test that holds the indoor
  kit to this must also cover the district kit.

## Step 5: wiring, evidence, tests, PR

- Wire the art through the skin table keyed by `ThemeName`. Raise the
  `DISTRICT_TINT` contrast between the districts so the grade can be seen.
- Evidence:
  - A 4-district contact sheet at gameplay zoom, old against new.
  - In-game shots of each district.
  - All of it published with `pnpm run review:image`.
  - Fail the PR if old and new look alike.
- Tests:
  - Skin tests build authored levels with `worldFromState` or level text, not
    seed and floor pins.
  - No modern-crime, police or city vocabulary.
  - Gate on `pnpm run build`, `pnpm exec vitest run --maxWorkers=2`, and
    `pnpm run lint` including the lore `--check`.
- Delivery:
  - Add a release note under `src/ui/releaseNotes/`, dated the merge day.
  - Open the PR from `art/district-identity`, and don't merge it.
