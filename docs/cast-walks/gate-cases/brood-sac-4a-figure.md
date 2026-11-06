# Rule 14 case: gate 4a's "does not read as a figure" on the brood-sac (an egg-sac by design)

Status: **proposed, not applied**. The gate is unchanged (938319cdcc807028, G7). Written by the brood-sac worker on 2026-11-06.

## Symptom

The root-walker brood-sac (branch `art/brood-sac-1106`, export 5e456e76) passed 8 of 9 gates on its one gate run. It failed only 4a, 39 of 50 frames (s 5, se 7, e 8, ne 9, n 10).

Passed: seams s .130, se .104, e .119, ne .116, n .126; colour 0; spec 0 violations; 4b pairs 0/5, same 0/9; judge and boil ok in all five; style 0/10; palette 0. Log: `/mnt/d/tmp/cast-walks/brood-sac/gate.log`.

## Measurement

A re-ask of `verify.check` on 8 frames (10:07, same model and prompts) shows one cause:

| frame | subject | is_figure | view | problem |
|---|---|---|---|---|
| s-idle | egg | false | front | does not read as a figure |
| s-walk-1 | creature | true | front | none |
| se-walk-0 | egg | false | side | does not read as a figure |
| e-walk-0 | creature | true | side | none |
| e-walk-3 | egg | false | side | does not read as a figure |
| ne-walk-0 | egg | false | side | does not read as a figure |
| n-idle | egg | false | back | does not read as a figure |
| n-walk-2 | egg | false | side | does not read as a figure |

Every view check passes (s/se front or side, e side, ne/n back or side), and no back frame shows a face. The only failure is `is_figure: false` with subject `egg`. Frames at the size the VLM sees them: https://2cb.pw/gate-case-4a-frames-11254e

## Why the rule misjudges this kind

- The VLM is right: the pod archetype is an egg-sac (`src/game/data/npcs.ts`: "a dormant egg-sac ... then it hatches"). It answers "egg" because the sprite is an egg. The rule exists to catch a character render that came out as a prop. Here, the prop-like read is the design.
- The rule already exempts two kinds for the same reason (`verify.py`: `spore-drone`, `derelict-bot`, since July, before the ledger).
- More legs do not fix it. The sac stands on six root legs that crawl in every frame, and the VLM still calls 39 of 50 frames an egg. It calls a frame a creature only when a lit blister and the legs line up as a face (s-walk-1, e-walk-0). A back view has no blister, so ne/n fail 19 of 20.

## Proposed change

A per-kind exemption entry `Kind: brood-sac`: add `brood-sac` to the `is_figure` exemption tuple in `verify.py` `check()`. This is one line, and the other 4a rules (s not away, ne/n no face, the view votes) still apply to it.

Old vs new on the shipped cast: no shipped kind changes (the tuple only grows). Controls still to run before the entry lands: `cast_gate_selftest.py` (its non-figure negatives are props, not `brood-sac`).

## The other route, not taken

Redesign the sac so that its back reads as an animal (a head, mandibles or a tail). That turns the egg-sac into a different creature, which goes against the archetype. If Aaron prefers that, the next step is a `--describe-back` with a creature cue and a ne/n retake (skeleton seed 3, about 4 minutes of GPU time).
