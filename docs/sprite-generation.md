# Sprite generation — setup & pipeline guide

How to generate theme sprite packs for Sporefall Station with a local ComfyUI, from a
cold machine to a merged `public/themes/<id>/` package. The reference
implementation is the **swampspace** pack ("Sporefall Station") built by
`scripts/assets/`; its per-asset lineage is `public/themes/swampspace/CURATION.md`.
Theme manifest format: `docs/themes.md`. Swampspace-specific art direction:
`docs/swampspace-theme.md`.

## 1. Infrastructure setup

### ComfyUI

The pipeline drives ComfyUI **entirely over HTTP** (`POST /prompt`, `GET
/history/<id>`, `GET /view`, `POST /upload/image`) — no saved workflow JSONs,
no UI. It expects the server at **`http://localhost:8188`** (override with
`COMFY=http://host:port`). In this repo's environment that is an SSH tunnel to
a shared GPU box; anything serving the ComfyUI API works.

Required models (exact filenames, in ComfyUI's `models/` tree):

| Kind | File | Used for |
|---|---|---|
| checkpoint | `AnythingXL_xl.safetensors` (SDXL) | hero/env/character-anchor generation with the pixel-art LoRA |
| checkpoint | `dreamshaper_8.safetensors` (SD1.5) | low-VRAM fallback path; step-frame img2img; NPC sweeps |
| lora | `pixel_art_style_by_skormino_v7.05_test_72img.safetensors` | pixel-art style. **This LoRA is Illustrious/SDXL** — with an SD1.5 checkpoint it silently no-ops (an earlier pack made exactly this mistake). Triggers: `masterpiece, pixpix, 8-bit, pixel_art`; CFG 3–4, euler, 28+ steps |
| ipadapter | `ip-adapter-plus_sdxl_vit-h.safetensors`, `ip-adapter-plus_sd15.bin` | style anchoring (loaded automatically by IPAdapterUnifiedLoader preset "PLUS (high strength)") |
| clip_vision | `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | IPAdapter image encoder |

Required custom nodes (install via ComfyUI-Manager or git):

| Node pack | Nodes used |
|---|---|
| ComfyUI_IPAdapter_plus | `IPAdapterUnifiedLoader`, `IPAdapterAdvanced` |
| WAS Node Suite | `Image Rembg (Remove Background)` |
| comfy_mtb | `Image Tile Offset (mtb)` (seamless-tile offset pass) |

Core nodes used (ship with ComfyUI): `CheckpointLoaderSimple`, `LoraLoader`,
`CLIPTextEncode`, `EmptyLatentImage`, `RepeatLatentBatch`, `VAEEncode/Decode`,
`KSampler`, `ImageScale`, `ImageBatch`, `SaveImage`.

Verify an install before a run:

```bash
curl -s localhost:8188/system_stats | jq .devices   # server up, VRAM visible
curl -s localhost:8188/models/checkpoints | jq .    # checkpoints present
curl -s localhost:8188/models/loras | jq .          # LoRA present
curl -s localhost:8188/object_info | jq 'keys' \
  | grep -E "IPAdapterAdvanced|Rembg|Tile Offset"   # custom nodes present
```

Known trap: `Model Patch Seamless (mtb)` crashes (deepcopy TypeError) on
ComfyUI 0.28 — the pipeline uses the offset+heal technique instead (§4).

### Ollama (VLM verification gate)

`scripts/assets/verify.py` needs Ollama at **`localhost:11434`** (override
`OLLAMA=`) with the **`qwen3-vl:8b`** model pulled (`ollama pull qwen3-vl:8b`).

### Python

Python 3.10+, `pip install pillow numpy`. No other deps.

### Shared-GPU realities (hard-won)

- SDXL needs ~10 GB VRAM headroom. If other tenants (e.g. resident Ollama
  models) squeeze it, ComfyUI silently drops to "lowvram" offload and a 40 s
  batch becomes 30 min. Watch `docker logs`/`system_stats`; prefer the SD1.5
  path (`CKPT=dreamshaper_8.safetensors LORA= SIZE=512`) under pressure — the
  k-centroid + palette-lock post-pass (§4) equalizes most of the style gap.
- Keep batches ≤4 (`EmptyLatentImage.batch_size`); bigger batches on the
  two-pass tile graph have OOM'd/hung the server.
- ComfyUI's outputs also land in its own output dir (synced here to
  `~/sync/comfy-output/`) — if the driver times out polling, the images still
  arrive there; you can harvest them without regenerating.
- Run the VLM gate **between** generation phases, not concurrently — qwen3-vl
  and SDXL contending for one GPU starves both.

## 2. Driver scripts (`scripts/assets/`)

| Script | Role |
|---|---|
| `comfy.py` | HTTP driver + graph builder. Env knobs: `COMFY`, `CKPT`, `LORA`, `LORA_W`, `SIZE`. Sampler recipe lives here (CFG 3.5, euler, 28 steps). |
| `generate.py` | **The job table** — every asset's subject prompt, negatives, category, target px — plus the `sweep` / `final` CLI. |
| `post.py` | Post-processing: content bbox crop → k-centroid downscale → palette quantize (no dither) → hard alpha → canvas placement; `tile()`, `sprite()`, `luma_sprite()`, `derive_step()`, `seam_energy()`, `contact_sheet()`. |
| `palette.py` | The locked theme palette (34 colors for swampspace). Run it to emit a swatch sheet. |
| `verify.py` | VLM gate (§5): per-asset checks, `--pairs`, `--same`, `--style`. |
| `consistency.py` | Silhouette-metric consistency harness + per-character spec gate (§5b). |
| `consistency-spec.json` | Committed per-character proportion envelopes (ref frame + tolerances). |
| `procedural.py` | Deterministic PIL sprites for sparse particles/FX. |
| `tilesets_floor.py` | Macro-tile floor/street redesign: 64px (2×2-tile) procedural macros (`proc`) → SD img2img refine (`sd`; floors get `restamp_floor` to re-assert seams/rivets/roots after the paint pass) → slice into the shipped variant pools + moss overlay decals (`final`). Pairs with the manifest `macroTiles` section and `tile.<name>.overlay` keys (docs/themes.md). |
| `manifest.py` | Emits `manifest.json` against the schema in `docs/themes.md`, with within-theme direction borrowing, and registers the theme in `public/themes/index.json`. |
| `sheets.py` | Contact sheets + 4×4 tiling proofs into `docs/assets/swampspace/`. |
| `curation.json` | Lineage: per job `{seed, batch, index, raw, size, ckpt}` of the curated pick. |
| `anchors/` | Curated raws (512 px) used as IPAdapter reference images. |

Common commands:

```bash
cd scripts/assets
export SWAMPSPACE_STAGE=/tmp/swampspace-stage    # raw sweeps live here, never committed

python3 generate.py --list                       # every job name
python3 generate.py sweep prop.spore-barrel --seeds=8    # one asset sweep
python3 generate.py sweep char.bog-mutant.s-idle --seeds=8   # one character pose
# low-VRAM / fallback path:
CKPT=dreamshaper_8.safetensors LORA= SIZE=512 python3 generate.py sweep item.root-club --seeds=4

# after curating (recording the pick in curation.json):
python3 generate.py final prop.spore-barrel      # post-process into public/themes/<id>/
python3 procedural.py && python3 manifest.py && python3 sheets.py
pnpm exec vitest run src/render/theme.test.ts    # schema + file integrity
```

Sweep outputs land in `$SWAMPSPACE_STAGE/<job>/`; curated, post-processed
sprites land in `public/themes/swampspace/`. Both the shipped sprite **and the
curated raw** are committed (raws in `scripts/assets/raws/`, see §2b).

## 2b. Durable curation — never lose an approved pick (hard-won 2026-07)

**The gotcha that cost a pack.** The original pipeline recorded each curated
pick's raw *only by its `$STAGE` (/tmp) path*. Those paths die with the session.
`final` then fell back to a same-seed **regen** — but the ComfyUI graph and
prompts drift over time, so regenerating a lost pick produces *different* art (a
same-seed `spore-pistol` regen came back a contaminated blob). Net effect: 34 of
40 curated picks (every item/prop/tile, all step and non-`s` direction frames)
became **unreproducible** — the shipped 48/32px sprites survived, but there was
no faithful path to re-derive or re-scale them. Only the 6 character `s-idle`
anchors (deliberately committed to `anchors/`) survived.

**The fix — a curated raw is an artifact, so commit it.**

- `scripts/assets/raws/<job>.png` is the durable, **committed** home for every
  curated sweep raw. `curation.json` stores each `raw` as a path **relative to
  `scripts/assets/`** (`"raws/item.spore-pistol.png"`) so it survives machine,
  user and `/tmp` churn — never record a `$STAGE`/`/tmp` absolute path again.
- `generate.resolve_raw(job, pick)` resolves **durable-first**: the recorded
  relative raw → `raws/<job>.png` → (for characters) the `anchors/<kind>-<dir>-<frame>.png`
  exemplar. `final` and the step/direction `init_from_idle` chains all go through it.
- **Approve a pick with the `curate` verb** — this is the *only* correct way to
  bless a sweep candidate:

  ```bash
  python3 generate.py sweep item.spore-pistol --seeds=8   # -> $STAGE
  # review the contact sheet, then approve the winner:
  python3 generate.py curate item.spore-pistol \
      $STAGE/item.spore-pistol/item-spore-pistol-s414575_00001_.png \
      --seed 414575 --index 0 --size 512 --ckpt dreamshaper_8 --note "icon"
  python3 generate.py final item.spore-pistol                # posts the durable raw
  ```

  `curate` copies the file into `raws/` and records the relative path — so
  `final` reproduces the exact approved pixels forever, at any target size.
- `final` **no longer silently drift-regens.** A lost pick prints how to
  re-curate and skips; `--allow-regen` is the explicit (drift-prone) escape hatch.
- `post.sprite` background-keys **alpha-less** raws (the 512px black-bg character
  anchors) before cropping — without this, `bbox_crop` keeps the whole black
  frame and ships a black-boxed figure. Alpha-cut raws (Rembg'd items) pass
  straight through unchanged (`post.has_alpha` routes it).

**Migration / audit.** `python3 migrate_curation.py` (dry run; `--write` to
apply) backfills every currently-recoverable raw into `raws/` and rewrites its
path to relative, then prints the PERSISTED / ALREADY-DURABLE / **LOST** split.
The LOST list is the exact re-curation backlog: each entry needs a fresh
`sweep` → `curate`. Re-run it after any curation change as a standing audit.

## 3. The generation contract

- **Characters: 48×48 px canvas**, feet on bottom-center (the engine anchors
  there). **5 drawn directions** `s se e ne n` × **2 frames** `idle step`;
  west (`sw w nw`) is mirrored by the engine — never draw it.
  **Drawn side art MUST face RIGHT** (`e` = profile facing right, `se`/`ne` =
  turned to the character's right): the engine (`src/render/anim.ts`) flips
  the drawn frames for the west half, so a left-facing `e` frame makes every
  horizontal move read inverted in-game — the player walks left while the
  sprite looks right. This shipped once (the first vine-ranger `e`/`ne` set
  was drawn facing left) and is user-visible in every session; diffusion
  models happily ignore "facing right" in the prompt, so NEVER trust the
  prompt alone — gate facing with `consistency.py --check` (accent-pixel
  heuristic, §5b) and `verify.py` before curating, and if a good candidate
  faces left, mirror the RAW (record it in `curation.json`) so
  `generate.py final` stays reproducible. Manifest keys
  `char.<archetype>.<dir>-<frame>` (archetypes: `player cop thug civilian
  scientist gangster robot`); file naming here is `chars/<kind>-<dir>-<frame>.png`
  with thematic kind names — the manifest maps keys to files.
- **Tiles: 32×32 px**, opaque, must tile seamlessly (`tile.floor`, `tile.wall`).
- **Props/items: 32×32 px**, transparent background, centered.
- **FX**: transparent, sized to read at the engine's FX scale (48–64 px);
  `fx.*` manifest keys take **arrays** of frames.
- Full key list and fallback semantics: `docs/themes.md`. One critical rule
  learned in-game: sprite keys resolve per key against `[theme, city]` — any
  char key your manifest **omits** shows CITY's art for that pose (a human cop
  walking east between spore-drone frames). `manifest.py` therefore mentions
  every direction key, borrowing within the theme (`se→s`, `e→s`, `ne→e→s`,
  `n→s`, `step→idle`) until real art lands.

## 4. Technique playbook (do not relearn these the expensive way)

1. **Reference separation.** IPAdapter refs must be ENVIRONMENT-only for
   props/tiles and CHARACTER-only for figures. Mixing them grows faces on lamp
   posts. In `generate.py` this is the `refs="env" / "char-anchor" /
   "char-cast"` field.
2. **Items get no refs at all.** Env-anchored item sweeps turned every weapon
   into a mushroom; items use "flat 2D game inventory item icon" wording plus
   the palette lock for cohesion.
3. **Anti-figure negatives for anything inanimate**, in the FIRST CLIP window:
   "person, humanoid, figure, character, creature, face, head, arms, legs…".
4. **Cast identity beats cast cohesion.** A 0.8-weight "cast anchor" turned
   every NPC into a player clone. Keep the cast anchor at ≤0.3 and put the
   player's signature look (colors, helmet, silhouette) in each NPC's
   NEGATIVE prompt; force divergent silhouettes in the positive.
5. **Direction poses.** Anchor each character's non-`s` poses on its curated
   `s-idle` (IPAdapter "style transfer"), but LOWER the weight for away-facing
   poses (`s/se` 0.7–0.8, `e` 0.55, `ne/n` 0.5) and add facing negatives
   ("face, eyes, front view") — at 0.8 the anchor's front pose wins over the
   pose prompt.
6. **Step frames are img2img FROM the curated idle** at denoise ~0.38 with a
   prompt delta of only "mid-stride, one leg forward". txt2img steps flicker
   like costume changes when the walk cycle alternates frames. (This is wired
   in: any `*-step` job automatically inits from its `*-idle` curated raw.)
   `post.derive_step()` is a zero-GPU procedural fallback.
7. **Seamless tiles: half-offset + heal.** txt2img → `Image Tile Offset`
   (2×2) → img2img at denoise 0.35. Wrap edges become adjacent interior
   columns (seamless by construction); the heal pass erases the old seams now
   at the center cross. Check with `post.seam_energy` (deck-moss ships at 3.9)
   and eyeball the 4×4 tiling proofs from `sheets.py`.
8. **Palette lock is the great unifier.** Generate big (512–1024), k-centroid
   downscale to target px, snap every pixel to the theme's locked palette, no
   dither, hard alpha. This is what makes SD1.5 and SDXL outputs sit in one
   pack, and what makes AI renders read as crisp pixel art.
9. **Sparse particles are procedural.** Diffusion hallucinates figures into
   sparse-particle prompts (a firefly monster, a glowing man in the fog) and
   glow-on-black luma keying leaves gray boxes. Sparks, splats, bolts, flame
   flickers: seeded PIL drawings in the palette (`procedural.py`) — also gives
   frame-coherent animation for free.
10. **Seed sweeps + human curation.** 4–8 seeds per asset, contact-sheet at
    FINAL sprite size (judging at 512 px lies), pick, record lineage in
    `curation.json`, regenerate any time with `generate.py final`.
    **Props: budget 8–12, not 3.** A 5-subject × 3-seed prop sweep landed roughly
    1 usable seed in 3 — two of three `spore-barrel` seeds grew a tree out of the
    barrel, and `wall-screen` produced the exact reading its negatives forbade.
    Judging that sweep by its best seed made it look like a 4-in-5 recipe and set
    the seed budget far too low. **Rate the SWEEP, not the pick** — the pick is
    curated by definition, so quoting it back as the hit rate is circular.
11. **Cross-direction anchoring: derive, don't re-imagine.** txt2img per
    direction drifts identity — the first vine-ranger set shipped an `e` with
    a different cap, a bulky grey `ne` and slim `n` frames (width 21→31 px,
    mass ±21% within ONE character). The fix is the step-frame discipline
    extended to directions: img2img each new direction FROM an already-curated
    neighbouring direction's raw, at moderate denoise, keeping the s-idle
    IPAdapter anchor at the §4.5 per-direction weight and adding "the exact
    same character, identical outfit colors gear and proportions" to the
    prompt. Chain outward from the identity anchor:
    `s-idle → e-idle (denoise ~0.6) → ne-idle (~0.5–0.55) → n-idle (~0.5)`,
    `s-idle → se-idle (~0.5)`; every step frame then img2img's from ITS
    direction's new idle at 0.38 as before. Each hop inherits proportions and
    palette from an already-locked frame, so drift cannot compound. Gate every
    candidate with the consistency harness (§5b) BEFORE the VLM, and curate
    from the survivors.

## 5. The VLM verification gate (`verify.py`)

Ollama `qwen3-vl:8b`, majority vote (3 reads, `VOTES=` to change), temp 0.
Checks per category:

- props/items/tiles/fx: must NOT read as a person/creature (anthropomorphism);
- props additionally: must NOT read as a **grave marker, boulder or planter**.
  Anthropomorphism was the only wrong-reading anyone gated for, so the entire
  prop set shipped as mossy headstones and passed every check we had. Note the
  VLM gate **times out** and has never actually run — do not record it as passed;
  read the contact sheet at game size instead;
- floor tiles: camera must read top-down;
- characters: `n`/`ne` poses must not show a face, `s` must not face away,
  `e` must read as a profile;
- `--pairs` mode: for every curated idle/step pair, both images go to the VLM
  with a same-character/same-posture/same-gear/only-limbs-differ contract.

```bash
python3 verify.py --pack               # verify every curated file in the theme
python3 verify.py --pairs              # idle/step pose-consistency gate
python3 verify.py $STAGE/prop.foo --job prop.foo   # gate a sweep before curating
```

Exit code = number of failures (CI-gate style). To add a check: extend the
JSON contract in `PROMPT` (or `PAIR_PROMPT`) and add the corresponding
majority-vote rule in `check()` — keep answers machine-parseable JSON and
never trust a single VLM read.

Two more modes cover character identity:

```bash
python3 verify.py --pairs               # idle/step: same character, only limbs differ
python3 verify.py --same                # cross-DIRECTION identity: every curated
                                        # frame vs its character's s-idle
python3 verify.py --same a.png b.png    # ad-hoc: gate one candidate vs the anchor
```

## 5b. The consistency harness (`consistency.py`) — metrics, not vibes

The VLM judges identity; the harness judges **proportions**, deterministically.
For every shipped frame it measures the silhouette from the alpha channel —
standing height, max width, head-block height (rows from the top until row
occupancy drops below 55% of the head peak), pixel mass, centroid-x, foot row —
and gates each frame against a committed per-character envelope in
`consistency-spec.json` (reference = the curated s-idle's metrics; tolerances
default to height ±2 px, width ±3 px, head ±2 px, mass ±22%, cx ±2.5 px,
foot_y ±1 px, hand-tunable per character in the spec file).

A spec may also carry an `accent` block — the FACING gate (see §3: drawn side
art faces right). For characters whose face has a hot-accent marker (the
ranger's amber visor / orange cap, palette colors `#ffd83e #ff9032 #e04a2a`):
on `e`/`se` frames the accent centroid must sit ≥ `min_dx` px to the RIGHT of
the body centroid; on `ne`/`n` (back views) a modest centered-or-right accent
is fine — that's the cap CROWN, which SHOULD stay visible from behind so the
character keeps its signature color from every direction (the VLM reads a
capless back view as a different character) — but a face-sized accent
(> `back_max_frac` of the head zone) or a left-shifted one (dx <
`back_min_dx`) fails: the frame isn't a right-turned back view at all —
exactly how the original left-facing set would have been caught.

```bash
python3 consistency.py                  # report: per-frame metrics + max deviation
python3 consistency.py vine-ranger      # one character
python3 consistency.py --check          # gate against consistency-spec.json (CI-style)
python3 consistency.py --files spr.png  # ad-hoc metrics for sweep candidates
python3 consistency.py --write-spec vine-ranger=s-idle   # (re)derive a spec
```

**Animation families.** Frames are grouped into families — `pose` (idle / step /
attack) and `walk` (a rotoscoped 8-frame cycle). A stride legitimately swings
width and foot row far more than a pose does, so non-pose families are NOT
judged frame-by-frame; each is judged on its **median build** (height, head
block, mass) against the character's reference pose, with looser tolerances
(`FAMILY_TOL`: height ±3 px, head ±4 px, mass ±25%). This catches the failure
that matters — *a walk cycle that is a slimmer or gear-less character than the
idle, so the player changes shape the moment they move* — and reports it once
per family instead of once per frame.

**One harness, not two.** `scripts/assets/rotoscope/gate.py` layers 1-2 only
ever look WITHIN a cycle (coherence, palette, alpha, feet, no scale pumping),
so a perfectly coherent cycle *of the wrong character* passed them cleanly and
shipped — that is exactly how the r1 vine-ranger walk (head_h 6 vs the idle's
27, mass −35%) reached `main`. `gate.py` therefore has an **identity layer**
that calls `consistency.check(consistency.collect(CHAR), load_spec())`
directly. It defines no metrics of its own: `consistency.py` owns them, the
rotoscope gate runs them at the moment a cycle is gated, and
`src/render/charConsistency.test.ts` is the standing tripwire over the same
spec file. Loosening `FAMILY_TOL` to make a cycle pass defeats all three at
once — fix the motion source instead (§6, stage 1).

This is a **standing check**: `src/render/charConsistency.test.ts` re-implements
the same metrics (self-contained PNG decode, mirrored constants) and fails the
vitest suite whenever any shipped frame leaves its character's envelope, or when
a reference frame's metrics no longer match the committed spec (i.e. someone
edited a sprite without re-running `--write-spec`). If you change a metric
definition, change it in BOTH files. Gate order when curating: metrics first
(cheap, exact), VLM second (GPU, judgement) — a candidate must pass both.

