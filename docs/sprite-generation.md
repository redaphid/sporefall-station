# Sprite generation — setup & pipeline guide

How to generate theme sprite packs for Backseat with a local ComfyUI, from a
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
| `verify.py` | VLM gate (§5). |
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
sprites land in `public/themes/swampspace/`. Only the latter is committed.

## 3. The generation contract

- **Characters: 48×48 px canvas**, feet on bottom-center (the engine anchors
  there). **5 drawn directions** `s se e ne n` × **2 frames** `idle step`;
  west (`sw w nw`) is mirrored by the engine — never draw it. Manifest keys
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

## 5. The VLM verification gate (`verify.py`)

Ollama `qwen3-vl:8b`, majority vote (3 reads, `VOTES=` to change), temp 0.
Checks per category:

- props/items/tiles/fx: must NOT read as a person/creature (anthropomorphism);
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

### Stage 2 — AI tracer (`trace.py`)

Each frame goes through ComfyUI **img2img at denoise 0.35** with the
character's curated s-idle as IPAdapter anchor (per-direction weights from
§4.5), same seed for all 40 frames. Model: SDXL + pixel-art LoRA by default;
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

Shared-GPU manners: the tracer is fire-and-forget and resumable — it submits
in waves of ≤8, polls history, harvests finished frames even if a previous
client was killed, and skips frames already traced. `--no-trace` skips the AI
entirely and ships palette-quantized 3D frames (the coherence-safe fallback);
`--post-only` redoes the downscale from cached traces. `DENOISE=`/`SEED=` to
re-tune.

### Stage 3 — gate (`gate.py`) and manifest

`gate.py` (exit code = failures): deterministic checks (48×48, hard alpha,
every pixel in the locked palette, feet on the bottom rows, no content-height
pumping across the cycle), a coherence metric (fraction of changed pixels
between adjacent frames — a spike over 3× the direction's median is tracing
flicker), and the qwen3-vl gates (facing per frame, same-character contract
between the two contact poses). `manifest.py` then emits the
`char.<arch>.<dir>-walk-0..7` clips plus `anim.walk` cadence (4 ticks/frame:
8-frame stride ≈ 1.07 s; the engine-default 6 was tuned for the 2-frame flip).
Legacy `idle`/`step` keys stay as the fallback for states/directions without
clips (docs/themes.md "Animation states").

In-game proof: `bash e2e/run-roto-walk.sh` (port 4993) records the ranger
walking the full 8-direction compass circle on the new cycles.

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
