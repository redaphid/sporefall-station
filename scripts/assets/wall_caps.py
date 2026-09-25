#!/usr/bin/env python3
"""Split the lit CAP strip off a theme's wall-family tiles so the renderer can
autotile it.

The wall sprites were authored with the cap (the grey top strip + the dark
shadow line under it) baked along the NORTH edge. Every wall tile drew it there
whatever its neighbours were, so a vertical wall run read as a ladder of grey
dashes instead of a line. This script:

  1. detects the cap rows at the top of each family's base tile (bright rows,
     plus the dark shadow row under them),
  2. writes `<fam>-cap.png` (the strip along the top edge, transparent below)
     and `<fam>-cap-inner.png` (a cap-sized square in the top-left corner, for
     concave corners),
  3. rewrites every `<fam>-N.png` / `<fam>-accent-N.png` with the cap rows
     replaced by the body texture mirrored up from just below them,
  4. maps `tile.<fam>.cap` / `tile.<fam>.cap.inner` in the manifest.

src/render/wallCaps.ts then lays the strip on every edge that faces open
ground (rotated to that edge) and the inner nub in concave corners.
Idempotent: a family whose tiles carry no cap any more is left alone.

    python3 scripts/assets/wall_caps.py [--theme public/themes/swampspace-hires]
"""
import argparse
import glob
import json
import os

import numpy as np
from PIL import Image

FAMILIES = ("wall", "hull")


def lum(a):
    return a[..., :3].astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)


def cap_rows(a):
    """Rows 0..k-1 that form the cap: rows clearly brighter than the body,
    plus the dark shadow row directly under them. 0 when there is no cap."""
    rows = lum(a).mean(axis=1)
    body = float(np.median(rows[len(rows) // 4:]))
    k = 0
    while k < len(rows) // 4 and rows[k] > body + 25:
        k += 1
    if k == 0:
        return 0
    if rows[k] < body:  # the shadow line under the lit strip belongs to the cap
        k += 1
    return k


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="public/themes/swampspace-hires")
    args = ap.parse_args()
    tiles = os.path.join(args.theme, "tiles")
    mpath = os.path.join(args.theme, "manifest.json")
    m = json.load(open(mpath))
    for fam in FAMILIES:
        files = sorted(glob.glob(os.path.join(tiles, f"{fam}-[0-9]*.png")) +
                       glob.glob(os.path.join(tiles, f"{fam}-accent-[0-9]*.png")))
        if not files:
            continue
        base = np.asarray(Image.open(os.path.join(tiles, f"{fam}-0.png")).convert("RGB"))
        k = cap_rows(base)
        if k == 0:
            print(f"{fam}: no baked cap (already split)")
            continue
        S = base.shape[1]
        strip = np.zeros((S, S, 4), np.uint8)
        strip[:k, :, :3] = base[:k]
        strip[:k, :, 3] = 255
        inner = np.zeros_like(strip)
        inner[:k, :k] = strip[:k, :k]
        Image.fromarray(strip, "RGBA").save(os.path.join(tiles, f"{fam}-cap.png"))
        Image.fromarray(inner, "RGBA").save(os.path.join(tiles, f"{fam}-cap-inner.png"))
        for f in files:
            a = np.asarray(Image.open(f).convert("RGB")).copy()
            kk = cap_rows(a) or k
            a[:kk] = a[kk:2 * kk][::-1]
            Image.fromarray(a, "RGB").save(f)
        m["sprites"][f"tile.{fam}.cap"] = f"tiles/{fam}-cap.png"
        m["sprites"][f"tile.{fam}.cap.inner"] = f"tiles/{fam}-cap-inner.png"
        print(f"{fam}: cap = {k} rows of {S}; stripped {len(files)} tiles")
    with open(mpath, "w") as fh:
        json.dump(m, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main()
