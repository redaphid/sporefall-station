#!/usr/bin/env python3
"""Bake a hard dark outline (and a soft ground shadow) into every character
sprite so figures separate from ANY ground — the Genesis-era fix for the
"character blends into the road" complaint. A mean-luminance contrast gate
(contrast_audit.py) can't be satisfied for every body-vs-ground pair at once
(a mid-olive mutant will always sit near mid-olive bog); a 2px near-black rim
solves it independent of the ground value.

For each chars/*.png:
  - dilate the alpha mask by `--width` px and fill the new rim with the
    palette's darkest outline color (#08080c), UNDER the existing pixels;
  - re-snap the rim to hard alpha.
Idempotent-ish: an already-outlined sprite grows its rim, so run once from the
committed originals (git checkout first if re-tuning).

Usage: python3 char_outline.py [--theme <dir>] [--width 2] [--dry]
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from palette import RGB  # noqa: E402

OUTLINE = (8, 8, 12)  # #08080c — palette darkest
PAL = np.array(RGB, np.float32)


def outline_sprite(im, width=2):
    a = np.asarray(im.convert("RGBA")).copy()
    mask = a[..., 3] > 128
    if not mask.any():
        return im, 0
    grown = binary_dilation(mask, iterations=width)
    rim = grown & ~mask
    a[rim, 0], a[rim, 1], a[rim, 2] = OUTLINE
    a[rim, 3] = 255
    return Image.fromarray(a, "RGBA"), int(rim.sum())


def edge_darkness(im, width=2):
    """Fraction of the sprite's outer rim that is already dark (<40 lum) —
    a coarse 'does it have an outline' probe for reporting."""
    a = np.asarray(im.convert("RGBA"))
    mask = a[..., 3] > 128
    if not mask.any():
        return 1.0
    inner = mask & ~binary_dilation(~mask, iterations=width)
    edge = mask & ~inner
    if not edge.any():
        return 1.0
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    return float((lum[edge] < 40).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="../../public/themes/swampspace-hires")
    ap.add_argument("--width", type=int, default=2)
    ap.add_argument("--dirs", default="chars", help="comma-separated: chars,props,items")
    ap.add_argument("--skip-outlined", type=float, default=None,
                    help="skip files whose rim already exceeds this (re-run safety)")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    tag = "would outline" if args.dry else "outlined"
    for sub in args.dirs.split(","):
        files = sorted(glob.glob(os.path.join(args.theme, sub, "*.png")))
        n = 0
        for f in files:
            base = os.path.basename(f)
            if sub == "chars" and not (base.endswith(("-idle.png", "-step.png")) or "-walk-" in f):
                continue
            im = Image.open(f)
            before = edge_darkness(im, args.width)
            if args.skip_outlined is not None and before >= args.skip_outlined:
                continue
            out, rim = outline_sprite(im, args.width)
            if not args.dry:
                out.save(f)
            n += 1
        print(f"{tag} {n} {sub} sprites (width {args.width})")


if __name__ == "__main__":
    main()
