# Rule 14 case: gate 3's head block on a quadruped front view (gloam-hound)

Status: **proposed, not applied**. The gate is unchanged (938319cdcc807028, G7). The case was written by the gloam-hound worker on 2026-11-05.

## Symptom

The gloam-hound trot (branch `art/gloam-hound-1105`, export c5a9ff58) passed 8 of 9 gates. It failed only gate 3, the build check:

> the 'walk' frames are a DIFFERENT BUILD from the 's-idle' reference: head_h 28 vs 33 (limit `FAMILY_TOL.head_h` 4)

The run log is `/mnt/d/tmp/cast-walks/gloam-hound/gate.log`. The other 8 gates passed: seams .107-.595, colour 0, 4a 0/50, 4b 0/5 and 0/9, judge boil .135-.295, style 0/10, palette 0.

## Measurement

`consistency.metrics().head_h` finds the widest row in the top 45% of the figure (`HEAD_ZONE`) and sets a cut at 55% of that width (`HEAD_CUT`). It returns the length, from the top, of the first run of rows at or above the cut.

On the gloam-hound s-idle at 48 px (34 rows tall), the top 45% holds only the dome head, at most 20 px wide. The cut is therefore 11 px, and every row below the head is wider than that: shoulders, chest, then four splayed legs. The run continues to the feet, so head_h = **33 of 34 rows (0.97)**. The number measures where the feet end, not where the head ends.

The build check compares that one front-view number with the median over all five views' walk frames. For this body the views measure:

| view | head_h per walk frame (48 px) |
|---|---|
| s (front) | 31-33 |
| se | 20-31 |
| e (profile) | 16-17 |
| ne | 28 |
| n (back) | 7 or 26-28 |

The median is 27.5. The front view sits 5.5 rows above it only because of how the run is cut, not because the build differs. The gate's own VLM identity check (4b same, 0 of 9 fail) and the contact sheet show one creature.

## Controls: shipped s-idles (48 px pack, same metric)

| kind | head_h / height | walk median | gap |
|---|---|---|---|
| bellwether | 30/44 (.68) | 30.0 | +0.0 |
| blast-diver | 31/45 (.69) | 30.0 | +1.0 |
| cinder-husk | 7/43 (.16) | 7.0 | +0.0 |
| drowned-diver | 31/45 (.69) | 31.5 | -0.5 |
| frog-settler | 38/44 (.86) | 42.0 | -4.0 (at the limit) |
| gloom-lurker | 32/43 (.74) | 31.0 | +1.0 |
| mycologist | 36/45 (.80) | 37.0 | -1.0 |
| sporeling-mite | 20/44 (.45) | 20.0 | +0.0 |
| vine-ranger | 28/43 (.65) | 28.5 | -0.5 |
| **gloam-hound** | **33/34 (.97)** | **27.5** | **+5.5** |

On the shipped cast, head_h covers between .16 and .86 of the figure, so it reads as "head" on almost none of them. It still passes them because an upright biped has the same profile from every side. The approved frog already sits at the limit (-4.0), and it is the only other body that splays wide.

## Evidence that shaping the art to pass is worse

Lowering the head into the shoulders does pass the check: the s head band squashed to 0.70, so the shoulders fall inside the top 45%, measures head_h 25-26 and 0 violations on CPU. It is a worse drawing:
- At 96 px beside se/e/ne/n, the dome shrinks next to the big round head every other view draws.
- The teal ribs crowd up into a collar around the mouth.
- Aaron likes the orange dome, and this version loses it.

The same candidate also had to be mirrored to keep gate 3's cx check, which is a second step taken only to fit a metric. Neither was shipped.

- Comparison at 96 px: https://2cb.pw/s-head-compare-813f54 (`/mnt/d/tmp/cast-walks/gloam-hound/s-head-compare.png`)
- Squash variants: https://2cb.pw/sq-montage-20ea29

## Proposed change (for Aaron)

Compare head_h only between frames drawn from the same view, as `VIEW_DEPENDENT` already does for `width` and `head_h` in the per-frame envelope. The family build check (`FAMILY_TOL`) would check head_h per direction against that direction's own idle, and keep its cross-view checks on height and mass.

Expected effect: the shipped cast keeps passing. Their per-view gaps are small, and the check would have to be re-run on all of them plus `consistency_selftest.py` and `cast_gate_selftest.py` before any entry lands. The negative control (a walk set that is a different build) is still caught by height and mass, and by head_h within a view.

Approved-by:
