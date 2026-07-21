#!/usr/bin/env python3
"""Genesis-upgrade tile BASES: value-banded structural inits for ComfyUI.

Stage 1 of the tile pipeline (stage 2 = tiles_genesis_sd.py, the ComfyUI
img2img repaint). These bases fix what made the shipped pack unreadable
(docs/genesis-upgrade.md): wall and floor luminance bands overlapped
(contrast 1.14), the exit was invisible on the deck (1.02), street ≈
sidewalk (1.18). Every surface now owns a value band and touching surfaces
sit ≥1 band apart — the diffusion pass repaints TEXTURE inside each band at
moderate denoise, and post enforces the band again after painting.

Bands (mean luminance targets, gated by contrast_audit.py):
  wall ~33 (near-black body, pale raised top cap) < street ~53 < grass ~66
  < floor ~90 (warm tan deck) < sidewalk ~140 (light plates) < exit ~155.

Macro surfaces (floor, street — manifest macroTiles=2) are authored as 2x2
supertiles sliced row-major, matching pickTileVariant. floor-overlay decals
ship straight from here (RGBA alpha art stays procedural, docs §4).

Deterministic: fixed seed per (surface, variant).
Usage: tiles_genesis.py <outdir> [T]   (bases + overlays; T = tile px, default 64)
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, binary_dilation

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from palette import RGB  # noqa: E402

PAL = np.array(RGB, np.float32)

# Per-surface mean-luminance targets — the value plan, used by the SD post
# pass to re-enforce the band after diffusion repaints texture.
BAND = {"wall": 33.0, "street": 53.0, "grass": 66.0, "floor": 90.0,
        "sidewalk": 140.0, "exit": 155.0}

BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) / 16.0


def hexc(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32)


def snap(img, dither=12.0):
    """Nearest-palette quantize through a Bayer 4x4 ordered dither (the
    Genesis band-transition signature; post-diffusion output goes through
    this too, so bases and repaints share one quantizer)."""
    h, w = img.shape[:2]
    ty = np.tile(BAYER4, (h // 4 + 1, w // 4 + 1))[:h, :w]
    j = img + ((ty - 0.5) * dither)[..., None]
    d = ((j.reshape(-1, 3)[:, None] - PAL[None]) ** 2).sum(-1)
    return PAL[d.argmin(1)].reshape(img.shape).astype(np.uint8)


def lum(img):
    a = np.asarray(img, np.float32)
    return float((0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]).mean())


def edge_calm(img, to_color, px=3):
    """Pull a tile's outer `px` ring toward a SHARED color so every variant of an
    organic surface meets every other without a seam. High-contrast features
    stay in the interior; the border becomes common ground. `to_color` is the
    same constant for all variants of a surface — that's what makes an arbitrary
    field of them tile (continuity for many-variant grass)."""
    a = np.asarray(img, np.float32)
    H, W = a.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    edge = np.minimum.reduce([yy, xx, H - 1 - yy, W - 1 - xx])
    calm = np.clip(edge / px, 0, 1)[..., None]
    return a * calm + np.asarray(to_color, np.float32)[None, None] * (1 - calm)


def despeckle(img, passes=1):
    """Kill isolated single pixels: any pixel differing from BOTH horizontal
    and BOTH vertical neighbors (wrap) is replaced by its most common neighbor.
    Turns diffusion salt-and-pepper into the flat color areas Genesis art wants,
    without touching plate edges/lines (those have same-value neighbors along
    the line)."""
    a = np.asarray(img, np.uint8).copy()
    for _ in range(passes):
        up, down = np.roll(a, 1, 0), np.roll(a, -1, 0)
        left, right = np.roll(a, 1, 1), np.roll(a, -1, 1)
        diff = lambda b: (np.abs(a.astype(np.int16) - b) > 8).any(-1)
        iso = diff(up) & diff(down) & diff(left) & diff(right)
        # replace isolated pixels with the vertical-neighbor average (cheap mode)
        repl = ((up.astype(np.int16) + down + left + right) // 4).astype(np.uint8)
        a[iso] = repl[iso]
    return a


# Flat surfaces (light metal, asphalt) checkerboard badly when the palette
# snap dithers between two adjacent grays — a nearly-uniform value lands
# exactly between palette entries. These snap with NO dither; the busier
# organic surfaces keep a light dither for Genesis band transitions.
FLAT = {"sidewalk", "street"}


def enforce_band(img, surface, tol=0.08):
    """Scale a repainted tile's luminance back onto its band when diffusion
    drifted more than `tol` off target, then re-snap. Keeps the value plan
    machine-guaranteed while leaving in-band texture alone."""
    d = 0.0 if surface in FLAT else 4.0
    t = BAND[surface]
    m = lum(img)
    ratio = (t + 12.75) / (m + 12.75)
    if abs(1 - ratio) <= tol:
        return snap(np.asarray(img, np.float32), dither=d)
    s = np.clip(ratio, 0.55, 1.8)
    return snap(np.clip(np.asarray(img, np.float32) * s, 0, 255), dither=d)


def tnoise(T, rng, scale, octaves=1):
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
    T = img.shape[0]
    x, y = float(x0), float(y0)
    for _ in range(n):
        for ax in range(-w, w + 1):
            for ay in range(-w, w + 1):
                if ax * ax + ay * ay <= w * w:
                    img[int(y + ay) % T, int(x + ax) % T] = col
        x += dx
        y += dy


def field(S, rng, c0, c1, sigma, ramp=0.6):
    """Zero-mean two-tone base so a laid field has no per-tile quilt grid."""
    n = tnoise(S, rng, sigma, octaves=2) - 0.5
    mid = (c0 + c1) * 0.5
    return mid[None, None] + (n * ramp)[..., None] * (c1 - c0)[None, None]


# ---- structural bases ------------------------------------------------------

def floor_macro(T, m):
    """2Tx2T deck-plate supertile: warm tan plates lit from top, dark seams."""
    M = 2 * T
    rng = np.random.default_rng(11000 + m)
    img = field(M, rng, hexc("#6b4d26"), hexc("#8f6c38"), sigma=M / 5, ramp=0.5)
    seam, lit = hexc("#2e1e10"), hexc("#b08d50")
    plate = T // 2
    off = (m * 11) % plate
    for y in range(off, M + off, plate):
        img[y % M, :] = seam
        img[(y + 1) % M, :] = lit * 0.7 + img[(y + 1) % M, :] * 0.3
    for x in range(off, M + off, plate):
        img[:, x % M] = seam
    for y in range(off, M + off, plate):
        for x in range(off, M + off, plate):
            if ((x + y) // plate) % 2 == 0:
                img[(y + 3) % M, (x + 3) % M] = seam
    mask = np.zeros((M, M), bool)
    for y in range(off, M + off, plate):
        mask[y % M, :] = True
    near = binary_dilation(mask, iterations=2) & ~mask
    speck = tnoise(M, rng, M / 8) > 0.78
    img[near & speck] = hexc("#4c6b28")
    return img


def wall_tile(T, v):
    rng = np.random.default_rng(13000 + v)
    img = field(T, rng, hexc("#08080c"), hexc("#141a16"), sigma=T / 4, ramp=0.5)
    for _ in range(2 + v % 2):
        wrapline(img, rng.integers(0, T), rng.integers(0, T),
                 rng.uniform(-0.4, 0.4), 1.0, T, hexc("#2e1e10"), w=1)
    for _ in range(1 + v % 2):
        wrapline(img, rng.integers(0, T), rng.integers(0, T),
                 rng.uniform(-0.5, 0.5), 1.0, T, hexc("#22380f"), w=0)
    if v % 3 == 0:
        img[rng.integers(T // 3, T), rng.integers(0, T)] = hexc("#46e078")
    cap = field(T, rng, hexc("#59636d"), hexc("#7b8791"), sigma=T / 3, ramp=0.4)
    ch = max(4, T // 10)  # raised top cap, lit from the top of the screen
    img[0:ch, :] = cap[0:ch, :]
    img[ch, :] = hexc("#08080c")  # cap drop-shadow line
    return img


def street_macro(T, m):
    M = 2 * T
    rng = np.random.default_rng(14000 + m)
    img = field(M, rng, hexc("#23282e"), hexc("#3c444d"), sigma=M / 5, ramp=0.4)
    wear = tnoise(M, rng, M / 3, octaves=1)
    img[wear > 0.8] = img[wear > 0.8] * 0.5 + hexc("#59636d")[None] * 0.5
    cracks = np.zeros((M, M), bool)
    for _ in range(3 + m):
        before = img.copy()
        ang = rng.uniform(0, 6.28)
        wrapline(img, rng.integers(0, M), rng.integers(0, M),
                 np.cos(ang), np.sin(ang), M, hexc("#08080c"), w=0)
        cracks |= (img != before).any(-1)
    near = binary_dilation(cracks, iterations=1) & ~cracks
    speck = tnoise(M, rng, M / 7) > 0.72
    img[near & speck] = hexc("#35511a")
    return img


def sidewalk_tile(T, v):
    rng = np.random.default_rng(15000 + v)
    img = field(T, rng, hexc("#7b8791"), hexc("#a2adb4"), sigma=T / 4, ramp=0.4)
    seam = hexc("#3c444d")
    ox = (v * 17) % T
    mask = np.zeros((T, T), bool)
    img[:, ox] = seam
    img[:, (ox + 1) % T] = seam
    mask[:, ox] = True
    if v % 2:
        yy = (v * 13) % T
        img[yy, :] = seam
        mask[yy, :] = True
    if v % 2 == 0:
        cx, cy = (ox + 5) % T, (v * 9 + 4) % T
        img[cy:cy + 3, cx:cx + 3] = hexc("#59636d")
    near = binary_dilation(mask, iterations=2) & ~mask
    speck = tnoise(T, rng, T / 6) > 0.8
    img[near & speck] = hexc("#35511a")
    return img


def bog_tile(T, v):
    rng = np.random.default_rng(16000 + v)
    img = field(T, rng, hexc("#22380f"), hexc("#35511a"), sigma=T / 3, ramp=0.7)
    clump = tnoise(T, rng, T / 4, octaves=2)  # LOW frequency: tufts, not confetti
    img[clump > 0.62] = hexc("#4c6b28")
    img[clump > 0.78] = hexc("#67873c")
    img[clump > 0.90] = hexc("#86a750")
    dark = tnoise(T, rng, T / 4)
    img[dark > 0.80] = hexc("#141a16")
    return img


def bog_macro(T, m):
    """2Tx2T bog supertile — LOW CONTRAST and edge-calm so many variants read as
    ONE continuous mossy field (the interesting features live in rare accents,
    not every tile). No near-black hollows (they read as 'dark gray' spam and
    expose the tile grid); just a gentle 3-value olive tonal weave. The outer
    ring is pulled toward the mid green so ANY macro tiles seamlessly against
    ANY other across cell boundaries — the continuity multiple variants need."""
    M = 2 * T
    rng = np.random.default_rng(16500 + m)
    base = field(M, rng, hexc("#2e460f"), hexc("#4c6b28"), sigma=M / 5, ramp=0.5)
    clump = tnoise(M, rng, M / 6, octaves=2)
    base[clump > 0.62] = hexc("#4c6b28") * 0.5 + base[clump > 0.62] * 0.5
    base[clump > 0.80] = hexc("#67873c")           # brighter tuft tips, sparse
    shade = tnoise(M, rng, M / 6, octaves=2)
    base[shade > 0.80] = hexc("#35511a") * 0.6 + base[shade > 0.80] * 0.4  # soft dark moss
    # fine dithered grain so it doesn't read as flat paint
    grain = tnoise(M, rng, M / 20)
    base[grain > 0.7] = base[grain > 0.7] * 0.9 + hexc("#67873c")[None] * 0.1
    # edge-calm: blend the outer ring toward the field mean so cross-cell seams
    # vanish regardless of which macro sits next to which.
    yy, xx = np.mgrid[0:M, 0:M].astype(np.float32)
    edge = np.minimum.reduce([yy, xx, M - 1 - yy, M - 1 - xx])
    calm = np.clip(edge / 5.0, 0, 1)[..., None]
    mean = base.reshape(-1, 3).mean(0)
    return base * calm + mean[None, None] * (1 - calm)


def exit_tile(T, v=0):
    """Launch-bay pad: hot biolume ring — must scream against the deck."""
    rng = np.random.default_rng(17000)
    img = field(T, rng, hexc("#163a3e"), hexc("#24565c"), sigma=T / 4, ramp=0.5)
    c = T / 2 - 0.5
    yy, xx = np.mgrid[0:T, 0:T]
    r = np.hypot(yy - c, xx - c)
    img[r < T * 0.48] = hexc("#46e078")
    img[r < T * 0.36] = hexc("#a6ffbe")
    img[r < T * 0.16] = hexc("#46e078")
    return img


def street_accent(T, v):
    img = street_macro(T // 2, 0)[:T // 2, :T // 2]
    img = np.repeat(np.repeat(img, 2, axis=0), 2, axis=1)[:T, :T].copy()
    rng = np.random.default_rng(18000 + v)
    c = T / 2 - 0.5
    yy, xx = np.mgrid[0:T, 0:T]
    r = np.hypot(yy - c, xx - c)
    if v == 0:  # manhole
        img[r < T * 0.36] = hexc("#141a16")
        img[r < T * 0.30] = hexc("#3c444d")
        img[int(c), int(c - 3):int(c + 4)] = hexc("#141a16")
    elif v == 1:  # spore burst
        blot = tnoise(T, rng, T / 5, octaves=2)
        img[blot > 0.62] = hexc("#35511a")
        img[blot > 0.78] = hexc("#4c6b28")
        img[blot > 0.90] = hexc("#46e078")
    else:  # tar patch
        img[r < T * 0.4] = img[r < T * 0.4] * 0.4 + hexc("#08080c")[None] * 0.6
        img[(r > T * 0.28) & (r < T * 0.34)] = hexc("#3c444d")
    return img


def floor_accent(T, v):
    img = floor_macro(T, 0)[:T, :T].copy()
    rng = np.random.default_rng(19000 + v)
    if v == 0:  # vent grate
        pad = T // 5
        img[pad:T - pad, pad:T - pad] = hexc("#23282e")[None, None]
        for y in range(pad + 2, T - pad, 4):
            img[y:y + 2, pad + 2:T - pad - 2] = hexc("#08080c")
        img[pad:pad + 2, pad:T - pad] = hexc("#59636d")
    else:  # glowing fungus cluster
        blot = tnoise(T, rng, T / 5, octaves=2)
        img[blot > 0.66] = hexc("#22380f")
        img[blot > 0.80] = hexc("#35511a")
        img[blot > 0.90] = hexc("#46e078")
        img[blot > 0.96] = hexc("#a6ffbe")
    return img


def grass_accent(T, v):
    img = bog_tile(T, 7).copy()
    rng = np.random.default_rng(20000 + v)
    if v == 0:  # root cluster
        for _ in range(4):
            wrapline(img, rng.integers(0, T), rng.integers(0, T),
                     rng.uniform(-0.7, 0.7), rng.uniform(0.5, 1.0), T // 2, hexc("#4a3419"), w=2)
        img[tnoise(T, rng, T / 6) > 0.88] = hexc("#6b4d26")
    elif v == 1:  # biolume flowers
        spots = tnoise(T, rng, T / 8) > 0.86
        img[spots] = hexc("#46e078")
        img[binary_dilation(spots, iterations=1) & ~spots] = hexc("#22380f")
    else:  # teal pool
        c = T / 2 - 0.5
        yy, xx = np.mgrid[0:T, 0:T]
        r = np.hypot(yy - c, xx - c) + tnoise(T, rng, T / 6) * 6
        img[r < T * 0.34] = hexc("#163a3e")
        img[r < T * 0.22] = hexc("#24565c")
        img[(r >= T * 0.34) & (r < T * 0.40)] = hexc("#22380f")
    return img


def floor_overlay(T, v):
    """RGBA moss decal for the LIGHT deck floor — dark green, alpha-shaped,
    chunky 4-level alpha. Ships straight from here (alpha art stays
    procedural — docs/sprite-generation.md §4)."""
    rng = np.random.default_rng(21000 + v)
    blot = tnoise(T, rng, T / (4 + v % 3), octaves=2)
    a = np.clip((blot - 0.55) * 3.2, 0, 1)
    yy, xx = np.mgrid[0:T, 0:T].astype(np.float32)
    fade = [yy / T, 1 - yy / T, xx / T, 1 - xx / T][v % 4]
    a = a * np.clip(1.3 - fade * 1.6, 0, 1)
    rgb = np.zeros((T, T, 3), np.float32) + hexc("#22380f")[None, None]
    rgb[blot > 0.75] = hexc("#35511a")
    rgb[blot > 0.9] = hexc("#4c6b28")
    out = np.zeros((T, T, 4), np.uint8)
    out[..., :3] = snap(rgb, dither=8.0)
    out[..., 3] = ((np.clip(a, 0, 1) * 255).astype(np.uint8) // 64) * 64
    return out


if __name__ == "__main__":
    out = sys.argv[1]
    T = int(sys.argv[2]) if len(sys.argv) > 2 else 64
    os.makedirs(out, exist_ok=True)
    for m in range(2):
        Image.fromarray(snap(floor_macro(T, m)), "RGB").save(f"{out}/base-floor-macro-{m}.png")
    for m in range(3):
        Image.fromarray(snap(street_macro(T, m)), "RGB").save(f"{out}/base-street-macro-{m}.png")
    for v in range(3):
        Image.fromarray(snap(wall_tile(T, v)), "RGB").save(f"{out}/base-wall-{v}.png")
    for v in range(4):
        Image.fromarray(snap(sidewalk_tile(T, v)), "RGB").save(f"{out}/base-sidewalk-{v}.png")
    for v in range(8):
        Image.fromarray(snap(bog_tile(T, v)), "RGB").save(f"{out}/base-grass-{v}.png")
    Image.fromarray(snap(exit_tile(T)), "RGB").save(f"{out}/base-exit-0.png")
    for v in range(3):
        Image.fromarray(snap(street_accent(T, v)), "RGB").save(f"{out}/base-street-accent-{v}.png")
    for v in range(2):
        Image.fromarray(snap(floor_accent(T, v)), "RGB").save(f"{out}/base-floor-accent-{v}.png")
    for v in range(3):
        Image.fromarray(snap(grass_accent(T, v)), "RGB").save(f"{out}/base-grass-accent-{v}.png")
    for v in range(4):
        Image.fromarray(floor_overlay(T, v), "RGBA").save(f"{out}/floor-overlay-{v}.png")
    print(f"wrote genesis bases to {out} at T={T}")
