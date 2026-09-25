#!/usr/bin/env python3
"""Indoor-complex tile art (floors 3+) for the swampspace-hires theme.

Surfaces (Tile ids from src/game/levelgen/level.ts, sprite keys `tile.<name>`):

  hall     corridor deck plating          macro-2 units (plates span tiles)
  grate    vent grate set into the deck   single feature tiles
  tiled    scrubbed ceramic (mess/galley/washroom/medbay/lab)
  plating  diamond-tread engineering plate (reactor/depot)   macro-2 units
  hull     outer pressure hull (wall family, fully solid)
  bog      swamp seep flooding the deck   macro-2 units
  + `.accent` pools for hall/tiled/plating/hull/bog.

Pipeline per unit, same shape as the Genesis tile recipe (the `themed-tilesets`
skill on the hires-assets branch):

  value-banded procedural base (structure aligned to tile edges)
  -> x8 nearest to 1024 -> ComfyUI img2img (Juggernaut Ragnarok + Pixel Art XL
     LoRA @ 0.7) over N seeds
  -> wrap-safe k-centroid downscale -> despeckle
  -> STRUCTURE RESTORE: seams / grout / rivets / grate slats re-stamped from the
     base so every variant meets every other on identical edge lines
  -> band enforcement + palette snap -> auto-pick (band fit + detail) -> slice.

Every seed's candidate is kept in $SWAMPSPACE_STAGE/indoor-tiles/<surface>/ with a
contact sheet so a human can re-pick (`--pick surface:unit=seed`).

Usage:
  SWAMPSPACE_STAGE=/tmp/indoor-stage python3 tiles_indoor.py [--seeds=3] \
      [--out=../../public/themes/swampspace-hires/tiles] [--procedural] [surface...]

`--procedural` skips ComfyUI entirely (structure-only art, deterministic).
"""
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from palette import RGB  # noqa: E402
from post import kcentroid  # noqa: E402

T = 64
STAGE = Path(os.environ.get("SWAMPSPACE_STAGE", "/tmp/indoor-stage")) / "indoor-tiles"
OUT_DEFAULT = Path(__file__).resolve().parents[2] / "public/themes/swampspace-hires/tiles"

# ---------------------------------------------------------------------------
# Palette: the locked 34-colour swampspace palette PLUS a few indoor steps.
# LOOSENED RULE: the locked palette has no colour between #a2adb4 and the
# near-white #f2f6ea, and nothing between #23282e and #3c444d, so ceramic tile
# and dark bulkhead ramps banded into 2-tone posterisation. These extras are
# interpolations of existing palette entries (same hue family), not new hues.
# ---------------------------------------------------------------------------
INDOOR_EXTRA = ["#2e343b", "#4a535c", "#6a747e", "#8e99a1", "#bcc5c8", "#d3d9d8", "#2a4a4c"]


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


PAL = np.array(list(RGB) + [_hex(c) for c in INDOOR_EXTRA], np.float32)
C = {name: np.array(_hex(h), np.float32) for name, h in {
    "black": "#08080c", "ink": "#141a16", "steel0": "#23282e", "steel05": "#2e343b",
    "steel1": "#3c444d", "steel15": "#4a535c", "steel2": "#59636d", "steel25": "#6a747e",
    "steel3": "#7b8791", "steel35": "#8e99a1", "steel4": "#a2adb4", "cer1": "#bcc5c8",
    "cer2": "#d3d9d8", "white": "#f2f6ea",
    "teal0": "#163a3e", "teal05": "#2a4a4c", "teal1": "#24565c", "teal2": "#3a7a80", "teal3": "#5aa4ae",
    "teal4": "#7ecbd2", "olive0": "#22380f", "olive1": "#35511a", "olive2": "#4c6b28", "olive3": "#67873c",
    "olive4": "#86a750", "brown0": "#2e1e10", "brown1": "#4a3419", "brown2": "#6b4d26",
    "tan": "#8f6c38", "tan2": "#b08d50", "sand": "#cbb277", "glow": "#46e078", "glow2": "#a6ffbe",
    "cyan": "#3ce0d8", "amber": "#ffd83e", "orange": "#ff9032", "red": "#e04a2a",
}.items()}

BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], np.float32) / 16.0

# Value plan (mean luminance). Existing swampspace-hires bands:
#   wall 30 < street 40 < grass 54 < floor 82 < sidewalk 118 < exit 150.
# Indoor surfaces slot in so every TOUCHING pair sits >= one band apart:
# hull (outer mass) darkest; corridors a clear step above the module walls;
# engineering plate between corridor and the tan crew deck; ceramic the light
# room floor; bog seep reads as a dark sunken pool on any deck.
BAND = {"hull": 22.0, "grate": 40.0, "bog": 58.0, "hall": 62.0, "plating": 72.0, "tiled": 112.0}
# Texture transitions are authored as explicit ordered-dither zones (dzone), so
# the final palette snap never adds dither of its own.
FLAT = {"hall", "plating", "tiled", "hull", "grate", "bog"}
# Water must never snap into the steel grays (a scaled dark teal lands nearer
# #23282e than #163a3e and reads as a gray hole in the pool).
_STEEL = {_hex(h) for h in ("#23282e", "#2e343b", "#3c444d", "#4a535c", "#59636d", "#6a747e",
                            "#7b8791", "#8e99a1", "#a2adb4", "#bcc5c8", "#d3d9d8", "#1c1420")}
