#!/usr/bin/env python3
"""The aim review sheet: every facing x (idle | aim-n | aimwalk 0-7 | shipped walk 0-7) at 4x nearest on the
game's floor colour, plus a GIF per character (aim hold, then aimwalk beside the shipped walk, all facings).

  python3 aim_sheet.py --kind vine-ranger [--src DIR] --out DIR [--zoom 4] [--pack swampspace-hires]

--src: a `cast_action.py post` dir holding <px>/<kind>-<dir>-{aim,aimwalk}-<n>.png (default: the pack itself).
"""
import argparse
import glob
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import cast_walk as CW  # noqa: E402


def frames(src, px, kind, d, state):
    fs = glob.glob(os.path.join(src, f"{kind}-{d}-{state}-*.png"))
    return sorted(fs, key=lambda f: int(f.rsplit("-", 1)[1][:-4]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kind", required=True)
    ap.add_argument("--src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--zoom", type=int, default=4)
    ap.add_argument("--pack", default="swampspace-hires")
    a = ap.parse_args()
    px = CW.PACKS[a.pack][0]
    chars = os.path.join(CW.THEMES, a.pack, "chars")
    src = os.path.join(a.src, str(px)) if a.src else chars
    z, cell = a.zoom, px * a.zoom
    rows = []
    for d in CW.DIRS:
        aim, walk = frames(src, px, a.kind, d, "aim"), frames(src, px, a.kind, d, "aimwalk")
        shipped = [os.path.join(chars, f"{a.kind}-{d}-walk-{n}.png") for n in range(8)]
        rows.append((d, [os.path.join(chars, f"{a.kind}-{d}-idle.png")], aim, walk, shipped))
    ncol = max(1 + len(r[2]) + len(r[3]) + len(r[4]) for r in rows)
    gap = 8
    W, H = 50 + ncol * (cell + 2) + 3 * gap, 30 + len(rows) * (cell + 2)
    sheet = Image.new("RGB", (W, H), CW.BG)
    dr = ImageDraw.Draw(sheet)
    dr.text((50, 8), f"{a.kind} {px}px x{z}: idle | aim | aimwalk 0-7 | shipped walk 0-7", fill=(220, 220, 200))
    for r, (d, idle, aim, walk, shipped) in enumerate(rows):
        y = 30 + r * (cell + 2)
        dr.text((8, y + cell // 2), d, fill=(220, 220, 200))
        x = 50
        for group in (idle, aim, walk, shipped):
            for f in group:
                im = Image.open(f).convert("RGBA").resize((cell, cell), Image.NEAREST)
                sheet.paste(im, (x, y), im)
                x += cell + 2
            x += gap
    os.makedirs(a.out, exist_ok=True)
    sp = os.path.join(a.out, f"{a.kind}-aim-zoom{z}-{px}.png")
    sheet.save(sp)
    # GIF: per facing two cells, aim then aimwalk on the left, the shipped walk on the right, at 3x
    g = 3
    gc = px * g
    gif = []
    for i in range(32):
        f = Image.new("RGB", (len(rows) * (2 * gc + 6), gc), CW.BG)
        for c, (d, idle, aim, walk, shipped) in enumerate(rows):
            left = aim[(i // 4) % len(aim)] if i < 8 and aim else (walk[(i // 1) % len(walk)] if walk else idle[0])
            right = shipped[i % 8]
            for k, p in enumerate((left, right)):
                im = Image.open(p).convert("RGBA").resize((gc, gc), Image.NEAREST)
                f.paste(im, (c * (2 * gc + 6) + k * gc, 0), im)
        gif.append(f)
    gp = os.path.join(a.out, f"{a.kind}-aim-{g}x-{px}.gif")
    gif[0].save(gp, save_all=True, append_images=gif[1:], duration=133, loop=0)  # 4 ticks of 30 Hz per walk frame
    print(sp)
    print(gp)


if __name__ == "__main__":
    main()
