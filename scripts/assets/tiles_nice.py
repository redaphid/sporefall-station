#!/usr/bin/env python3
"""Iterated swampspace tiles: quiet, varied, seamless-by-construction.

Design goals (fixing the old confetti/visible-grid tiles):
- SEAMLESS: all texture is tileable value-noise (gaussian-smoothed random field
  with wrap) or wrapped features, so edges always match.
- QUIET INTERIORS: interior tone stays within a couple palette steps; contrast
  is saved for structure (plate seams, roots, cracks), not speckle.
- BREAK THE GRID: 6-8 variants per surface with DIFFERENT seam offsets / root
  paths / clump fields, so a field of tiles doesn't read as one stamp repeated.
Deterministic: fixed seed per (surface, variant).
"""
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

sys.path.insert(0, "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/scripts/assets")
from palette import RGB  # noqa: E402

PAL = np.array(RGB, np.float32)


def snap(rgb):
    d = ((rgb.reshape(-1, 3)[:, None] - PAL[None]) ** 2).sum(-1)
    return PAL[d.argmin(1)].reshape(rgb.shape).astype(np.uint8)


def hexc(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32)


def tnoise(T, rng, scale, octaves=1):
    """Tileable smooth noise in [0,1] — gaussian blur with wrap makes it seamless."""
    out = np.zeros((T, T), np.float32)
    amp = 1.0
    for o in range(octaves):
        f = rng.standard_normal((T, T))
        f = gaussian_filter(f, sigma=scale / (o + 1), mode="wrap")
        out += amp * f
        amp *= 0.5
    out -= out.min()
    return out / (out.max() + 1e-6)


def wrapline(img, x0, y0, dx, dy, n, col, w=1):
    """A wandering wrapped stroke (roots/cracks)."""
    T = img.shape[0]
    x, y = float(x0), float(y0)
    for _ in range(n):
        for ax in range(-w, w + 1):
            for ay in range(-w, w + 1):
                if ax * ax + ay * ay <= w * w:
                    img[int(y + ay) % T, int(x + ax) % T] = col
        x += dx
        y += dy


def base_field(T, rng, c0, c1, sigma=6.0, ramp=0.5):
    """Quiet two-tone interior. The tone shift is ZERO-MEAN around the midpoint
    of c0/c1, so every tile shares the same average brightness — no per-tile
    'quilt' grid when the pool is laid out as a field."""
    n = tnoise(T, rng, sigma, octaves=2) - 0.5  # zero-mean
    mid = (c0 + c1) * 0.5
    t = (n * ramp)[..., None]
    return mid[None, None] + t * (c1 - c0)[None, None]


