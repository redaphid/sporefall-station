#!/usr/bin/env python3
"""Before/after at game scale. usage: before_after.py REPO ARCHIVE_DIR OUT.png name..."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
REPO, ARC, OUT = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]; names = sys.argv[4:]
R = REPO / "public/themes/swampspace-hires"; L = REPO / "public/themes/swampspace"
F = lambda s: ImageFont.truetype("/mnt/c/Windows/Fonts/consola.ttf", s)
Z = 2; S = 64 * Z
tile = Image.open(R / "tiles/plating-0.png").convert("RGBA").resize((S, S), Image.NEAREST)
ltile = Image.open(L / "tiles/plating-0.png").convert("RGBA") if (L / "tiles/plating-0.png").exists() else None
def cell(img, s=S, t=tile):
    bg = t.copy() if t.size == (s, s) else t.resize((s, s), Image.NEAREST)
    bg.alpha_composite(img.convert("RGBA").resize((s, s), Image.NEAREST)); return bg
cols = 4; cw = 2 * S + 60 + 2 * 40
W = 20 + cols * cw; rows = (len(names) + cols - 1) // cols
H = 64 + rows * (S + 40) + 96 * Z + 30
sh = Image.new("RGBA", (W, H), (22, 24, 30, 255)); d = ImageDraw.Draw(sh)
d.text((12, 8), "props 11-06: BEFORE -> AFTER, hi-res pack at 2x (32 vs 48 logical, true scale) + low-res pack 1:1", font=F(16), fill=(235, 238, 245))
d.text((12, 32), "each pair: old | new on plating; small = low-res 32px pack, true pixels", font=F(12), fill=(150, 156, 168))
for i, n in enumerate(names):
    x = 12 + (i % cols) * cw; y = 56 + (i // cols) * (S + 40)
    sh.alpha_composite(cell(Image.open(ARC / "swampspace-hires" / f"{n}.png")), (x, y))
    d.text((x + S + 6, y + S // 2 - 10), "->", font=F(16), fill=(200, 200, 210))
    sh.alpha_composite(cell(Image.open(R / "props" / f"{n}.png")), (x + S + 30, y))
    sh.alpha_composite(cell(Image.open(ARC / "swampspace" / f"{n}.png"), 32), (x + 2 * S + 40, y))
    sh.alpha_composite(cell(Image.open(L / "props" / f"{n}.png"), 32), (x + 2 * S + 40, y + 40))
    d.text((x, y + S + 4), n, font=F(13), fill=(200, 204, 214))
y = 56 + rows * (S + 40); x = 12
for c in ("vine-ranger", "mycologist", "derelict-bot"):
    bg = Image.new("RGBA", (96 * Z, 96 * Z))
    for yy in (0, S):
        for xx in (0, S): bg.paste(tile, (xx, yy))
    bg.alpha_composite(Image.open(R / f"chars/{c}-s-idle.png").convert("RGBA").resize((96 * Z, 96 * Z), Image.NEAREST))
    sh.alpha_composite(bg, (x, y)); x += 96 * Z + 10
sh.convert("RGB").save(OUT); print(OUT, sh.size)
