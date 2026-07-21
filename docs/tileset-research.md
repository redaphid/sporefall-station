# Tileset generation research — directions to adopt

Prior-art survey (owner-provided, 2026-07) on edge-locked, mass-generation
pixel-art tilesets. The current pipeline (docs/genesis-upgrade.md) gets
continuity from **macro placement + edge-blended accents + a shared palette**;
this file records the more fundamental techniques to adopt next.

## Highest-leverage adoptions

1. **Exterior-boundary inpainting for TRUE edge-locking** (Sartor & Peers,
   SIGGRAPH Asia 2024; code: github.com/samsartor/content_aware_tiles). Fix a
   border strip, mask the interior, inpaint against it → every tile's edges match
   by construction, so ANY tile co-tiles with ANY tile (not just macro-ordered).
   Would replace macro-placement and give perfect continuity WITH full variety.
   Also has an automated reject loop (4 candidates/tile, keep best).
2. **Dual-grid (15-tile) autotiling** instead of the current macro scheme, for
   terrain BOUNDARIES (bog↔deck↔causeway transitions). 15 tiles per boundary vs
   blob-47; better corners. Needs an engine change: `pickTileVariant` →
   edge-aware autotile lookup (4-bit corner mask, `frameByMask` table). This is
   how bog would blend INTO deck instead of hard room edges.
3. **Circular-padding seamless** (ComfyUI-seamless-tiling: Seamless Tile / Make
   Circular VAE nodes) to replace our offset-heal seamless (the center-cross
   source; we mitigate with SEAMLESS_HEAL). Cleaner self-tiling.
4. **Rigorous curation metrics** to augment tile_judge.py (qwen3-vl + confetti):
   - **TexTile** (CVPR 2024, `pip install textile-metric`) — differentiable
     no-reference tileability classifier. Validate on pixel art first (trained on
     photographic textures).
   - **CLIP-IQA** (AAAI 2023) — no-reference quality.
   - **SSD-over-overlap** (Efros–Freeman image quilting) — cheap pixel seam error
     across locked edges.
   Keep a POOL of top variants per edge-signature (we already keep 48 grass).
5. **Shared VAE GroupNorm across a batch** (Tiled-VAE trick) to kill per-tile
   brightness/contrast drift when generating a set — the exact discontinuity that
   makes independently-generated tiles not match.

## Turnkey tools worth a look
- **Retro Diffusion RD-Tile** (API, native Wang tileset + transition mode) — the
  pixel-art fidelity leader; trained on licensed art (matters if shipped).
- **PixelLab** — exports Wang / dual-grid-15 / 3×3 tilesets with inner/transition/
  outer prompts.
- **WFC simple-tiled model** (mxgmn/WaveFunctionCollapse) for map assembly from a
  curated tile set + edge adjacencies (guarantees local adjacency, NOT global
  playability — still need connectivity checks).

## Confirmed by the research (already doing)
- k-centroid downscale + master-palette quantization IS the pixel-art step
  (post.py). Palette quantization is the strongest cohesion lever.
- Generate at 4× target res, then downscale — never generate natively tiny.
- Variant pools + rare feature tiles; low-contrast base so sprites pop.

## The genuine gap (novel space)
Mass-generating thousands of pixel-art tiles that lock to a shared dual-grid/Wang
edge scheme, with automated seam+aesthetic curation and an independent "infection"
overlay autotile layer. No turnkey tool does edge-locked *mass* generation with
auto-curation — that's the part to build (on top of exterior-boundary inpainting
+ TexTile/CLIP-IQA scoring).
