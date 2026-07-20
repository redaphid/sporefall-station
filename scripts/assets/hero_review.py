#!/usr/bin/env python3
"""Deterministic (no-GPU) review artifacts for the feat/hero-sprites revision.

1. before.png  — a contact sheet of the CURRENTLY SHIPPED vine-ranger frames
                 (real assets from public/themes/swampspace/chars). This is the
                 honest "before": the thin r1 ranger the revision replaces.
2. proportion-schematic.png — a labelled silhouette DIAGRAM (not a sprite)
                 comparing the r1 build (width/height 0.455) to the r2 target
                 (~0.66), so a reviewer can see the intended size/proportion
                 change before the GPU/Blender regen runs.

Run: python3 scripts/assets/hero_review.py
Outputs land in docs/assets/hero-sprites/.
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHARS = os.path.join(ROOT, "public", "themes", "swampspace", "chars")
OUT = os.path.join(ROOT, "docs", "assets", "hero-sprites")
os.makedirs(OUT, exist_ok=True)

DIRS = ["s", "se", "e", "ne", "n"]
BG = (28, 30, 34, 255)
FG = (210, 214, 220, 255)
SCALE = 5


def contact_sheet():
    """Grid: rows = directions, cols = idle/step + 8 walk frames. Real PNGs."""
    cols = ["idle", "step"] + [f"walk-{i}" for i in range(8)]
    cell = 48 * SCALE
    pad, label_w, header_h = 8, 70, 22
    W = label_w + len(cols) * (cell + pad) + pad
    H = header_h + len(DIRS) * (cell + pad) + pad
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((pad, 6), "vine-ranger — CURRENTLY SHIPPED (r1, the 'before')", fill=FG)
    for ci, c in enumerate(cols):
        d.text((label_w + ci * (cell + pad) + 4, header_h - 14), c, fill=FG)
    for ri, dr in enumerate(DIRS):
        y = header_h + ri * (cell + pad)
        d.text((6, y + cell // 2), dr, fill=FG)
        for ci, c in enumerate(cols):
            x = label_w + ci * (cell + pad)
            p = os.path.join(CHARS, f"vine-ranger-{dr}-{c}.png")
            if not os.path.exists(p):
                continue
            fr = Image.open(p).convert("RGBA").resize((cell, cell), Image.NEAREST)
            sheet.alpha_composite(fr, (x, y))
    out = os.path.join(OUT, "before.png")
    sheet.save(out)
    return out, sheet.size


def silhouette(spans, cap_frac, label, sub):
    """Draw a 48px-tall banded silhouette from (y0,y1,width_frac) spans."""
    S = 8
    W, H = 48 * S, (48 + 26) * S
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = W // 2
    teal = (58, 122, 128, 255)
    grey = (123, 135, 145, 255)
    amber = (255, 144, 50, 255)
    peak = max(w for _, _, w in spans)
    for y0, y1, wf in spans:
        half = int(wf * 48 * S / 2)
        col = grey if wf >= 0.9 * peak else teal
        d.rectangle([cx - half, int(y0 * 48 * S), cx + half, int(y1 * 48 * S)], fill=col)
    # amber cap/visor accent band near the top
    ah = int(cap_frac * 48 * S / 2)
    d.rectangle([cx - ah, int(0.03 * 48 * S), cx + ah, int(0.14 * 48 * S)], fill=amber)
    d.text((4, 48 * S + 4), label, fill=FG)
    d.text((4, 48 * S + 14), sub, fill=(150, 154, 160, 255))
    return img


def schematic():
    # r1 build: peak width 0.455 of height; r2 target: 0.66. Spans are
    # (y0,y1,width_fraction_of_height) mirroring rig_walk.py's band table.
    r1 = [(0.00, 0.19, 0.30), (0.19, 0.40, 0.455), (0.40, 0.46, 0.30),
          (0.46, 0.56, 0.34), (0.56, 1.00, 0.185)]
    r2 = [(0.00, 0.19, 0.44), (0.19, 0.40, 0.66), (0.40, 0.46, 0.41),
          (0.46, 0.56, 0.48), (0.56, 1.00, 0.27)]
    a = silhouette(r1, 0.20, "r1 SHIPPED", "w/h 0.455 · width~21 · mass~455")
    b = silhouette(r2, 0.30, "r2 TARGET", "w/h ~0.66 · width~29 · mass~720")
    gap = 40
    W = a.width + gap + b.width + 40
    H = a.height + 40
    canvas = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    d.text((10, 6), "RANGER PROPORTION SCHEMATIC (diagram, NOT a shipped sprite)", fill=FG)
    canvas.alpha_composite(a, (20, 30))
    canvas.alpha_composite(b, (20 + a.width + gap, 30))
    out = os.path.join(OUT, "proportion-schematic.png")
    canvas.save(out)
    return out, canvas.size


if __name__ == "__main__":
    for fn in (contact_sheet, schematic):
        path, size = fn()
        print(f"wrote {path}  {size}")
