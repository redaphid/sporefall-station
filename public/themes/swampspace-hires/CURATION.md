# Sporefall Station (swampspace) — curation & lineage

Fused swamp/space theme: an alien bog overtaking a derelict space station.
Mangrove roots through deck plating, spore drones instead of cops, phosphor
water, overgrown tech. Art direction: dominant-color study of *Flashback*
(Amiga 1992) Titan jungle — teal mist, olive overgrowth, tan/gray tech, hot
accents (inspiration only; no Flashback art used as input or reproduced).

Pipeline guide (setup, scripts, techniques): `docs/sprite-generation.md`.

## Numbers

- 47 shipped sprites: 20 character frames (6 cast members), 2 seamless tiles,
  6 props, 8 items, 11 FX/projectiles.
- 36 are curated diffusion picks from ~384 staged sweep candidates
  (~9% acceptance); 11 FX are deterministic procedural PIL drawings.
- Three whole sweep rounds were rejected outright and re-prompted: NPC s-idles
  (cast-anchor weight 0.8 turned everyone into player clones), items
  (environment IPAdapter refs turned weapons into mushrooms), and diffusion FX
  (gray scene remnants on "pure black background" prompts).

## How each asset was chosen

Every diffusion asset came from a **seed sweep** (4–16 candidates), reviewed
at final sprite size on contact sheets, gated by the VLM verifier
(`scripts/assets/verify.py`, qwen3-vl: anthropomorphism/perspective/facing per
asset, `--pairs` idle-vs-step pose consistency, `--style` pack-wide style
match against anchor sprites), and the winner's exact lineage recorded in
`scripts/assets/curation.json` (`{seed, batch, index, raw, size, ckpt}` —
regenerate any pick with `python3 scripts/assets/generate.py final <job>`).

Two generator configurations (recorded per pick in `curation.json`):

- **SDXL** `juggernautXL_juggXIByRundiffusion` + skormino pixel LoRA @768–1024
  — tiles, props, the ranger's 10 poses, spore-drone idle and the r2 cast.
  (This line named `AnythingXL_xl` until **2026-09-25**. That was stale, and
  the art disagrees with it: of the 26 raws in `scripts/assets/raws/` that
  still carry their ComfyUI graph, 20 are juggernautXL and 6 are anything-xl —
  the 2026-07 figures only. The anime base is **superseded**; `curation.json`
  records the real checkpoint per pick.)
