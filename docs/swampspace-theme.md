# Swampspace theme ("Sporefall Station") — how it was made & how to regenerate

`public/themes/swampspace/` is an AI-generated theme pack (schema: `docs/themes.md`):
an alien bog overtaking a derelict space station. Art direction is anchored on the
Titan-jungle levels of *Flashback* (Amiga, 1992): teal mist, olive overgrowth
swallowing tan/gray tech, sparse hot bioluminescent accents. Inspiration only —
prompts plus a palette derived from a dominant-color study; no Flashback art is
used as a generation input or reproduced.

## Pipeline (scripts/assets/)

| Script | Role |
|---|---|
| `comfy.py` | ComfyUI HTTP driver (graph builder; no saved workflow files) |
| `generate.py` | Job table (every asset's prompt/seed/params) + `sweep`/`final` CLI |
| `post.py` | k-centroid downscale, locked-palette quantize, canvas placement |
| `palette.py` | The locked 34-color palette (run it to emit a swatch sheet) |
| `verify.py` | VLM gate (Ollama `qwen3-vl:8b`): anti-figure, camera, facing checks |
| `procedural.py` | Deterministic PIL sprites for sparse particles (spark/splat/bolt) |
| `manifest.py` | Emits `manifest.json` (only keys whose file exists) + index entry |
| `sheets.py` | Contact sheets + tiling proofs into `docs/assets/swampspace/` |
| `curation.json` | Lineage: per asset the chosen seed / batch index / raw file |
| `anchors/` | Curated raw picks reused as IPAdapter style references |

Recipe highlights (researched 2026-07, calibrated locally):

- **Model**: SDXL `AnythingXL_xl.safetensors` + `pixel_art_style_by_skormino_v7.05`
  LoRA. The skormino LoRA is **Illustrious/SDXL** — pairing it with an SD1.5
  checkpoint (as an earlier pack did) silently no-ops. Triggers
  `masterpiece, pixpix, 8-bit, pixel_art`; CFG 3.5, euler, 28 steps, 1024 px.
- **Consistency**: IPAdapterAdvanced "style transfer" (weight ~0.8) onto fixed
  anchors — environment anchors for props/items, each character's curated
  `s-idle` for its other nine poses. Never rotate reference images.
- **Seamless tiles**: txt2img → half-offset (`Image Tile Offset (mtb)`) →
  img2img heal at denoise 0.35. Wrap edges are continuous by construction;
  `post.seam_energy` + the 4×4 tiling proofs in `docs/assets/swampspace/` verify.
  (`Model Patch Seamless (mtb)` deepcopy-crashes on ComfyUI 0.28.)
- **Pixelization**: generate large → k-centroid downscale to the final sprite
  size → quantize every pixel to the locked palette, no dither → hard alpha.
- **Gate**: every candidate/curated asset passes `verify.py` (majority-vote
  qwen3-vl): props/tiles must not read as figures, floor tiles must read
  top-down, `n`/`ne` character poses must not show a face.

## Regenerating

Requirements: ComfyUI at `localhost:8188` (models above installed), Ollama at
`localhost:11434` with `qwen3-vl:8b`, Python 3 + Pillow + numpy.

```bash
cd scripts/assets
python3 generate.py --list                     # all job names
python3 generate.py sweep prop.spore-barrel --seeds=8   # raw sweep to staging
python3 verify.py $SWAMPSPACE_STAGE/prop.spore-barrel --job prop.spore-barrel
# pick a winner, record {seed,batch,index,raw} in curation.json, then:
python3 generate.py final prop.spore-barrel    # post-process into the theme dir
python3 procedural.py && python3 manifest.py && python3 sheets.py
pnpm exec vitest run src/render/theme.test.ts  # manifest/file integrity
```

Raw sweeps land in `$SWAMPSPACE_STAGE` (default `/tmp/swampspace-stage`) and are
**never committed** — only curated, post-processed, palette-locked sprites ship.

Preview in game: `pnpm run dev` → `http://localhost:5173/?theme=swampspace`, or
`THEME_ID=swampspace bash e2e/run-theme.sh` for a seeded side-by-side recording.
