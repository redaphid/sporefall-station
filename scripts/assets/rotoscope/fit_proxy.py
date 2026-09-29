#!/usr/bin/env python3
"""Fit the multileg proxy's silhouette to the character keyframe, on CPU. The proxy's outline is the
outline Fun-Control draws, so it must be the character's before any GPU time is spent.

  python3 fit_proxy.py --ref .../se-keyframe.png --out /mnt/d/tmp/cast-walks/rnd-multileg/fit/try1 \
      -- --body-z 1.5 --femur 0.95 ...   (everything after -- goes to rig_multileg.py)

Renders frame 0 (colour only), then prints bbox, IoU, and per-band width (10 bands top to bottom,
fraction of the keyframe's bbox width) for the proxy against the keyframe, and writes overlay.png
(keyframe mask red, proxy green, overlap yellow).
"""
import argparse
import os
import subprocess
import sys

import numpy as np
from PIL import Image

BLENDER = "/mnt/d/tools/blender/blender.exe"
RIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rig_multileg.py")


def win(path):
    return "D:/" + os.path.relpath(path, "/mnt/d") if path.startswith("/mnt/d/") else path


def mask_ref(path, w=848, h=480):
    a = np.asarray(Image.open(path).convert("RGB").resize((w, h), Image.LANCZOS), np.int16)
    return a.min(2) < 215


def profile(m, box):
    x0, x1, y0, y1 = box
    rows = m[y0:y1 + 1]
    bands = np.array_split(np.arange(len(rows)), 10)
    width = x1 - x0 + 1
    return [round(float(np.mean([np.ptp(np.where(rows[i])[0]) + 1 if rows[i].any() else 0 for i in b])) / width, 2)
            for b in bands]


def bbox(m):
    ys, xs = np.where(m)
    return int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())


def main():
    argv = sys.argv[1:]
    rig_args = argv[argv.index("--") + 1:] if "--" in argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dir", default="se")
    a = ap.parse_args(argv[:argv.index("--")] if "--" in argv else argv)
    os.makedirs(a.out, exist_ok=True)
    stage = os.path.join(os.path.abspath(a.out), "rig_multileg.py")  # on D: so the Windows Blender can read it
    open(stage, "w").write(open(RIG).read())
    r = subprocess.run([BLENDER, "-b", "-P", win(stage), "--", "--out", win(os.path.abspath(a.out)), "--dirs", a.dir,
                        "--only", "0", "--samples", "4", *rig_args], capture_output=True, text=True)
    if "RIG_MULTILEG_DONE" not in r.stdout:
        raise SystemExit(r.stdout[-2000:] + r.stderr[-2000:])
    ref = mask_ref(a.ref)
    prox = np.asarray(Image.open(os.path.join(a.out, a.dir, "color-00.png")))[..., 3] > 127
    rb, pb = bbox(ref), bbox(prox)
    iou = float((ref & prox).sum() / (ref | prox).sum())
    print("ref   bbox", rb, "w", rb[1] - rb[0], "h", rb[3] - rb[2], "fill", round(float(ref.sum()) / 1e3, 1), "k")
    print("proxy bbox", pb, "w", pb[1] - pb[0], "h", pb[3] - pb[2], "fill", round(float(prox.sum()) / 1e3, 1), "k")
    print("iou", round(iou, 3))
    print("ref   bands", profile(ref, rb))
    print("proxy bands", [round(v * (pb[1] - pb[0] + 1) / (rb[1] - rb[0] + 1), 2) for v in profile(prox, pb)])
    ov = np.zeros(ref.shape + (3,), np.uint8) + 255
    ov[ref & ~prox] = (230, 60, 60)
    ov[prox & ~ref] = (60, 180, 60)
    ov[ref & prox] = (230, 200, 40)
    Image.fromarray(ov).save(os.path.join(a.out, "overlay.png"))


if __name__ == "__main__":
    main()
