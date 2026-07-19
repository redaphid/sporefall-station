#!/usr/bin/env python3
"""Deterministic procedural sprites for the swampspace pack.

Sparse particle/glow sprites (hit spark, pickup sparkle, blood/ichor splat,
projectile bolt, muzzle-ish accents) are PROCEDURAL, not diffusion: the prior
swamp pack burned three rounds of prompting on figures hallucinated into sparse
particle prompts. Seeded PIL drawings in the locked palette are exactly
reproducible and match the pack's pixel chunk.

Usage: python3 procedural.py            # regenerate all
"""
import os
import random
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from palette import rgb

THEME = os.path.join(os.path.dirname(os.path.dirname(HERE)), "public", "themes", "swampspace")

# palette colors used below
SPORE = rgb("#46e078")
SPORE_PALE = rgb("#a6ffbe")
CYAN = rgb("#3ce0d8")
AMBER = rgb("#ffd83e")
ORANGE = rgb("#ff9032")
TEAL_DK = rgb("#163a3e")
TEAL_MD = rgb("#24565c")
OLIVE_DK = rgb("#22380f")
WHITE = rgb("#f2f6ea")


def save(im: Image.Image, rel: str):
    dest = os.path.join(THEME, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    im.save(dest)
    print(rel, im.size)


def hit_spark(seed=771101, px=48):
    """Radial cyan-white impact spark, 1 frame."""
    rng = random.Random(seed)
    im = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = px // 2
    for _ in range(10):
        ang = rng.uniform(0, 6.283)
        ln = rng.uniform(px * 0.18, px * 0.42)
        import math
        x2, y2 = c + math.cos(ang) * ln, c + math.sin(ang) * ln
        col = rng.choice([CYAN, SPORE_PALE, WHITE])
        d.line((c, c, x2, y2), fill=col + (255,), width=2)
    d.ellipse((c - 4, c - 4, c + 4, c + 4), fill=WHITE + (255,))
    d.ellipse((c - 2, c - 2, c + 2, c + 2), fill=CYAN + (255,))
    save(im, "fx/hit-spark.png")


def pickup_sparkle(seed=771102, px=48):
    """Four-point spore-green sparkle with satellite motes."""
    rng = random.Random(seed)
    im = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = px // 2
    for r, col in ((int(px * 0.38), SPORE), (int(px * 0.24), SPORE_PALE), (int(px * 0.1), WHITE)):
        d.polygon([(c, c - r), (c + r // 3, c), (c, c + r), (c - r // 3, c)], fill=col + (255,))
        d.polygon([(c - r, c), (c, c + r // 3), (c + r, c), (c, c - r // 3)], fill=col + (255,))
    for _ in range(7):
        x, y = rng.randrange(4, px - 4), rng.randrange(4, px - 4)
        if abs(x - c) + abs(y - c) > px * 0.3:
            d.ellipse((x - 1, y - 1, x + 1, y + 1), fill=SPORE_PALE + (220,))
    save(im, "fx/pickup-sparkle.png")


def ichor_splat(seed=771103, px=56):
    """Dark teal-green alien ichor splat (death mark, drawn under actors)."""
    rng = random.Random(seed)
    im = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = px // 2
    for _ in range(9):  # overlapping blobs
        r = rng.randrange(px // 8, px // 4)
        x = c + rng.randrange(-px // 4, px // 4)
        y = c + rng.randrange(-px // 4, px // 4)
        d.ellipse((x - r, y - r, x + r, y + r), fill=TEAL_DK + (255,))
    for _ in range(12):  # spatter dots
        x, y = rng.randrange(2, px - 2), rng.randrange(2, px - 2)
        r = rng.randrange(1, 3)
        d.ellipse((x - r, y - r, x + r, y + r), fill=rng.choice([TEAL_DK, TEAL_MD, OLIVE_DK]) + (255,))
    # faint glow flecks in the pool
    for _ in range(6):
        x = c + rng.randrange(-px // 5, px // 5)
        y = c + rng.randrange(-px // 5, px // 5)
        d.point((x, y), SPORE + (180,))
    save(im, "fx/ichor-splat.png")


def projectile(px=16):
    """Spore bolt: bright core with a short tail, flying +x (rotated in engine)."""
    im = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cy = px // 2
    d.line((1, cy, px - 5, cy), fill=SPORE + (140,), width=2)
    d.ellipse((px - 8, cy - 3, px - 2, cy + 3), fill=SPORE + (255,))
    d.ellipse((px - 6, cy - 1, px - 4, cy + 1), fill=WHITE + (255,))
    save(im, "fx/spore-bolt.png")


def grenade_ball(px=20):
    """Thrown spore pod: olive ball, glowing cracks, amber pin."""
    im = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = px // 2
    r = px // 2 - 2
    d.ellipse((c - r, c - r, c + r, c + r), fill=rgb("#35511a") + (255,))
    d.ellipse((c - r, c - r, c + r, c + r), outline=rgb("#141a16") + (255,), width=1)
    d.arc((c - r + 1, c - r + 1, c + r - 1, c + r - 1), 200, 320, fill=rgb("#67873c") + (255,), width=2)
    d.line((c - 2, c, c + 3, c + 2), fill=SPORE + (255,), width=1)
    d.line((c + 1, c - 3, c - 1, c + 4), fill=SPORE + (200,), width=1)
    d.rectangle((c - 1, c - r - 1, c + 1, c - r + 2), fill=AMBER + (255,))
    save(im, "fx/spore-pod.png")


if __name__ == "__main__":
    hit_spark()
    pickup_sparkle()
    ichor_splat()
    projectile()
    grenade_ball()
