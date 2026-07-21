#!/usr/bin/env python3
"""Genesis-upgrade contrast gate: measure luminance separation between tile
surfaces that touch in play, and between characters and the ground they stand
on. Run against a theme dir; non-zero exit when any pair is below target.

    python3 contrast_audit.py [--theme public/themes/swampspace-hires]

Why luminance ratio: hue separation dies on cheap phone screens and for
color-blind players; value separation is what makes a Sega-Genesis-era scene
readable. Ratio is (L_hi + 12.75) / (L_lo + 12.75) on 0..255 mean luminance
(offset ~ perceptual flare floor, same shape as WCAG).
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image

# Surface pairs that share an edge in generated levels, with the minimum
# readable ratio. wall/floor and floor/exit were 1.14 / 1.02 before the
# upgrade — functionally invisible.
PAIRS = [
    ("wall", "floor", 1.7),
    ("floor", "exit", 1.6),
    ("street", "sidewalk", 1.30),
    ("sidewalk", "grass", 1.30),
    # street (dark asphalt) and grass (dark bog) are naturally close in value;
    # in generated levels a sidewalk border almost always mediates between them,
    # so a modest bar is enough here.
    ("street", "grass", 1.18),
    ("wall", "street", 1.5),
    ("wall", "sidewalk", 1.5),
]

# Characters must separate from every ground they can stand on by mean-lum
# distance (their std also matters — internal contrast — but mean is the gate).
CHAR_GROUND_MIN_DIFF = 28.0
CHAR_GROUNDS = ["street", "sidewalk", "floor", "grass"]


def mean_lum(path):
    a = np.asarray(Image.open(path).convert("RGBA"), dtype=float)
    mask = a[..., 3] > 128
    if not mask.any():
        return None
    lum = (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2])[mask]
    return float(lum.mean())


def edge_darkness(path, width=2):
    """Fraction of a sprite's outer rim that is near-black — a baked dark
    outline separates a figure from ANY ground regardless of its mean value,
    so a strong rim is an alternative way to pass the ground-separation gate."""
    from scipy.ndimage import binary_dilation
    a = np.asarray(Image.open(path).convert("RGBA"), float)
    mask = a[..., 3] > 128
    if not mask.any():
        return 0.0
    inner = mask & ~binary_dilation(~mask, iterations=width)
    edge = mask & ~inner
    if not edge.any():
        return 0.0
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    return float((lum[edge] < 40).mean())


def group_lum(theme, name):
    files = sorted(glob.glob(os.path.join(theme, "tiles", f"{name}-[0-9]*.png")))
    files = [f for f in files if "accent" not in f and "overlay" not in f]
    vals = [mean_lum(f) for f in files]
    vals = [v for v in vals if v is not None]
    return (sum(vals) / len(vals)) if vals else None


def ratio(a, b):
    hi, lo = max(a, b), min(a, b)
    return (hi + 12.75) / (lo + 12.75)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="public/themes/swampspace-hires")
    args = ap.parse_args()

    fails = []
    lums = {}
    for name in {n for pair in PAIRS for n in pair[:2]} | set(CHAR_GROUNDS):
        lums[name] = group_lum(args.theme, name)

    print(f"theme: {args.theme}")
    for name, v in sorted(lums.items()):
        print(f"  {name:10s} meanLum={v:6.1f}" if v is not None else f"  {name:10s} (no tiles)")

    print("\nsurface pairs:")
    for a, b, target in PAIRS:
        la, lb = lums.get(a), lums.get(b)
        if la is None or lb is None:
            continue
        r = ratio(la, lb)
        ok = r >= target
        print(f"  {a:9s} vs {b:9s} ratio={r:4.2f} target={target:.2f} {'ok' if ok else 'FAIL'}")
        if not ok:
            fails.append(f"{a} vs {b}: {r:.2f} < {target}")

    print("\ncharacter vs ground (pass = lum separation OR a dark outline):")
    for char in sorted(glob.glob(os.path.join(args.theme, "chars", "*-s-idle.png"))):
        cl = mean_lum(char)
        if cl is None:
            continue
        cname = os.path.basename(char).replace("-s-idle.png", "")
        rim = edge_darkness(char)
        outlined = rim >= 0.6
        for g in CHAR_GROUNDS:
            gl = lums.get(g)
            if gl is None:
                continue
            diff = abs(cl - gl)
            ok = diff >= CHAR_GROUND_MIN_DIFF or outlined
            how = "lum" if diff >= CHAR_GROUND_MIN_DIFF else ("outline" if outlined else "")
            mark = f"ok({how})" if ok else "FAIL"
            print(f"  {cname:16s} ({cl:5.1f}) vs {g:9s} ({gl:5.1f}) diff={diff:5.1f} rim={rim:.2f} {mark}")
            if not ok:
                fails.append(f"{cname} vs {g}: lum diff {diff:.1f} < {CHAR_GROUND_MIN_DIFF} and no outline (rim {rim:.2f})")

    if fails:
        print(f"\n{len(fails)} contrast failures")
        return 1
    print("\nall contrast targets met")
    return 0


if __name__ == "__main__":
    sys.exit(main())
