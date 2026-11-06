#!/usr/bin/env python3
"""Export the held-weapon pixel art (src/render/weaponSprites.ts) as indexed PNGs.

The drawings live in the TS module as literal rows (one char per pixel, the
locked palette only). This reads them back so the art pipeline, and anyone
painting the same prop into a character clip, works from the shipped pixels:

    python3 scripts/assets/weapon_sprites.py OUT_DIR            # every grid/class/view
    python3 scripts/assets/weapon_sprites.py OUT_DIR --sheet 8  # plus a zoomed contact sheet
    python3 scripts/assets/weapon_sprites.py OUT_DIR --only pistol

Each PNG is palette-indexed (P mode, index 0 transparent) and named
`<class>-<view>@<grid>x.png`; `weapons.json` beside them records each drawing's
grip and muzzle pixel. The west half of the compass is these mirrored.
"""
import argparse
import json
import os
import re

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "src", "render", "weaponSprites.ts")
VIEWS = ["e", "se", "s", "ne", "n"]


def parse_ts(path=SRC):
    """{grid: {class: {view: [rows]}}} and the ink table, read from the TS module."""
    text = open(path).read()
    ink = {}
    block = text[text.index("WEAPON_INK"):]
    block = block[: block.index("}")]
    for k, v in re.findall(r"'?([^\s':]+)'?: 0x([0-9a-fA-F]{6})", block):
        ink[k] = "#" + v.lower()
    sheets = {}
    for grid in ("1", "2"):
        start = text.index(f"const GRID{grid}: Sheet = {{")
        body = text[start: text.index("\n}\n", start)]
        cls = view = None
        out = {}
        for line in body.splitlines()[1:]:
            m = re.match(r"^  (\w+): \{", line)
            if m:
                cls = m.group(1); out[cls] = {}; continue
            m = re.match(r"^    (\w+): \[", line)
            if m:
                view = m.group(1); out[cls][view] = []; continue
            m = re.match(r"^      '([^']*)',", line)
            if m:
                out[cls][view].append(m.group(1))
        sheets[int(grid)] = out
    return sheets, ink


def to_png(rows, ink):
    """Indexed image: index 0 transparent, then the ink colours in table order."""
    keys = list(ink)
    pal_hex = []
    for k in keys:
        if ink[k] not in pal_hex:
            pal_hex.append(ink[k])
    w, h = max(map(len, rows)), len(rows)
    im = Image.new("P", (w, h), 0)
    flat = [0, 0, 0]
    for c in pal_hex:
        flat += [int(c[i:i + 2], 16) for i in (1, 3, 5)]
    im.putpalette(flat + [0] * (768 - len(flat)))
    for y, r in enumerate(rows):
        for x, ch in enumerate(r):
            if ch != ".":
                im.putpixel((x, y), 1 + pal_hex.index(ink[ch]))
    im.info["transparency"] = 0
    return im


def marker(rows, ch):
    for y, r in enumerate(rows):
        if ch in r:
            return [r.index(ch), y]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--sheet", type=int, default=0, help="also write a contact sheet at this zoom")
    ap.add_argument("--only", default=None, help="one class")
    a = ap.parse_args()
    sheets, ink = parse_ts()
    os.makedirs(a.out, exist_ok=True)
    meta = {}
    for grid, classes in sheets.items():
        for cls, views in classes.items():
            if a.only and cls != a.only:
                continue
            for view in VIEWS:
                rows = views[view]
                name = f"{cls}-{view}@{grid}x.png"
                to_png(rows, ink).save(os.path.join(a.out, name), transparency=0)
                meta[name] = {"grip": marker(rows, "@"), "muzzle": marker(rows, "*") or marker(rows, "@")}
    json.dump(meta, open(os.path.join(a.out, "weapons.json"), "w"), indent=1)
    if a.sheet:
        for grid, classes in sheets.items():
            cells = [[to_png(classes[c][v], ink).convert("RGBA") for v in VIEWS]
                     for c in classes if not a.only or c == a.only]
            cw = max(i.width for r in cells for i in r) + 4
            ch = max(i.height for r in cells for i in r) + 4
            s = Image.new("RGBA", (cw * len(VIEWS), ch * len(cells)), (84, 104, 96, 255))
            for j, r in enumerate(cells):
                for i, im in enumerate(r):
                    s.alpha_composite(im, (i * cw + 2, j * ch + 2))
            s.resize((s.width * a.sheet, s.height * a.sheet), Image.NEAREST).save(
                os.path.join(a.out, f"sheet@{grid}x.png"))
    print(f"{len(meta)} drawings -> {a.out}")


if __name__ == "__main__":
    main()
