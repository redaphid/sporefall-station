---
name: themed-tilesets
description: >-
  Generate a cohesive, THEMED, Genesis/SNES-quality tile SET for any theme with
  the local ComfyUI pipeline (Juggernaut Ragnarok + Pixel Art XL LoRA + circular
  seamless), then gate it (contrast + qwen3-vl aesthetic + seam) and evaluate it
  IN-GAME by assembling real fields and screenshotting. Covers the value plan,
  diverse-master variation, macro/edge continuity, edge-blended feature accents,
  the manifest-sync guard, and how to retarget to a NEW theme/palette. Use when
  asked to make/redo floor/wall/water/ground tiles for a theme, fix "ugly/
  low-contrast/amateurish/repetitive" tiles, or add tile variety.
---

# Themed tilesets — the repeatable pipeline

A production-tested loop for turning a theme brief into a cohesive tile set that
reads as crafted 16-bit pixel art (not noisy AI texture), stays readable
(characters pop), and tiles with real variety. Everything lives in
`scripts/assets/`. Infra: ComfyUI `localhost:8188` (RTX 4090), qwen3-vl on Ollama
`localhost:11434`. Stage raws: `export SWAMPSPACE_STAGE=/tmp/<theme>-stage`.

The reference build is the `swampspace-hires` dark-swamp-outpost theme; the same
scripts retarget to any theme — see **§7 Retargeting**.

## 0. The recipe (learned the hard way — do not deviate blindly)

- **Model: Juggernaut Ragnarok (SDXL) + Pixel Art XL LoRA @ 0.7** (comfy.py
  defaults; tile scripts set the LoRA). Juggernaut ALONE is painterly → its
  downscaled output is noodly AI-texture NOISE (reads amateurish). **Pixel Art XL**
  (`XL/pixel-art-xl.safetensors`, NeriJS — NOT the skormino halftone LoRA) resolves
  detail into deliberate, chunky, crafted pixel clusters with real shading. 0.7
  keeps organic detail; 1.0 over-blocks. **k-centroid + palette IS the pixel-art
  step** (post.py) — generate at 1024, downscale hard.
- **Seamless: `SEAMLESS_MODE=circular`** (default) — ComfyUI `SeamlessTile` +
  `CircularVAEDecode` make tiles wrap by construction (seam ≈6 vs offset-heal ≈25),
  NO center-cross (the "x/y axis" artifact). `=offset` is the legacy fallback.
- **Value plan (contrast > hue).** Every surface owns a luminance BAND; touching
  surfaces sit ≥1 band apart; brightness is RESERVED for glow accents + sprites.
  Dark, moody ground so characters pop. Gate: `contrast_audit.py`.
- **Palette-lock** every tile to one small master palette (palette.py + to_palette)
  — the single strongest cohesion lever.

## 1. Value plan first (before generating anything)

Assign each surface a mean-luminance band in `tiles_genesis.py` `BAND`. Example
(dark swamp): `wall 30 < street 40 < grass 54 < floor 82 < sidewalk 118 < exit 150`.
Rules: ground compressed and dark; structure one step up; the exit/goal is the one
hot value. `enforce_band` re-snaps every generated tile onto its band so diffusion
can't drift the plan.

## 2. Generate — two surface archetypes

**Organic ground (grass/bog/sand/snow) → `themed_ground.py`.** Generate a large
WRAPPING master and SLICE it (every slice shares material/lighting and co-tiles):
- `master`  — hero + N consistent variations (one material, low repeat).
- `vary`    — img2img+IPAdapter variations anchored to a hero (same material).
- `diverse` — **one master per DIVERSE terrain prompt** (moss / open water-lake /
  root-tangle / mire / sunken-wreck). The engine alternates a master per macro-cell,
  so snapping tiles together yields a VARIED, complicated field, not one repeat.
  Use this when the owner wants "more variation/complication."

  ```sh
  SWAMPSPACE_STAGE=/tmp/swamp-stage SEAMLESS_MODE=circular \
    python3 themed_ground.py diverse grass 4 54 2   # 5 terrains × 16 slices = 80 tiles
  ```

**Structured surfaces (metal deck plates, brick, walkway) → `tiles_genesis_sd.py`.**
A value-banded procedural base (plate grid / cap) carries the STRUCTURE; img2img at
moderate denoise (~0.5) dresses it. The grid aligns to tile edges so seams hide in
the structure.

  ```sh
  SWAMPSPACE_STAGE=/tmp/swamp-stage SEAMLESS_MODE=circular \
    python3 tiles_genesis_sd.py --seeds=2 floor street sidewalk wall exit
  ```

