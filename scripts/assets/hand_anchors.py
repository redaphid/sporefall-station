#!/usr/bin/env python3
"""Measure where each armed character's weapon hand is, frame by frame, and write
src/render/handAnchors.ts for the held-weapon overlay.

    python3 scripts/assets/hand_anchors.py            # measure, write the TS table
    python3 scripts/assets/hand_anchors.py --sheet D  # also write review sheets to D

A held weapon has to sit in the fist the frame actually draws: the walk cycle
swings the arm 8+ px, so one rig per facing leaves the gun floating beside the
hand on most frames. The weapon hand is the screen-right one in the s/se/ne/n
views (the west half is that mirrored) and the visible one in the e profile.

  s/se/ne/n  found from the silhouette: the right-most limb in the arm band
             (rows 42-70% of the frame), and the fist is the bottom of it, where
             the hanging arm ends.
  e          the hand sits inside the profile silhouette, so it is SEEDED by eye on
             the idle frame (SEEDS) and tracked into every other frame by matching
             that fist patch near the previous frame's position.
OVERRIDES pins any frame the measure gets wrong (found on the review sheet).

Boxes are measured on the hi-res pack (96px) and halved for the base pack (48px),
whose frames are the same drawings at half size. Output: per frame path, the fist
box [x0, y0, x1, y1] and the grip pixel [gx, gy], in that frame's own pixels.
"""
import argparse
import glob
import json
import os
import re

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
THEMES = os.path.join(REPO, "public", "themes")
OUT = os.path.join(REPO, "src", "render", "handAnchors.ts")
HIRES, BASE = "swampspace-hires", "swampspace"

# Bodies that hold a carried weapon (npcs.ts table weapon or the player's).
KINDS = ["vine-ranger", "drowned-diver", "bellwether", "bog-mutant", "spore-drone", "frog-settler", "blast-diver"]
DIRS = ["s", "se", "e", "ne", "n"]

# e-profile fist on the idle frame, hi-res px: (x0, y0, x1, y1) exclusive ends.
SEEDS = {
    "vine-ranger": (40, 51, 49, 60),
    "drowned-diver": (40, 55, 49, 64),
    "bellwether": (40, 50, 48, 58),
    "frog-settler": (58, 54, 67, 63),
    "blast-diver": (57, 55, 65, 63),
}
FIST = (8, 9)  # hi-res fist box size used by the silhouette measure
# frame name -> (x0, y0, x1, y1): corrections from the review sheet.
OVERRIDES = {}


def rgba(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.int32)


