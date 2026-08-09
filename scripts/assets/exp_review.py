#!/usr/bin/env python3
"""Build review contact sheets for experimental sprite raws (art-loop).

Judging a sprite at 1024 is how the grey shadow slab shipped once already
(art-gen.md). Everything here is judged at the sizes players actually see:
48px (the `swampspace` pack) and 96px (`swampspace-hires`, the DEFAULT theme
per src/app/settings.ts), with a 4x nearest-neighbour blow-up of each so the
pixels are legible, and always BESIDE shipped cast sprites because the
complaint was always comparative.

  # plain post-processing (silhouette review)
  python3 exp_review.py D:/tmp/art-loop/i1 --out D:/tmp/art-loop/i1-sheet.png
  # with the cinder-husk colour ramp applied (final-look review)
  python3 exp_review.py D:/tmp/art-loop/i1 --ramp cinder-husk --out ...
"""
import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BG = (24, 26, 30, 255)


def process(raw_path, px, content, ink, ramp=None):
    """Reproduce the shipped pipeline for one raw. With --ramp this is
    restyle.build()'s body; without it, plain post.sprite()."""
    import post as P
    src = Image.open(raw_path)
    if not P.has_alpha(src):
        import numpy as np
        bg_lum = float(P.corner_bg(src) @ np.array([0.2126, 0.7152, 0.0722]))
        src = P.flat_key(src) if bg_lum > 128 else P.black_key(src)
    src, _ = P.strip_ground_shadow(src)
    im = P.bbox_crop(src)

    if ramp:
        import restyle as R
        spec = R.RAMPS[ramp]
        im = R.denoise(im, content)
        im = R.ramp_grade(im, spec["ramp"], spec.get("accent"),
                          spec.get("accent_q", 0.94), spec.get("equalize", 0.85))

    w, h = im.size
    if w >= h:
        tw, th = content, max(1, round(content * h / w))
    else:
        tw, th = max(1, round(content * w / h)), content
    im = P.to_palette(P.kcentroid(im, tw, th))
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(im, ((px - tw) // 2, max(0, px - th - 1)))
    if ink:
        import restyle as R
        out = R.ink_rim(out)
    return out


def cast_tile(name, px):
    theme = "swampspace-hires" if px == 96 else "swampspace"
    p = os.path.join(REPO, "public", "themes", theme, "chars", f"{name}-s-idle.png")
    return Image.open(p).convert("RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="dir of experiment raws (subdirs = conditions)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ramp", default=None)
    ap.add_argument("--px", type=int, default=96)
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("--ink", action="store_true", default=None)
    ap.add_argument("--cast", default="carapace-brute,mireclaw-stalker,vine-ranger")
    a = ap.parse_args()

    px = a.px
    content = 92 if px == 96 else 46
    ink = (px == 96) if a.ink is None else a.ink
    S = a.scale

    rows = []  # (label, [tiles])
    for cast in [c for c in a.cast.split(",") if c]:
        rows.append((f"CAST {cast}", [cast_tile(cast, px)]))

    conds = sorted(d for d in os.listdir(a.root)
                   if os.path.isdir(os.path.join(a.root, d)) and not d.startswith("_"))
    for c in conds:
        files = sorted(glob.glob(os.path.join(a.root, c, "*.png")))
        tiles = []
        for f in files:
            try:
                tiles.append(process(f, px, content, ink, a.ramp))
            except Exception as e:  # a keying failure should not lose the sheet
                print(f"  !! {os.path.basename(f)}: {e}")
        if tiles:
            rows.append((c, tiles))

    ncol = max(len(t) for _, t in rows)
    lab = 150
    cell = px * S
    W = lab + ncol * (cell + 8)
    H = len(rows) * (cell + 8)
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    for r, (label, tiles) in enumerate(rows):
        y = r * (cell + 8)
        d.text((6, y + cell // 2), label, fill=(220, 220, 220, 255))
        for i, t in enumerate(tiles):
            big = t.resize((cell, cell), Image.NEAREST)
            sheet.paste(big, (lab + i * (cell + 8), y), big)
    sheet.save(a.out)
    print(f"{a.out}  {sheet.size}  rows={len(rows)} px={px} ink={ink} ramp={a.ramp}")


if __name__ == "__main__":
    main()