Both pipelines: circular downscale (`seamless_kcentroid`) → `despeckle` →
`enforce_band` → palette snap.

## 3. Feature accents (rare, ~6% via engine `TILE_ACCENT_EVERY`)

Brightness lives HERE, not in base tiles. Accents = glowing pods, embers, pools,
grates, fungus. Generate them so they SEAT in the field: init from a REAL base tile
with a feature blob, and **restore the base border (feathered)** after diffusion so
they blend instead of sitting in a box (`themed_accents.py`, and `_blend_border` in
`tiles_genesis_sd.repaint_accent`).

## 4. Assemble & JUDGE at field scale (not one tile)

- `field_preview.py <surface> --n 16` — assembles a field EXACTLY as the engine does
  (ports `pickTileVariant` + `coordHash` + macro placement + accents). This is where
  repetition, seams, and variety actually show. Judge THIS, not single tiles.
- `tile_judge.py --surface <s> <file>` — qwen3-vl aesthetic score + a `confetti`
  isolated-pixel metric (noise detector). The VLM is generous on noise; trust the
  confetti_px number too.
- Seam check: mean abs diff of opposite edges (in `field_preview`/`post.seam_energy`).

## 5. Gates (all must pass)

```sh
python3 contrast_audit.py --theme public/themes/<id>   # value bands + char-vs-ground (outline counts)
python3 sync_manifest.py  --theme public/themes/<id> --check   # CRITICAL, see §6
```

## 6. Sync the manifest — the silent-killer gotcha

The theme manifest lists tile pools EXPLICITLY. A macro pool with fewer files than
`macro*macro` silently drops the engine out of the macro path into per-tile hashing
— the continuity you authored never ships (this shipped a bog checkerboard: manifest
had 8 of 48 tiles). **ALWAYS run `python3 scripts/assets/sync_manifest.py` after ANY
tile regen** (and `--check` in CI).

## 7. Retargeting to a NEW theme / requirements

The theme-specific knobs, in order:
1. **Palette** — `palette.py` `PALETTE` (a small locked list; derive from a mood
   study). All tiles snap to it.
2. **Value bands** — `tiles_genesis.py` `BAND` per the new theme's light logic.
3. **Prompts** — `themed_ground.py` `DIVERSE` (terrain list) + `BASE_PROMPTS`, and
   `tiles_genesis_sd.py` `UNITS`/`ACCENTS`. Name the VALUE and the FICTION explicitly;
   negative-prompt away perspective/photo/figure.
4. **Manifest** — `public/themes/<id>/manifest.json`: `macroTiles`, `palette.tiles`,
   names; then `sync_manifest.py`.
5. **Evaluate in-game** — `e2e/scene-shots.mjs` (`THEME=<id> PREFIX=.. SCENES='[...]'`).

(Consolidating these into one `theme_config.py` the scripts import is the clean next
step — currently they're edited in place.)

## 8. Character/ground readability

Bake a 2px dark outline into EVERY character/prop/item sprite
(`char_outline.py`) — the universal fix for figures blending into ground, and it
lets `contrast_audit` pass ground pairs on outline rather than impossible
every-body-vs-every-ground value separation.

## Gotchas (each cost real time)

- **Pixel LoRA matters which one.** skormino = halftone camo-blobs (bad);
  Pixel Art XL = crafted clusters (good). At field scale, not just one tile.
- **Diffusion + downscale ≠ pixel art** without a pixel-art LoRA — you get noise.
- **Judge the FIELD, not the tile** — a fine single tile can checkerboard as a field.
- **Diverse masters meet at hard macro-cell edges** — real terrain-blend needs
  dual-grid/Wang transition tiles (engine change; see `docs/tileset-research.md`).
- **Reserve brightness for accents + sprites.** Glow on every base tile = polka-dot.
- **Even visual weight per tile** or a dark/light checkerboard betrays the grid
  (the master picker penalizes per-slice luminance spread).

## Full reference
`docs/genesis-upgrade.md` (the build log + value plan), `docs/tileset-research.md`
(edge-locking / dual-grid / curation-metric prior art to adopt next), and the
`sprite-art` skill (characters, FX, rotoscoped walk cycles).
