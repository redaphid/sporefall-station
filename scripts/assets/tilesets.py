#!/usr/bin/env python3
"""Procedural SNES-style tile SETS for the swampspace pack.

Generates 32x32 pixel-art tiles — several variants per ground type plus rare
accent tiles — holding the pack's locked palette (sampled from the shipped
deck-moss/root-bulkhead tiles + manifest palette). Deterministic per (type,
variant): a fixed-seed PRNG, so re-running the script reproduces the pack
byte-for-byte.

Usage:  python3 scripts/assets/tilesets.py [outdir]
Writes <outdir>/(grass|street|sidewalk|floor|wall|exit)-N.png and *-accent-N.png
Default outdir: public/themes/swampspace/tiles/
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

from PIL import Image

T = 32

# ---- Locked palette (sampled from the shipped pack) -----------------------
MOSS_DEEP = (28, 43, 18)      # #1c2b12
MOSS_DARK = (47, 71, 23)      # #2f4717
MOSS_BASE = (53, 81, 26)      # #35511a  (pack grass)
MOSS_LIGHT = (76, 107, 40)    # #4c6b28
MOSS_HI = (103, 135, 60)      # #67873c
MOSS_BRIGHT = (134, 167, 80)  # #86a750
MOSS_GLOW = (168, 196, 106)   # #a8c46a
SPORE_GLOW = (70, 224, 120)   # #46e078  (ui accent)

BOG_DEEP = (14, 26, 30)       # deep water
BOG_BASE = (24, 42, 48)       # #182a30 — brighter than the old #16282c void
BOG_MID = (36, 86, 92)        # #24565c
BOG_SHEEN = (58, 122, 128)    # #3a7a80
BOG_GLINT = (96, 168, 168)    # rare sparkle

ROOT_DARK = (32, 20, 10)      # #20140a
ROOT_BASE = (46, 30, 16)      # #2e1e10
ROOT_MID = (74, 52, 25)       # #4a3419
ROOT_LIGHT = (107, 77, 38)    # #6b4d26

STEEL_DARK = (18, 24, 28)     # seams
STEEL_BASE = (35, 40, 46)     # #23282e
STEEL_MID = (60, 68, 77)      # #3c444d
STEEL_LIGHT = (89, 99, 109)   # #59636d
STEEL_RIM = (126, 140, 150)   # top rim light

WALL_VOID = (20, 26, 22)      # #141a16


def clamp(v: int) -> int:
    return max(0, min(255, v))


def mix(a, b, t: float):
    return tuple(clamp(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


class TilePainter:
    def __init__(self, seed: int, base):
        self.rng = random.Random(seed)
        self.im = Image.new("RGB", (T, T), base)
        self.px = self.im.load()

    def set(self, x: int, y: int, c) -> None:
        if 0 <= x < T and 0 <= y < T:
            self.px[x, y] = c

    def get(self, x: int, y: int):
        return self.px[x % T, y % T]

    def blob(self, cx: int, cy: int, r: float, color, dither: float = 0.5) -> None:
        """Rough organic blob: solid core, dithered fringe (SNES cluster look)."""
        for y in range(int(cy - r - 1), int(cy + r + 2)):
            for x in range(int(cx - r - 1), int(cx + r + 2)):
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if d <= r * 0.6:
                    self.set(x, y, color)
                elif d <= r and self.rng.random() < dither:
                    self.set(x, y, color)

    def speck(self, n: int, color, w: int = 1) -> None:
        for _ in range(n):
            x, y = self.rng.randrange(T), self.rng.randrange(T)
            for dx in range(w):
                for dy in range(w):
                    self.set(x + dx, y + dy, color)

    def worm(self, x: float, y: float, steps: int, color, jitter: float = 1.2) -> None:
        """A wandering 1px root/crack."""
        ang = self.rng.uniform(0, 6.283)
        for _ in range(steps):
            self.set(int(x), int(y), color)
            ang += self.rng.uniform(-jitter, jitter) * 0.5
            x += __import__("math").cos(ang)
            y += __import__("math").sin(ang)

    def hline_broken(self, y: int, color, keep: float = 0.7) -> None:
        for x in range(T):
            if self.rng.random() < keep:
                self.set(x, y, color)


# ---- GRASS: swamp moss ground --------------------------------------------

def grass(variant: int) -> Image.Image:
    # Per-variant BASE TONE shift: the field only reads as patchy terrain (not
    # a flat carpet) if whole tiles differ in value, so v0 runs dark bog-moss,
    # v3 runs sun-caught — the coord hash then paints multi-tile patchwork.
    # Kept subtle (~0.35 mix max): enough for patchwork at field scale, not so
    # much that individual 32px tiles read as a quilt grid.
    base = [mix(MOSS_BASE, MOSS_DARK, 0.35), MOSS_BASE, mix(MOSS_BASE, MOSS_LIGHT, 0.18), mix(MOSS_BASE, MOSS_LIGHT, 0.35)][variant % 4]
    p = TilePainter(1000 + variant, base)
    # Large mottle: dark undergrowth patches
    for _ in range(p.rng.randint(4, 6)):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(3, 6), MOSS_DARK, 0.45)
    for _ in range(p.rng.randint(2, 3)):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(2, 4), MOSS_DEEP, 0.4)
    # Light moss clumps on top
    for _ in range(p.rng.randint(4, 6)):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(1.5, 3.2), MOSS_LIGHT, 0.5)
    if variant >= 2:
        for _ in range(3):
            p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(1.5, 2.5), mix(MOSS_LIGHT, MOSS_HI, 0.5), 0.5)
    # Grass-blade ticks: short vertical strokes, paired light/highlight
    for _ in range(p.rng.randint(10, 14)):
        x, y = p.rng.randrange(T), p.rng.randrange(T)
        p.set(x, y, MOSS_HI)
        p.set(x, y - 1, MOSS_LIGHT)
    # Sparse bright tips + rare twig
    p.speck(p.rng.randint(4, 7), MOSS_BRIGHT)
    if variant % 2 == 1:
        p.worm(p.rng.randrange(T), p.rng.randrange(T), p.rng.randint(6, 10), ROOT_MID)
    return p.im


def grass_accent(n: int) -> Image.Image:
    if n == 0:
        # Gnarled root cluster breaking through the moss
        p = TilePainter(1500, MOSS_BASE)
        for _ in range(5):
            p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(3, 5), MOSS_DARK, 0.45)
        cx, cy = 16, 16
        p.blob(cx, cy, 7, ROOT_BASE, 0.6)
        p.blob(cx, cy, 4.5, ROOT_MID, 0.7)
        for _ in range(6):
            p.worm(cx + p.rng.uniform(-3, 3), cy + p.rng.uniform(-3, 3), p.rng.randint(8, 14), ROOT_MID)
        for _ in range(4):
            p.worm(cx + p.rng.uniform(-2, 2), cy + p.rng.uniform(-2, 2), p.rng.randint(4, 8), ROOT_LIGHT)
        # moss regrowing over the roots
        for _ in range(4):
            p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(1, 2), MOSS_LIGHT, 0.5)
        return p.im
    if n == 1:
        # Glowing spore patch — the theme's signature bioluminescence
        p = TilePainter(1600, MOSS_DARK)
        for _ in range(4):
            p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(3, 5), MOSS_DEEP, 0.5)
        for _ in range(3):
            p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(2, 3), MOSS_BASE, 0.5)
        # spore cluster: dark halo, glowing hearts
        for _ in range(p.rng.randint(5, 7)):
            x, y = p.rng.randrange(3, T - 3), p.rng.randrange(3, T - 3)
            p.blob(x, y, 2.2, MOSS_DEEP, 0.6)
            p.set(x, y, SPORE_GLOW)
            p.set(x + 1, y, mix(SPORE_GLOW, MOSS_GLOW, 0.5))
            p.set(x, y + 1, MOSS_GLOW)
        return p.im
    # n == 2: still bog puddle catching the light
    p = TilePainter(1700, MOSS_BASE)
    for _ in range(4):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(2, 4), MOSS_DARK, 0.5)
    p.blob(15, 17, 8, MOSS_DEEP, 0.55)      # muddy rim
    p.blob(15, 17, 6, BOG_DEEP, 0.7)
    p.blob(15, 17, 4.5, BOG_BASE, 0.8)
    for x in range(10, 21):
        if p.rng.random() < 0.6:
            p.set(x, 16, BOG_MID)
    p.set(13, 15, BOG_SHEEN)
    p.set(14, 15, BOG_SHEEN)
    for _ in range(6):
        p.set(p.rng.randrange(T), p.rng.randrange(T), MOSS_LIGHT)
    return p.im


# ---- STREET: bog-water channel -------------------------------------------

def street(variant: int) -> Image.Image:
    p = TilePainter(2000 + variant, BOG_BASE)
    # Depth mottle
    for _ in range(p.rng.randint(3, 5)):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(3, 6), BOG_DEEP, 0.45)
    # Ripple bands: broken horizontal lines of teal, brighter crests sparse
    for _ in range(p.rng.randint(3, 4)):
        y = p.rng.randrange(T)
        x0 = p.rng.randrange(T)
        ln = p.rng.randint(6, 14)
        for i in range(ln):
            x = (x0 + i) % T
            p.set(x, y, BOG_MID)
            if p.rng.random() < 0.25:
                p.set(x, y - 1, mix(BOG_MID, BOG_BASE, 0.5))
    for _ in range(p.rng.randint(2, 3)):
        y = p.rng.randrange(T)
        x0 = p.rng.randrange(T)
        for i in range(p.rng.randint(3, 6)):
            p.set((x0 + i) % T, y, BOG_SHEEN)
    # Floating moss flecks + a rare glint
    for _ in range(p.rng.randint(3, 5)):
        x, y = p.rng.randrange(T), p.rng.randrange(T)
        p.set(x, y, MOSS_DARK)
        if p.rng.random() < 0.5:
            p.set(x + 1, y, MOSS_DEEP)
    if variant >= 2:
        p.set(p.rng.randrange(T), p.rng.randrange(T), BOG_GLINT)
    return p.im


def street_accent(n: int) -> Image.Image:
    if n == 0:
        # Drifting spore bloom on the water
        p = TilePainter(2500, BOG_BASE)
        for _ in range(4):
            p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(3, 5), BOG_DEEP, 0.45)
        for _ in range(3):
            y = p.rng.randrange(T)
            x0 = p.rng.randrange(T)
            for i in range(p.rng.randint(5, 10)):
                p.set((x0 + i) % T, y, BOG_MID)
        for _ in range(4):
            x, y = p.rng.randrange(4, T - 4), p.rng.randrange(4, T - 4)
            p.blob(x, y, 1.8, mix(BOG_DEEP, (0, 0, 0), 0.3), 0.6)
            p.set(x, y, SPORE_GLOW)
            p.set(x + 1, y + 1, mix(SPORE_GLOW, BOG_MID, 0.6))
        return p.im
    # n == 1: half-sunk root crossing the channel
    p = TilePainter(2600, BOG_BASE)
    for _ in range(4):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(3, 5), BOG_DEEP, 0.5)
    y = 14.0
    x = 0.0
    import math
    ang = 0.15
    while x < T:
        p.set(int(x), int(y), ROOT_MID)
        p.set(int(x), int(y) + 1, ROOT_BASE)
        if p.rng.random() < 0.3:
            p.set(int(x), int(y) - 1, ROOT_LIGHT)
        if p.rng.random() < 0.4:  # waterline ripple hugging the root
            p.set(int(x), int(y) + 2, BOG_MID)
        ang += p.rng.uniform(-0.3, 0.3) * 0.4
        x += math.cos(ang)
        y += math.sin(ang) * 0.7
    return p.im


# ---- SIDEWALK: raised deck plating ---------------------------------------

def sidewalk(variant: int) -> Image.Image:
    p = TilePainter(3000 + variant, STEEL_BASE)
    # Two plates per tile, offset per variant, each with a lit top edge
    seam_y = 15 if variant % 2 == 0 else 11
    for y in range(T):
        for x in range(T):
            p.set(x, y, STEEL_BASE)
    # plate face subtle noise
    p.speck(26, mix(STEEL_BASE, STEEL_MID, 0.5))
    p.speck(10, mix(STEEL_BASE, STEEL_DARK, 0.5))
    # seams: dark line + light bevel below
    for sy in (0, seam_y):
        p.hline_broken(sy, STEEL_DARK, 0.95)
        p.hline_broken(sy + 1, STEEL_MID, 0.85)
    # vertical joints, staggered
    xj = 6 + (variant * 9) % 16
    for y in range(1, seam_y):
        p.set(xj, y, STEEL_DARK)
    xj2 = (xj + 13) % (T - 2) + 1
    for y in range(seam_y + 1, T):
        p.set(xj2, y, STEEL_DARK)
    # rivets on plate corners
    for (rx, ry) in [(2, 3), (T - 3, 3), (2, seam_y + 3), (T - 3, seam_y + 3)]:
        p.set(rx, ry, STEEL_LIGHT)
        p.set(rx + 1, ry + 1, STEEL_DARK)
    # moss creeping in the seams
    for _ in range(p.rng.randint(3, 5)):
        x = p.rng.randrange(T)
        sy = p.rng.choice((0, seam_y))
        p.set(x, sy, MOSS_DARK)
        if p.rng.random() < 0.6:
            p.set(x + 1, sy, MOSS_BASE)
        if p.rng.random() < 0.3:
            p.set(x, sy + 1, MOSS_DARK)
    if variant >= 2:
        # a patch of wear
        p.blob(p.rng.randrange(T), p.rng.randrange(T), 2.5, mix(STEEL_BASE, STEEL_DARK, 0.6), 0.5)
    return p.im


# ---- FLOOR: interior mossy deck ------------------------------------------

def floor(variant: int) -> Image.Image:
    p = TilePainter(4000 + variant, (42, 52, 34))  # mossy deck base
    # deck plank shading: horizontal bands
    for row in range(4):
        y0 = row * 8
        tone = mix((42, 52, 34), (36, 46, 30), (row % 2))
        for y in range(y0, y0 + 8):
            for x in range(T):
                p.set(x, y, tone)
        p.hline_broken(y0, (28, 36, 24), 0.9)
    # moss growth
    for _ in range(p.rng.randint(4, 6)):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(2, 4), MOSS_DARK, 0.5)
    for _ in range(p.rng.randint(3, 5)):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(1.5, 2.5), MOSS_BASE, 0.55)
    for _ in range(p.rng.randint(2, 4)):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(1, 1.8), MOSS_LIGHT, 0.5)
    p.speck(p.rng.randint(3, 5), MOSS_HI)
    # deck fastener dots along one plank line
    y = p.rng.choice((8, 16, 24))
    for x in range(p.rng.randrange(4), T, 8):
        p.set(x, y + 1, STEEL_MID)
    return p.im


def floor_accent(n: int) -> Image.Image:
    # Accent bases sit on the SD floor pool's darker deck tone (see
    # tilesets_curate.py) so accents read as details, not bright patches.
    if n == 0:
        # Ventilation grate with a faint teal under-glow
        p = TilePainter(4500, (33, 39, 37))
        for row in range(4):
            p.hline_broken(row * 8, (28, 36, 24), 0.9)
        # frame
        for x in range(6, 26):
            p.set(x, 8, STEEL_MID)
            p.set(x, 24, STEEL_DARK)
        for y in range(8, 25):
            p.set(6, y, STEEL_MID)
            p.set(25, y, STEEL_DARK)
        # slats with glow between
        for y in range(10, 24, 3):
            for x in range(8, 24):
                p.set(x, y, STEEL_DARK)
                if y + 1 < 24:
                    p.set(x, y + 1, mix(BOG_MID, (38, 47, 31), 0.45))
        for _ in range(3):
            p.blob(p.rng.randrange(T), p.rng.randrange(T), 1.5, MOSS_BASE, 0.5)
        return p.im
    # n == 1: roots bursting through the decking
    p = TilePainter(4600, (35, 41, 38))
    for row in range(4):
        p.hline_broken(row * 8, (28, 36, 24), 0.9)
    for _ in range(3):
        p.blob(p.rng.randrange(T), p.rng.randrange(T), p.rng.uniform(2, 3), MOSS_DARK, 0.5)
    p.blob(16, 18, 5, ROOT_BASE, 0.65)
    for _ in range(5):
        p.worm(16 + p.rng.uniform(-2, 2), 18 + p.rng.uniform(-2, 2), p.rng.randint(7, 12), ROOT_MID)
    for _ in range(3):
        p.worm(16 + p.rng.uniform(-2, 2), 18 + p.rng.uniform(-2, 2), p.rng.randint(4, 7), ROOT_LIGHT)
    # cracked plank ends
    p.set(11, 17, STEEL_DARK)
    p.set(21, 20, STEEL_DARK)
    return p.im


# ---- WALL: root-woven bulkhead with a lit top face ------------------------

def wall(variant: int) -> Image.Image:
    p = TilePainter(5000 + variant, WALL_VOID)
    TOP = 9  # top-face height: the lit cap that makes the wall read as volume
    # top face: steel cap, brightest at the very top rim
    for y in range(TOP):
        tone = STEEL_MID if y >= 2 else STEEL_LIGHT
        for x in range(T):
            p.set(x, y, tone)
    for x in range(T):
        p.set(x, 0, STEEL_RIM)
    # cap seams + moss tufts on the cap
    for x in range(p.rng.randrange(3), T, 11):
        for y in range(1, TOP):
            p.set(x, y, mix(STEEL_MID, STEEL_DARK, 0.6))
    for _ in range(p.rng.randint(2, 4)):
        x = p.rng.randrange(T)
        p.set(x, p.rng.randrange(2, TOP), MOSS_DARK)
        p.set(x + 1, p.rng.randrange(2, TOP), MOSS_BASE)
    # cap/front divider: strong dark line = the edge
    for x in range(T):
        p.set(x, TOP, (10, 12, 10))
    # front face: woven roots over dark bulkhead
    front_h = T - TOP - 1
    for _ in range(p.rng.randint(3, 4)):
        # vertical root columns
        x = p.rng.randrange(1, T - 1)
        y = TOP + 1
        xx = float(x)
        import math
        ang = math.pi / 2
        while y < T:
            p.set(int(xx), y, ROOT_MID)
            p.set(int(xx) - 1, y, ROOT_BASE)
            if p.rng.random() < 0.25:
                p.set(int(xx) + 1, y, ROOT_LIGHT)
            ang += p.rng.uniform(-0.4, 0.4) * 0.5
            xx += math.cos(ang)
            y += 1
    # teal conduit glints between roots
    for _ in range(p.rng.randint(2, 4)):
        x, y = p.rng.randrange(T), p.rng.randrange(TOP + 2, T - 2)
        p.set(x, y, BOG_MID)
        if p.rng.random() < 0.5:
            p.set(x, y + 1, mix(BOG_MID, WALL_VOID, 0.5))
    # sparse moss on the front
    for _ in range(p.rng.randint(3, 5)):
        p.set(p.rng.randrange(T), p.rng.randrange(TOP + 1, T), MOSS_DARK)
    # base shadow: darkest 2 rows ground the wall
    for x in range(T):
        p.set(x, T - 1, (8, 10, 8))
        if p.rng.random() < 0.7:
            p.set(x, T - 2, (12, 15, 12))
    return p.im


# ---- EXIT: launch-bay pad -------------------------------------------------

def exit_tile(variant: int) -> Image.Image:
    p = TilePainter(6000 + variant, STEEL_BASE)
    p.speck(20, mix(STEEL_BASE, STEEL_MID, 0.5))
    # pad ring
    for x in range(3, 29):
        p.set(x, 3, STEEL_LIGHT)
        p.set(x, 28, STEEL_DARK)
    for y in range(3, 29):
        p.set(3, y, STEEL_LIGHT)
        p.set(28, y, STEEL_DARK)
    # glowing chevron pointing east
    cx, cy = 13, 16
    for i in range(8):
        for dy in (-i, i):
            p.set(cx + i, cy + dy, SPORE_GLOW)
            p.set(cx + i - 1, cy + dy, mix(SPORE_GLOW, STEEL_BASE, 0.55))
    # corner marker lights
    for (mx, my) in [(5, 5), (26, 5), (5, 26), (26, 26)]:
        p.set(mx, my, MOSS_GLOW)
    return p.im


GENERATORS = {
    "grass": (grass, 4, grass_accent, 3),
    "street": (street, 4, street_accent, 2),
    "sidewalk": (sidewalk, 4, None, 0),
    "floor": (floor, 4, floor_accent, 2),
    "wall": (wall, 3, None, 0),
    "exit": (exit_tile, 1, None, 0),
}


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("public/themes/swampspace/tiles")
    out.mkdir(parents=True, exist_ok=True)
    for name, (gen, n, accent, na) in GENERATORS.items():
        for v in range(n):
            gen(v).save(out / f"{name}-{v}.png")
        for a in range(na):
            accent(a).save(out / f"{name}-accent-{a}.png")
        print(f"{name}: {n} variants, {na} accents")


if __name__ == "__main__":
    main()
