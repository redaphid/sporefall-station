#!/usr/bin/env python3
"""Curate the final swampspace tile pools: procedural + SD-refined, healed.

- grass: 4 procedural + 4 SD (healed: SD sometimes drops steel-blue speck
  artifacts into foliage; remap any out-of-family color to the nearest
  in-family palette color) = 8 variants
- street: 4 procedural + SD 0,1,3 (SD 2 carries an arrow-shaped artifact) = 7
- floor: SD 0-3 replace the procedural (better moss-on-deck contrast)
- wall: SD 0-2 replace the procedural (more organic root weave, cap intact)
- sidewalk/exit/accents: procedural only

Usage: python3 scripts/assets/tilesets_curate.py <proc_dir> <sd_dir> <out_dir>
(<out_dir> is normally public/themes/swampspace/tiles — proc tiles already
there stay; this adds/overwrites the curated pool files.)
"""

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from palette import RGB  # noqa: E402

# In-family palette colors for foliage surfaces: greens, browns, deep darks,
# bioluminescent greens. Steel/teal specks inside grass are SD artifacts.
GRASS_FAMILY = [
    (8, 8, 12), (20, 26, 22), (34, 56, 15), (53, 81, 26), (76, 107, 40),
    (103, 135, 60), (134, 167, 80), (168, 196, 106), (46, 30, 16),
    (74, 52, 25), (107, 77, 38), (70, 224, 120), (166, 255, 190),
]


def heal(im: Image.Image, family: list[tuple[int, int, int]]) -> Image.Image:
    im = im.convert("RGB")
    px = im.load()
    fam = set(family)
    for y in range(im.height):
        for x in range(im.width):
            c = px[x, y]
            if c in fam:
                continue
            # nearest family color
            px[x, y] = min(family, key=lambda f: sum((f[i] - c[i]) ** 2 for i in range(3)))
    return im


def tone_normalize(tiles: list[Image.Image], family: list[tuple[int, int, int]], k: float = 0.85) -> list[Image.Image]:
    """Pull each tile's mean brightness toward the POOL mean by factor k, then
    re-snap to the family palette. Kills the 32px value-checkerboard a variant
    pool paints when variants differ in average tone, while keeping each
    tile's internal texture (the variety that matters)."""
    means = []
    for im in tiles:
        px = list(im.convert("RGB").getdata())
        means.append(sum(sum(c) for c in px) / (3 * len(px)))
    pool = sum(means) / len(means)
    out = []
    for im, m in zip(tiles, means):
        im = im.convert("RGB")
        shift = (pool - m) * k
        p = im.load()
        for y in range(im.height):
            for x in range(im.width):
                c = tuple(min(255, max(0, round(v + shift))) for v in p[x, y])
                p[x, y] = min(family, key=lambda f: sum((f[i] - c[i]) ** 2 for i in range(3)))
        out.append(im)
    return out


def main() -> None:
    proc_dir, sd_dir, out_dir = (Path(a) for a in sys.argv[1:4])
    out_dir.mkdir(parents=True, exist_ok=True)

    # grass: proc 0-3 + healed SD 0-3, tone-normalized as ONE pool of 8
    pool = [Image.open(proc_dir / f"grass-{i}.png") for i in range(4)] + [
        heal(Image.open(sd_dir / f"grass-{i}.png"), GRASS_FAMILY) for i in range(4)
    ]
    for i, im in enumerate(tone_normalize(pool, GRASS_FAMILY)):
        im.save(out_dir / f"grass-{i}.png")

    # street: proc 0-3 stay; SD 0,1,3 become street-4..6
    for j, i in enumerate([0, 1, 3]):
        Image.open(sd_dir / f"street-{i}.png").convert("RGB").save(out_dir / f"street-{4 + j}.png")

    # floor: SD replaces proc
    for i in range(4):
        Image.open(sd_dir / f"floor-{i}.png").convert("RGB").save(out_dir / f"floor-{i}.png")

    # wall: SD replaces proc
    for i in range(3):
        Image.open(sd_dir / f"wall-{i}.png").convert("RGB").save(out_dir / f"wall-{i}.png")

    print("curated pools written to", out_dir)


if __name__ == "__main__":
    main()
