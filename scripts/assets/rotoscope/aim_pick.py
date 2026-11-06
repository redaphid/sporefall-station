#!/usr/bin/env python3
"""Pick the 8 aimwalk frames out of a posted Fun-Control clip so the legs step in time with the shipped walk.

  python3 aim_pick.py SCAN --kind vine-ranger --dir e --period 24 [--first 24] [--belt 0.55]

SCAN is a `cast_action.py post` of every clip frame (state `scan`, frames 0..N-1, 96 px). For each start t
the candidate is frames t, t+P/8, ... t+7P/8; it scores
  legs   the share of leg-band pixels (below `--belt` of the figure) whose opacity differs from the shipped
         walk-n's, mean over n: the aimwalk then picks up the walk's stride phase when the engine swaps
         walk -> aimwalk mid-step;
  seam   frame t+P against frame t (the loop's join), the same alpha measure over the whole sprite;
  boil   mean colour change of the upper body (above the belt) between consecutive picks: the arms are
         locked, so the gun and torso should hold still.
Prints the best few starts and the clip indices for `cast_action.py post --clip dir=RUN:i,...`.
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import cast_walk as CW  # noqa: E402


def load(p):
    return np.asarray(Image.open(p).convert("RGBA"))


def band(a, belt):
    ys = np.nonzero((a[..., 3] > 0).any(1))[0]
    return int(ys.min() + belt * (ys.max() - ys.min())) if len(ys) else a.shape[0] // 2


def alpha_diff(a, b, rows=slice(None)):
    A, B = a[rows, :, 3] > 0, b[rows, :, 3] > 0
    u = (A | B).sum()
    return float((A ^ B).sum() / max(1, u))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scan")
    ap.add_argument("--kind", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--state", default="scan")
    ap.add_argument("--period", type=int, required=True)
    ap.add_argument("--first", type=int, default=0, help="the earliest start (skip the clip's settling frames)")
    ap.add_argument("--belt", type=float, default=0.55)
    a = ap.parse_args()
    fs = sorted(glob.glob(f"{a.scan}/96/{a.kind}-{a.dir}-{a.state}-*.png"), key=lambda f: int(f.rsplit("-", 1)[1][:-4]))
    clip = [load(f) for f in fs]
    walk = [load(os.path.join(CW.THEMES, "swampspace-hires", "chars", f"{a.kind}-{a.dir}-walk-{n}.png")) for n in range(8)]
    step = a.period / 8
    rows = []
    for t in range(a.first, len(clip) - a.period):
        idx = [t + round(n * step) for n in range(8)]
        legs = np.mean([alpha_diff(clip[i], walk[n], slice(band(walk[n], a.belt), None)) for n, i in enumerate(idx)])
        seam = alpha_diff(clip[t], clip[t + a.period])
        top = [slice(None, band(clip[i], a.belt)) for i in idx]
        boil = np.mean([np.abs(clip[i][top[k]].astype(float) - clip[idx[(k + 1) % 8]][top[k]].astype(float))[..., :3].mean()
                        for k, i in enumerate(idx)])
        rows.append((legs + seam + boil / 100, t, legs, seam, boil, idx))
    rows.sort()
    for score, t, legs, seam, boil, idx in rows[:5]:
        print(f"start {t:3d} legs {legs:.3f} seam {seam:.3f} boil {boil:5.2f}  {','.join(map(str, idx))}")


if __name__ == "__main__":
    main()