def right_fist(a):
    """Bottom of the right-most limb in the arm band: the screen-right fist."""
    h, w = a.shape[:2]
    m = a[..., 3] > 0
    y0, y1 = int(h * 0.42), int(h * 0.70)
    r = np.full(h, -1)
    for y in range(y0, y1):
        xs = np.nonzero(m[y])[0]
        if len(xs):
            r[y] = xs.max()
    band = r[y0:y1]
    rmax = band.max()
    rows = [y for y in range(y0, y1) if r[y] >= rmax - 3]
    # the lowest row of the block of near-extreme rows that holds the extreme
    top = rows[0]
    ybot = top
    for y in rows:
        if y - ybot <= 2:
            ybot = y
    fw, fh = FIST
    x1 = int(r[max(top, ybot - fh // 2)]) + 1
    x1 = max(x1, int(r[ybot]) + 1)
    return (x1 - fw, ybot + 1 - fh, x1, ybot + 1)


def track(a, tmpl, near, reach=10):
    """Best match of the template patch within `reach` of `near` (x0, y0)."""
    th, tw = tmpl.shape[:2]
    on = tmpl[..., 3] > 0
    best = None
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            x0, y0 = near[0] + dx, near[1] + dy
            if x0 < 0 or y0 < 0 or x0 + tw > a.shape[1] or y0 + th > a.shape[0]:
                continue
            p = a[y0:y0 + th, x0:x0 + tw]
            col = np.abs(p[..., :3] - tmpl[..., :3]).sum(-1)
            err = (col * on).sum() + 400 * ((p[..., 3] > 0) != on).sum() + 4 * (dx * dx + dy * dy)
            if best is None or err < best[0]:
                best = (err, x0, y0)
    return best[1], best[2]


def frames(kind, d):
    fs = glob.glob(os.path.join(THEMES, HIRES, "chars", f"{kind}-{d}-*.png"))
    def key(f):
        n = os.path.basename(f)[:-4].split("-")
        return (0 if n[-1] == "idle" else 1, n[-2] if n[-1].isdigit() else n[-1], int(n[-1]) if n[-1].isdigit() else -1)
    return sorted(fs, key=key)


def measure():
    out = {}
    for kind in KINDS:
        for d in DIRS:
            fs = frames(kind, d)
            if not fs:
                continue
            idle = [f for f in fs if f.endswith(f"-{d}-idle.png")]
            if d == "e" and kind in SEEDS:
                sx0, sy0, sx1, sy1 = SEEDS[kind]
                tmpl = rgba(idle[0])[sy0:sy1, sx0:sx1]
                prev = (sx0, sy0)
                for f in fs:
                    x0, y0 = (sx0, sy0) if f in idle else track(rgba(f), tmpl, prev)
                    prev = (x0, y0)
                    out[os.path.basename(f)] = (x0, y0, x0 + sx1 - sx0, y0 + sy1 - sy0)
            else:
                for f in fs:
                    out[os.path.basename(f)] = right_fist(rgba(f))
    out.update(OVERRIDES)
    return out


def entry(box, s=1):
    x0, y0, x1, y1 = (v // s for v in box)
    if s > 1:
        x1, y1 = max(x1, x0 + 1), max(y1, y0 + 1)
    return [x0, y0, x1, y1, (x0 + x1) // 2, (y0 + y1) // 2]


def write_ts(boxes):
    lines = [
        "// GENERATED by scripts/assets/hand_anchors.py: the weapon fist in each armed",
        "// character frame, measured off the art. Do not hand-edit; fix the measure",
        "// (SEEDS/OVERRIDES there) and re-run it.",
        "//",
        "// Key: frame path under public/themes/. Value: [x0, y0, x1, y1, gx, gy] in that",
        "// frame's own pixels: the fist box (exclusive ends) and the grip pixel.",
        "export const HAND_ANCHORS: Readonly<Record<string, readonly [number, number, number, number, number, number]>> = {",
    ]
    for name in sorted(boxes):
        for pack, s in ((HIRES, 1), (BASE, 2)):
            if os.path.exists(os.path.join(THEMES, pack, "chars", name)):
                lines.append(f"  '{pack}/chars/{name}': {json.dumps(entry(boxes[name], s)).replace(',', ', ')},")
    lines.append("}")
    open(OUT, "w").write("\n".join(lines) + "\n")


def sheet(boxes, out_dir, zoom=4):
    os.makedirs(out_dir, exist_ok=True)
    for kind in KINDS:
        rows = []
        for d in DIRS:
            fs = frames(kind, d)
            if not fs:
                continue
            cells = []
            for f in fs:
                im = Image.open(f).convert("RGBA")
                bg = Image.new("RGBA", im.size, (96, 116, 106, 255))
                bg.alpha_composite(im)
                bg = bg.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
                x0, y0, x1, y1, gx, gy = entry(boxes[os.path.basename(f)])
                dr = ImageDraw.Draw(bg)
                dr.rectangle([x0 * zoom, y0 * zoom, x1 * zoom - 1, y1 * zoom - 1], outline=(255, 0, 255, 255))
                dr.rectangle([gx * zoom, gy * zoom, gx * zoom + zoom - 1, gy * zoom + zoom - 1], fill=(255, 255, 0, 255))
                cells.append(bg)
            rows.append(cells)
        W = max(sum(c.width for c in r) for r in rows)
        H = sum(r[0].height for r in rows)
        s = Image.new("RGBA", (W, H), (0, 0, 0, 255))
        y = 0
        for r in rows:
            x = 0
            for c in r:
                s.alpha_composite(c, (x, y))
                x += c.width
            y += r[0].height
        s.save(os.path.join(out_dir, f"hands-{kind}.png"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", default=None)
    a = ap.parse_args()
    boxes = measure()
    write_ts(boxes)
    if a.sheet:
        sheet(boxes, a.sheet)
    print(f"{len(boxes)} frames -> {os.path.relpath(OUT, REPO)}")


if __name__ == "__main__":
    main()
