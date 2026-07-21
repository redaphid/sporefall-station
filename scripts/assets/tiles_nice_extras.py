#!/usr/bin/env python3
"""Native-res accents / overlays / exit for the iterated swampspace tiles,
matching tiles_nice.py's style. Regenerates the pieces that were still 2x-nearest
in the hi-res theme. Deterministic. Usage: tile_extras.py <outdir> <T>"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/scripts/assets")
import tiles_nice as N  # noqa: E402

hexc, snap, base_field, tnoise, wrapline = N.hexc, N.snap, N.base_field, N.tnoise, N.wrapline
rng_ = np.random.default_rng


def exit_tile(T):
    rng = rng_(6000)
    img = base_field(T, rng, hexc("#141a16"), hexc("#23282e"), T / 4, 0.3)
    b = hexc("#3c444d")
    img[:max(1, T // 16), :] = b; img[-max(1, T // 16):, :] = b
    img[:, :max(1, T // 16)] = b; img[:, -max(1, T // 16):] = b
    g = hexc("#46e078")
    cx = T * 6 // 10
    w = max(1, T // 16)
    for i in range(T // 4):
        for dw in range(w):
            img[T // 2 - i, cx - i + dw] = g
            img[T // 2 + i, cx - i + dw] = g
    return snap(img)


def _clump(T, rng, cx, cy, r, col, img):
    m = tnoise(T, rng, r * 0.8)
    yy, xx = np.mgrid[0:T, 0:T]
    dist = np.minimum(np.abs(xx - cx), T - np.abs(xx - cx)) ** 2 + np.minimum(np.abs(yy - cy), T - np.abs(yy - cy)) ** 2
    mask = (dist < (r * r) * (0.5 + m))
    img[mask] = col


def floor_accent(T, v):
    rng = rng_(7000 + v)
    img = N.floor_tile(T, v).astype(np.float32)
    if v == 0:  # grate: horizontal slats
        for y in range(T // 4, 3 * T // 4, max(2, T // 10)):
            img[y:y + max(1, T // 32), T // 6:5 * T // 6] = hexc("#141a16")
    else:  # buckled plate wrapped in roots
        for _ in range(4):
            wrapline(img, rng.integers(0, T), rng.integers(0, T), rng.uniform(-0.5, 0.5), 1.0, T // 2 + T // 4,
                     hexc("#4a3419"), max(1, T // 32))
        _clump(T, rng, T // 2, T // 2, T // 6, hexc("#35511a"), img)
    return snap(img)


def grass_accent(T, v):
    rng = rng_(8000 + v)
    img = N.bog_tile(T, v).astype(np.float32)
    cx, cy = rng.integers(T // 3, 2 * T // 3), rng.integers(T // 3, 2 * T // 3)
    _clump(T, rng, cx, cy, T // 4, hexc("#22380f"), img)
    _clump(T, rng, cx, cy, T // 6, hexc("#4c6b28"), img)
    _clump(T, rng, cx, cy, T // 10, hexc("#67873c"), img)
    for _ in range(3):  # a few glowing spores
        img[(cy + rng.integers(-T // 8, T // 8)) % T, (cx + rng.integers(-T // 8, T // 8)) % T] = hexc("#a6ffbe")
    return snap(img)


def street_accent(T, v):
    rng = rng_(9000 + v)
    img = N.street_tile(T, v).astype(np.float32)
    # a drain grate with teal seep
    s = T // 4
    x0, y0 = T // 2 - s // 2, T // 2 - s // 2
    img[y0:y0 + s, x0:x0 + s] = hexc("#23282e")
    for i in range(0, s, max(2, s // 4)):
        img[y0:y0 + s, x0 + i] = hexc("#141a16")
    for _ in range(4):
        img[(y0 + rng.integers(0, s)) % T, (x0 + rng.integers(-2, s + 2)) % T] = hexc("#3ce0d8")
    return snap(img)


def floor_overlay(T, v):
    """RGBA moss DECAL: organic clump on transparent, mass biased toward the TOP
    edge (renderer rotates it toward the wall/seam that earned it)."""
    rng = rng_(10000 + v)
    out = np.zeros((T, T, 4), np.uint8)
    field = tnoise(T, rng, T / 7, octaves=2)
    yy = np.mgrid[0:T, 0:T][0]
    bias = 1.0 - (yy / T) * 0.7  # denser at top
    mask = field * bias > 0.62
    rgb = np.zeros((T, T, 3), np.float32)
    rgb[:] = hexc("#35511a")
    rgb[field * bias > 0.72] = hexc("#4c6b28")
    edge = (field * bias > 0.62) & (field * bias < 0.66)
    rgb[edge] = hexc("#22380f")  # dark rim
    out[..., :3] = snap(rgb)
    out[..., 3] = np.where(mask, 255, 0)
    return Image.fromarray(out, "RGBA")


def main():
    out = sys.argv[1]
    T = int(sys.argv[2])
    os.makedirs(out, exist_ok=True)
    Image.fromarray(exit_tile(T), "RGB").save(f"{out}/exit-0.png")
    for v in range(2):
        Image.fromarray(floor_accent(T, v), "RGB").save(f"{out}/floor-accent-{v}.png")
    for v in range(3):
        Image.fromarray(grass_accent(T, v), "RGB").save(f"{out}/grass-accent-{v}.png")
        Image.fromarray(street_accent(T, v), "RGB").save(f"{out}/street-accent-{v}.png")
    for v in range(4):
        floor_overlay(T, v).save(f"{out}/floor-overlay-{v}.png")
    print(f"tile extras -> {out} (T={T})")


if __name__ == "__main__":
    main()
