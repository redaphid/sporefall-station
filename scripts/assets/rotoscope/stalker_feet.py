#!/usr/bin/env python3
"""Lift mireclaw-stalker's lower legs off the dark floor, on the locked 34 colours. Order: `cast_walk.py export`,
this, `cast_walk.py embed --kind mireclaw-stalker`, then the gate.

The design's charcoal tips snap to colours under luminance 40, and the floor (12,20,22) is about 18, so 60%+ of
the legs vanish at game scale. Below LEGS_FROM of the silhouette height the near-black ramp moves two steps up the
palette's blue-grey ramp. Same alpha, same teal, same crest: only the charcoal gets lighter. Reads the repack frames
export leaves in <run>-<px>, so reruns give the same result, and keeps each PNG's embedded flow.

  python3 stalker_feet.py <run> [<themes dir>]
"""
import os
import sys

import numpy as np
from PIL import Image, PngImagePlugin

PACKS = {96: "swampspace-hires", 48: "swampspace"}
DIRS = ("s", "se", "e", "ne", "n")
POSES = ["idle", "step"] + [f"walk-{i}" for i in range(8)]
RAMP = {(8, 8, 12): (35, 40, 46), (20, 26, 22): (60, 68, 77), (28, 20, 32): (60, 68, 77), (35, 40, 46): (89, 99, 109)}
LEGS_FROM = 0.55


def leg_cut(frames):
    """First leg row for one direction, from all its frames' union: a per-frame cut would ride up and down with
    the lifted foot, and the charcoal/grey edge would crawl along the leg."""
    ys = np.nonzero(np.any([a[..., 3] > 0 for a in frames], axis=0).any(1))[0]
    return int(ys.min() + LEGS_FROM * (ys.max() - ys.min()))


def recolour(a, cut):
    out, legs = a.copy(), a[..., 3] > 0
    legs[:cut] = False
    for src, dst in RAMP.items():  # match on the source image so a pixel moves once
        out[legs & np.all(a[..., :3] == src, axis=2), :3] = dst
    return out


def main():
    run = os.path.abspath(sys.argv[1]).rstrip("/")
    themes = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "public", "themes")
    for px, pack in PACKS.items():
        n = 0
        for d in DIRS:
            ims = {p: Image.open(f"{run}-{px}/frames/mireclaw-stalker-{d}-{p}.png") for p in POSES}
            arrs = {p: np.asarray(im.convert("RGBA")) for p, im in ims.items()}
            cut = leg_cut(list(arrs.values()))
            for p, im in ims.items():
                name = f"mireclaw-stalker-{d}-{p}.png"
                a = arrs[p]
                b = recolour(a, cut)
                n += int((a != b).any(2).sum())
                info = PngImagePlugin.PngInfo()
                for k, v in im.text.items():
                    info.add_text(k, v)
                Image.fromarray(b).save(os.path.join(themes, pack, "chars", name), pnginfo=info)
        print(f"{pack}: {n} px moved in 50 frames")


if __name__ == "__main__":
    main()
