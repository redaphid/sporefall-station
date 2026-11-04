#!/usr/bin/env python3
"""One direction of several 96 px takes side by side, at game scale, plus a crest count per frame.

  python3 compare_takes.py --kind mireclaw-stalker --dir se --out /mnt/d/tmp/cast-walks/skeleton-test/cmp \
      shipped=<dir> A-skeleton=<run>-pal/frames B-legs=<run>-pal/frames

Each <dir> holds <kind>-<dir>-{idle,step,walk-0..7}.png at 96 px. Writes <out>-contact-96.png (one row
per take, 96 px x2 on the game background), <out>-walk-96.gif (the walks side by side at 1x, as the
game draws them) and <out>-walk-96@3x.gif, and prints the crest count: bone-coloured pixels (hue
25-55 deg, the crest spines, fangs and knee spurs) in the top 40% of each frame's sprite.
"""
import argparse
import colorsys
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from cast_walk import BG, POSES  # noqa: E402


def bone_top(im):
    a = np.asarray(im.convert("RGBA"))
    solid = a[..., 3] > 127
    rows = np.where(solid.any(1))[0]
    if not len(rows):
        return 0
    cut = rows.min() + int(0.4 * (rows.max() - rows.min()))
    n = 0
    for y in range(rows.min(), cut + 1):
        for x in np.where(solid[y])[0]:
            h, s, v = colorsys.rgb_to_hsv(*(a[y, x, :3] / 255.0))
            n += int(25 <= h * 360 <= 55 and 0.15 <= s <= 0.6 and v >= 0.45)
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True)
    ap.add_argument("--dir", default="se")
    ap.add_argument("--out", required=True)
    ap.add_argument("takes", nargs="+", help="name=dir of 96 px frames")
    a = ap.parse_args()
    takes = [t.split("=", 1) for t in a.takes]
    frames = {n: [Image.open(os.path.join(d, f"{a.kind}-{a.dir}-{p}.png")).convert("RGBA") for p in POSES]
              for n, d in takes}

    s, lab, cell = 2, 90, 192
    sheet = Image.new("RGB", (lab + cell * len(POSES), cell * len(takes)), BG)
    dr = ImageDraw.Draw(sheet)
    for r, (n, _) in enumerate(takes):
        dr.text((4, r * cell + cell // 2), f"{n}\n{a.dir}", fill=(200, 210, 200))
        for c, fr in enumerate(frames[n]):
            big = fr.resize((96 * s, 96 * s), Image.NEAREST)
            sheet.paste(big, (lab + c * cell, r * cell), big)
    sheet.save(f"{a.out}-contact-96.png")

    for scale, tag in ((1, ""), (3, "@3x")):
        seq = []
        for i in range(8):
            fr = Image.new("RGB", (96 * scale * len(takes), 96 * scale), BG)
            for c, (n, _) in enumerate(takes):
                w = frames[n][2 + i].resize((96 * scale, 96 * scale), Image.NEAREST)
                fr.paste(w, (c * 96 * scale, 0), w)
            seq.append(fr)
        # anim.walk = 4: a walk frame every 4 ticks at 60 Hz
        seq[0].save(f"{a.out}-walk-96{tag}.gif", save_all=True, append_images=seq[1:], duration=67, loop=0)

    crest = {n: {"idle": bone_top(fr[0]), "walk": [bone_top(f) for f in fr[2:]]} for n, fr in frames.items()}
    for v in crest.values():
        v["walk_mean"] = round(float(np.mean(v["walk"])), 1)
    print(json.dumps(crest))
    json.dump(crest, open(f"{a.out}-crest.json", "w"), indent=1)


if __name__ == "__main__":
    main()