SURFACE_PAL = {"bog": np.array([c for c in PAL.tolist() if tuple(int(v) for v in c) not in _STEEL], np.float32)}


def lum(a):
    a = np.asarray(a, np.float32)
    return float((0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]).mean())


def snap(img, dither=0.0, pal=None):
    pal = PAL if pal is None else pal
    img = np.asarray(img, np.float32)
    h, w = img.shape[:2]
    if dither:
        ty = np.tile(BAYER4, (h // 4 + 1, w // 4 + 1))[:h, :w]
        img = img + ((ty - 0.5) * dither)[..., None]
    d = ((img.reshape(-1, 3)[:, None] - pal[None]) ** 2).sum(-1)
    return pal[d.argmin(1)].reshape(img.shape).astype(np.uint8)


def tnoise(S, rng, sigma):
    f = gaussian_filter(rng.standard_normal((S, S)), sigma=sigma, mode="wrap")
    f -= f.min()
    return f / (f.max() + 1e-6)


def blend(dst, mask, col, a=1.0):
    m = (np.asarray(mask, np.float32) * a)[..., None]
    return dst * (1 - m) + col[None, None] * m


def dzone(img, field, col, lo, hi):
    """Ordered-dither zone: full `col` above `hi`, none below `lo`, a Bayer
    checker ramp between — the Genesis-era transition the shipped hires tiles
    use instead of soft alpha blends (which the palette snap would posterise)."""
    S = img.shape[0]
    b = np.tile(BAYER4, (S // 4 + 1, S // 4 + 1))[:S, :S]
    t = np.clip((field - lo) / (hi - lo), 0, 1)
    out = img.copy()
    out[t > b + 1e-6] = col
    return out


def despeckle(a, passes=2):
    a = np.asarray(a, np.uint8).copy()
    for _ in range(passes):
        up, down = np.roll(a, 1, 0), np.roll(a, -1, 0)
        left, right = np.roll(a, 1, 1), np.roll(a, -1, 1)
        diff = lambda b: (np.abs(a.astype(np.int16) - b) > 8).any(-1)  # noqa: E731
        iso = diff(up) & diff(down) & diff(left) & diff(right)
        repl = ((up.astype(np.int16) + down + left + right) // 4).astype(np.uint8)
        a[iso] = repl[iso]
    return a


def enforce_band(img, surface, tol=0.2, dither=None, ref=None):
    """Scale onto the surface's value band. `ref` (an accent's base tile) makes
    the scale follow the SURROUNDING surface, so a dark feature doesn't get
    brightened (or a hot one dimmed) away from the field it sits in."""
    d = (0.0 if surface in FLAT else 5.0) if dither is None else dither
    t = BAND[surface]
    m = lum(img if ref is None else ref)
    ratio = (t + 12.75) / (m + 12.75)
    a = np.asarray(img, np.float32)
    if abs(1 - ratio) > tol:
        a = np.clip(a * np.clip(ratio, 0.55, 1.8), 0, 255)
    return snap(a, dither=d, pal=SURFACE_PAL.get(surface))


# ---------------------------------------------------------------------------
# Procedural bases. Each returns (rgb float HxW x3, structure mask HxW bool,
# structure rgb). The structure layer is what gets re-stamped after diffusion.
# ---------------------------------------------------------------------------

def _rivet(img, st, sm, x, y, hi, lo):
    S = img.shape[0]
    for (dx, dy, col) in ((0, 0, hi), (1, 0, hi), (0, 1, hi), (1, 1, lo), (2, 1, lo), (1, 2, lo), (2, 2, lo)):
        yy, xx = (y + dy) % S, (x + dx) % S
        img[yy, xx] = col
        st[yy, xx] = col
        sm[yy, xx] = True


def _hline(img, st, sm, y, x0, x1, col):
    img[y, x0:x1] = col
    st[y, x0:x1] = col
    sm[y, x0:x1] = True


def _vline(img, st, sm, x, y0, y1, col):
    img[y0:y1, x] = col
    st[y0:y1, x] = col
    sm[y0:y1, x] = True


def _plates(img, st, sm, S, rng, rects, seam, hi, rivet_hi, rivet_lo, rivets=True):
    """Panel rects (x,y,w,h): dark seam on the top/left edge, a 1px bevel
    highlight inside it, rivets inset at the corners."""
    for (x, y, w, h) in rects:
        _hline(img, st, sm, y, x, x + w, seam)
        _vline(img, st, sm, x, y, y + h, seam)
        _hline(img, st, sm, (y + 1) % S, x + 1, x + w, hi)
        _vline(img, st, sm, (x + 1) % S, y + 1, y + h, hi)
        if rivets and w >= 16 and h >= 16:
            for (rx, ry) in ((x + 4, y + 4), (x + w - 6, y + 4), (x + 4, y + h - 6), (x + w - 6, y + h - 6)):
                _rivet(img, st, sm, rx, ry, rivet_hi, rivet_lo)


def _split(rng, x, y, w, h, depth):
    """Recursive panel split inside one tile-aligned plate."""
    if depth == 0 or (w < 24 and h < 24) or rng.random() < 0.3:
        return [(x, y, w, h)]
    if (w >= h and w >= 24) or h < 24:
        cut = int(rng.choice([w // 2, w // 4 * 1, w // 4 * 3]))
        cut = max(8, min(w - 8, cut))
        return _split(rng, x, y, cut, h, depth - 1) + _split(rng, x + cut, y, w - cut, h, depth - 1)
    cut = max(8, min(h - 8, int(rng.choice([h // 2, h // 4, h // 4 * 3]))))
    return _split(rng, x, y, w, cut, depth - 1) + _split(rng, x, y + cut, w, h - cut, depth - 1)


def hall_unit(u):
    """128px corridor deck: blue-gray bolted plates, scuffed walk line, grime,
    moss in a few seams."""
    S = 2 * T
    rng = np.random.default_rng(1000 + u)
    n = tnoise(S, rng, 10)
    img = np.zeros((S, S, 3), np.float32) + C["steel15"]
    img = dzone(img, n, C["steel1"], 0.62, 0.85)
    img = dzone(img, 1 - n, C["steel2"], 0.7, 0.95)
    # scuffed wear: fine streaks along the walk direction
    streak = gaussian_filter(rng.standard_normal((S, S)), sigma=(0.6, 6), mode="wrap")
    img = blend(img, streak > 0.55, C["steel2"], 1.0)
    img = blend(img, streak < -0.62, C["steel05"], 1.0)
    st = np.zeros_like(img)
    sm = np.zeros((S, S), bool)
    rects = []
    for (px, py) in ((0, 0), (T, 0), (0, T), (T, T)):
        rects += _split(rng, px, py, T, T, 2 if rng.random() < 0.6 else 1)
    _plates(img, st, sm, S, rng, rects, C["steel0"], C["steel25"], C["steel35"], C["steel0"])
    # moss creeping into some seams
    moss = tnoise(S, rng, 4)
    near = gaussian_filter(sm.astype(np.float32), 1.0, mode="wrap") > 0.2
    img = blend(img, near & (moss > 0.78), C["olive1"], 1.0)
    img = blend(img, near & (moss > 0.86), C["olive2"], 1.0)
    return img, st, sm


def grate_tile(v):
    """A vent grate set into a hall plate: bevelled frame, dark slats, a sickly
    spore glow rising from below."""
    base, _, _ = hall_unit(7 + v)
    img = base[:T, :T].copy()
    st = np.zeros_like(img)
    sm = np.zeros((T, T), bool)
    _plates(img, st, sm, T, None, [(0, 0, T, T)], C["steel0"], C["steel25"], C["steel35"], C["steel0"], rivets=False)
    yy, xx = np.mgrid[0:T, 0:T].astype(np.float32)
    x0, x1 = 9, T - 9
    frame = (xx >= x0 - 3) & (xx < x1 + 3) & (yy >= x0 - 3) & (yy < x1 + 3)
    inner = (xx >= x0) & (xx < x1) & (yy >= x0) & (yy < x1)
    img[frame] = C["steel1"]
    img[frame & ((xx < x0 - 1) | (yy < x0 - 1))] = C["steel3"]
    img[frame & ((xx >= x1 + 1) | (yy >= x1 + 1))] = C["steel0"]
    d = np.hypot(xx - T / 2 + 0.5, yy - T / 2 + 0.5) / (T / 2)
    glow = np.clip(1 - d * 1.35, 0, 1)
    hole = np.zeros((T, T, 3), np.float32) + C["black"]
    hole = blend(hole, glow > 0.15, C["olive0"])
    hole = blend(hole, glow > 0.45, C["olive1"])
    hole = blend(hole, glow > 0.62, C["olive2"])
    hole = blend(hole, glow > 0.8, C["glow"])
    if v % 3 == 0:  # horizontal slats
        slat = ((yy - x0) % 6) < 3
        shade = ((yy - x0) % 6) == 0
    elif v % 3 == 1:  # diagonal slats
        slat = ((xx + yy) % 8) < 4
        shade = ((xx + yy) % 8) == 0
    else:  # square mesh
        slat = (((xx - x0) % 7) < 2) | (((yy - x0) % 7) < 2)
        shade = (((xx - x0) % 7) == 0) | (((yy - x0) % 7) == 0)
    g = np.where(slat[..., None], C["steel15"], hole)
    g = np.where((slat & shade)[..., None], C["steel3"], g)
    img[inner] = g[inner]
    # corner bolts on the frame
    for (bx, by) in ((x0 - 2, x0 - 2), (x1, x0 - 2), (x0 - 2, x1), (x1, x1)):
        img[by:by + 2, bx:bx + 2] = C["steel4"]
    st[frame | inner] = img[frame | inner]
    sm |= frame | inner
    return img, st, sm


def tiled_tile(v):
    """Scrubbed ceramic: 16px squares on a 1px grout grid aligned to the tile
    edge (so every variant meets every other on grout), bevel per square,
    grime pooling in the grout, the odd crack or missing square."""
    rng = np.random.default_rng(2000 + v)
    img = np.zeros((T, T, 3), np.float32)
    st = np.zeros_like(img)
    sm = np.zeros((T, T), bool)
    grime = tnoise(T, rng, 9)
    tones = [C["cer1"], C["cer1"], C["steel4"], C["cer1"] * 0.5 + C["cer2"] * 0.5]
    for gy in range(4):
        for gx in range(4):
            x, y = gx * 16, gy * 16
            col = tones[int(rng.integers(len(tones)))]
            img[y:y + 16, x:x + 16] = col
            img[y + 1, x + 1:x + 15] = C["cer2"]
            img[y + 1:y + 15, x + 1] = C["cer2"]
            img[y + 15, x + 1:x + 16] = C["steel35"]
            img[y + 1:y + 16, x + 15] = C["steel35"]
    # grime film (warm-gray) over the ceramic, heavier in the grout
    img = dzone(img, grime, C["steel35"], 0.7, 1.0)
    # a missing / broken square now and then (dark bed, moss sprouting)
    if v == 5:  # one variant in six: a single lifted square
        gx, gy = rng.integers(4), rng.integers(4)
        x, y = int(gx) * 16, int(gy) * 16
        img[y + 1:y + 16, x + 1:x + 16] = C["steel1"]
        m = tnoise(16, rng, 2)[:15, :15]
        sub = img[y + 1:y + 16, x + 1:x + 16]
        sub[m > 0.6] = C["olive1"]
        sub[m > 0.8] = C["olive2"]
    # a hairline crack wandering across a square or two
    if rng.random() < 0.7:
        cx, cy = float(rng.integers(4, 60)), float(rng.integers(4, 60))
        dx, dy = rng.uniform(-1, 1), rng.uniform(-1, 1)
        for _ in range(int(rng.integers(10, 26))):
            img[int(cy) % T, int(cx) % T] = C["steel2"]
            cx += dx + rng.uniform(-0.6, 0.6)
            cy += dy + rng.uniform(-0.6, 0.6)
    yy, xx = np.mgrid[0:T, 0:T]
    grout = (xx % 16 == 0) | (yy % 16 == 0)
    img[grout] = C["steel25"]
    img[grout & (grime > 0.7)] = C["steel2"]
    st[grout] = img[grout]
    sm |= grout
    return img, st, sm


def plating_unit(u):
    """128px diamond-tread engineering plate: raised lozenge tread, heavy
    bolted seams, oil and rust, a hazard chevron band on some plates."""
    S = 2 * T
    rng = np.random.default_rng(3000 + u)
    img = np.zeros((S, S, 3), np.float32) + C["steel2"]
    n = tnoise(S, rng, 12)
    img = dzone(img, n, C["steel15"], 0.6, 0.85)
    yy, xx = np.mgrid[0:S, 0:S]
    # tread: alternating-diagonal 4x1 lozenges on an 8px lattice
    cx, cy = xx % 8, yy % 8
    alt = ((xx // 8 + yy // 8) % 2) == 0
    a_ = alt & (((cx - cy) % 8 == 0) | ((cx - cy) % 8 == 1)) & (cx >= 1) & (cx <= 5) & (cy >= 1) & (cy <= 5)
    b_ = (~alt) & (((cx + cy) % 8 == 6) | ((cx + cy) % 8 == 7)) & (cx >= 1) & (cx <= 5) & (cy >= 1) & (cy <= 5)
    tread = a_ | b_
    img[tread] = C["steel35"]
    shadow = np.roll(np.roll(tread, 1, 0), 1, 1) & ~tread
    img[shadow] = C["steel1"]
    # oil / rust stains
    stain = tnoise(S, rng, 6)
    img = dzone(img, stain, C["brown1"], 0.84, 0.94)
    img = blend(img, stain > 0.96, C["brown0"], 1.0)
    st = np.zeros_like(img)
    sm = np.zeros((S, S), bool)
    # hazard chevron band along one plate edge (a quarter of the units)
    if u == 3:  # one macro in four carries a hazard band along a plate edge
        by = T - 7
        band = (yy >= by) & (yy < by + 5)
        chev = ((xx + yy) // 4) % 2 == 0
        img[band & chev] = C["tan2"]
        img[band & ~chev] = C["ink"]
        st[band] = img[band]
        sm |= band
    rects = [(0, 0, T, T), (T, 0, T, T), (0, T, T, T), (T, T, T, T)]
    _plates(img, st, sm, S, rng, rects, C["steel0"], C["steel3"], C["steel4"], C["steel0"])
    # extra bolt rows along the seams
    for x in range(12, T - 8, 12):
        for (px, py) in ((x, 3), (x + T, 3), (x, T + 3), (x + T, T + 3)):
            _rivet(img, st, sm, px, py, C["steel4"], C["steel0"])
    return img, st, sm


def hull_tile(v):
    """Outer pressure hull: near-black ribbed plate, a lit cap strip along the
    top like the module walls, vertical beams with rivet rows, rust weeping."""
    rng = np.random.default_rng(4000 + v)
    img = np.zeros((T, T, 3), np.float32) + C["ink"]
    n = tnoise(T, rng, 8)
    img = dzone(img, n, C["steel0"], 0.55, 0.8)
    img = dzone(img, 1 - n, C["black"], 0.7, 0.9)
    yy, xx = np.mgrid[0:T, 0:T]
    st = np.zeros_like(img)
    sm = np.zeros((T, T), bool)
    # horizontal ribs
    for ry in (18, 40):
        rib = (yy >= ry) & (yy < ry + 5)
        img[rib] = C["steel05"]
        img[(yy == ry)] = C["steel1"]
        img[(yy == ry + 5)] = C["black"]
        st[rib | (yy == ry + 5)] = img[rib | (yy == ry + 5)]
        sm |= rib | (yy == ry + 5)
    # vertical beams at the tile edge (shared by every variant) and mid
    for bx in (0, 32):
        beam = (xx >= bx) & (xx < bx + 4)
        img[beam] = C["steel0"]
        img[beam & (xx == bx)] = C["steel05"]
        for ry in range(8, T, 8):
            img[ry, bx + 1:bx + 3] = C["steel1"]
        st[beam] = img[beam]
        sm |= beam
    # rust weeping down from the ribs
    for _ in range(int(rng.integers(2, 5))):
        x = int(rng.integers(5, T - 2))
        y0 = int(rng.choice([23, 45]))
        ln = int(rng.integers(4, 14))
        img[y0:y0 + ln, x] = C["brown1"]
        if rng.random() < 0.5:
            img[y0:y0 + ln // 2, x + 1] = C["brown0"]
    # the lit cap strip (same language as the module wall tiles)
    cap = yy < 4
    img[cap] = C["steel2"]
    img[yy == 0] = C["steel3"]
    img[yy == 4] = C["black"]
    st[cap | (yy == 4)] = img[cap | (yy == 4)]
    sm |= cap | (yy == 4)
    return img, st, sm


def bog_unit(u):
    """128px swamp seep over the deck: teal water with drowned plate seams
    showing through, algae rafts, ripples, a few glowing spores."""
    S = 2 * T
    rng = np.random.default_rng(5000 + u)
    n = tnoise(S, rng, 14)
    img = np.zeros((S, S, 3), np.float32) + C["teal0"]
    img = dzone(img, n, C["teal05"], 0.46, 0.66)
    img = dzone(img, n, C["teal1"], 0.76, 0.93)
    img = dzone(img, n, C["teal2"], 0.92, 1.0)
    # drowned plate seams (the deck is still down there)
    yy, xx = np.mgrid[0:S, 0:S]
    seams = ((xx % T) == 0) | ((yy % T) == 0) | ((xx % T) == T // 2) & (yy % T < T // 2)
    img = blend(img, seams & (n > 0.38), C["teal0"], 1.0)
    img = blend(img, seams & (n <= 0.38), C["ink"], 1.0)
    # ripples: thin bright contour arcs of a second noise field
    r = tnoise(S, rng, 7)
    frag = tnoise(S, rng, 3)
    rip = (np.abs(((r * 5) % 1) - 0.5) < 0.04) & (n > 0.45) & (frag > 0.4)
    img = blend(img, rip, C["teal2"], 0.9)
    # algae / duckweed rafts
    a = tnoise(S, rng, 5)
    img = blend(img, a > 0.72, C["olive1"], 1.0)
    img = blend(img, a > 0.8, C["olive2"], 1.0)
    img = blend(img, a > 0.88, C["olive3"], 1.0)
    # sparse glowing spores floating on the film
    for _ in range(int(rng.integers(3, 7))):
        x, y = int(rng.integers(S)), int(rng.integers(S))
        img[y, x] = C["glow2"]
        img[(y + 1) % S, x] = C["glow"]
    return img, np.zeros_like(img), np.zeros((S, S), bool)


# ---- accents: self-contained feature tiles seated on a base tile ----------

def _disc(T_, cx, cy, r):
    yy, xx = np.mgrid[0:T_, 0:T_].astype(np.float32)
    return np.hypot(xx - cx, yy - cy) <= r


def accent(surface, v):
    yy, xx = np.mgrid[0:T, 0:T].astype(np.float32)
    rng = np.random.default_rng(9000 + 100 * list(ACCENTS).index(surface) + v)
    if surface == "hall":
        img, st, sm = hall_unit(20 + v)
        img, st, sm = img[:T, :T].copy(), st[:T, :T].copy(), sm[:T, :T].copy()
        if v == 0:  # round floor drain with a moss ring
            ring = _disc(T, 32, 32, 13) & ~_disc(T, 32, 32, 9)
            img = blend(img, _disc(T, 32, 32, 17) & ~_disc(T, 32, 32, 13), C["olive1"], 1.0)
            img[ring] = C["steel3"]
            img[_disc(T, 32, 32, 9)] = C["black"]
            for k in range(-8, 9, 3):
                img[(np.abs(xx - 32 - k) < 1) & _disc(T, 32, 32, 9)] = C["steel1"]
            img[_disc(T, 31, 31, 13) & ~_disc(T, 31, 31, 12)] = C["steel4"]
        elif v == 1:  # glowing spore stain seeping from a seam
            s = tnoise(T, rng, 4)
            fall = np.clip(1 - np.hypot(xx - 30, yy - 34) / 26, 0, 1)
            m = s * fall
            img = blend(img, m > 0.18, C["olive0"], 1.0)
            img = blend(img, m > 0.3, C["olive2"], 1.0)
            img = blend(img, m > 0.42, C["glow"], 1.0)
            img = blend(img, m > 0.55, C["glow2"], 1.0)
        else:  # maintenance hatch with a hazard border
            hatch = (xx >= 12) & (xx < 52) & (yy >= 12) & (yy < 52)
            border = hatch & ~((xx >= 16) & (xx < 48) & (yy >= 16) & (yy < 48))
            chev = ((xx + yy) // 4) % 2 == 0
            img[border & chev] = C["tan2"]
            img[border & ~chev] = C["ink"]
            inner = hatch & ~border
            img[inner] = C["steel2"]
            img[inner & ((yy == 16) | (xx == 16))] = C["steel3"]
            img[inner & ((yy == 47) | (xx == 47))] = C["steel0"]
            img[(xx >= 28) & (xx < 36) & (yy >= 30) & (yy < 34)] = C["steel0"]  # handle recess
            img[(xx >= 29) & (xx < 35) & (yy == 31)] = C["steel4"]
        return img
    if surface == "tiled":
        img, _, _ = tiled_tile(40 + v)
        if v == 0:  # square floor drain in the grout crossing
            d = (np.abs(xx - 32) <= 7) & (np.abs(yy - 32) <= 7)
            img[d] = C["steel2"]
            img[(np.abs(xx - 32) <= 5) & (np.abs(yy - 32) <= 5)] = C["black"]
            for k in range(-4, 5, 2):
                img[(np.abs(yy - 32 - k) < 1) & (np.abs(xx - 32) <= 5)] = C["steel3"]
            img[d & ((np.abs(xx - 32) == 7) | (np.abs(yy - 32) == 7))] = C["steel35"]
            wet = tnoise(T, rng, 3) * np.clip(1 - np.hypot(xx - 32, yy - 32) / 22, 0, 1)
            img = blend(img, (wet > 0.3) & ~d, C["steel3"], 0.9)
        else:  # shattered squares, bioluminescent caps pushing through
            broken = (xx >= 16) & (xx < 48) & (yy >= 16) & (yy < 48)
            m = tnoise(T, rng, 3)
            img = blend(img, broken & (m > 0.35), C["steel1"], 1.0)
            img = blend(img, broken & (m > 0.55), C["olive1"], 1.0)
            img = blend(img, broken & (m > 0.7), C["olive2"], 1.0)
            for _ in range(5):
                cx, cy = rng.integers(20, 44), rng.integers(20, 44)
                cap = _disc(T, cx, cy, 2.2)
                img[cap] = C["cyan"]
                img[_disc(T, cx - 0.6, cy - 0.6, 1)] = C["white"]
                img[int(cy) + 2:int(cy) + 4, int(cx)] = C["olive3"]
        return img
    if surface == "plating":
        img, _, _ = plating_unit(10 + v)
        img = img[:T, :T].copy()
        if v == 0:  # heat vent glowing orange
            box = (xx >= 20) & (xx < 44) & (yy >= 24) & (yy < 40)
            img[box] = C["steel0"]
            fins = box & (((xx - 20) % 4) < 2)
            img[fins] = C["steel2"]
            heat = np.clip(1 - np.hypot(xx - 32, (yy - 32) * 1.6) / 16, 0, 1)
            img = blend(img, box & ~fins & (heat > 0.2), C["brown2"], 1.0)
            img = blend(img, box & ~fins & (heat > 0.3), C["red"], 1.0)
            img = blend(img, box & ~fins & (heat > 0.35), C["orange"], 1.0)
            img = blend(img, box & ~fins & (heat > 0.65), C["amber"], 1.0)
            img[(box ^ ((xx >= 21) & (xx < 43) & (yy >= 25) & (yy < 39)))] = C["steel3"]
        elif v == 1:  # oil slick with a rainbow-ish sheen (teal/violet)
            m = tnoise(T, rng, 5) * np.clip(1 - np.hypot(xx - 32, yy - 32) / 28, 0, 1)
            img = blend(img, m > 0.2, C["ink"], 1.0)
            img = blend(img, m > 0.34, C["steel0"], 1.0)
            ring = (np.abs(((m * 10) % 1) - 0.5) < 0.08) & (m > 0.25)
            img = blend(img, ring, C["teal2"], 1.0)
        else:  # stencilled warning chevrons
            chev = (np.abs(xx - 32) + (yy % 16) < 14) & (np.abs(xx - 32) + (yy % 16) > 8) & (yy > 10) & (yy < 54)
            img[chev] = C["tan2"]
        return img
    if surface == "hull":
        img, _, _ = hull_tile(20 + v)
        if v == 0:  # sealed viewport: dark glass, teal glint
            g = _disc(T, 34, 36, 13)
            img[g & ~_disc(T, 34, 36, 10)] = C["steel2"]
            img[_disc(T, 34, 36, 10)] = C["black"]
            img[_disc(T, 34, 36, 10) & (xx - yy > 4) & (xx - yy < 8)] = C["teal1"]
            img[_disc(T, 30, 32, 2)] = C["teal3"]
            for a in np.linspace(0, 2 * np.pi, 9)[:-1]:
                bx, by = int(34 + 11.5 * np.cos(a)), int(36 + 11.5 * np.sin(a))
                img[by, bx] = C["steel4"]
        else:  # roots breaching the hull
            for _ in range(4):
                x, y = float(rng.integers(8, 56)), 6.0
                dx = rng.uniform(-0.5, 0.5)
                while y < T:
                    w = 2 if y < 36 else 1
                    img[int(y), max(0, int(x) - w):int(x) + w] = C["brown1"]
                    img[int(y), max(0, int(x) - w)] = C["brown2"]
                    x = min(T - 2, max(1, x + dx + rng.uniform(-0.7, 0.7)))
                    y += 1
            m = tnoise(T, rng, 3)
            img = blend(img, (m > 0.8) & (yy > 8), C["olive1"], 1.0)
        return img
    if surface == "bog":
        img, _, _ = bog_unit(30 + v)
        img = img[:T, :T].copy()
        if v == 0:  # spore bloom: pale lily pads with glowing hearts
            for _ in range(4):
                cx, cy = rng.integers(14, 50), rng.integers(14, 50)
                r = rng.uniform(4, 7)
                pad = _disc(T, cx, cy, r)
                notch = (np.abs(yy - cy) < 1.2) & (xx > cx)
                img[pad & ~notch] = C["olive3"]
                img[pad & ~notch & ~_disc(T, cx - 1, cy - 1, r - 1.5)] = C["olive1"]
                img[_disc(T, cx - 1, cy - 1, 1.5)] = C["glow2"]
        elif v == 1:  # sunken crate corner breaking the surface
            box = (xx >= 18) & (xx < 46) & (yy >= 22) & (yy < 44)
            img[box] = C["brown1"]
            img[box & ((xx - 18) % 7 == 0)] = C["brown0"]
            img[box & (yy == 22)] = C["tan"]
            img[box & (xx == 45)] = C["brown0"]
            ring = _disc(T, 32, 33, 20) & ~_disc(T, 32, 33, 18) & ~box
            img[ring] = C["teal3"]
        else:  # rising gas bubbles
            for _ in range(7):
                cx, cy = rng.integers(12, 52), rng.integers(12, 52)
                r = rng.uniform(1.5, 3.5)
                img[_disc(T, cx, cy, r + 1) & ~_disc(T, cx, cy, r)] = C["teal3"]
                img[_disc(T, cx - r / 2, cy - r / 2, 0.8)] = C["teal4"]
        return img
    raise ValueError(surface)


# ---------------------------------------------------------------------------
# Units & diffusion
# ---------------------------------------------------------------------------

GEN = ("hand-crafted 16-bit pixel art game tile, sega genesis, careful pixel shading, "
       "crisp defined shapes, clean flat colour areas")
NEG = ("photo, photorealistic, blurry, smooth gradients, 3d render, depth of field, text, "
       "letters, watermark, frame, border, vignette, creature, character, figure, face, "
       "perspective, horizon, noisy, muddy, washed out")
FICTION = "derelict space station interior sinking into an alien swamp"

# surface -> (kind, units, fn, prompt, denoise, seamless)
UNITS = {
    "hall": ("macro", 4, hall_unit,
             f"top-down corridor deck floor of a {FICTION}, blue-gray bolted steel floor plates, "
             f"scuffed walkway, grime in the seams, {GEN}, flat top-down orthographic view", 0.38, False),
    "plating": ("macro", 4, plating_unit,
                f"top-down engineering bay floor of a {FICTION}, steel diamond tread plate, heavy bolts, "
                f"oil stains, rust, {GEN}, flat top-down orthographic view", 0.34, False),
    "bog": ("macro", 3, bog_unit,
            f"top-down shallow murky teal swamp water flooding a metal deck, algae and duckweed rafts, "
            f"ripples, faint glowing spores, {GEN}, seamless tileable, flat top-down orthographic view",
            0.45, True),
    "tiled": ("tile", 6, tiled_tile,
              f"top-down pale ceramic floor tiles of a station mess hall, square tiles with gray grout, "
              f"grime and cracks, {GEN}, flat top-down orthographic view", 0.3, False),
    "hull": ("tile", 3, hull_tile,
             f"top-down near-black riveted pressure hull wall of a {FICTION}, heavy steel ribs, "
             f"rust streaks, {GEN}, flat straight-on view", 0.32, False),
    "grate": ("tile", 3, grate_tile,
              f"top-down ventilation grate in a metal floor, dark slats, faint green glow from below, "
              f"{GEN}, flat top-down orthographic view", 0.28, False),
}
ACCENTS = {"hall": 3, "tiled": 2, "plating": 3, "hull": 2, "bog": 3}
ACCENT_HINT = {
    "hall": "metal corridor floor with a single detail feature (floor drain / glowing spore stain / hazard hatch)",
    "tiled": "ceramic tile floor with a single detail feature (floor drain / broken tiles with glowing fungus)",
    "plating": "tread plate floor with a single detail feature (glowing heat vent / oil slick / warning chevrons)",
    "hull": "dark riveted hull wall with a single detail feature (sealed porthole / roots breaking through)",
    "bog": "murky swamp water with a single detail feature (glowing lily pads / sunken crate / bubbles)",
}


def seamless_kcentroid(im, res):
    a = np.asarray(im.convert("RGB"))
    big = kcentroid(Image.fromarray(np.tile(a, (3, 3, 1)), "RGB"), 3 * res, 3 * res).convert("RGB")
    return np.asarray(big)[res:2 * res, res:2 * res]


def detail_energy(img):
    a = np.asarray(img, np.float32)
    return float(np.abs(np.diff(a, axis=0)).mean() + np.abs(np.diff(a, axis=1)).mean())


def score(img, surface):
    t = BAND[surface]
    return -abs(lum(img) - t) / (t + 12.75) * 100 + min(detail_energy(img), 40)


def _seat(img, base, feather=6):
    """Restore the base tile's border (feathered) so an accent sits IN the
    field instead of in a box."""
    H, W = img.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    edge = np.minimum.reduce([yy, xx, H - 1 - yy, W - 1 - xx])
    c = np.clip((edge - feather) / feather, 0, 1)[..., None]
    return img * c + base * (1 - c)


def diffuse(init_rgb, res, pos, denoise, seamless, seed, prefix, udir):
    import comfy
    comfy.CKPT = os.environ.get("CKPT", "juggernautXL_ragnarokBy.safetensors")
    comfy.LORA = os.environ.get("LORA", "XL\\pixel-art-xl.safetensors")
    comfy.LORA_W = float(os.environ.get("LORA_W", "0.7"))
    init_path = udir / f"{prefix}-init.png"
    Image.fromarray(snap(init_rgb), "RGB").resize((1024, 1024), Image.NEAREST).save(init_path)
    graph = comfy.build_graph(pos=pos, neg=NEG, seed=seed, init=str(init_path), denoise=denoise,
                              seamless=seamless, alpha=False, prefix=f"indoor-{prefix}")
    raw = comfy.run(graph, str(udir / "raw"))
    im = Image.open(raw[-1]).convert("RGB")
    small = seamless_kcentroid(im, res) if seamless else np.asarray(kcentroid(im, res, res).convert("RGB"))
    return despeckle(small, passes=2).astype(np.float32)


def contact(paths, out, scale=2):
    ims = [Image.open(p).convert("RGB") for p in paths]
    if not ims:
        return
    w, h = ims[0].size
    cols = min(6, len(ims))
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w * scale + 4), rows * (h * scale + 4)), (16, 16, 20))
    for i, im in enumerate(ims):
        sheet.paste(im.resize((w * scale, h * scale), Image.NEAREST),
                    ((i % cols) * (w * scale + 4) + 2, (i // cols) * (h * scale + 4) + 2))
    sheet.save(out)


def make_unit(surface, u, seeds, procedural, picks):
    kind, _, fn, pos, denoise, seamless = UNITS[surface]
    base, st, sm = fn(u)
    res = base.shape[0]
    udir = STAGE / surface
    udir.mkdir(parents=True, exist_ok=True)
    cands = []
    proc = enforce_band(base, surface)
    Image.fromarray(proc, "RGB").save(udir / f"unit-{u}-proc.png")
    cands.append((score(proc, surface) - 5, "proc", proc))  # small bias toward the painted pass
    if not procedural:
        for s in range(seeds):
            seed = 818000 + u * 97 + s * 1009 + len(surface) * 7
            painted = diffuse(base, res, pos, denoise, seamless, seed, f"{surface}-{u}-s{s}", udir)
            # structure restore: seams / grout / rivets / slats exactly as authored
            painted[sm] = st[sm]
            out = enforce_band(painted, surface)
            Image.fromarray(out, "RGB").save(udir / f"unit-{u}-seed{s}.png")
            cands.append((score(out, surface), f"seed{s}", out))
            print(f"  {surface}[{u}] seed{s}: lum={lum(out):.1f} (target {BAND[surface]:.0f}) "
                  f"score={cands[-1][0]:.1f}", flush=True)
    want = picks.get(f"{surface}:{u}")
    chosen = next((c for c in cands if c[1] == want), None) or max(cands, key=lambda c: c[0])
    print(f"  {surface}[{u}] -> {chosen[1]}", flush=True)
    return chosen[2]


def make_accent(surface, v, seeds, procedural, picks):
    udir = STAGE / f"{surface}-accent"
    udir.mkdir(parents=True, exist_ok=True)
    feat = accent(surface, v)
    kind = UNITS[surface][0]
    fn = UNITS[surface][2]
    b = fn(v)[0]
    base_tile = b[:T, :T] if kind == "macro" else b
    feat = _seat(feat, base_tile, feather=5)
    banded = enforce_band(feat, surface, ref=base_tile)
    cands = [(score(banded, surface) - 5, "proc", banded)]
    Image.fromarray(cands[0][2], "RGB").save(udir / f"acc-{v}-proc.png")
    if not procedural:
        pos = f"top-down {ACCENT_HINT[surface]}, {GEN}, flat top-down orthographic view"
        for s in range(seeds):
            seed = 919000 + v * 131 + s * 1013 + len(surface) * 11
            painted = diffuse(feat, T, pos, 0.32, False, seed, f"{surface}-acc{v}-s{s}", udir)
            painted = _seat(painted, base_tile, feather=5)
            out = enforce_band(painted, surface, ref=base_tile)
            Image.fromarray(out, "RGB").save(udir / f"acc-{v}-seed{s}.png")
            cands.append((score(out, surface), f"seed{s}", out))
    want = picks.get(f"{surface}-accent:{v}")
    chosen = next((c for c in cands if c[1] == want), None) or max(cands, key=lambda c: c[0])
    print(f"  {surface}-accent-{v} -> {chosen[1]} lum={lum(chosen[2]):.1f}", flush=True)
    return chosen[2]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    seeds, outdir, procedural, picks = 2, OUT_DEFAULT, False, {}
    for a in sys.argv[1:]:
        if a.startswith("--seeds="):
            seeds = int(a.split("=")[1])
        elif a.startswith("--out="):
            outdir = Path(a.split("=", 1)[1])
        elif a == "--procedural":
            procedural = True
        elif a.startswith("--pick="):  # --pick=hall:0=seed1,tiled-accent:1=proc
            for p in a.split("=", 1)[1].split(","):
                k, val = p.rsplit("=", 1)
                picks[k] = val
    outdir.mkdir(parents=True, exist_ok=True)
    surfaces = args or list(UNITS)
    for surface in surfaces:
        kind, n_units = UNITS[surface][0], UNITS[surface][1]
        print(f"[{surface}]", flush=True)
        written = []
        for u in range(n_units):
            unit = make_unit(surface, u, seeds, procedural, picks)
            if kind == "macro":
                for q in range(4):
                    y, x = divmod(q, 2)
                    p = outdir / f"{surface}-{u * 4 + q}.png"
                    Image.fromarray(unit[y * T:(y + 1) * T, x * T:(x + 1) * T], "RGB").save(p)
                    written.append(p)
            else:
                p = outdir / f"{surface}-{u}.png"
                Image.fromarray(unit, "RGB").save(p)
                written.append(p)
        for v in range(ACCENTS.get(surface, 0)):
            p = outdir / f"{surface}-accent-{v}.png"
            Image.fromarray(make_accent(surface, v, seeds, procedural, picks), "RGB").save(p)
            written.append(p)
        contact(written, STAGE / f"{surface}-shipped.png", scale=3)


if __name__ == "__main__":
    main()
