#!/usr/bin/env python3
"""Draw today's gun, gem and round next to the proposed launcher, bubble and
glass round, at game pixel size on four floors, then upscale 4x.

Run from the repo root:  python3 docs/design/setting-fit/sketch.py
Needs Pillow 10.1 or newer. Writes docs/design/setting-fit/sketch.png.

This is a mock of the proposals in setting-fit.md, drawn with PIL, not the
engine. What it reads live:
  - floor colours from public/themes/swampspace-hires/manifest.json
  - gem colours from MOD_PICKUP_COLORS in src/render/modColors.ts
  - the default theme's round, public/themes/swampspace-hires/fx/spore-bolt.png
  - every proposed colour from PALETTE in scripts/assets/palette.py
What it copies by hand, so re-check it if the source changes:
  - the pistol and gem geometry from src/render/art.ts (case 'gun', the
    `mod.` branch), and the pistol's steel and grip colours
  - the composed Incendiary colour #ff9217, printed by round-colours.mts
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / "scripts" / "assets"))
from palette import PALETTE  # noqa: E402

OUT = ROOT / "docs/design/setting-fit/sketch.png"
SCALE = 4
TILES = json.loads((ROOT / "public/themes/swampspace-hires/manifest.json").read_text())["palette"]["tiles"]
FLOORS = {k: TILES[k] for k in ("bog", "floor", "plating", "tiled")}
_mod_src = (ROOT / "src/render/modColors.ts").read_text().split("MOD_PICKUP_COLORS", 1)[1].split("}", 1)[0]
GEMS = {m[0]: "#" + m[1] for m in re.findall(r"(\w+):\s*0x([0-9a-fA-F]{6})", _mod_src)}
BOLT = Image.open(ROOT / "public/themes/swampspace-hires/fx/spore-bolt.png").convert("RGBA")
INCENDIARY_COMPOSED = "#ff9217"


def pal(h):
    assert h in PALETTE, f"{h} is not in the locked palette"
    return h


INK, BRASS_D, BRASS, BRASS_L = pal("#08080c"), pal("#6b4d26"), pal("#b08d50"), pal("#cbb277")
GLASS, BONE, LEATHER = pal("#7ecbd2"), pal("#f2f6ea"), pal("#4a3419")
FAMILY = {"storm": pal("#a05ae0"), "cold": pal("#a6ffbe"), "flame": pal("#ff9032"), "flight": pal("#ffd83e")}


def rgba(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def layer(w, h):
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def pistol_today():
    im, d = layer(44, 18)
    gx, my = 5, 9
    top = my - 5
    d.polygon([(gx - 1, top + 4), (gx + 6, top + 4), (gx + 4, my + 9), (gx - 3, my + 8)], fill=rgba("#33363d"))
    d.ellipse([gx + 5, my, gx + 11, my + 6], outline=rgba("#2a2c33"))
    d.rounded_rectangle([gx - 1, top, gx + 21, top + 7], 1, fill=rgba("#b8bcc6"), outline=rgba("#101018"))
    d.rectangle([gx + 20, my - 2, 41, my + 1], fill=rgba("#6d7079"))
    return im


def launcher_proposed(glow):
    im, d = layer(44, 18)
    my = 9
    d.rectangle([2, my - 1, 10, my + 6], fill=rgba(BRASS_D))
    d.rectangle([3, my + 2, 9, my + 3], fill=rgba(LEATHER))
    d.rectangle([10, my - 2, 36, my + 1], fill=rgba(BRASS), outline=rgba(INK))
    d.line([(11, my - 2), (35, my - 2)], fill=rgba(BRASS_L))
    d.ellipse([12, my - 6, 22, my + 4], fill=rgba(glow, 200), outline=rgba(INK))
    d.ellipse([14, my - 4, 16, my - 2], fill=rgba(BONE))
    d.ellipse([36, my - 6, 42, my + 5], outline=rgba(GLASS, 220))
    return im


def gem_today(color):
    im, d = layer(32, 32)
    r = 32 * 0.28
    o = 16 - r
    outer = [(o + r, o), (o + 2 * r, o + r), (o + r, o + 2 * r), (o, o + r)]
    inner = [(o + r, o + r * 0.35), (o + r * 1.55, o + r), (o + r, o + r * 1.65), (o + r * 0.45, o + r)]
    d.polygon(outer, fill=rgba(color), outline=rgba("#101018", 153))
    d.polygon(inner, outline=rgba("#ffffff", 90))
    return im


def bubble_proposed(glow=None):
    im = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    if glow:
        ImageDraw.Draw(im).ellipse([4, 4, 28, 28], fill=rgba(glow, 70))
    d = ImageDraw.Draw(im)
    d.ellipse([7, 7, 25, 25], fill=rgba(glow or GLASS, 90), outline=rgba(INK))
    d.ellipse([8, 8, 24, 24], outline=rgba(glow or BONE, 230))
    d.rectangle([13, 15, 19, 20], fill=rgba("#3c444d"), outline=rgba(INK))
    d.ellipse([11, 10, 14, 13], fill=rgba(BONE))
    return im


def bolt(tint=None):
    im = BOLT.copy()
    if tint:
        t = rgba(tint)
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                r, g, b, a = px[x, y]
                px[x, y] = (r * t[0] // 255, g * t[1] // 255, b * t[2] // 255, a)
    return im


def round_proposed(glow):
    im, d = layer(32, 32)
    d.ellipse([4, 7, 28, 25], fill=rgba(glow, 110))
    d.ellipse([7, 9, 25, 23], fill=rgba(glow, 170))
    d.ellipse([11, 12, 21, 20], fill=rgba(BONE, 210), outline=rgba(INK))
    d.ellipse([12, 13, 15, 15], fill=rgba("#ffffff"))
    return im


def tile(sprite, floor, w=48, h=32):
    base = Image.new("RGBA", (w, h), rgba(FLOORS[floor]))
    base.alpha_composite(sprite, ((w - sprite.width) // 2, (h - sprite.height) // 2))
    return base


rows = [
    ("held weapon: today's pistol", [pistol_today()]),
    ("held weapon: launcher, chamber lit by the next cast", [launcher_proposed(FAMILY[k]) for k in ("cold", "storm", "flight")]),
    ("pickup: today's gems (pierce, overload, rapid, heavy)", [gem_today(GEMS[k]) for k in ("pierce", "overload", "rapid", "heavy")]),
    ("pickup: bubble, clear or lit by family", [bubble_proposed(), bubble_proposed(FAMILY["cold"]), bubble_proposed(FAMILY["storm"]), bubble_proposed(FAMILY["flight"])]),
    ("round: today, plain and Incendiary (spore-bolt x tint)", [bolt(), bolt(INCENDIARY_COMPOSED)]),
    ("round: glass, lit by family", [round_proposed(FAMILY[k]) for k in ("cold", "storm", "flight", "flame")]),
]
cols = max(len(s) for _, s in rows) * len(FLOORS)
LABEL = 24
sheet = Image.new("RGBA", ((48 * cols) * SCALE, (32 + LABEL) * len(rows) * SCALE), rgba("#0c1416"))
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default(size=40)
for r, (name, sprites) in enumerate(rows):
    y = r * (32 + LABEL) * SCALE
    draw.text((12, y + 20), f"{name}   (each on {', '.join(FLOORS)})", fill=rgba(BONE), font=font)
    x = 0
    for s in sprites:
        for floor in FLOORS:
            cell = tile(s, floor).resize((48 * SCALE, 32 * SCALE), Image.NEAREST)
            sheet.alpha_composite(cell, (x, y + LABEL * SCALE))
            x += 48 * SCALE
sheet.convert("RGB").save(OUT, optimize=True)
print(OUT.relative_to(ROOT), sheet.size, OUT.stat().st_size, "bytes")
