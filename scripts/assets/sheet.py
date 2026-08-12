#!/usr/bin/env python3
"""Contact sheet builder for prop sweeps.

Curation for props is done BY EYE -- the silhouette and render checks both pass
on art that reads as a grey blob, so they are not evidence. This just lays the
candidates out big enough to judge, on a mid-grey checker so that a near-white
render (which is CORRECT -- ramp_grade keeps value and discards hue) and any
residual ground shadow are both visible against the background.

  python3 sheet.py out.png TILE label=path.png [label=path.png ...]
"""
import os
import sys

from PIL import Image, ImageDraw

CHECK_A, CHECK_B = (110, 110, 118), (92, 92, 100)


def checker(size, step=16):
    bg = Image.new("RGB", (size, size), CHECK_A)
    d = ImageDraw.Draw(bg)
    for y in range(0, size, step):
        for x in range(0, size, step):
            if (x // step + y // step) % 2:
                d.rectangle([x, y, x + step - 1, y + step - 1], fill=CHECK_B)
    return bg


def main():
    out, tile = sys.argv[1], int(sys.argv[2])
    items = []
    for spec in sys.argv[3:]:
        label, _, path = spec.partition("=")
        items.append((label, path))
    if not items:
        print("no items")
        sys.exit(1)

    cols = min(5, len(items))
    rows = (len(items) + cols - 1) // cols
    pad, lab = 8, 18
    cell_w, cell_h = tile + pad, tile + pad + lab
    sheet = Image.new("RGB", (cols * cell_w + pad, rows * cell_h + pad), (28, 28, 32))
    draw = ImageDraw.Draw(sheet)
    base = checker(tile)

    for i, (label, path) in enumerate(items):
        cx = pad + (i % cols) * cell_w
        cy = pad + (i // cols) * cell_h
        cell = base.copy()
        if os.path.exists(path):
            im = Image.open(path)
            im.thumbnail((tile, tile), Image.LANCZOS)
            ox, oy = (tile - im.width) // 2, (tile - im.height) // 2
            if im.mode in ("RGBA", "LA"):
                cell.paste(im.convert("RGBA"), (ox, oy), im.convert("RGBA"))
            else:
                cell.paste(im.convert("RGB"), (ox, oy))
        else:
            draw.text((cx + 4, cy + 4), "MISSING", fill=(255, 80, 80))
        sheet.paste(cell, (cx, cy))
        draw.rectangle([cx, cy, cx + tile - 1, cy + tile - 1], outline=(60, 60, 68))
        draw.text((cx + 2, cy + tile + 4), label, fill=(230, 230, 235))

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    sheet.save(out)
    print(f"{out}  {sheet.width}x{sheet.height}  ({len(items)} tiles)")


if __name__ == "__main__":
    main()
