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

- **SDXL** `AnythingXL_xl` + skormino pixel LoRA @1024 — tiles, props, the
  ranger's 10 poses, spore-drone idle.
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
| scientist | mycologist | pale hazmat, green shoulder pods, sample tube |
| robot | derelict-bot | dark boxy machine, orange eye lenses |
| civilian | frog-settler | squat frog in rope-belted poncho (shopkeeper shares) |

Characters: 48×48, feet bottom-center. The player has all 5 drawn directions;
NPCs ship s-idle/s-step and borrow the rest via manifest fallback chains
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
