# Findings — durable curation & item re-curation (2026-07-20)

Session focus: close the **/tmp curation-loss gotcha** and prove the fixed
pipeline by re-curating lost assets on real GPU. Branch `feat/art-durable-curation`.
Infra confirmed up: ComfyUI 0.28.2 on an RTX 4090 (24 GB free), Ollama
`qwen3-vl:8b`, Blender 5.0.1 at `/mnt/d/tools/blender/blender.exe`.

## 1. The loss, quantified

`migrate_curation.py` (dry run) split the 40 recorded picks:

- **6 recoverable** — the character `s-idle`s, via the committed 512px anchors
  in `scripts/assets/anchors/`.
- **34 LOST** — every item (8), prop (6), tile (2), all step frames, all
  non-`s` ranger directions, and 4 staged attack frames. Their `raw` pointed at
  a dead `/tmp/claude-1000/-home-redaphid-.../stage/...` path (note: an *old
  user + old repo name*, pre-`sporefall-station` rename — doubly dead).

Root cause was structural, not accidental: `curation.json` stored the raw as an
ephemeral absolute path and `final` *silently drift-regenerated* on a miss. The
graph has moved since (prompts/anchor logic evolved), so a same-seed regen no
longer matches the approved pick — confirmed by the memory's "contaminated blob"
spore-pistol regen.

## 2. The fix (committed, non-GPU)

See `docs/sprite-generation.md` §2b for the operator's version. In short:

- `scripts/assets/raws/` — committed curated raws; `curation.json` `raw` fields
  are now **relative to `scripts/assets/`**.
- `generate.resolve_raw()` resolves durable-first (relative raw → `raws/<job>`
  → char anchor). `final` and `init_from_idle` chains use it.
- `generate.py curate <job> <file>` — the one blessed way to approve a pick.
- `final` refuses to drift-regen (explicit `--allow-regen` only).
- `post.sprite` black-keys alpha-less raws — fixes a black-boxed-figure
  regression when posting the black-bg 512px anchors. Verified: hero reproduces
  clean + transparent from its anchor (mean abs diff 16.7 vs the shipped 48px;
  same character, brighter/more on-model — the shipped char sprites predate this
  post path and can be re-shipped with `final` if desired, left untouched here).

`migrate_curation.py --write` persisted the 6 anchors into `raws/` and rewrote
their paths. It doubles as a **standing audit**: re-run to see the re-curation
backlog shrink.

## 3. Item re-curation (GPU) — BLOCKED by shared-GPU contention

Attempted to re-curate the lost items on real GPU to prove the loop end-to-end.
The shared RTX 4090 was **saturated by a co-tenant** the whole window and no
generation completed:

- `system_stats` reported 20–24 GB *free* when queried between jobs, but the
  instant any prompt ran, VRAM jumped to **23.8 GB used at 100 % GPU** and stayed
  there — a co-tenant model (~20 GB; almost certainly a large resident model,
  possibly the qwen3-vl:8b VLM among others) pins the card, forcing my SD1.5 job
  into deep lowvram offload.
- An 8-image `item.spore-pistol` sweep **timed out at 900 s** with zero output;
  its ComfyUI history stayed empty.
- A minimal control probe — **one** 512px SD1.5 image, no Rembg, no LoRA —
  **also timed out (190 s)**. So it is not batch size or the isnet download; the
  card is simply not available for our work right now.

This is the exact "shared-GPU realities" trap in docs §1 (resident models squeeze
SDXL/SD1.5 into 30-min lowvram batches). The right move is to be a good tenant:
interrupted our own stuck jobs to free the card and **deferred generation** rather
than hammer a contended GPU. The fixed pipeline is ready — the re-curation is a
pure GPU-availability wait, no code work remains to start it:

```bash
cd scripts/assets
SWAMPSPACE_STAGE=../../.art-stage CKPT=dreamshaper_8.safetensors LORA= SIZE=512 \
  python3 generate.py sweep item.spore-pistol --seeds=8     # + the other 33 LOST jobs
# review contact sheet, then for each winner:
python3 generate.py curate <job> ../../.art-stage/<job>/<file> --seed N --index I --size 512 --ckpt dreamshaper_8
python3 generate.py final <job>
python3 migrate_curation.py            # watch the LOST count fall toward 0
```

**Verified without the GPU**, so the loop is known-good the moment the card frees:
`final char.vine-ranger.s-idle` reproduces the hero cleanly and transparently
from the durable anchor (the black-key fix); `curate`/`resolve_raw`/`migrate`
all exercised; `post.has_alpha`/`black_key` unit-checked on the anchor.

## 4. Open questions / next steps

- **Re-curate the remaining LOST assets**: props (env-anchored, SDXL), tiles
  (seamless offset-heal), and the ranger's step/direction frames (chain from the
  durable s-idle anchor). Each: `sweep` → visual/VLM curate → `curate` → `final`.
- **Pose plateau (unchanged this session).** The depth-ControlNet "armored read"
  on organic characters (docs §6c) still stands. Untried levers in priority
  order: `CN_STRENGTH~0.3`; switch control to lineart/normal at low strength;
  add vine geometry to the Blender proxy so depth develops *into* a vine read.
- **Re-ship char sprites from anchors?** Owner call — `final` output is arguably
  more faithful than the current dimmer shipped set.
