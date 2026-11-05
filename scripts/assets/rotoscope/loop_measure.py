#!/usr/bin/env python3
"""Seam, legs/body split and gate-5 metrics for one direction's raw walk clip, in the run's own units.

  python3 loop_measure.py <raw dir> <dir> [--period P]

Prints one JSON line: the CLI's own loop pick (spritesheet.find_loop), the seam at the proxy's
known period (best start and median over every start), partscan's body/legs split both as the
best single-frame seam over P 12-64 and at the picked loop, and cast_walk.judge_loop (identity,
head drift, boil, sharpness, coverage) on the picked loop.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import cast_walk as C  # noqa: E402
import spritesheet as S  # noqa: E402

SKIP = 6


def parts(paths):
    """partscan.py's split: top 45% of the sprite's rows (carapace) vs the rest (legs)."""
    fr = [np.asarray(Image.open(p).convert("L").resize((212, 120)), dtype=np.float32) / 255 for p in paths]
    m = np.stack([a < 0.85 for a in fr])
    rows = np.where(m.any(0).any(1))[0]
    top, bot = rows.min(), rows.max()
    cut = int(top + 0.45 * (bot - top))
    return {"body": [a[top:cut] for a in fr], "legs": [a[cut:bot + 1] for a in fr]}


def seam(x, s, p, step):
    return float(np.abs(x[s] - x[s + p]).mean()) / step


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raw")
    ap.add_argument("dir")
    ap.add_argument("--period", type=int, default=0)
    a = ap.parse_args()
    paths = sorted(glob.glob(os.path.join(a.raw, f"walk-{a.dir}", "*.png")))
    frames = [Image.open(p).convert("RGB") for p in paths]
    n = len(frames)
    fl = S.find_loop(frames)
    out = {"n": n, "pick": {k: fl[k] for k in ("period", "start", "seam")}}
    small = S._small(frames)
    step = float(np.median([np.abs(small[t + 1] - small[t]).mean() for t in range(SKIP, n - 1)]))
    if a.period:
        for p in (a.period, 2 * a.period):
            v = [seam(small, s, p, step) for s in range(SKIP, n - p)]
            out[f"P{p}"] = {"best": round(min(v), 3), "best_start": SKIP + int(np.argmin(v)),
                            "median": round(float(np.median(v)), 3)}
    for name, x in parts(paths).items():
        st = float(np.median([np.abs(x[t + 1] - x[t]).mean() for t in range(SKIP, n - 1)]))
        out[name] = {"best_any": round(min(seam(x, s, p, st) for p in range(12, 65) for s in range(SKIP, n - p)), 3),
                     "at_pick": round(seam(x, fl["start"], fl["period"], st), 3)}
        if a.period:
            out[name][f"at_P{a.period}"] = round(min(seam(x, s, a.period, st) for s in range(SKIP, n - a.period)), 3)
    _, rep = C.judge_loop(paths, fl["start"], fl["period"])
    out["judge"] = {k: rep[k] for k in ("identity_drift", "head_drift", "boil", "sharpness", "coverage_jitter")}
    out["judge"]["pass"] = rep["pass"]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
