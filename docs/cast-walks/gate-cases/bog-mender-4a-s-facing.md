# Rule 14 case: gate 4a's one-image "facing" question on a faceless front (bog-mender)

Status: **proposed, not applied**. The gate is unchanged (938319cdcc807028, G7). The bog-mender worker wrote this case on 2026-11-06 and stopped the s direction. Round 2 tried the art-side route (a lit visor slit, see the last section): 4a went from 3/50 to 1/50 but still fails.

## Symptom

The bog-mender walk (a medbay automaton, branch `art/bog-mender-1106`, export b05fb41a) passed 8 of 9 gates. It failed only gate 4a, on 3 of 50 frames:

> bog-mender-s-walk-0/1/2.png subj='robot' facing=away view=front: 's' sprite reads as facing away

The run log is `/mnt/d/tmp/cast-walks/bog-mender/gate.log`. The other gates passed: seams s .253, se .330, e .286, ne .159, n .855; colour 0; spec 0; 4b 0/5 and 0/9; judge ok x5; style 0/10; palette 0.

## Measurement

`verify.check()` asks two questions of an s frame:

1. The one-image prompt returns `facing` (toward-viewer / away / left / right). An s frame fails when `facing == away`.
2. `view_votes()` shows the character's own s-idle (front) and n-idle (back) beside the frame and asks front, back or side.

A diagnostic run of `verify.py` on s-walk-0..3 (same model, same job, no gate change; GPU-WAN.lock 09:06) returned:

| frame | facing (one image) | view (against s-idle + n-idle) | result |
|---|---|---|---|
| s-walk-0 | away | front | FAIL |
| s-walk-1 | away | front | FAIL |
| s-walk-2 | away | front | FAIL |
| s-walk-3 | toward-viewer | front | ok |

The four frames differ only in leg phase. Every one shows the dark visor band and the glowing amber chest port. Only the front view has the chest port. 4x zoom of s-idle and s-walk-0..7: https://2cb.pw/s-walk-zoom-e91710

`verify.py` documents this weakness itself, above `VIEWS_OK`: "One-image 'which way does it face' has nothing to go on for a sealed visor or a hood: it read 6 of the mycologist's 10 east profiles as 'away'". The two-reference `view` check was added for that reason. The s rule still fails a frame on the one-image `facing` answer alone, even when the reference check reads the same frame as front.

## Proposed change

For s and se, fail on `facing == away` only when the reference check does not read the frame as front or side. In other words, let `view_votes` decide whenever it ran. The rule for n and ne stays as it is: no visible face.

Before applying it, run `cast_gate_selftest.py`. Its back-view negative control for s must still fail through `view`.

## Art-side route tried (round 2, 2026-11-06): a lit visor slit, and 4a still fails

Rule 14 asks for a better art route before a gate change, so round 2 gave the front a face cue that one image can read.

- A short lit amber slit was painted into the visor band of the take1 s, se and e keyframes: two 8 px block rows, a yellow core (240,224,64) with an orange rim (224,96,32). These are the chest port's own hues, so G3 still has one accent. Script: `/mnt/d/tmp/cast-walks/bog-mender/slit-1106/tools/paint_slit.py`.
- Wan take3 (seed 3) ran from those keyframes with `--keyframe`, giving seams s .289, se .276 and e .308. At 96 px the slit is 2 px tall and lit in every s, se and e frame.
- ne was also redrawn as a true three-quarter back. It is faceless and was rendered by skeleton Fun-Control (seam .127).

The one gate run on export d52fdce5 (gate 938319cdcc807028, G7) scored 8/9 again. 4a now fails on **1 of 50** frames (3 of 50 before):

> bog-mender-s-step.png subj='robot' facing=away: 's' sprite reads as facing away

A diagnostic run of `verify.py` used the gate's own job (`char.bog-mender.s-idle`) and the same model. The gate itself was unchanged.

| frame | facing (one image) | view (against s-idle + n-idle) | result |
|---|---|---|---|
| s-step | away | side | FAIL |
| s-walk-0 | toward-viewer | front | ok |

The lit slit and the chest port are both plainly visible on s-step (4x zoom: https://2cb.pw/s-step-zoom-144b59). Sheet: https://2cb.pw/contact-96-vs-frog-settler-8c12bf. GIF: https://2cb.pw/walk-96-vs-frog-settler-b1dc23.

The added face cue moved the one-image answer on most frames, but not on all of them. One frame with a lit visor and a lit chest port still reads "away". The proposed change still covers it: `view` returns side here, which an s frame is allowed to be. The art route has been tried, and the worker has stopped. The decision belongs to Aaron.
