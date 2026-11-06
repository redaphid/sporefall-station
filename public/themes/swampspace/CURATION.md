# Sporefall Station (swampspace) — curation & lineage

Fused swamp/space theme: an alien bog overtaking a derelict space station.
Mangrove roots through deck plating, spore drones walking the patrol beat, phosphor
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
| player | vine-ranger | bareheaded, long copper braid, quilted grey liner vest, orange sleeves, caged rust-orange jar at the hip; **full 5-dir idle/step + 8-frame walk**, 2026-09-29, redesigned toward the key art, Wan 2.2 I2V, see below |
| warden | spore-drone | hovering jellyfish-drone, green sensor mass (lockkeeper shares) |
| mutant | bog-mutant | hulking moss-crusted olive brute (boss/acolyte share) |
| scientist | mycologist | pale hazmat, green shoulder pods, sample tube; **full 5-dir idle/step + 8-frame walk**, 2026-09-29, Wan 2.2 I2V, see below |
| robot | derelict-bot | dark boxy machine, orange eye lenses |
| civilian | frog-settler | cloaked swamp frog in a brown hood — **full 5-dir idle/step + 8-frame walk**, 2026-09-25, Wan 2.2 I2V, see below (shopkeeper shares) |

Characters: 48×48, feet bottom-center. The player and **frog-settler** have all
5 drawn directions with 8-frame walk cycles; the other NPCs ship s-idle/s-step and borrow the rest via manifest fallback chains
(`manifest.py` mentions every one of the 70 char keys so nothing falls back to
the settlement theme's human sprites mid-walk).

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

## Floor/causeway macro redesign (fix/floor-tile-structure)

The original interior floors shipped as uniform bright-green speckle over dark
plates ("confetti moss") and the bog repeated identical ripple dash clusters.
Both surfaces were rebuilt by `scripts/assets/tilesets_floor.py`:

- `tile.floor` (8 variants) = two 64px (2×2-tile) macro plates sliced
  row-major, declared via manifest `macroTiles.floor: 2`. Lineage: procedural
  macro (fixed seeds 7000/7001) → SD1.5 img2img (dreamshaper_8, 512px,
  denoise 0.3, seeds 90210/90223, seamless offset+heal) → k-centroid 64 →
  heal to the close-valued FLOOR_FAMILY ramp → `restamp_floor` re-asserts
  seams/rivets/buckled-plate roots. (Denoise 0.4 washed the plates — rejected.)
- `tile.causeway` (12 variants) = three procedural 64px macros (seeds 8000-8002;
  ring / drift / calm — the big ripple bloom lands on ~1/3 of cells). The SD
  pass was A/B'd and REJECTED for causeways: it broke ring containment at macro
  borders and brightened the calm water.
- `tile.floor.overlay` (4 RGBA decals, seeds 9500+37n) — context-placed moss
  (wall bases / corners / door thresholds / plate seams) via
  `src/render/tileSelect.ts planTileOverlays`; art is procedural (clumps with
  dark MOSS_DEEP rims, mass biased to the tile's top edge).
- `floor-accent-{0,1}` rebased onto the plate deck (seeds 9000/9100);
  `causeway-accent-2` is a new lily/scum feature tile (seed 8500).
- Whole-screen judgement shots (seed 11, zoom 0.5/1/2):
  `~/Videos/backseat/floor-redesign-*.png`.

## Rotoscoped walk cycles (feat/rotoscoped-walk)

Superseded 2026-09-29 by the vine-ranger redesign below. All 50 frames of this set per pack are archived at `/mnt/d/tmp/cast-walks/archive/vine-ranger/pre-walk/`.

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

## vine-ranger (player), 2026-09-29: redesigned toward the key art

The owner asked for "a rework to be closer to the hero image", the key art
`sporefall-art/wip/identity/530-poster-wardrobe-fix/painterly_seed412.png` (a
figure on a jetty in a quilted grey heirloom liner, waders, a long pole, a
rust-orange lantern, a copper braid in the prompt). Procedure:
[`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| design | Step 0 redesign, lore family A (salvage caste; canon anchor and motion donor). The next diver in the family line, in the re-sewn liner. Bareheaded with a long copper braid over the right shoulder, quilted grey liner vest, orange sleeves, caged rust-orange jar at the right hip. No pole: the renderer draws the held weapon at the hand |
| candidates | juggernautXL on the ranger's own r2 graph (no IPAdapter, so nothing pulls back the teal suit): 16 stills in two batches, then img2img from the best (4A, seed 882003) with paint-over hints for the braid, jar and sleeve patches, widened 1.18x. R1 (denoise .50, seed 883000) chosen; sheets https://2cb.pw/candidates-d44dd4, https://2cb.pw/refine-46a277 |
| input | `/mnt/d/tmp/cast-walks/vine-ranger/raw3/cast-walks-vine-ranger-refine-d50-s883000_00001_.png`, 768 px rembg matte, sha256 `27b4a0e32708…5d449396`. The old r2 anchor is archived at `/mnt/d/tmp/cast-walks/archive/vine-ranger/anchor-2026-09-29/` |
| keyframes | Qwen-Image-Edit-2511 fp8 + Lightning 4-step + multiple-angles LoRA, one per direction; `--describe` for s/se/e, a face-free `--describe-back` (braid down the back, jar strap) for ne/n |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo, bf16 compute, 848x480, 81 frames at 16 fps, `--motion walk` |
| takes | take1 seed 3 for all five directions; s retaken with seed 11. se, e, ne and n ship from take1, s from take2 |
| loops | the shortest full stride: s period 19 (seam .294), se 25 (.287), e 20 (.288), ne 24 (.353), n 22 (.525) |
| colour lock | `assemble` snaps every frame onto the s-idle's colours, all in the locked 34 |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.player.*`, the only archetype on `vine-ranger` |

Gates (`cast_walk.py gate`), 2026-09-29, all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .294 / .287 / .288 / .353 / .525 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .100-.225, head .059-.096 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Gate 3 first failed the e-idle (mass 34% under the front, centroid 2.33 px
off). The e view is a true side profile, 11 px wide against 21 in front, and a
slim figure in profile keeps about 60% of its front mass. fed84b6 measures a
walk character's side-view poses against their own view's walk frames.

Known nit: the s frames stand 43 px on the 48 px pack against 45-46 in the other
views, because the s retake's keyframe drew the figure about 4% smaller and one
scale covers the sheet. It is inside the height tolerance (3); the old set
varied by 2 px.

## drowned-diver (drowner), 2026-09-29: the shipped design, walking, rifle removed

The raid rank-and-file (`npcs.ts` `drowner`) had one frame, the August hires
s-idle, drawn in every direction. Procedure:
[`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| design | Step 0 kept the shipped design, lore family D (drowned machinery): a security diver's hard suit still walking a patrol nobody rescinded, dark visor, no face. It failed one check: it held a rifle, and the renderer already draws the drowner's pistol at the hand (`weaponArt.ts`), so in play it carried two guns. Coordinator ruling: removing the rifle is a cleanup, not a redesign. Before/after https://2cb.pw/old-vs-new-ef9cf8 |
| input | Qwen-Image-Edit-2511 (Lightning 4-step) removed only the rifle from the NEAREST-upscaled s-idle; 4 seeds, all clean, seed 3 kept. Its blocks were sampled back onto the shipped 96 px grid and snapped to the s-idle's own colours (95% of shared pixels land on the exact old colour). sha256 `00543eb5c23029ea…`. The old s-idle is archived at `/mnt/d/tmp/cast-walks/archive/drowned-diver/anchor-2026-09-29/` |
| keyframes | Qwen-Image-Edit-2511 fp8 + Lightning 4-step + multiple-angles LoRA, one per direction; `--describe` (visor, rust stain on the crown, mould patch on one shoulder pad, air tank) for s/se/e, a face-free `--describe-back` (smooth helmet back, tank between the pads) for ne/n |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo, bf16 compute, 848x480, 81 frames at 16 fps, `--motion walk` |
| takes | take1 seed 3 for all five directions; every direction ships from it |
| loops | the shortest full stride: s period 19 (seam .385), se 24 (.231), e 20 (.21), ne 21 (.411), n 22 (.378) |
| colour lock | `assemble` snaps every frame onto the s-idle's colours, all in the locked 34 |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.drowner.*`, the only archetype on `drowned-diver` |

Gates (`cast_walk.py gate`), 2026-09-29, all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .385 / .231 / .21 / .411 / .378 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .100-.183, head .055-.075 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Nothing parked. Frame heights: 88-92 px on the hi-res pack, 43-46 on the 48 px
pack, every direction.

## blast-diver (breacher), 2026-09-29: the shipped design, walking

The raid's sapper (`npcs.ts` `breacher`) had one frame, the August hires
s-idle, drawn in every direction. Procedure:
[`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| design | Step 0 kept the shipped design, lore family A (salvage caste): the colony's hatch-breacher in the station's heirloom blast hard suit, a huge round charcoal helmet with one orange visor (the single hot accent), tan canvas cuffs. It holds nothing, so no cleanup was needed; the renderer draws its weapon at the hand (`weaponArt.ts`) |
| input | the shipped hires s-idle as is, sha256 `f47c7de3f5bb9ab7…`, archived at `/mnt/d/tmp/cast-walks/archive/blast-diver/anchor-2026-09-29/` |
| keyframes | Qwen-Image-Edit-2511 fp8 + Lightning 4-step + multiple-angles LoRA, one per direction; `--describe` (visor, valve canisters, tan cuffs, belt lights) for s/se/e. ne/n: the first face-free `--describe-back` named no back gear and Qwen drew twin slim tanks that the VLM read as a front view; the second names one upright air tank with two hoses into the helmet, matching the tank the e view drew |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo, bf16 compute, 848x480, 81 frames at 16 fps, `--motion walk` |
| takes | s and e from take1 (seed 3). se take3 (seed 23): take1 turned to face front mid-clip (1.093), take2 missed by .032 (.532). n take3 and ne take2 (seed 11, second back describe) |
| loops | the shortest full stride: s period 17 (seam .356), se 19 (.327), e 22 (.287), ne 24 (.297), n 21 (.679) |
| colour lock | `assemble` snaps every frame onto the s-idle's colours, all in the locked 34 |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.breacher.*`, the only archetype on `blast-diver` |

Gates (`cast_walk.py gate`), 2026-09-29, all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .356 / .327 / .287 / .297 / .679 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .085-.193, head .028-.068 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Gate 4b same was fixed on the way (7046bba): it counted the front's visor
against every back view. Nothing parked. Frame heights: 84-90 px on the
hi-res pack, 42-45 on the 48 px pack.

## cinder-husk (cinder), 2026-11-04: the shipped design, walking, for testing

The burning colonist (`npcs.ts` `cinder`) had one frame, the August hires s-idle,
drawn in every direction. Aaron, 2026-09-29: "fine for now. We can revisit later",
so it ships for testing and gets a redesign later (thin, reads nude, no G1 gear).
Procedure: [`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| design | Step 0 kept the shipped ochre ember husk, lore family C: a still-stoker the ember essence baked hollow. The r2 anchor (a blue ghoul with a flaming skull) does not match the game and was not used. Holds nothing |
| input | the shipped hires s-idle minus two detached 2 px ash specks by the feet, sha256 `12b72416abd1fb81…`, archived at `/mnt/d/tmp/cast-walks/archive/cinder-husk/anchor-2026-09-29/` |
| keyframes | Qwen-Image-Edit-2511 fp8 + Lightning 4-step + multiple-angles LoRA, one per direction; `--describe` for s/se/e, face-free `--describe-back` for ne/n. The first back describe put a bright glow on the rump; the second moves the cracks to the shoulders and back |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo, bf16 compute, 848x480, 81 frames at 16 fps, `--motion walk` |
| takes | s, ne and n from take2 (seed 11). se take3 (seed 23): take1 .753, take2 .741. e take2 (seed 11): take1 looped at .268 but its keyframe drew an orange crest and a long beak the other views lack |
| loops | the shortest full stride: s period 18 (seam .395), se 20 (.343), e 23 (.314), ne 20 (.438), n 21 (.892) |
| colour lock | `assemble` snaps every frame onto the s-idle's colours, all in the locked 34. After export, `runs/cinder-husk/shins.py` moves the ne/n shins one ramp step darker, below 55% of the height, to match s/se/e (2126 px at 96, 568 at 48) |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.cinder.*`, the only archetype on `cinder-husk` |

Gates (`cast_walk.py gate`), 2026-11-04, gate 938319cdcc807028 (G7), all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .395 / .343 / .314 / .438 / .892 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .108-.185, head .043-.089 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Nothing parked. Frame heights: 84-91 px on the hi-res pack, 41-45 on the 48 px
pack. Known look gaps, left for the redesign: the back views' head is a round ball
where s and se draw a tall egg, the e head keeps a short snout, the crown spike is
missing from n-idle only, and ne/n shoulder cracks tick a pixel or two past the outline.

## bellwether, 2026-11-05: redesigned (yellow marshal), walking, ne by skeleton control

The raid's marshal (`npcs.ts` `bellwether`: kill it and the raid routs) had
one frame, the August hires s-idle, drawn in every direction. Procedure:
[`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| design | Step 0 redesign. The shipped s-idle held a blade (lore check 4), and the first concept (glare-marshal) vanished on the game floor at 96 px. Lore family A (salvage caste): the raid's marshal in faded hazard-yellow plate (§8.1 trade paint), a black gas mask with one orange lens band (the single hot accent), a small brass hand bell under the belt, and a flat charcoal air pack on the back. It holds nothing; the renderer draws its weapon (`weaponArt.ts`) |
| input | concept yellow-marshal redrawn by `concept_to_input.py` (Qwen-Image-Edit, seed 11 of 4), sha256 `4eec320445b51be6…`; old anchors archived at `/mnt/d/tmp/cast-walks/archive/bellwether/` |
| keyframes | Qwen-Image-Edit-2511 + Lightning 4-step + multiple-angles LoRA, one per direction. e and se retaken with a describe that names the charcoal pack and says it is never yellow; ne/n use a face-free `--describe-back` |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo, 848x480, 81 frames at 16 fps, `--motion walk`, for s, se, e, n. ne: Wan Fun-Control driven by a stick-skeleton biped walk rig (`scripts/assets/rotoscope/fun_control.py`), seed 23, on the take3 ne keyframe mirrored to face right like every shipped ne |
| takes | s and n take1 (seed 1004). se take3 (seed 3, the pack describe; take1 .431 and take2 .265 came before the pack fix). e take2 (seed 3). ne: three Wan takes failed (1.563 / .749 / 1.066), then the skeleton route (skel1) |
| loops | the shortest full stride: s period 17 (seam .483), se 25 (.386), e 17 (.241), ne 20 (.136), n 21 (.755) |
| colour lock | `assemble` snaps every frame onto the s-idle's colours, all in the locked 34 |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.bellwether.*` |

Gates (`cast_walk.py gate`), 2026-11-05, gate 938319cdcc807028 (G7), all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .483 / .386 / .241 / .136 / .755 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .108-.199, head .048-.072 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Nothing parked. Known look gap: the n view (take1) draws a narrower, flatter
dark back panel than the deep charcoal pack that e and ne show. Frame
heights: 85-92 px on the hi-res pack, 42-46 on the 48 px pack.

## sporeling-mite, 2026-11-05: the shipped design, walking, ne by skeleton control

The hive-spire's budded vermin (lore family B swamp fauna). Step 0 kept the
shipped hires s-idle. Procedure:
[`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| input | shipped hires s-idle, sha256 `a9c061414e793800…`; archived at `/mnt/d/tmp/cast-walks/archive/sporeling-mite/anchor-2026-09-29/` |
| keyframes | Qwen-Image-Edit-2511 + Lightning 4-step + multiple-angles LoRA. s, se and e from take1/take2. ne and n were redrawn (kf2) from the s keyframe with a face-free back describe so they keep the mossy mottled cap and star spot: ne seed 3, n seed 3 |
| motion | Wan 2.2 I2V A14B Q4_K_M hi/lo, 848x480, 81 frames at 16 fps, `--motion walk`, for s, se, e, n. ne: Wan Fun-Control driven by a stick-skeleton biped waddle rig fitted to the kf2 ne keyframe (`scripts/assets/rotoscope/rig_biped.py`, `fun_control.py`), seed 3, period 18 |
| takes | s and se take1 (seed 3). e take2 (seed 11; take1 .573). n kf2 (seed 3). ne: take1 (.262) was held as a different render (smooth highlighted cap); take2 .615. On the kf2 keyframe seeds 3, 11 and 23 (.377, .527, .228), then a kf3 keyframe (.853), failed the VLM figure read under 1 px shifts (10/40, 8/40, 10/40, 4/40). The skeleton take (skel1) fails 0/40 |
| loops | the shortest full stride: s period 17 (seam .267), se 16 (.391), e 24 (.487), ne 18 (.325), n 17 (.308) |
| height lock | `assemble --lock-height`: each direction scaled so its idle stands as tall as the s idle |
| colour lock | `assemble` snaps every frame onto the s-idle's colours, all in the locked 34 |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.sporeling.*` |

Gates (`cast_walk.py gate`), 2026-11-05, gate 938319cdcc807028 (G7), all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .267 / .391 / .487 / .325 / .308 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .133-.206, head .044-.138 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Nothing parked. The skeleton ne row takes small steps with the feet held
apart; it never crosses its legs. Frame heights: 87-92 px on the hi-res pack,
43-46 on the 48 px pack.

## gloom-lurker (lurker), 2026-11-05: redesigned (feral hooded colonist), prowling, se/e/ne by skeleton control

The ambusher (`npcs.ts` `lurker`: spawns inert, wakes on a stimulus and
pounces) had one frame, the August hires s-idle, drawn in every direction.
Procedure: [`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md).

| stage | what |
|---|---|
| design | Step 0 redesign from concept textile-tailor. Lore family C: a colonist in a sealed black-teal rubber hood and loose coverall gone feral, crouched dormant in dark stockrooms until a body strays close. One lit essence-green visor (the single hot accent) on s/se/e; ne/n are faceless backs with a faded canvas patch. Holds nothing |
| input | concept redrawn by `concept_to_input.py` (Qwen-Image-Edit, seed 3 of 4), suit ramp one step darker and visor snapped to essence green (`/mnt/d/tmp/cast-walks/gloom-lurker/tools/tune.py`), sha256 `c0cf35ddea088872…` |
| keyframes | Qwen-Image-Edit-2511 + Lightning 4-step + multiple-angles LoRA, one per direction; coverall describes (no muscle read), face-free `--describe-back` for ne/n. s from a narrow-stance describe (seed 13) so its head and mass match the walk. ne: the take2 keyframe with the charcoal hood-front edge recoloured to suit teal (3297 px at 1280x720, outline kept) so the back view carries no face-like dark mass |
| motion | s and n: Wan 2.2 I2V A14B Q4_K_M hi/lo, 848x480, 81 frames at 16 fps, `--motion prowl`. se, e, ne: Wan Fun-Control driven by the stick-skeleton biped rig (`scripts/assets/rotoscope/rig_biped.py`, period 24, crouch kept), because Wan's prowl lunged its limbs past gate 5's match window (boil se .846, e 1.372, ne .800) |
| takes | s take3 (seed 13); n take2 (seed 3). e: Wan take2 .539, take3 .504, take4 .221 (boil 1.372), then skel1 (seed 3) on the take4 keyframe. se: Wan take2 (boil .846), then skel1 (seed 3). ne: Wan take2 (boil .800), skel1 (seed 3; one frame failed gate 4a), then skel2 (seed 11) on the recoloured keyframe |
| loops | the shortest full stride: s period 13 (seam .495), se 24 (.135), e 24 (.137), ne 24 (.129), n 13 (.561) |
| colour lock | `assemble --lock-height` snaps every frame onto the s-idle's colours, all in the locked 34, and scales each direction's idle to the s idle's height |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.lurker.*` |

Gates (`cast_walk.py gate`), 2026-11-05, gate 938319cdcc807028 (G7), all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .495 / .135 / .137 / .129 / .561 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | boil .150-.239, head .016-.136 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Nothing parked. Known look gaps: s and n are Wan clips with short strides
(period 13) and sit close to their limits (s seam .495 of .5, n head drift
.136 of .14); se/e/ne are skeleton-driven and step more evenly than s/n. Frame
heights: 84-91 px on the hi-res pack, 42-46 on the 48 px pack.

## carapace-brute (brute), 2026-11-05: design kept, trotting on four legs by skeleton control in all 5 directions

The armoured quadruped (`npcs.ts` `brute`) had one frame, the August hires
s-idle, drawn in every direction. The design is kept: a bone-tan ridged shell
over head and shoulders, dark teal mottled hide, a teal flank plate with brass
trim, a tufted tail, tan claws. Procedure:
[`docs/cast-walks/RUNBOOK.md`](../../../docs/cast-walks/RUNBOOK.md) and the
quadruped route in `docs/cast-walks/PIPELINE-NONBIPED.md`.

| stage | what |
|---|---|
| design | kept as shipped (no redesign on this run); a beast that holds nothing |
| input | the shipped `carapace-brute-s-idle.png`, sha256 `113a1d81630bda3e…` |
| keyframes | Qwen-Image-Edit band only (`scripts/assets/rotoscope/keyframe_probe.py`), one still per direction from the s-idle. s: an all-fours describe (the head-on one drew an upright biped on 3 of 3 seeds), seed 3. se seed 3. e: the pipeline proof's seed 3. ne/n: a face-free back describe naming the ridged shell (the first round drew a smooth dome and gave n 24% less mass); ne seed 3 drawn facing upper left and mirrored, n seed 11. The tail and its tuft are the rear cue, inside the silhouette |
| motion | Wan 2.2 Fun-Control A14B driven by a stick skeleton of a diagonal-pair trot (`scripts/assets/rotoscope/rig_quadruped.py`, period 16, half stride 40 px, lift 28 at 848x480; n half stride 50, lift 44; e by `rig_quadruped_side.py`), keyframe as `ref_image`, seed 3 |
| takes | s take1, se take1, e the proof take (fc-brute-e-s3), ne take2 (ridged-shell keyframe), n take3 (ridged-shell keyframe, longer stride: foot lift 2.9 px -> 4.4 px at 96) |
| loops | period 16 in every direction: s .129, se .112, e .103, ne .113, n .125 |
| colour lock | `assemble` snaps every frame onto the s-idle's colours, all in the locked 34 |
| backdrop | `spritesheet.py` keys the backdrop the legs enclose in the lower 40% of the silhouette, and flat backdrop anywhere (`pocket_key`, `POCKET_FLAT`); the shell's pale highlights had switched pocket keying off for this kind |
| hind legs | after export, `/mnt/d/tmp/cast-walks/runs/carapace-brute-1105/tools/hindlegs.py` moves the hide ramp one step lighter in the rear hind-leg box below the belly of s/se/e/ne ((35,40,46) -> (22,58,62) -> (36,86,92) -> (58,122,128); outlines and claws kept): 13671 px at 96, 4137 at 48 |
| export | 96 px (content 92) to `swampspace-hires`, 48 px (content 46) to `swampspace`, feet on canvas-2; 50 keys for `char.brute.*` |

Gates (`cast_walk.py gate`), 2026-11-05, gate 938319cdcc807028 (G7), all PASS (9/9):

| # | gate | result |
|---|---|---|
| 1 | loop seam, max .5 (n 1.0) | .129 / .112 / .103 / .113 / .125 |
| 2 | colour drift vs s-idle, max 1% | 0 in every direction |
| 3 | silhouette spec | 0 violations |
| 4a | VLM view of every frame, against its own s-idle and n-idle | 0 of 50 fail |
| 4b | VLM idle/step pairs; identity vs s-idle | 0 of 5; 0 of 9 |
| 5 | judge identity, sharpness and coverage; boil max .3; head drift max .14 | identity .024-.058, boil .100-.197, head .030-.070 |
| 6 | VLM style vs the frog, rendering only | 0 of 10 |
| 6b | pixels off the locked palette, max 0 | 0.0 |

Nothing parked. Gait at 96 px (`gait_measure.py`, first-harmonic foot lift):
s 6.8, se 8.1, e 4.4, ne 8.7, n 4.4 px, legs out of phase in every direction
(phase_R .05-.20). Known look gaps: the s view is a three-quarter front turned
to the left, as the shipped s-idle was; its hind legs stay in the belly's
shadow. Frame heights: 68-77 px on the hi-res pack, 34-38 on the 48 px pack.
