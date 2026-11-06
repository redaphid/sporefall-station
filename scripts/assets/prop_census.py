#!/usr/bin/env python3
"""Census contact sheet: every default-loaded prop key at game scale beside the cast.

usage: census.py REPO OUT.png [--grades grades.json] [--title T]
Hi-res pack: props 64px (32 logical), cast 96px (48 logical); shown at Zx nearest,
on the pack's own plating/tiled/floor tiles, plus a 1:1 strip (true pixels)."""
import json, sys, argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("repo"); ap.add_argument("out")
ap.add_argument("--grades"); ap.add_argument("--title", default="prop census")
ap.add_argument("--z", type=int, default=2)
a = ap.parse_args()
R = Path(a.repo) / "public/themes/swampspace-hires"
m = json.load(open(R / "manifest.json"))["sprites"]
keys = [k for k in m if k.startswith("prop.")]
byfile = {}
for k in keys:
    byfile.setdefault(m[k], []).append(k)
grades = json.load(open(a.grades)) if a.grades else {}
def F(s):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/mnt/c/Windows/Fonts/consola.ttf"]:
        try: return ImageFont.truetype(p, s)
        except OSError: pass
    return ImageFont.load_default()
Z = a.z
tiles = [Image.open(R / f"tiles/{t}.png").convert("RGBA") for t in ("plating-0", "tiled-0", "floor-0") if (R / f"tiles/{t}.png").exists()]
def tilebg(w, h, t):
    bg = Image.new("RGBA", (w, h))
    tt = t.resize((64 * Z, 64 * Z), Image.NEAREST)
    for y in range(0, h, tt.height):
        for x in range(0, w, tt.width): bg.paste(tt, (x, y))
    return bg
cast = ["vine-ranger", "mycologist", "derelict-bot"]
cellw, cellh = 64 * Z * len(tiles) + 16, 64 * Z + 8
rowh = cellh + 34
W = 24 + 64 + 12 + cellw + 12 + 860
files = list(byfile)
H = 70 + len(files) * rowh + 96 * Z + 60
sh = Image.new("RGBA", (W, H), (22, 24, 30, 255)); d = ImageDraw.Draw(sh)
d.text((16, 10), a.title, font=F(20), fill=(235, 238, 245))
d.text((16, 38), f"hi-res pack, {Z}x nearest: prop 64px = 32 logical, cast 96px = 48 logical (true relative scale). left: 1:1 pixels.", font=F(13), fill=(150, 156, 168))
y = 70
for f in files:
    im = Image.open(R / f).convert("RGBA")
    x = 16
    sh.alpha_composite(tilebg(64, 64, tiles[0]).resize((64, 64)) if False else Image.new("RGBA", (64, 64), (99, 82, 63, 255)), (x, y))
    sh.alpha_composite(im, (x, y)); x += 76
    for t in tiles:
        bg = tilebg(64 * Z, 64 * Z, t); bg.alpha_composite(im.resize((64 * Z, 64 * Z), Image.NEAREST))
        sh.alpha_composite(bg, (x, y)); x += 64 * Z + 8
    x += 8
    name = Path(f).stem
    g = grades.get(name, {})
    d.text((x, y + 4), f"{name}  ->  {', '.join(byfile[f])}", font=F(16), fill=(235, 238, 245))
    if g:
        col = {"A": (110, 220, 130), "B": (170, 220, 110), "C": (235, 210, 90), "D": (240, 150, 70), "F": (240, 80, 70)}[g["grade"][0]]
        d.text((x, y + 30), g["grade"], font=F(30), fill=col)
        words, line, ly = g["why"].split(), "", y + 34
        for w_ in words:
            if len(line) + len(w_) > 70: d.text((x + 60, ly), line, font=F(13), fill=(200, 204, 214)); ly += 17; line = ""
            line += w_ + " "
        d.text((x + 60, ly), line, font=F(13), fill=(200, 204, 214))
    y += rowh
d.text((16, y), "the cast, same zoom, on plating:", font=F(13), fill=(150, 156, 168)); y += 20
x = 16
for c in cast:
    bg = tilebg(96 * Z, 96 * Z, tiles[0]); bg.alpha_composite(Image.open(R / f"chars/{c}-s-idle.png").convert("RGBA").resize((96 * Z, 96 * Z), Image.NEAREST))
    sh.alpha_composite(bg, (x, y)); x += 96 * Z + 10
# a crate next to the ranger at shared scale
sh.convert("RGB").save(a.out); print(a.out, sh.size)
