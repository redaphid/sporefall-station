#!/usr/bin/env python3
"""Draw the multileg rig's joints as an OpenPose-style stick control: coloured tapered limbs and joint
dots on black, no body surface. The keyframe, not the control, then supplies the creature's shape.

  python3 skeleton.py <rig out>/<dir> [--stick 4] [--ref keyframe.png]

Reads joints-NN.json (rig_multileg.py --mode skeleton) and writes skel-NN.png beside them. With --ref it
also writes overlay-00.png: frame 0 over the keyframe, to check the two line up before any GPU time.
"""
import argparse
import glob
import json
import math
import os

from PIL import Image, ImageDraw

# OpenPose's limb palette; DWPose/OpenPose renders are what Fun-Control's pose training saw
PALETTE = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
           (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
           (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]


def segments(js):
    """(a, b, colour) per limb: the body axis head to tail, then each leg hip-knee-mid-tip, in a fixed order."""
    chains = [js["body"]] + [js["legs"][k] for k in sorted(js["legs"])]
    segs = []
    for chain in chains:
        for a, b in zip(chain, chain[1:]):
            segs.append((a, b, PALETTE[len(segs) % len(PALETTE)]))
    return segs


def limb(a, b, stick):
    """OpenPose's limb shape: an ellipse along a->b, half-width `stick`."""
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    half = math.hypot(b[0] - a[0], b[1] - a[1]) / 2
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    ca, sa = math.cos(ang), math.sin(ang)
    return [(mx + half * math.cos(t) * ca - stick * math.sin(t) * sa, my + half * math.cos(t) * sa + stick * math.sin(t) * ca)
            for t in (2 * math.pi * i / 36 for i in range(36))]


def draw(js, stick):
    im = Image.new("RGB", (js["w"], js["h"]))
    dr = ImageDraw.Draw(im)
    # far limbs first, so a near leg crosses over a far one
    for a, b, col in sorted(segments(js), key=lambda s: -(s[0][2] + s[1][2])):
        dr.polygon(limb(a, b, stick), fill=tuple(int(c * 0.6) for c in col))
        for p in (a, b):
            dr.ellipse([p[0] - stick, p[1] - stick, p[0] + stick, p[1] + stick], fill=col)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--stick", type=float, default=4.0)
    ap.add_argument("--ref")
    a = ap.parse_args()
    paths = sorted(glob.glob(os.path.join(a.dir, "joints-*.json")))
    assert paths, f"no joints-*.json in {a.dir}"
    for p in paths:
        n = os.path.basename(p)[len("joints-"):-len(".json")]
        draw(json.load(open(p)), a.stick).save(os.path.join(a.dir, f"skel-{n}.png"))
    if a.ref:
        sk = Image.open(os.path.join(a.dir, "skel-00.png")).convert("RGB")
        ref = Image.open(a.ref).convert("RGB").resize(sk.size, Image.LANCZOS)
        mask = sk.convert("L").point(lambda v: 255 if v > 0 else 0)
        Image.composite(sk, ref, mask).save(os.path.join(a.dir, "overlay-00.png"))
    print(f"{len(paths)} skel frames -> {a.dir}")


if __name__ == "__main__":
    main()