## 6. Rotoscoped animation (`scripts/assets/rotoscope/`)

Flashback (1992) got its fluid animation by rotoscoping filmed actors. The
modern equivalent here renders a rigged 3D walk cycle and lets the diffusion
pipeline "trace" every frame into pack style — 3D supplies the frame-to-frame
coherence AI can't, AI supplies the look 3D can't. Three stages, one command:

```bash
cd scripts/assets/rotoscope
export SWAMPSPACE_STAGE=/tmp/swampspace-stage
CHAR=vine-ranger bash run.sh     # render -> trace -> gate -> manifest
```

### Stage 1 — motion source (`rig_walk.py` via `render.sh`)

A fully **procedural** color-blocked humanoid proxy — every mesh is a bpy
primitive created by the script, so the motion source has **no external
rig/asset and no license baggage**. The walk is the classic 4-keypose stride
(contact/down/passing/up, Williams) written out as 8 explicit poses; hip
height is solved per frame by leg FK so the stance foot always touches the
ground (bob emerges from geometry, feet never float). The proxy is
color-blocked as the character (teal suit, orange cap, visor, boots) because
at low denoise the tracer keeps color regions — that's what keeps every frame
the same character.

> **The proxy silhouette IS the identity contract — match it to the curated
> art before rendering.** `post_frame` masks the traced RGB with the *Blender*
> alpha, so the proxy's outline, not diffusion, decides the shipped
> silhouette: whatever build the proxy has is the build the player gets.
> Version 1 of the ranger proxy was a generic lithe humanoid (width/height
> 0.28, long legs, a bare neck under a small head) while the curated ranger is
> a geared figure (0.455, short-legged, helmet sitting straight on the
> collar). The cycle gated green on coherence and shipped — and the player
> visibly changed physique the instant they walked.
>
> Derive the proxy's proportions from the curated `s-idle`'s row profile
> (`python3 consistency.py <char>`, or read occupancy per row) as **fractions
> of standing height**, and reproduce them:
>
> | band | ranger | why it matters |
> |---|---|---|
> | 0.00-0.19 | helmet, ~0.59 of the shoulder peak | must clear the 55% head-block cut |
> | 0.20-0.39 | shoulders/chest, **peak** width | pauldrons + pack, sets width/height |
> | 0.41-0.55 | waist then hip/belt flare | keeps the occupancy run unbroken |
> | 0.57-1.00 | legs, ~0.45 of peak | well under the cut, so `head_h` breaks cleanly at the crotch |
>
> The two traps, both of which bit r1: a **bare neck** notches occupancy below
> the cut and collapses `head_h` (27 → 3), and **default humanoid leg length**
> (0.56 of height vs the ranger's 0.39) makes a short-torsoed, slim read.
> Gear the proxy — pauldrons, collar, chest rig, backpack, belt pouches, knee
> plates, thicker limbs — until `python3 consistency.py --check` passes on the
> `--no-trace` output. That loop needs **no GPU** and is the cheap way to
> converge: render, `trace.py --no-trace`, measure, adjust.

It renders on the `soul` box: a **Windows** Blender 5.x driven headless from
WSL over ssh. The exact invocation (`render.sh` does all of this):

```bash
ssh soul   # alias in ~/.ssh/config (cloudflared); NOT soul.local. The
           # "Could not request local forwarding" noise is benign tunnel chatter.
# inside: binary /mnt/d/tools/blender/blender.exe, and paths handed to Blender
# must be D:/-style (the exe is a Windows binary; /mnt/d = D:). Remote shell is
# zsh — unmatched globs abort, clean up with find. Workdir: /mnt/d/tmp/backseat-roto.
/mnt/d/tools/blender/blender.exe -b -P 'D:/tmp/backseat-roto/rig_walk.py' -- \
  --out 'D:/tmp/backseat-roto/frames' --res 1024
```

Output: `walk-<dir>-<n>.png`, 5 dirs × 8 frames, RGBA-transparent, one fixed
orthographic camera (slight-high game angle, elevation 14°) so framing/scale
are identical across every frame and direction. e/ne face RIGHT per the pack
facing convention (west is engine-mirrored, never drawn).

Alongside each color frame `rig_walk.py` also emits a **native depth (Z) pass**
`walk-<dir>-<n>-depth.png` (white = near, black = far), the ControlNet control
map for Stage 2. It comes from Blender's real Z buffer through a **fixed
map-range** (`DIST ± 0.9 m`, script-derived) — *fixed*, not a per-frame
Normalize, so the depth is temporally stable across all 40 frames (a 2D depth
estimator renormalizes per frame and its noise flickers frame-to-frame; the
true Z with a fixed window does not). Disable with `--depth 0`. NB Blender 5.0's
compositor is the unified node-group compositor: `scene.node_tree` is gone (use
`scene.compositing_node_group`), the `Composite` node is replaced by the group's
`NodeGroupOutput`, and range math is the generic `ShaderNodeMapRange`
(`CompositorNodeMapRange` no longer exists). Engine enum is `BLENDER_EEVEE`
(no `_NEXT` in this build).

### Stage 2 — AI tracer (`trace.py`)

Each frame goes through ComfyUI **img2img at denoise 0.48** with the
character's curated s-idle as IPAdapter anchor (per-direction weights
`s .95 / se .85 / e .70 / ne .60 / n .55`), same seed for all 40 frames.
Because the silhouette is pinned by the Blender alpha downstream, denoise here
can only change *surface*, never build — so it is safe to push, and pushing it
is what puts the ranger's plating, harness and vine detail back on (r1's 0.35
with anchor weights ~0.5-0.8 restyled the surface but left a gear-less
character). Back quarters keep the lower anchor weights on purpose: the anchor
is a FRONT view, and over-weighting it bleeds a visor onto a back view, which
the VLM face check and the accent gate both fail. Model: SDXL + pixel-art LoRA by default;
the shipped vine-ranger cycle was traced on the documented low-VRAM fallback
(`CKPT=dreamshaper_8.safetensors LORA= SIZE=512`) because resident VLM models
had squeezed the shared GPU into offload mode (5 s vs 200 s per frame) — at
48 px after k-centroid + palette lock the two paths were indistinguishable in
an A/B pilot (`e-0`/`s-0`, seed 414977). The 3D render pins pose and
composition; diffusion only re-develops the surface into pack pixel art.
Then, instead of per-frame rembg (alpha flicker) the traced RGB is masked by
the **Blender frame's own alpha**, and every frame is downscaled through
**one fixed crop window** (union bbox of all 40 Blender frames) —
k-centroid + locked palette — so scale and feet anchoring never pump between
frames. Results land as `public/themes/swampspace/chars/<char>-<dir>-walk-<n>.png`.

