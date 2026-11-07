#!/usr/bin/env python3
"""Compose the held-weapon zoom sheets from weapon-zoom-sheet.mjs's raw captures.

    python3 e2e/weapon_zoom_compose.py OUT_DIR/LABEL.json

Per pose: one cell per (archetype, facing), cropped around the feet from the
2x-device screenshot (one hi-res art pixel = one pixel there) and enlarged 4x
nearest-neighbour, so every art pixel is a 4x4 block. Writes
LABEL-<pose>-4x.png and LABEL-<pose>-1x.png (the same cells unenlarged).
"""
import json
import os
import sys

from PIL import Image, ImageDraw

W, H = 96, 104  # crop around the feet, in screenshot px (= hi-res art px)
Z = 4
PAD, HEAD = 6, 18


def main():
    meta = json.load(open(sys.argv[1]))
    out = os.path.dirname(sys.argv[1])
    rows, facings = meta["rows"], meta["facings"]
    for pose, p in meta["poses"].items():
        raw = Image.open(p["raw"]).convert("RGB")
        for z in (Z, 1):
            cw, ch = W * z + PAD, H * z + PAD
            sheet = Image.new("RGB", (cw * len(facings) + 90, ch * len(rows) + HEAD), (16, 16, 20))
            d = ImageDraw.Draw(sheet)
            for i, f in enumerate(facings):
                d.text((90 + i * cw + 4, 3), f, fill=(230, 230, 230))
            for j, (arch, weapon, *rest) in enumerate(rows):
                mods = "+".join(m["id"] for m in rest[0]) if rest else ""
                d.text((4, HEAD + j * ch + 4), f"{arch}\n{weapon}\n{mods}", fill=(230, 230, 230))
            for c in p["feet"]:
                x, y = round(c["x"]), round(c["y"])
                cell = raw.crop((x - W // 2, y - H + 6, x + W // 2, y + 6))
                if z != 1:
                    cell = cell.resize((W * z, H * z), Image.NEAREST)
                sheet.paste(cell, (90 + c["col"] * cw, HEAD + c["row"] * ch))
            d.text((4, sheet.height - 14), f"{meta['label']} {pose} {meta['theme']} weapons={meta['weapons']}", fill=(150, 150, 150))
            sheet.save(os.path.join(out, f"{meta['label']}-{pose}-{z}x.png"))
    print(f"[zoom-sheet] {len(meta['poses'])} poses -> {out}")


if __name__ == "__main__":
    main()
