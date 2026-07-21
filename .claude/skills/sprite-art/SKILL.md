---
name: sprite-art
description: >-
  Generate and animate theme sprite art for Sporefall Station with the local
  ComfyUI + Blender pipeline: seed-swept diffusion sprites (SDXL/SD1.5 +
  IPAdapter style anchor), seamless tiles, procedural FX, and rotoscoped walk
  cycles (Blender proxy → native depth pass → depth-ControlNet trace). Gates
  every asset with the silhouette-consistency harness and the qwen3-vl VLM.
  Use when asked to make/regenerate character sprites, tiles, items, FX, or
  walk-cycle animations for a theme pack, add an NPC, or trace/curate rotoscoped
  animation. Reference: docs/sprite-generation.md.
---

# Sprite art: generate, animate, gate, curate

An AI art pipeline that drives a **local ComfyUI over HTTP** (no UI, no saved
workflows) plus **local Blender** for motion, and gates output with two
machines — `consistency.py` (silhouette metrics) and `verify.py` (qwen3-vl) —
before a human curates. The full reference is
[`docs/sprite-generation.md`](../../../docs/sprite-generation.md); this skill is
the repeatable loop. Everything lives in `scripts/assets/`.

## 0. Infra check (do this first)

"soul" is **this local WSL box**, not a remote host:

```sh
curl -s localhost:8188/system_stats | jq .devices      # ComfyUI (GPU visible)
curl -s localhost:11434/api/tags | jq '.models[].name' # Ollama has qwen3-vl:8b
/mnt/d/tools/blender/blender.exe --version              # Windows Blender 5.x
```

ComfyUI `localhost:8188`, Ollama `localhost:11434`, Blender
`/mnt/d/tools/blender/blender.exe`. The `render.sh` `ssh soul` path needs a
Cloudflare login and is unnecessary — render locally. Required models / nodes /
palette: docs §1. Stage raws outside the repo:
`export SWAMPSPACE_STAGE=/tmp/swampspace-stage`.

## 1. Static assets — sweep, gate, curate

```sh
cd scripts/assets
python3 generate.py --list                              # every job name
python3 generate.py sweep prop.spore-barrel --seeds=8   # one asset, 8 seeds
# low-VRAM / fallback path (SD1.5, no LoRA):
CKPT=dreamshaper_8.safetensors LORA= SIZE=512 python3 generate.py sweep item.root-club --seeds=4
```

Then, gate **before** curating (cheap metrics first, GPU VLM second):

```sh
python3 consistency.py --files $STAGE/<job>/*.png        # silhouette metrics
python3 verify.py $STAGE/<job> --job <job>               # qwen3-vl per-asset
```

Approve the winner with the **`curate` verb** — it copies the raw into the
committed `raws/` dir and records a portable (relative) path in `curation.json`,
so `final` reproduces the exact approved pixels forever (docs §2b — this closed
the /tmp curation-loss gotcha). For a character s-idle also save the 512px raw
to `anchors/` (it becomes the IPAdapter reference).

```sh
python3 generate.py curate <job> $STAGE/<job>/<picked-file>.png \
    --seed <N> --index <I> --size 512 --ckpt dreamshaper_8 --note "<why>"
python3 generate.py final <job>                          # post the durable raw into public/themes/<id>/
python3 manifest.py && python3 sheets.py
pnpm exec vitest run src/render/theme.test.ts            # schema + file integrity
```

`final` will **not** silently regenerate a lost pick (the graph drifts —
same-seed regen ≠ the approved art); it points you to re-curate. `--allow-regen`
is the explicit escape hatch. Audit reproducibility any time with
`python3 migrate_curation.py` (lists PERSISTED / LOST picks).

Hard-won rules (details in docs §4): IPAdapter refs must be ENVIRONMENT-only for
props/tiles, CHARACTER-only for figures; items get NO refs; palette-lock is the
great unifier; sparse FX are procedural (`procedural.py`), never diffusion.

## 2. Rotoscoped walk cycles — the three stages

One command (see docs §6):

```sh
cd scripts/assets/rotoscope
CHAR=vine-ranger bash run.sh        # render → trace → gate → manifest
```

### Stage 1 — proxy + native depth pass (`rig_walk.py`, local Blender)

A fully **procedural** color-blocked humanoid proxy (no external rig — license
clean). Its silhouette IS the identity contract: match its proportions to the
curated s-idle (`python3 consistency.py <char>`) or the walk cycle ships a
differently-built character. It renders 5 dirs × 8 frames of color **and a
native depth (Z) pass** (`walk-<dir>-<n>-depth.png`) for the ControlNet tracer.

Run it locally (Windows binary → `D:/` paths; workdir under `/mnt/d`):

