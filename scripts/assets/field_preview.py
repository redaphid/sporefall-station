#!/usr/bin/env python3
"""Assemble a large tile FIELD exactly as the engine would, so tile
combinations can be judged at field scale (repeat, seams, variety) instead of
one tile at a time. Ports src/render/tileSelect.ts pickTileVariant + coordHash
so the layout is byte-identical to what ships.

    python3 field_preview.py <surface> [--theme dir] [--n 14] [--scale 6] [--out path]

Also `--all` writes a preview per surface, and `--judge` runs qwen3-vl over the
field for an aesthetic read (variety / repeat / seams / look).
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MACRO = {"floor": 2, "street": 2, "grass": 4}  # mirror manifest macroTiles


def coord_hash(tx, ty):
    def imul(a, b):
        return (a * b) & 0xFFFFFFFF
    h = imul((tx ^ 0x9E3779B9) & 0xFFFFFFFF, 0x85EBCA6B) ^ imul((ty ^ 0xC2B2AE35) & 0xFFFFFFFF, 0x27D4EB2F)
    h &= 0xFFFFFFFF
    h = imul(h ^ (h >> 15), 0x2545F491)
    return h & 0xFFFFFFFF


def pick_variant(pool_len, macro, tx, ty, h):
    if pool_len <= 0:
        return 0
    if macro is not None and macro >= 2 and pool_len >= macro * macro:
        per = macro * macro
        quadrant = (ty % macro) * macro + (tx % macro)
        n_macros = pool_len // per
        cell = coord_hash(tx // macro, ty // macro)
        m = cell % n_macros if n_macros > 1 else 0
        return m * per + quadrant
    return (h >> 2) % pool_len


def load_pool(theme, surface):
    fs = sorted(glob.glob(os.path.join(theme, "tiles", f"{surface}-[0-9]*.png")),
                key=lambda p: int(p.rsplit("-", 1)[1].split(".")[0]))
    return [np.asarray(Image.open(f).convert("RGB")) for f in fs]


def build_field(theme, surface, n):
    pool = load_pool(theme, surface)
    if not pool:
        raise SystemExit(f"no tiles for {surface}")
    T = pool[0].shape[0]
    macro = MACRO.get(surface)
    accents = sorted(glob.glob(os.path.join(theme, "tiles", f"{surface}-accent-*.png")))
    accent_imgs = [np.asarray(Image.open(f).convert("RGB")) for f in accents]
    field = np.zeros((n * T, n * T, 3), np.uint8)
    for ty in range(n):
        for tx in range(n):
            h = coord_hash(tx, ty)
            # accents ride the same hash (TILE_ACCENT_EVERY=17), mirror art.ts
            if accent_imgs and h % 17 == 0:
                tile = accent_imgs[(h >> 5) % len(accent_imgs)]
            else:
                tile = pool[pick_variant(len(pool), macro, tx, ty, h)]
            field[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T] = tile
    return Image.fromarray(field, "RGB")


def repeat_metric(field, T):
    """Autocorrelation-ish: mean abs diff between the field and itself shifted
    by one tile. Low = tiles too similar (bland); very structured peaks at the
    macro period reveal a visible repeat. Reported as a diagnostic number."""
    a = np.asarray(field, np.float32)
    sh = np.roll(a, T, axis=1)
    return float(np.abs(a - sh).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("surface", nargs="?", default="floor")
    ap.add_argument("--theme", default="public/themes/swampspace-hires")
    ap.add_argument("--n", type=int, default=14)
    ap.add_argument("--scale", type=int, default=6)
    ap.add_argument("--out", default=None)
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    surfaces = ["floor", "street", "grass", "sidewalk", "wall"] if args.all else [args.surface]
    for s in surfaces:
        field = build_field(args.theme, s, args.n)
        T = load_pool(args.theme, s)[0].shape[0]
        big = field.resize((field.width * 1, field.height * 1), Image.NEAREST)
        # scale up for viewing
        vw = min(1024, field.width * args.scale)
        big = field.resize((vw, vw), Image.NEAREST)
        out = args.out or f"/tmp/field-{s}.png"
        big.save(out)
        n_variants = len(load_pool(args.theme, s))
        print(f"{s:9s} {n_variants} variants  field {args.n}x{args.n}  "
              f"tile-shift-diff={repeat_metric(field, T):5.1f}  -> {out}")


if __name__ == "__main__":
    main()
