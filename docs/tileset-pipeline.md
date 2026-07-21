# Themed tileset pipeline — how to make a tile set (any theme)

A repeatable, local ComfyUI pipeline for a cohesive, crafted, readable tile set.
This is the human guide; the agent-facing version is the **`themed-tilesets`
skill** (`.claude/skills/themed-tilesets`). Build log and value plan:
`docs/genesis-upgrade.md`. Prior-art to adopt next: `docs/tileset-research.md`.

## What you get / the quality bar

Tiles that read as **crafted 16-bit pixel art** (not noisy AI texture), stay
**readable** (dark ground, characters pop), tile with **real variety**, and match
one **theme + palette**. The reference build is the `swampspace-hires` dark-swamp
outpost.

## The recipe (the load-bearing choices)

| Choice | Value | Why |
|---|---|---|
| Base model | Juggernaut Ragnarok (SDXL) | good composition/detail |
| LoRA | **Pixel Art XL @ 0.7** (`XL/pixel-art-xl.safetensors`) | resolves painterly output into crafted pixel clusters. Juggernaut alone → noodly noise. NOT skormino (halftone). |
| Pixel-art step | k-centroid downscale + palette snap (`post.py`) | the downscale IS the pixelation |
| Seamless | `SEAMLESS_MODE=circular` | `SeamlessTile`+`CircularVAEDecode` wrap by construction; no center-cross |
| Cohesion | one locked palette (`palette.py`) + value bands | palette-lock is the strongest cohesion lever |

## The loop

1. **Value plan** — each surface a luminance band (`theme_config.py` `bands`);
   ground dark, structure a step up, goal the one hot value; neighbours ≥1 band apart.
2. **Generate**
   - Organic ground → `themed_ground.py` (`diverse` for varied terrain, `master`/`vary`
     for one material). Wrapping master → sliced macro tiles that flow across tiles.
   - Structured surfaces → `tiles_genesis_sd.py` (value-banded procedural base +
     img2img; grid hides seams).
3. **Accents** — rare feature tiles (glow/pools/grates), edge-blended to a real base
   tile so they seat in the field (`themed_accents.py`).
4. **Assemble & judge at FIELD scale** — `field_preview.py` (assembles exactly as the
   engine does), `tile_judge.py` (qwen3-vl + confetti metric). Judge the field, not
   one tile.
5. **Gate** — `contrast_audit.py` (value + char-vs-ground), then **`sync_manifest.py`**
   (critical — a stale/underfilled pool silently kills macro continuity).
6. **Evaluate in-game** — `e2e/scene-shots.mjs`, screenshot real rooms.

Example (dark swamp bog, 5 varied terrains):
```sh
cd scripts/assets
export SWAMPSPACE_STAGE=/tmp/swamp-stage SEAMLESS_MODE=circular
python3 themed_ground.py diverse grass 4 54 2      # 5 terrains × 16 = 80 tiles
python3 tiles_genesis_sd.py --seeds=2 floor street sidewalk wall exit
python3 tiles_genesis_sd.py --seeds=2 street-accent floor-accent grass-accent
cd ../.. && python3 scripts/assets/sync_manifest.py
python3 scripts/assets/field_preview.py grass --n 16    # judge the field
```

## Retarget to a NEW theme

Edit **`scripts/assets/theme_config.py`** (one file): `id`/`tiles_dir`, `bands`
(value plan), `diverse` (terrain prompts), `fiction` (one-line world), and the
palette in `palette.py`. Add the surface prompts to `themed_ground.py BASE_PROMPTS`
and `tiles_genesis_sd.py UNITS`. Create `public/themes/<id>/manifest.json`
(`macroTiles`, `palette.tiles`, names) and run `sync_manifest.py`. Then run the loop
above with `THEME_ID=<id>` (or `THEME_CONFIG=<module>`).

## Gotchas (each cost real time)

- **Which pixel LoRA matters** — Pixel Art XL good, skormino bad. Test at FIELD scale.
- **Reserve brightness for accents + sprites** — glow on every base tile = polka-dot.
- **Diverse masters meet at hard macro-cell edges** — smooth terrain blends need
  dual-grid/Wang transition tiles (engine change; `docs/tileset-research.md`).
- **Bake a dark outline on characters/props** (`char_outline.py`) so figures pop on
  any ground.
- **Always `sync_manifest.py` after regen** — the manifest lists pools explicitly.