- **SD1.5** `dreamshaper_8` @512 (no LoRA — it's SDXL-only) — NPC cast,
  items, wall tile, all step frames. Adopted when resident VLM models on the
  shared GPU pushed SDXL into 30-min lowvram batches. The k-centroid +
  locked-palette post-pass keeps both sets in one visual register.

All curated sprites are quantized to the locked 34-color Flashback-derived
palette (`scripts/assets/palette.py`), no dither, hard alpha.

## Cast

| archetype | kind | notes |
|---|---|---|
| player | vine-ranger | teal EVA suit, amber cap-visor, vine arm — full 5-dir × idle/step set |
| cop | spore-drone | hovering jellyfish-drone, green sensor mass (bouncer shares) |
| thug | bog-mutant | hulking moss-crusted olive brute (boss/gangster share) |
| scientist | mycologist | pale hazmat, green shoulder pods, sample tube; **full 5-dir idle/step + 8-frame walk**, 2026-09-29, Wan 2.2 I2V, see below |
| robot | derelict-bot | dark boxy machine, orange eye lenses |
| civilian | frog-settler | cloaked swamp frog in a brown hood — **full 5-dir idle/step + 8-frame walk**, 2026-09-25, Wan 2.2 I2V, see below (shopkeeper shares) |

Characters: 48×48, feet bottom-center. The player and **frog-settler** have all
5 drawn directions with 8-frame walk cycles; the other NPCs ship s-idle/s-step and borrow the rest via manifest fallback chains
(`manifest.py` mentions every one of the 70 char keys so nothing falls back to
the city theme's human sprites mid-walk).

**Step frames are img2img from that direction's curated idle** (denoise 0.38,
prompt delta only "mid-stride, one leg forward") — txt2img steps flickered
like costume changes against their idles in the walk cycle.

## Known compromises

- `item.root-club` is the weakest sprite in the pack (dark, low silhouette
  readability at 19 px display size); two re-prompt rounds didn't beat it.
- The ranger's amber "visor" reads as an amber cap in most poses; kept — it is
  consistent across all 10 poses and reads at gameplay zoom.
- `tile.root-bulkhead` seam energy 8.6 (deck-moss 3.9) — visible texture
  variance when tiled in long runs, acceptable at gameplay zoom (see
  `docs/assets/swampspace/tiling-root-bulkhead.png`).
- NPC non-south directions are manifest borrows of the south sprites (engine
  mirrors/billboards); real per-direction NPC art is the natural next
  increment, one `sweep` per pose with the anchors already in
  `scripts/assets/anchors/`.

- VLM gate status at ship time: per-sweep gating ran during curation
  (facing/anthropomorphism spot checks); the final whole-pack `--pack` /
  `--pairs` / `--style` batch run was blocked by other tenants monopolizing
  the shared qwen3-vl instance and should be re-run when the GPU frees:
  `cd scripts/assets && python3 verify.py --pack && python3 verify.py --pairs
  && python3 verify.py --style`. Every shipped sprite WAS human-reviewed on a
  final-size contact sheet; pair consistency is enforced by construction
  (steps are low-denoise img2img from their idles).

Contact sheets: `docs/assets/swampspace/{pack,tiles,chars,props,items,fx}.png`;
in-game capture: `docs/assets/swampspace/ingame-swampspace.png`.

## Floor/street macro redesign (fix/floor-tile-structure)

The original interior floors shipped as uniform bright-green speckle over dark
plates ("confetti moss") and the bog repeated identical ripple dash clusters.
Both surfaces were rebuilt by `scripts/assets/tilesets_floor.py`:

- `tile.floor` (8 variants) = two 64px (2×2-tile) macro plates sliced
  row-major, declared via manifest `macroTiles.floor: 2`. Lineage: procedural
  macro (fixed seeds 7000/7001) → SD1.5 img2img (dreamshaper_8, 512px,
  denoise 0.3, seeds 90210/90223, seamless offset+heal) → k-centroid 64 →
  heal to the close-valued FLOOR_FAMILY ramp → `restamp_floor` re-asserts
  seams/rivets/buckled-plate roots. (Denoise 0.4 washed the plates — rejected.)
- `tile.street` (12 variants) = three procedural 64px macros (seeds 8000-8002;
  ring / drift / calm — the big ripple bloom lands on ~1/3 of cells). The SD
  pass was A/B'd and REJECTED for streets: it broke ring containment at macro
  borders and brightened the calm water.
- `tile.floor.overlay` (4 RGBA decals, seeds 9500+37n) — context-placed moss
  (wall bases / corners / door thresholds / plate seams) via
  `src/render/tileSelect.ts planTileOverlays`; art is procedural (clumps with
  dark MOSS_DEEP rims, mass biased to the tile's top edge).
- `floor-accent-{0,1}` rebased onto the plate deck (seeds 9000/9100);
  `street-accent-2` is a new lily/scum feature tile (seed 8500).
- Whole-screen judgement shots (seed 11, zoom 0.5/1/2):
  `~/Videos/backseat/floor-redesign-*.png`.

## Rotoscoped walk cycles (feat/rotoscoped-walk)

`char.player.<dir>-walk-0..7` — 40 frames, `chars/vine-ranger-<dir>-walk-<n>.png`,
built by `scripts/assets/rotoscope/` (docs/sprite-generation.md §6):

- Motion source: fully procedural Blender proxy (`rig_walk.py`, no external
  rig/mesh — license-clean by construction), 4-keypose 8-frame stride with
  FK-grounded feet, rendered headless on `soul` (Blender 5.0.1, EEVEE,
  1024px, ortho elev 14°), 5 dirs; e/ne face right (west engine-mirrored).
- Trace: ComfyUI img2img denoise 0.35, seed 414977 for all 40 frames,
  IPAdapter anchor `anchors/vine-ranger-s-idle.png` (weights s .8 / se .7 /
  e .55 / ne .5 / n .5), SD1.5 low-VRAM path (dreamshaper_8 @512 — A/B'd
  indistinguishable from SDXL at 48px after palette lock; run tag `sd15a`).
- Post: Blender-alpha masking (no per-frame rembg flicker), one fixed crop
  window for all 40 frames (no scale pumping), cap-region signature-color
  rescue, k-centroid -> 34-color palette -> 48px, temporal mode-smoothing.
- Gates (`gate.py`): palette/alpha/feet determinism + adjacent-frame
  coherence (deltas at/below the pure-3D control floor) + palette-histogram
  flicker + qwen3-vl facing & same-character contracts.
- Film strips: `docs/assets/swampspace/rotoscope-walk-<dir>.png`; in-game
  proof `~/Videos/backseat/roto-walk-swampspace.mp4` (before:
  `roto-walk-before-2frame.mp4`). Manifest cadence `anim.walk: 4`.

## Indoor complex tiles (floors 3+)

`hall grate tiled plating hull bog` (+ accents) come from
`scripts/assets/tiles_indoor.py` — deterministic procedural pixel art on the
locked palette plus 7 interpolated indoor steps (`INDOOR_EXTRA`), ordered-dither
transitions, structure (seams, grout, rivets) aligned to tile edges so every
variant meets every other. The ComfyUI img2img repaint is still wired in (drop
`--procedural`) but lost to the procedural pass at every denoise tried:
≤0.4 changed nothing after the palette snap, ≥0.55 erased the moss and added
speckle. Previews: `docs/assets/indoor-tiles/` (via `dump_complex_levels.mts`
+ `indoor_preview.py`).

## frog-settler, 2026-09-25 — the video route (cyber-puck's framework)

The frog is the first character in this pack animated by a **video model**
rather than by independently-sampled per-frame SDXL. Per-frame sampling has no
temporal coherence by construction (`docs/sprite-pipeline-wan.md`); a video
model emits frames that are coherent with each other.

Framework: **`D:\projects\puck-sprites`** (cyber-puck's, approved 2026-09-22),
driven in place — nothing was forked into this repo. Full procedure and the
failures it cost: [`docs/sprite-cast-runbook.md`](../../../docs/sprite-cast-runbook.md).

| stage | what |
|---|---|
| keyframes | Qwen-Image-Edit-2511 fp8 + Lightning 4-step, 1280×720 on white, one per direction, from the curated `anchors/frog-settler-s-idle.png` |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo + lightx2v 4-step, bf16 compute, 848×480, 81 frames @16 fps, seed 3 |
| matte | `premat.py --shrink 1` (border-connected white matte; a chroma key punches holes in pale chest/cloak) |
| cut | `video2atlas.py --pixel --sprite-height 96 --frames 8 --lens-guard 0`, forced to a FULL stride |
| post | white-speck inpaint + this pack's locked 34-colour palette |

Loop seams, relative to an ordinary frame step (under 1.0 = the seam is
smoother than a normal step): s 0.42 (period 45), se 0.48 (38), e 0.16 (48),
ne 0.34 (54), n 0.37 (45).

The **cloak is deliberate** — the owner approved it on the turnaround. It made
the committed silhouette spec wrong, because that spec was measured off the
old bare-headed front frog; `consistency-spec.json` is re-anchored on
`se-idle`, whose build sits on the median of all ten pose frames.

## mycologist, 2026-09-29: the video route in this repo

The second video-route character, and the first made with this repo's own
tools (`spritesheet.py --method video`, then `scripts/assets/cast_walk.py`
assemble, export and gate) rather than puck-sprites. Procedure:
[`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| design | Step 0 kept the r2 in-game design: cream hazmat suit, teal visor and gloves, brown pack |
| input | `D:\tmp\sprite-stage-0822\cast\anchors\mycologist-s-idle.png`, the 768 px matted r2 anchor, sha256 `fd3fecb93f70…98128f`. Not `scripts/assets/anchors/mycologist-s-idle.png`, which is the older dark-green hooded July design |
| keyframes | Qwen-Image-Edit-2511 fp8 + Lightning 4-step + multiple-angles LoRA, one per direction |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo, bf16 compute, 848×480, 81 frames at 16 fps |
| takes | take1 seed 3 for all five directions; n retaken with seed 11 and seed 23. s, se, e and ne ship from take1, n from take2 |
| loops | the shortest full stride: s period 24 (seam .434), se 18 (.254), e 20 (.177), ne 18 (.398), n 15 (.559) |
| colour lock | `assemble` snaps every frame onto the s-idle's 16 colours, all of them in the locked 34. Take1 drew the visor green in s and cyan in e |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.scientist.*` |

n, the back view, failed the 0.5 seam on all three takes (.791, .559, .91).
The owner set n's limit to 1.0 on 2026-09-29, and take2 ships.

Gates (`cast_walk.py gate`, thresholds in `scripts/assets/cast-gate-spec.json`),
2026-09-29, all PASS in 194 s:

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .434 / .254 / .177 / .398 / .559 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .108-.173, head .070-.121 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Gates 4a, 5 and 6 were re-measured during this run (b981cbb, 1272b21):
their first version failed art that is right, and the approved frog failed
gate 5 as well. `scripts/assets/cast_gate_selftest.py` holds the controls
each gate must still catch.