def floor_tile(T, v):
    rng = np.random.default_rng(1000 + v)
    img = base_field(T, rng, hexc("#23282e"), hexc("#2e3a30"), sigma=T / 4, ramp=0.5)
    # plate seams at varied offsets per variant (break the grid)
    seam = hexc("#141a16")
    ox, oy = (v * 7) % T, (v * 11 + 5) % T
    for x in (ox, (ox + T // 2) % T):
        img[:, x] = seam
        img[:, (x + 1) % T] = seam * 0.6 + img[:, (x + 1) % T] * 0.4
    if v % 2 == 0:
        for y in (oy,):
            img[y, :] = seam
    # rivets near a couple plate corners
    for _ in range(3):
        rx, ry = rng.integers(0, T), rng.integers(0, T)
        img[ry % T, rx % T] = seam
    # rare moss creeping a seam corner (sparse)
    if v % 3 == 0:
        cx, cy = (ox + 2) % T, rng.integers(0, T)
        m = tnoise(T, rng, T / 6) > 0.72
        yy, xx = np.where(m)
        for y, x in zip(yy, xx):
            if abs((x - cx + T // 2) % T - T // 2) < 5:
                img[y, x] = hexc("#35511a")
    return snap(img)


def bog_tile(T, v):
    rng = np.random.default_rng(2000 + v)
    # quieter base ramp; keep the field in the mid-olive range
    img = base_field(T, rng, hexc("#22380f"), hexc("#35511a"), sigma=T / 5, ramp=0.8)
    clump = tnoise(T, rng, T / 7, octaves=2)
    img[clump > 0.70] = hexc("#4c6b28")   # mid moss: present but not dominant
    img[clump > 0.90] = hexc("#67873c")   # brighter tips: rare, small
    dark = tnoise(T, rng, T / 5)
    img[dark > 0.72] = hexc("#22380f")    # dark hollows for depth
    return snap(img)


def wall_tile(T, v):
    rng = np.random.default_rng(3000 + v)
    img = base_field(T, rng, hexc("#1c1420"), hexc("#23282e"), sigma=T / 4, ramp=0.4)
    # varied wandering roots (different path per variant -> no lockstep repeat)
    for _ in range(2 + v % 2):
        x0 = rng.integers(0, T)
        dx = rng.uniform(-0.4, 0.4)
        wrapline(img, x0, rng.integers(0, T), dx, 1.0, T, hexc("#4a3419"), w=1)
    for _ in range(2):
        wrapline(img, rng.integers(0, T), rng.integers(0, T),
                 rng.uniform(-0.5, 0.5), 1.0, T, hexc("#35511a"), w=0)
    # sparse biolume nodes
    for _ in range(rng.integers(0, 2)):
        img[rng.integers(0, T), rng.integers(0, T)] = hexc("#46e078")
    return snap(img)


def _moss_along(img, mask, rng, col, edge=0.55):
    """Tint moss ONLY on pixels adjacent to a crack/seam (mask), so overgrowth
    follows structure instead of splotching the open surface."""
    from scipy.ndimage import binary_dilation
    near = binary_dilation(mask, iterations=1) & ~mask
    speck = tnoise(img.shape[0], rng, img.shape[0] / 6) > edge
    img[near & speck] = col


def street_tile(T, v):
    rng = np.random.default_rng(4000 + v)
    img = base_field(T, rng, hexc("#3c444d"), hexc("#59636d"), sigma=T / 4, ramp=0.15)
    cracks = np.zeros((T, T), bool)
    for _ in range(2 + v % 2):
        c = np.zeros((T, T), bool)
        cimg = img.copy()
        ang = rng.uniform(0, 6.28)
        wrapline(cimg, rng.integers(0, T), rng.integers(0, T), np.cos(ang), np.sin(ang), T, hexc("#23282e"), w=0)
        c = (cimg != img).any(-1)
        img = cimg
        cracks |= c
    _moss_along(img, cracks, rng, hexc("#35511a"))
    return snap(img)


def sidewalk_tile(T, v):
    rng = np.random.default_rng(5000 + v)
    img = base_field(T, rng, hexc("#454e57"), hexc("#59636d"), sigma=T / 4, ramp=0.15)
    seam = hexc("#23282e")
    ox = (v * 9) % T
    mask = np.zeros((T, T), bool)
    img[:, ox] = seam
    mask[:, ox] = True
    if v % 2:
        yy = (v * 5) % T
        img[yy, :] = seam
        mask[yy, :] = True
    _moss_along(img, mask, rng, hexc("#35511a"), edge=0.7)
    return snap(img)


GENS = {"floor": floor_tile, "grass": bog_tile, "wall": wall_tile,
        "street": street_tile, "sidewalk": sidewalk_tile}
COUNTS = {"floor": 8, "grass": 8, "wall": 3, "street": 12, "sidewalk": 4}

if __name__ == "__main__":
    import os
    T = int(sys.argv[2]) if len(sys.argv) > 2 else 32
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, gen in GENS.items():
        for v in range(COUNTS[name]):
            Image.fromarray(gen(T, v), "RGB").save(f"{out}/{name}-{v}.png")
    print(f"wrote tiles to {out} at T={T}")
