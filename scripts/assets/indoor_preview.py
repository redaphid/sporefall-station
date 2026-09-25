#!/usr/bin/env python3
"""Textured previews of the indoor-complex tile art, composed WITHOUT a browser
(headless WebGL is unreliable on the dev box).

  1. contact sheet of every indoor tile pool in the theme (base + accents)
  2. per level: a full-map overview + a native-resolution crop around spawn,
     assembled the way src/render/tilemap.ts does it — coordHash variant pick,
     macro-slice placement (tileSelect.pickTileVariant), 1-in-17 accents,
     wall-contact shadow strips, and the biome floor grade (complexLook.ts).

Level grids come from dump_complex_levels.mts (the real generator):

  pnpm exec tsx scripts/assets/dump_complex_levels.mts /tmp/complex-levels.json 3:3 3:4 3:5 3:6
  python3 scripts/assets/indoor_preview.py /tmp/complex-levels.json docs/assets/indoor-tiles
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
THEME = os.path.join(ROOT, "public/themes/swampspace-hires")
TILE_ID = {"street": 0, "sidewalk": 1, "floor": 2, "wall": 3, "grass": 4, "exit": 5,
           "hall": 10, "grate": 11, "tiled": 12, "plating": 13, "hull": 14, "bog": 15}
WALLS = {3, 6, 7, 8, 9, 14}
INDOOR = ["hall", "grate", "tiled", "plating", "hull", "bog"]
BIOME_TINT = {"habitation": 0xF2ECDE, "flooded": 0xBFE0CF, "reactor": 0xF0D2B4, "overgrown": 0xC9E6B0}
ACCENT_EVERY = 17
M32 = 0xFFFFFFFF


def imul(a, b):
    return ((a & M32) * (b & M32)) & M32


def coord_hash(tx, ty):
    h = imul((tx & M32) ^ 0x9E3779B9, 0x85EBCA6B) ^ imul((ty & M32) ^ 0xC2B2AE35, 0x27D4EB2F)
    h = imul(h ^ (h >> 15), 0x2545F491)
    return h & M32


def pick_variant(n, macro, tx, ty, h):
    if macro and macro >= 2 and n >= macro * macro:
        per = macro * macro
        quad = (ty % macro) * macro + (tx % macro)
        n_macros = n // per
        m = coord_hash(tx // macro, ty // macro) % n_macros if n_macros > 1 else 0
        return m * per + quad
    return (h >> 2) % n


def load_pools():
    m = json.load(open(os.path.join(THEME, "manifest.json")))
    sp, macro = m["sprites"], m.get("macroTiles", {})
    load = lambda f: Image.open(os.path.join(THEME, f)).convert("RGB")  # noqa: E731
    pools, accents = {}, {}
    for name in TILE_ID:
        v = sp.get(f"tile.{name}")
        if v:
            pools[name] = [load(f) for f in (v if isinstance(v, list) else [v])]
        a = sp.get(f"tile.{name}.accent")
        if a:
            accents[name] = [load(f) for f in (a if isinstance(a, list) else [a])]
    return pools, accents, macro


def contact_sheet(pools, accents, out, scale=2):
    T = 64 * scale
    rows = [(n, pools[n] + accents.get(n, [])) for n in INDOOR if n in pools]
    cols = max(len(r[1]) for r in rows)
    lab = 120
    sheet = Image.new("RGB", (lab + cols * (T + 6), len(rows) * (T + 6) + 6), (12, 14, 18))
    d = ImageDraw.Draw(sheet)
    for r, (name, ims) in enumerate(rows):
        y = 6 + r * (T + 6)
        d.text((8, y + T // 2 - 12), name, fill=(220, 230, 220))
        d.text((8, y + T // 2 + 2), f"{len(pools[name])}+{len(accents.get(name, []))}acc", fill=(140, 150, 140))
        for i, im in enumerate(ims):
            x = lab + i * (T + 6)
            sheet.paste(im.resize((T, T), Image.NEAREST), (x, y))
            if i >= len(pools[name]):
                d.rectangle((x - 2, y - 2, x + T + 1, y + T + 1), outline=(70, 224, 120))
    sheet.save(out)
    print(out)


def compose(level, pools, accents, macro, px=64):
    w, h, tiles = level["w"], level["h"], level["tiles"]
    img = np.zeros((h * px, w * px, 3), np.float32)
    cache = {}

    def tex(name, i, acc=False):
        k = (name, i, acc)
        if k not in cache:
            src = (accents if acc else pools)[name][i]
            cache[k] = np.asarray(src.resize((px, px), Image.NEAREST), np.float32)
        return cache[k]

    name_by_id = {v: k for k, v in TILE_ID.items()}
    ramp = np.linspace(0.42, 0.0, max(2, px // 8))  # wall-contact shadow strip
    for ty in range(h):
        for tx in range(w):
            t = tiles[ty * w + tx]
            name = name_by_id.get(t, "wall" if t in WALLS else "floor")
            if name not in pools:
                name = "wall" if t in WALLS else "floor"
            hsh = coord_hash(tx, ty)
            if name in accents and hsh % ACCENT_EVERY == 0:
                a = accents[name]
                tile = tex(name, (hsh >> 5) % len(a), True)
            else:
                tile = tex(name, pick_variant(len(pools[name]), macro.get(name), tx, ty, hsh))
            cell = tile.copy()
            if t not in WALLS:
                for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
                    nx, ny = tx + dx, ty + dy
                    if 0 <= nx < w and 0 <= ny < h and tiles[ny * w + nx] in WALLS:
                        n = len(ramp)
                        if dy == -1:
                            cell[:n] *= (1 - ramp)[:, None, None]
                        elif dy == 1:
                            cell[-n:] *= (1 - ramp[::-1])[:, None, None]
                        elif dx == -1:
                            cell[:, :n] *= (1 - ramp)[None, :, None]
                        else:
                            cell[:, -n:] *= (1 - ramp[::-1])[None, :, None]
            img[ty * px:(ty + 1) * px, tx * px:(tx + 1) * px] = cell
    tint = BIOME_TINT.get(level.get("biome") or "", 0xFFFFFF)
    img *= np.array([(tint >> 16) & 255, (tint >> 8) & 255, tint & 255], np.float32) / 255
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


def main():
    levels = json.load(open(sys.argv[1]))
    out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/indoor-preview"
    os.makedirs(out, exist_ok=True)
    pools, accents, macro = load_pools()
    contact_sheet(pools, accents, os.path.join(out, "indoor-tiles-contact.png"))
    for lv in levels:
        tag = f"seed{lv['seed']}-floor{lv['floor']}-{lv['biome']}"
        full = compose(lv, pools, accents, macro, px=16)
        p = os.path.join(out, f"map-{tag}.png")
        full.save(p)
        print(p)
        # native-res crop (64px tiles = the hires art 1:1) around the densest
        # module cluster: the centre of the rooms' bounding box
        rooms = [r["rect"] for r in lv["rooms"]] or [{"x": 0, "y": 0, "w": lv["w"], "h": lv["h"]}]
        cx = int(np.median([r["x"] + r["w"] / 2 for r in rooms]))
        cy = int(np.median([r["y"] + r["h"] / 2 for r in rooms]))
        cw, ch = 24, 14
        x0 = max(0, min(lv["w"] - cw, cx - cw // 2))
        y0 = max(0, min(lv["h"] - ch, cy - ch // 2))
        # keep the coordinate hash in WORLD coords: compose on the full level, crop after
        crop = compose(lv, pools, accents, macro, px=64).crop((x0 * 64, y0 * 64, (x0 + cw) * 64, (y0 + ch) * 64))
        p = os.path.join(out, f"closeup-{tag}.png")
        crop.save(p)
        print(p)


if __name__ == "__main__":
    main()
