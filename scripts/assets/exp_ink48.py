#!/usr/bin/env python3
"""Make the 48px ink_rim question answerable by looking (art-loop).

`restyle.py` applies `ink_rim()` at 96px only. Its docstring gives the reason:
the 96px cast carries a literal 1px #08080c line on every boundary pixel
(rim_dark_frac 1.000) but the 48px cast does NOT (rim luma 8..210, median 74),
and at 48px one pixel is twice the proportional weight it has at 96px. That is
an argument, not a picture, and it has been sitting unanswered with the owner.

This writes the picture: the six creatures at 48px WITHOUT the ink line (what
ships today) directly above the same six WITH it, and two cast sprites at the
same scale for reference. Nothing here changes what ships.

  python3 exp_ink48.py --out docs/assets/ink-rim-48px-question.png
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BG = (24, 26, 30, 255)
CAST = ["vine-ranger", "bog-mutant"]


def main():
    import restyle as R
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=int, default=6)
    a = ap.parse_args()

    names = list(R.RAMPS)
    S = a.scale
    cell = 48 * S
    pad = 8
    lab = 22
    ncol = len(names) + len(CAST)
    W = pad + ncol * (cell + pad)
    H = lab + 2 * (cell + pad + lab)
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)

    for row, ink in enumerate((False, True)):
        y = lab + row * (cell + pad + lab)
        d.text((pad, y - lab + 4),
               "SHIPS TODAY - no ink line, 48px" if not ink
               else "WITH ink_rim() 1px #08080c at 48px",
               fill=(230, 230, 230, 255))
        for i, n in enumerate(names):
            # 48px target from restyle.TARGETS: canvas 48, content 46.
            im = R.build(n, 48, 46, ink)
            sheet.paste(im.resize((cell, cell), Image.NEAREST),
                        (pad + i * (cell + pad), y), im.resize((cell, cell), Image.NEAREST))
            d.text((pad + i * (cell + pad), y + cell + 1), n[:14], fill=(150, 150, 150, 255))
        for j, n in enumerate(CAST):
            i = len(names) + j
            p = os.path.join(REPO, "public", "themes", "swampspace", "chars", f"{n}-s-idle.png")
            im = Image.open(p).convert("RGBA")
            big = im.resize((cell, cell), Image.NEAREST)
            sheet.paste(big, (pad + i * (cell + pad), y), big)
            d.text((pad + i * (cell + pad), y + cell + 1), f"CAST {n[:10]}",
                   fill=(150, 150, 150, 255))

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    sheet.save(a.out)
    print(f"{a.out} {sheet.size}")


if __name__ == "__main__":
    main()
