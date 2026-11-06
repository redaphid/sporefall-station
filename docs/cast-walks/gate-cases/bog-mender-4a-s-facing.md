# Rule 14 case: gate 4a's one-image "facing" question on a faceless front (bog-mender)

Status: **proposed, not applied**. The gate is unchanged (938319cdcc807028, G7). The bog-mender worker wrote this case on 2026-11-06 and stopped the s direction.

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

## Art-side alternative (rule 14: try a better route first)

Give the front a face cue that one image can read, such as a thin lit amber slit in the visor (the design sheet's seed 23 drew one). It uses the same hue as the chest port, so G3 still has one accent. This means retaking s and se (and e to match), followed by a second gate run. The brief allowed one gate run, so this was not attempted.
