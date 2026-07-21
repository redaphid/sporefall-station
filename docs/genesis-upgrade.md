# Genesis-grade graphics upgrade (hires-assets branch)

Goal: bring the hi-res swampspace pack from "murky and small" to something a
Sega Genesis art director would ship — readable value separation between every
pair of touching surfaces, a bigger outlined character that never blends into
the ground, chunkier lower-frequency tile detail, and the rotoscoped walk
cycles kept.

## Measured "before" (2026-07-21, `scripts/assets/contrast_audit.py`)

| pair | contrast ratio | verdict |
|---|---|---|
| wall vs floor | **1.14** | invisible — interiors read as one dark mass |
| floor vs exit | **1.02** | the exit pad is literally invisible indoors |
| street vs sidewalk | 1.18 | curb barely reads |
| street vs grass | 1.27 | weak |
| vine-ranger vs street | lum 84 vs 79 | character blends into the road |

Baseline screenshots: `e2e/scene-shots.mjs` (`PREFIX=before`), committed under
`docs/art/genesis-upgrade/`.

## The plan

1. **Contrast gate** — `scripts/assets/contrast_audit.py` is the machine check;
   targets ≥1.7 wall/floor, ≥1.6 floor/exit, ≥1.3 street/sidewalk, ≥28 lum
   points between any character and any ground it can stand on. The upgrade is
   not done until it exits 0.
2. **Value plan (Genesis logic)** — each surface gets its own value band:
   walls darkest (raised, bright top-edge highlight), interior floor mid-value
   warm deck plating, street dark cool asphalt, sidewalk light neutral, grass
   mid saturated green with chunky low-frequency clusters, exit a hot
   bioluminescent pad.
3. **Character scale** — CHAR_PX 48 → 64 over 32px tiles (2 tiles tall, was
   1.5): Genesis-era top-down proportions. Render-layer only; sim untouched.
4. **Character separation** — 1px dark outline baked into every character
   frame (post-process), brighter/saturated re-trace of the rotoscoped walk
   frames via the depth-ControlNet pipeline; keep the cycle timing.
5. **Tiles** — regenerate via ComfyUI with per-surface value-band prompts +
   palette quantization; gate with the audit; curate winners.
6. **Props/items/FX** — outline + value-check pass so pickups pop.
7. **Before/after deliverable** — same scene-shot coordinates re-captured, plus
   walk-cycle GIFs; committed alongside the befores.

Scene rig: `e2e/scene-shots.mjs` — teleports the player through hand-picked
tile situations (street junction, interiors, park edge) and screenshots each.
