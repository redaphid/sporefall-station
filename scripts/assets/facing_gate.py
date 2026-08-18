#!/usr/bin/env python3
"""Measure whether a prop is drawn SQUARE TO THE VIEWER, the way the pack's
accepted art is -- and reject it before anyone grades its colour or its outline.

WHY THIS IS A GATE AND NOT A NOTE. `ROTATES_WITH_FACING` is empty (#44): the
renderer no longer turns furnishings, so the angle that is drawn is the angle
that ships, for every instance in every room, forever. A room of props each
drawn from its own viewpoint reads as incoherent even when every single sprite
is good on its own. Two candidates in the p6 sweep were rejected on sight for
exactly this, after effort had already been spent judging their value and
blockiness. Angle is cheap to measure and it invalidates everything downstream,
so it goes first.

THE MEASURE. An object seen square-on is left-right symmetric in SILHOUETTE; the
same object turned shows one side face and stops being symmetric. So: take the
alpha mask, mirror it about the silhouette's own centre of mass, and score the
intersection-over-union of mask against mirrored mask. Nothing here looks at
colour, so a dark chair and a pale one score the same -- which is the point,
because this must not double-count the value gate.

Mirroring about the CENTROID rather than the canvas centre matters: `post.sprite`
pastes content centred on the canvas, but a turned object's mass still sits off
to one side of its own bounding box, and centring on the canvas would hide
precisely the asymmetry being looked for.

WHAT THIS SCORE CANNOT DO, stated because the first version of it tried to and
was wrong. The accepted anchors are near-RECTANGLES (a cabinet, a locker, a wall
screen) and score 0.95-0.99. A chair has four legs and a gap under the seat, so
its silhouette is intricate and it scores 0.3-0.75 EVEN WHEN DRAWN PERFECTLY
SQUARE-ON. Applying the anchors' number to a chair as a pass mark rejected all
eight candidates in both sweeps, including ones a human eye called correct --
a gate that fails everything is not measuring the thing it claims to.

So the score is used two ways, and only these:
  * RELATIVE, within one subject's sweep -- ranking candidates against each
    other is valid, because silhouette complexity is then held constant. This
    reproduces the human call: the owner rejected p6 seeds 1004 and 1005 on
    sight, and they rank last and mid-low in that sweep (0.319, 0.473 against a
    0.619 best).
  * ABSOLUTE, only between props of comparable silhouette complexity.
The anchor numbers are printed as CONTEXT, not as a threshold.

    python facing_gate.py                              # calibrate on the pack
    python facing_gate.py p7/mess-chair                # rank a sweep's raws
    python facing_gate.py --pack review-s01003         # score a built pack
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import post as P
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
THEMES = REPO / "public/themes"
GEN = Path(os.environ.get("EXP_OUT", "D:/tmp/props-gen"))
PACK = os.environ.get("REVIEW_BASE", "swampspace-hires")

# The four accepted props that agree on a near front elevation. `cargo-crate`
# (left-handed isometric) and `spore-barrel` (high angle) are deliberately NOT
# in here: they are the pack's known outliers, and calibrating on them would
# widen the gate until it admitted the very rotation it exists to catch.
ANCHORS = ["work-desk", "supply-cabinet", "weapons-locker", "wall-screen"]


def symmetry(im: Image.Image) -> float:
    """Agreement between the alpha silhouette and its own mirror, about the
    silhouette's centre of mass.

    Measured on a SOFTENED, downsampled mask, not on raw pixels. A hard-edged IoU
    is dominated by thin members: a chair's four legs are a few pixels wide, so a
    one-pixel difference between left and right legs costs as much as a whole
    side panel, and every chair scores near zero whether it is turned or not --
    which makes the gate useless precisely where it is needed. Downsampling to
    roughly the size the object occupies on screen asks the question the eye
    actually asks: does this read as square-on at game size?
    """
    a = np.asarray(im.convert("RGBA"), dtype=np.float32)[..., 3] / 255.0
    if a.sum() == 0:
        return 0.0
    cols = np.flatnonzero((a > 0.12).any(axis=0))
    rows = np.flatnonzero((a > 0.12).any(axis=1))
    a = a[rows[0]: rows[-1] + 1, cols[0]: cols[-1] + 1]
    # Mirror about the centre of MASS, not the bounding box: a turned object's
    # mass sits off to one side of its own box, and mirroring about the box
    # would hide exactly the asymmetry this is looking for.
    xs = np.arange(a.shape[1])
    cx = float((a.sum(axis=0) * xs).sum() / a.sum())
    half = max(cx, a.shape[1] - 1 - cx)
    grid = np.linspace(cx - half, cx + half, 96)
    idx = np.clip(np.round(grid).astype(int), 0, a.shape[1] - 1)
    m = a[:, idx] * ((grid >= 0) & (grid <= a.shape[1] - 1))[None, :]
    # Soften to game-legible scale: 24 columns is about what a one-tile prop
    # occupies on screen at play zoom.
    m = Image.fromarray((m * 255).astype(np.uint8)).resize((24, 24), Image.BILINEAR)
    m = np.asarray(m, dtype=np.float32) / 255.0
    f = m[:, ::-1]
    denom = np.sqrt((m * m).sum() * (f * f).sum())
    return float((m * f).sum() / denom) if denom else 0.0


def sprite_of(raw: Path, px: int = 64) -> Image.Image:
    return P.sprite(Image.open(raw), px, content=px - 2, anchor="center")


def calibrate() -> None:
    print(f"anchors ({PACK}) -- CONTEXT, not a threshold:")
    for n in ANCHORS:
        print(f"  {n:18s} {symmetry(Image.open(THEMES / PACK / 'props' / f'{n}.png')):.3f}")
    for n in ["cargo-crate", "spore-barrel"]:
        p = THEMES / PACK / "props" / f"{n}.png"
        if p.exists():
            print(f"  {n:18s} {symmetry(Image.open(p)):.3f}   (known outlier, not in calibration)")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    calibrate()
    if "--pack" in sys.argv:
        for tag in args:
            print(f"{tag}: {symmetry(Image.open(THEMES / tag / 'props' / 'chair.png')):.3f}")
        return
    for subj in args:
        sweep, _, name = subj.partition("/")
        d = GEN / sweep / name
        scored = sorted(((symmetry(sprite_of(r)), r.stem) for r in d.glob("seed?????.png")), reverse=True)
        if not scored:
            print(f"\n{subj}: no raws")
            continue
        # RELATIVE to the best this subject achieved, because the absolute number
        # is a function of how intricate the silhouette is (see module docstring).
        best = scored[0][0]
        print(f"\n{subj}  (best {best:.3f}; flagging anything below 85% of it)")
        for s, stem in scored:
            print(f"  {stem}  {s:.3f}  {'ok' if s >= 0.85 * best else 'TURNED - reject'}")


if __name__ == "__main__":
    main()
