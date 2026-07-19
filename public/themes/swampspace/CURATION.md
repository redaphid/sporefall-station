# Sporefall Station (swampspace) — curation & lineage

Fused swamp/space theme: an alien bog overtaking a derelict space station.
Mangrove roots through deck plating, spore drones instead of cops, phosphor
water, overgrown tech. Art direction: dominant-color study of *Flashback*
(Amiga 1992) Titan jungle — teal mist, olive overgrowth, tan/gray tech, hot
accents (inspiration only; no Flashback art used as input or reproduced).

## How each asset was chosen

Every diffusion asset came from a **seed sweep** (4–16 candidates), reviewed
at final sprite size, gated by a VLM verifier (`scripts/assets/verify.py`,
qwen3-vl majority vote: props must not read as figures, floors must read
top-down, back-facing character poses must not show a face), and the winner's
exact lineage recorded in `scripts/assets/curation.json`
(`{seed, batch, index, raw}` — regenerate any pick with
`python3 scripts/assets/generate.py final <job>`).

- Generator: SDXL `AnythingXL_xl` + skormino pixel-art LoRA (SDXL/Illustrious),
  CFG 3.5 euler 28 steps @1024, IPAdapter style anchoring
  (`scripts/assets/anchors/`), k-centroid downscale, locked 34-color palette
  (`scripts/assets/palette.py`), no dither, hard alpha.
- Tiles are generated with a half-offset + img2img-heal pass (seamless by
  construction); tiling proofs live in `docs/assets/swampspace/tiling-*.png`.
- Sparse particle FX (hit spark, pickup sparkle, ichor splat, spore bolt,
  spore pod) are deterministic PIL drawings (`scripts/assets/procedural.py`) —
  diffusion reliably hallucinates figures into sparse particle prompts.
- Raw sweeps are NOT committed (staging under `$SWAMPSPACE_STAGE`).

## Cast

| archetype | kind | notes |
|---|---|---|
| player | vine-ranger | teal EVA suit, amber visor, vine-wrapped arm |
| cop | spore-drone | hovering pod drone, green sensor eye (bouncer shares) |
| thug | bog-mutant | hulking moss-crusted brute (boss/gangster share) |
| scientist | mycologist | pale hazmat, green faceplate, mushroom vials |
| robot | derelict-bot | rusted tracked maintenance unit |
| civilian | frog-settler | squat frog alien in poncho (shopkeeper shares) |

Each character: 5 drawn directions (s se e ne n; west mirrored by engine) ×
idle/step, 48×48, feet bottom-center. The character's curated `s-idle` is the
IPAdapter anchor for its other nine poses (weight 0.7–0.8 for front poses,
0.5–0.55 for away poses so the anchor doesn't fight the facing prompt — at 0.8
a "cast anchor" turned every NPC into a player clone; NPC identity is enforced
with per-kind negative prompts against the ranger's signature).

## Known compromises

- `tile.root-bulkhead` reads more "overgrown stone courses" than "roots over
  hull metal"; best of 20 candidates, seam energy 10.8 (deck-moss: 3.9).
- The ranger's amber "visor" drifted to an amber cap in most poses; kept — it
  is consistent across the set and reads at gameplay zoom.
- Props share a gray-teal body palette; silhouettes carry the differences.

Contact sheets: `docs/assets/swampspace/{pack,tiles,chars,props,items,fx}.png`.
Regeneration guide: `docs/swampspace-theme.md`.
