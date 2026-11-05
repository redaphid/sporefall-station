#!/usr/bin/env python3
"""Coordinate search over the multileg rig's proportions so its stick legs land on a keyframe's legs, on CPU.

  python3 fit_search.py --ref KEY.png --dir n --out FITDIR --start "$(cat proxy.args)" [--rounds 2] [--jobs 4]

A skeleton control has no surface, so fit_proxy's outline IoU is the wrong target: maximising it folded n's legs
under the dome. This scores the joints: leg samples that fall off the keyframe's silhouette, keyframe leg pixels
far from any leg, and the feet's lowest row and spread against the keyframe's. Lower is better. Bounds keep
the legs a stalker's legs. Writes FITDIR/best.args.
"""
import argparse
import concurrent.futures as cf
import glob
import json
import os
import shlex
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

BLENDER = "/mnt/d/tools/blender/blender.exe"
RIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rig_multileg.py")
# name: (step, low, high)
SPACE = {"--ortho": (.3, 5.0, 7.5), "--aim-z": (.12, .7, 1.8), "--foot-r": (.15, .4, 1.6), "--hip-x": (.06, .2, .5),
         "--body-z": (.12, 1.4, 2.1), "--femur": (.1, .6, 1.1), "--tibia": (.12, 1.3, 2.1)}


def win(path):
    return "D:/" + os.path.relpath(path, "/mnt/d")


def legs_of(js):
    pts = []
    for chain in js["legs"].values():
        for a, b in zip(chain, chain[1:]):
            for t in np.linspace(0, 1, 8):
                pts.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return np.array(pts)


def score(ref, d, out, args):
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    r = subprocess.run([BLENDER, "-b", "-P", win(STAGE), "--", "--out", win(out), "--dirs", d, "--frames", "16", "--mode", "skeleton", *args],
                       capture_output=True, text=True)
    if "RIG_MULTILEG_DONE" not in r.stdout:
        return 1e9
    m = np.asarray(Image.open(ref).convert("RGB").resize((848, 480), Image.LANCZOS), np.int16).min(2) < 215
    ys, xs = np.where(m)
    top, bot = ys.min(), ys.max()
    low = m.copy()
    low[:top + int(.5 * (bot - top))] = False
    off = ndimage.distance_transform_edt(~m)
    lx = np.where(low.any(0))[0]
    costs = []
    for p in sorted(glob.glob(os.path.join(out, d, "joints-*.json")))[::4]:
        js = json.load(open(p))
        pts = legs_of(js)
        ix, iy = np.clip(pts[:, 0].astype(int), 0, 847), np.clip(pts[:, 1].astype(int), 0, 479)
        grid = np.ones(m.shape, bool)
        grid[iy, ix] = False
        cover = ndimage.distance_transform_edt(grid)[low].mean()
        tips = np.array([c[-1][:2] for c in js["legs"].values()])
        costs.append(off[iy, ix].mean() + .5 * cover + .3 * abs(tips[:, 1].max() - bot)
                     + .2 * abs(np.ptp(tips[:, 0]) - (lx.max() - lx.min())))
    return float(np.mean(costs))


def with_value(args, k, v):
    a = list(args)
    a[a.index(k) + 1] = f"{v:.3g}"
    return a


def main():
    global STAGE
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--jobs", type=int, default=2)
    a = ap.parse_args()
    a.out = os.path.abspath(a.out)
    os.makedirs(a.out, exist_ok=True)
    STAGE = os.path.join(a.out, "rig_multileg.py")  # on D: so the Windows Blender can read it
    shutil.copyfile(RIG, STAGE)
    best = shlex.split(a.start)
    cost = score(a.ref, a.dir, os.path.join(a.out, "t"), best)
    print("start", round(cost, 1), flush=True)
    with cf.ThreadPoolExecutor(a.jobs) as pool:
        for rnd in range(a.rounds):
            for k, (step, lo, hi) in SPACE.items():
                v = float(best[best.index(k) + 1])
                tries = [with_value(best, k, x) for x in (v - 2 * step, v - step, v + step, v + 2 * step) if lo <= x <= hi]
                costs = list(pool.map(lambda t: score(a.ref, a.dir, os.path.join(a.out, f"t{t[0]}"), t[1]), enumerate(tries)))
                if costs and min(costs) < cost:
                    cost, best = min(costs), tries[int(np.argmin(costs))]
                    print(rnd, k, best[best.index(k) + 1], round(cost, 1), flush=True)
    open(os.path.join(a.out, "best.args"), "w").write(" ".join(best))
    print("best", round(cost, 1), " ".join(best))


if __name__ == "__main__":
    main()