```sh
cp rig_walk.py /mnt/d/tmp/backseat-roto/
/mnt/d/tools/blender/blender.exe -b -P 'D:/tmp/backseat-roto/rig_walk.py' -- \
  --out 'D:/tmp/backseat-roto/frames' --res 1024        # --depth 0 to skip Z
# stage for the tracer:
cp /mnt/d/tmp/backseat-roto/frames/walk-*.png "$SWAMPSPACE_STAGE/rotoscope/blender/"
```

Depth is Blender's Z through a **fixed** map-range (temporally stable across
frames — an estimator would flicker). NB Blender 5.0's compositor is the new
node-group API (`scene.compositing_node_group` + `NodeGroupOutput` +
`ShaderNodeMapRange`; the old `scene.node_tree`/`CompositorNode*` are gone) —
`rig_walk.py`'s `DEPTH` block is the working pattern.

### Stage 2 — AI tracer (`trace.py`): IPAdapter identity + ControlNet pose

Each frame is img2img'd into pack style. **IPAdapter** anchors identity (the
curated s-idle); the **depth ControlNet** pins pose/structure *during*
diffusion, so denoise can go high to restore gear without pose drift. The
silhouette is additionally pinned by masking with the Blender alpha downstream,
and all frames share one fixed crop window (no scale pumping).

```sh
# ControlNet+depth path (default ON), to a REVIEW dir — never overwrite shipped in place:
SWAMPSPACE_STAGE=$STAGE OUTDIR=/tmp/roto-review ROTO_TAG=cn1 \
CKPT=dreamshaper_8.safetensors LORA= SIZE=512 python3 trace.py
```

Knobs: `CONTROLNET=0` (mask-only fallback), `CN_MODEL`, `CN_STRENGTH` (0.85),
`CN_DENOISE` (0.85), `CN_END` (1.0 = full; <1 = pin-then-release). `--no-trace`
ships palette-quantized 3D frames; `--post-only` redoes the downscale.

> **Denoise-vs-"armored" tradeoff (know this before you pick a denoise).** The
> depth ControlNet faithfully reproduces the *geared 3D proxy geometry*, which
> renders as hard-surface armor. For an organic/vine character that reads as
> "armored" and the VLM identity gate fails on front/profile frames — at every
> denoise, not just high (it is structural, not a tuning miss). Depth-CN is the
> right tool for a hard-surface character (robot/power-armor) and the wrong
> default for a soft/organic one. To soften: lower `CN_STRENGTH` (~0.3), switch
> the control to lineart/normal, or emphasize the organic look in the proxy /
> prompt. Full analysis: docs §6c.

### Stage 3 — gate (`gate.py`) + manifest

Deterministic checks (48×48, hard alpha, palette, feet, no height pumping) +
adjacent-frame coherence + an **identity layer** that delegates to
`consistency.py` (the layer that catches a coherent cycle *of the wrong
character*) + qwen3-vl facing/same-character. Then `manifest.py` emits the
`char.<arch>.<dir>-walk-0..7` clips + `anim.walk` cadence.

```sh
python3 gate.py                                          # exit code = failures
python3 consistency.py --check                           # silhouette gate vs spec
python3 verify.py --same <frame.png> anchors/<char>-s-idle.png   # ad-hoc identity vs anchor
```

## 3. Review, don't auto-ship (art is subjective)

Trace to a scratch `OUTDIR=` and build a **before/after** deliverable (contact
sheet + animated GIF of shipped vs new, per direction) rather than overwriting
`public/themes/<id>/chars/*`. The metrics gate proves the silhouette held; the
VLM flags identity drift; but the accept/soften/hold call on the *look* is the
owner's. Only after approval do the new frames replace the shipped ones.

## Gotchas (each cost real time once)

- **`consistency.py` measures silhouette (alpha), not surface.** A ControlNet
  redraw that changes only RGB leaves metrics byte-identical (0 violations) even
  when the VLM sees a different-looking character — run **both** gates.
- **Facing.** Drawn side art must face RIGHT (engine mirrors the west half). The
  accent gate in `consistency.py` catches left-facing frames; never trust the
  prompt alone.
- **First ComfyUI load is minutes, warm is seconds.** Keep batches ≤4; the
  tracer is resumable (harvests server history) so a killed poll loses nothing.
- **Never** introduce raw sweeps into `public/themes/` — only curated,
  post-processed picks land there. Uncurated sweeps stay in `$SWAMPSPACE_STAGE`;
  the **approved** raw is committed to `scripts/assets/raws/` via `curate`.
- **A curated pick is an artifact — commit its raw.** Recording only the
  `$STAGE`/`/tmp` path (the old way) loses the pick when the session ends, and
  same-seed regen drifts. Always `curate` (→ `raws/`, relative path). Anchors in
  `anchors/` are the durable char s-idle raws and the only survivors of the last
  loss; `post.sprite` black-keys those alpha-less black-bg raws automatically.
