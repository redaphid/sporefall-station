#!/usr/bin/env python3
"""Contact sheets for the curated swampspace pack.

Writes per-category sheets + one whole-pack sheet to docs/assets/swampspace/
(non-shipping location), plus a 4x4 tiling proof for each tile.

Usage: python3 sheets.py
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate as G
import post as P

OUT = os.path.join(G.REPO, "docs", "assets", "swampspace")


def gather(sub):
    d = os.path.join(G.THEME, sub)
    if not os.path.isdir(d):
        return []
    return [(f[:-4], Image.open(os.path.join(d, f)))
            for f in sorted(os.listdir(d)) if f.endswith(".png")]


def main():
    os.makedirs(OUT, exist_ok=True)
    all_pairs = []
    for sub, cols, scale in (("tiles", 6, 3), ("chars", 10, 2), ("props", 6, 3),
                             ("items", 8, 3), ("fx", 6, 2)):
        pairs = gather(sub)
        if not pairs:
            continue
        P.contact_sheet(pairs, cols=cols, cell=110, scale=scale).save(
            os.path.join(OUT, f"{sub}.png"))
        print(f"{sub}: {len(pairs)} sprites -> docs/assets/swampspace/{sub}.png")
        all_pairs += pairs
    if all_pairs:
        P.contact_sheet(all_pairs, cols=12, cell=100, scale=2).save(
            os.path.join(OUT, "pack.png"))
        print(f"pack: {len(all_pairs)} sprites -> docs/assets/swampspace/pack.png")
    # tiling proof: each tile repeated 4x4
    for name, im in gather("tiles"):
        t = Image.new("RGB", (im.width * 4, im.height * 4))
        for j in range(4):
            for i in range(4):
                t.paste(im, (i * im.width, j * im.height))
        t = t.resize((t.width * 2, t.height * 2), Image.NEAREST)
        t.save(os.path.join(OUT, f"tiling-{name}.png"))
        print(f"tiling proof: docs/assets/swampspace/tiling-{name}.png "
              f"(seam energy {P.seam_energy(im):.1f})")


if __name__ == "__main__":
    main()