**ControlNet + depth path (default ON).** Masking pose *after* diffusion makes
denoise a fragile single knob — too low (0.35) leaves a gear-less character, too
high drifts identity because nothing pinned the pose *during* the redraw. The
fix is to feed Stage 1's depth pass to a **depth ControlNet** so pose/structure
is held DURING diffusion, orthogonally to the IPAdapter identity anchor
(IPAdapter patches the MODEL, ControlNet patches the CONDITIONING — one
KSampler). With pose pinned by ControlNet *and* the silhouette pinned by the
Blender alpha downstream, denoise is free to go high — `trace.py` defaults to
**`CN_DENOISE=0.85`** — for a full pack-style redraw that restores plating,
harness and vine detail without the build or pose moving. Knobs:
`CONTROLNET=0` falls back to the mask-only path at `DENOISE`;
`CN_MODEL` (default the SD1.5 depth CN `control_v11f1p_sd15_depth.pth`; use the
SDXL depth/union CN when tracing on SDXL), `CN_STRENGTH` (0.85), `CN_DENOISE`.
Wired through `comfy.build_graph(control=, controlnet=, cn_strength=, …)`; the
Blender depth is a ready-made control map so no preprocessor runs (pass
`cn_preprocess` only when the control image is a raw photo/render needing e.g.
`DepthAnythingV2Preprocessor`). Validated on the vine-ranger: at 0.85 the RGB
surface changes (~19% of the sprite's pixels — plating/harness/gear) while the
**alpha is byte-identical** to the mask-only cycle, so `consistency.py` reports
the same silhouette/identity metrics (0 violations) and the qwen3-vl gate reads
the same character — the redraw is surface-only by construction.

Shared-GPU manners: the tracer is fire-and-forget and resumable — it submits
in waves of ≤8, polls history, harvests finished frames even if a previous
client was killed, and skips frames already traced. `--no-trace` skips the AI
entirely and ships palette-quantized 3D frames (the coherence-safe fallback);
`--post-only` redoes the downscale from cached traces. `DENOISE=`/`SEED=` to
re-tune. Review before shipping: trace to a scratch dir with `OUTDIR=` and
diff against the shipped cycle (see the ControlNet review deliverable) rather
than overwriting `public/themes/.../chars` in place.

### Stage 3 — gate (`gate.py`) and manifest

`gate.py` (exit code = failures): deterministic checks (48×48, hard alpha,
every pixel in the locked palette, feet on the bottom rows, no content-height
pumping across the cycle), a coherence metric (fraction of changed pixels
between adjacent frames — a spike over 3× the direction's median is tracing
flicker), an **identity layer** that delegates to `consistency.py` so the cycle
must read as the same character as the curated idle (§5b — this is the layer
that would have stopped r1), and the qwen3-vl gates (facing per frame,
same-character contract between the two contact poses). `manifest.py` then emits the
`char.<arch>.<dir>-walk-0..7` clips plus `anim.walk` cadence (4 ticks/frame:
8-frame stride ≈ 1.07 s; the engine-default 6 was tuned for the 2-frame flip).
Legacy `idle`/`step` keys stay as the fallback for states/directions without
clips (docs/themes.md "Animation states").

In-game proof: `bash e2e/run-roto-walk.sh` (port 4993) records the ranger
walking the full 8-direction compass circle on the new cycles.

## 6c. Findings: ControlNet + native depth pass (rotoscope, 2026-07)

A full investigation of adding a **depth ControlNet** to the tracer, driven by
Blender's own Z buffer. This section is the durable record — read it before
touching the ControlNet path so you don't re-derive it the expensive way. The
`.claude/skills/sprite-art` skill is the step-by-step operator's version.

### The technique and why native depth beats a 2D estimator

IPAdapter and ControlNet are **orthogonal** and compose in one graph: IPAdapter
patches the **MODEL** (identity/style anchor), ControlNet patches the
**CONDITIONING** (pose/structure). One `KSampler` reads both
(`comfy.build_graph(refs=…, control=…, controlnet=…)`). So pose can be pinned
*during* diffusion instead of only masked after — which is what lets denoise go
high (restore gear) without pose or build wandering.

The control map **must be Blender's real Z pass, not a 2D depth estimator**
(DepthAnythingV2/Zoe/etc.):

- **Temporal stability.** An estimator renormalizes each frame to its own
  min/max, so its output *flickers* frame-to-frame — fatal for an animation.
  The Blender Z through a **fixed** `ShaderNodeMapRange` window (`DIST ± 0.9 m`,
  script-derived) is deterministic and identical-scaled across all 40 frames.
- **Free and exact.** The proxy already exists; the Z pass is one extra render
  target, no inference, and it is a *semantic* depth (the proxy's true geometry)
  rather than a guess from a flat sprite.
- **Measured result.** At `CN_DENOISE=0.85` the traced RGB changed ~19 % of the
  sprite's pixels (plating/harness/vine) while the **alpha stayed
  byte-identical** to the mask-only cycle — because `post_frame` still masks
  with the Blender alpha. So `consistency.py` reports the *same* silhouette /
  build metrics → **0 violations**, identical to the shipped cycle. Pose-lock is
  total; the redraw is provably surface-only.

### The denoise-vs-"armored" tradeoff (the real catch)

Pose-lock held perfectly, but the **qwen3-vl identity gate FAILED on the
front/profile frames** (`verify.py --same <frame> anchor`): back-¾ (`ne`) read
as the same character, but `s`/`e`/`n` read as "blocky armor vs. vine-covered
design." Crucially this is **not a denoise-tuning miss** — it reproduced across:

| config | `s`/`e` VLM verdict |
|---|---|
| `CN_DENOISE=0.85` | FAIL (white harness patches replace vines) |
| `CN_DENOISE=0.60` | FAIL (blocky armor vs vine-covered) |
| pin-then-release `CN_END=0.55`, `CN_STRENGTH=0.6`, denoise 0.75 | FAIL (angular vs vine-curvy) |

**Root cause:** the depth ControlNet *faithfully reproduces the geared 3D proxy
geometry* (pauldrons, chest-rig, knee-plates — deliberately modeled so the
silhouette matches the ranger's build, see §6 Stage 1). Depth control renders
that geometry as literal hard-surface armor. The mask-only path enforces only
the alpha *silhouette*, leaving diffusion free to develop a softer, painterly,
vine-covered surface inside it — which is closer to the curated anchor. **So for
an organic/vine identity draped over a geared silhouette, depth ControlNet
over-constrains toward armor.** It is the *right* tool for a genuinely
hard-surface character (a robot, power armor), and the wrong default for the
vine-ranger. (Note the VLM is conservative: on the contact sheets a human may
still prefer the CN frames — they are more detailed and still clearly the teal /
orange-cap / vine ranger. This is an owner's-eye call, which is why the frames
are a review deliverable, not an auto-merge.)

### Tuning knobs and softening options

`trace.py` env (all plumbed through `comfy.build_graph`):

- `CONTROLNET=0` — fall back to the mask-only path at `DENOISE`.
- `CN_MODEL` — the ControlNet checkpoint. SD1.5 default
  `control_v11f1p_sd15_depth.pth` (matches the dreamshaper low-VRAM path); use
  the SDXL depth/union CN (`xinsir-controlnet-union-sdxl-1.0-promax`,
  `SDXL/depth-zoe-xl-v1.0-controlnet`) when tracing on SDXL.
- `CN_STRENGTH` (0.85) — ControlNet conditioning weight.
- `CN_DENOISE` (0.85) — sampler denoise on the CN path (safe to raise; pose is
  pinned by CN and silhouette by the alpha mask).
- `CN_END` (1.0) — **pin-then-release**: ControlNet guides only the first
  `CN_END` fraction of steps, then releases so IPAdapter/vines reassert late.

To soften the armored read (untried-to-completion levers, in order of promise):
1. **Much lower `CN_STRENGTH` (~0.3)** — let depth nudge composition without
   dictating hard-surface detail.
2. **Switch the control to lineart or normal** at low strength — outlines/normals
   constrain pose without imposing plate volumes the way depth does.
3. **Emphasize vines in the proxy** — add vine geometry / bias the color-blocking
   in `rig_walk.py`, or add "vine-covered, organic" to the trace prompt, so the
   surface the ControlNet structure gets developed *into* is the vine read.
4. Accept it and keep the mask-only shipped cycle for this character; reserve the
   depth-CN path for hard-surface cast members.

### Blender 5.0 compositor API port (save the next person hours)

The depth pass uses the compositor, which was **rebuilt in Blender 5.0** into a
unified node-group compositor. The old API is gone:

| Blender ≤4.x | Blender 5.0 |
|---|---|
| `scene.node_tree` | `scene.compositing_node_group` (a `CompositorNodeTree` you create + assign) |
| `CompositorNodeComposite` (output sink) | `NodeGroupOutput` (add an `Image` OUTPUT socket to `ng.interface` first) |
| `CompositorNodeMapRange` | `ShaderNodeMapRange` (compositor now uses generic shader nodes; `clamp` attr, output `"Result"`) |
| `CompositorNodeRLayers` | unchanged; depth socket is `"Depth"` (fallback `"Z"`) |

Also: the engine enum in this build is `BLENDER_EEVEE` (no `_NEXT`) — the render
settings block already guards for that. Working pattern is in `rig_walk.py`
(the `DEPTH` block); a color pass renders with `use_compositing=False` +
`film_transparent=True`, then the depth pass with `use_compositing=True` +
`film_transparent=False` + `color_mode="RGB"`.

### Infra reality (as run 2026-07)

- **"soul" is this local WSL box.** Blender is `/mnt/d/tools/blender/blender.exe`
  (a **Windows** binary — v5.0.1), ComfyUI is `http://localhost:8188`, qwen3-vl
  is `http://localhost:11434`. The `render.sh` `ssh soul` path routes through
  Cloudflare Access whose token had expired (needs a browser login) and is
  **unnecessary** — render locally.
- **Windows-binary path translation.** The exe reads `D:/…`, not `/mnt/d/…`.
  Put the workdir under `/mnt/d` (used `/mnt/d/tmp/backseat-roto`), hand Blender
  `D:/tmp/backseat-roto/…` paths (`wslpath -w <path>` converts). Run color+depth
  with `blender.exe -b -P 'D:/…/rig_walk.py' -- --out 'D:/…/frames' --res 1024`.
- ComfyUI first-run loads (checkpoint + IPAdapter + ControlNet + any
  preprocessor) cost minutes; warm gens are seconds. Traces are resumable
  (`trace.py` harvests server history) — a killed poll loses nothing rendered.

### Deliverables (this investigation)

Under `~/Videos/backseat/rotoscope-controlnet/` (outside the repo — sprite frames
are NOT committed pending the owner's visual decision):

- `SHEET-rotoscope-before-after.png` — all 40, shipped r1 vs CN-depth 0.85, per direction.
- `SHEET-cn-denoise-variants.png` — `s`/`e` across shipped / .85 / .60 / pin-release.
- `walk-cycle-shipped-vs-controlnet.gif` — animated 8-frame cycle, all 5 dirs, shipped vs CN (judge motion/temporal stability, not just static poses).
- `frames/` — the 40 candidate CN sprites. `depth/` — the 40 Blender Z-pass control maps.

## 7. Worked example: add a new NPC to an existing theme

Goal: a "marsh-witch" NPC for swampspace, mapped to the `civilian` archetype.

1. **Declare it.** In `scripts/assets/generate.py` add to `CHARS`:
   `"civilian": ("marsh-witch", "<description: silhouette + dominant colors>",
   "<negatives: the player's signature look>")` — or a new archetype mapping if
   the engine gains one. This auto-creates the 10 pose jobs
   `char.marsh-witch.{s,se,e,ne,n}-{idle,step}`.
2. **Sweep the anchor pose.** `python3 generate.py sweep char.marsh-witch.s-idle
   --seeds=8`, contact-sheet the candidates at 48 px (`post.sprite` + 
   `post.contact_sheet`), check distinctness against the rest of the cast sheet.
3. **Gate + curate.** `python3 verify.py $STAGE/char.marsh-witch.s-idle --job
   char.marsh-witch.s-idle`; record the winner in `curation.json`
   (`{seed, batch, index, raw}`) and save its raw (512 px) to
   `anchors/marsh-witch-s-idle.png`.
4. **Directions.** Sweep `se/e/ne/n-idle` (they auto-anchor on the s-idle with
   per-direction weights); gate facing with `verify.py`; curate each.
5. **Steps.** Sweep the five `*-step` jobs — each automatically img2img's from
   its curated idle at denoise 0.38. Gate with `verify.py --pairs`.
6. **Finalize.** `python3 generate.py final char.marsh-witch.s-idle ...` (or
   loop over curated jobs) → 48×48 palette-locked PNGs in
   `public/themes/swampspace/chars/`.
7. **Manifest.** Point the archetype at the new kind in `manifest.py`
   (`CHAR_FILES`), run `python3 manifest.py` (fills all 10 keys with borrow
   chains), add a display name to `NAMES`, then
   `pnpm exec vitest run src/render/theme.test.ts` and eyeball in game:
   `pnpm run dev` → `http://localhost:5173/?theme=swampspace` (or
   `node scripts/test/swampspace-proof.mjs` against a preview build).
8. **Ship.** `python3 sheets.py`, update `CURATION.md`, commit the curated
   PNGs + manifest (never the raw sweeps).
