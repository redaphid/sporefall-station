#!/usr/bin/env python3
"""Stair tiles (between storeys) for the swampspace-hires theme, plus the
downscaled copies for the base swampspace theme.

Sprite pools (all authored FACING NORTH; the renderer rotates for other facings):

  tile.stair_up          stair_up-0..2.png        the LOWER storey's stair: grated
                         steps RISING toward the north edge into a lit wall niche
                         (each step a band brighter than the one below), handrails
                         both sides, open side south. Opaque.
  tile.stair_down        stair_down-0..2.png      the UPPER storey's stair: steps
                         FALLING toward the north edge into darkness (nosing lit,
                         a cast shadow under each, dithered dark vignette at the
                         far edge), handrails both sides, open side south. Opaque.
  tile.landing.overlay   landing-overlay-0..1.png RGBA decal for the deck tile in
                         front of a stair: worn amber hazard chevrons pointing north.

Same language as tiles_indoor.py (locked palette + INDOOR_EXTRA, `snap`,
`dzone`, `despeckle`); the steps reuse the grate/plating deck vocabulary (steel
ramp, slot / diamond-tread / mesh grating, rivets, rust, moss in the corners).
Colour is authored as an index into the steel ramp so every step is a flat,
palette-exact band; features sit on a 2px grid so the 32px downscale (the same
k-centroid used by the rest of the pipeline) keeps nosings and rails.

Procedural only, deterministic (seeded numpy rng) - no ComfyUI.

Usage:
  python3 tiles_stairs.py [--hires=../../public/themes/swampspace-hires/tiles] \
      [--base=../../public/themes/swampspace/tiles] [--contact=/tmp/stairs-contact.png]
"""
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from post import kcentroid  # noqa: E402
from tiles_indoor import BAYER4, C, PAL, T, despeckle, lum, snap, tnoise  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HIRES_DEFAULT = ROOT / "public/themes/swampspace-hires/tiles"
BASE_DEFAULT = ROOT / "public/themes/swampspace/tiles"
BASE_T = 32

# Steel value ramp, darkest -> lightest. A pixel's colour is RAMP[step_level + role].
RAMP = [C[k] for k in ("black", "ink", "steel0", "steel05", "steel1", "steel15", "steel2",
                       "steel25", "steel3", "steel35", "steel4", "cer1", "cer2", "white")]
# roles: offsets from a step's base level
HOLE, SHADOW, RISER, TREAD, NOSE = -4, -3, -1, 0, 2
STEP = 8          # px per step (all features on a 2px grid)
RAIL = 10         # handrail / stringer width per side


def ramp(level):
    return RAMP[int(np.clip(level, 0, len(RAMP) - 1))]


def _paint(level_map):
    out = np.zeros(level_map.shape + (3,), np.float32)
    for lv in np.unique(level_map):
        out[level_map == lv] = ramp(lv)
    return out


def _tread_pattern(kind, xx, yy):
    """Grating holes within a tread band. xx/yy are local coords. Returns
    (hole mask, highlight mask) - the same three families as grate-0..2."""
    if kind == 0:    # slotted: 4x2 slots on a 6px pitch, staggered per step
        hole = ((xx % 6) < 4) & (yy >= 1) & (yy < 3)
        hi = ((xx % 6) == 4) & (yy >= 1) & (yy < 3)
    elif kind == 1:  # diamond tread (plating family): raised 2x2 studs
        hole = np.zeros_like(xx, bool)
        hi = (((xx // 2) + (yy // 2)) % 3 == 0) & (yy < 4) & ((xx % 4) < 2)
    else:            # square mesh: 2px bars, 2x2 holes
        hole = ((xx % 4) >= 2) & (yy >= 1) & (yy < 3)
        hi = ((xx % 4) == 0) & (yy == 0)
    return hole, hi


def _rails(L, levels_by_row, rng, lit_top):
    """Both handrails: dark outer edge, stringer, rail tube with a highlight,
    posts (bolts) every step, a shadow gap onto the steps."""
    S = L.shape[0]
    for y in range(S):
        b = levels_by_row[y]
        for side in (0, 1):
            def put(x0, x1, off):
                if side == 0:
                    L[y, x0:x1] = b + off
                else:
                    L[y, S - x1:S - x0] = b + off
            put(0, 2, -3)        # wall edge
            put(2, 4, -1)        # stringer
            put(4, 6, 2)         # rail tube (lit)
            put(6, 8, 0)         # tube underside
            put(8, 10, -3)       # shadow gap onto the steps
    # posts: a bright 2x2 bolt on the stringer at each step
    for y in range(STEP // 2, S, STEP):
        b = levels_by_row[y]
        for x in (2, S - 4):
            L[y:y + 2, x:x + 2] = b + 3
    return L


def _wear(img, rng, mask_steps, v, S):
    """Rust drips on risers, moss in the rail corners, grime film."""
    yy, xx = np.mgrid[0:S, 0:S]
    g = tnoise(S, rng, 5)
    b = np.tile(BAYER4, (S // 4 + 1, S // 4 + 1))[:S, :S]
    grime = mask_steps & (g > 0.72) & ((g - 0.72) / 0.2 > b)
    img[grime] = img[grime] * 0.82
    # moss creeping out of the corners where the steps meet the stringers
    m = tnoise(S, rng, 3)
    near = ((xx >= RAIL) & (xx < RAIL + 4)) | ((xx < S - RAIL) & (xx >= S - RAIL - 4))
    img[near & (m > 0.7) & mask_steps] = C["olive1"]
    img[near & (m > 0.82) & mask_steps] = C["olive2"]
    return img


# ---------------------------------------------------------------------------
# stair_up: rising north into a lit niche
# ---------------------------------------------------------------------------

def stair_up(v):
    S = T
    rng = np.random.default_rng(7100 + v)
    kind = v % 3
    yy, xx = np.mgrid[0:S, 0:S]
    L = np.zeros((S, S), np.int32)
    n_steps = 7
    top = S - n_steps * STEP          # rows above the steps: the niche (8px)
    lvl_row = np.zeros(S, np.int32)
    # step k=0 is the bottom (south) step; levels climb one ramp notch per step
    base_levels = [2 + round(k * 6 / (n_steps - 1)) for k in range(n_steps)]  # steel0 .. steel3
    for k in range(n_steps):
        y0 = S - (k + 1) * STEP
        b = base_levels[k]
        lvl_row[y0:y0 + STEP] = b
        ly = yy[y0:y0 + STEP] - y0
        lx = xx[y0:y0 + STEP] + (3 if (k % 2 and kind == 0) else 0)
        blk = np.full((STEP, S), b + TREAD)
        hole, hi = _tread_pattern(kind, lx, ly)
        tread = ly < 4
        blk[tread & hole] = b + HOLE
        blk[tread & hi] = b + 1
        blk[(ly >= 4) & (ly < 6)] = b + NOSE          # nosing (front lip)
        blk[ly >= 6] = b + RISER - 1                  # riser face (toward viewer)
        blk[(ly == 6)] = b + RISER - 3                # shadow tucked under the nose
        L[y0:y0 + STEP] = blk
    # the niche: top landing plate, lamp strip, dark lintel
    lvl_row[:top] = base_levels[-1] + 1
    L[:top] = base_levels[-1] + 1
    L[0:2] = 1                     # lintel (ink)
    L[2:4] = 3
    L[4:top] = base_levels[-1] + 1
    L[6:8] = base_levels[-1] + 2   # landing lip
    L = _rails(L, lvl_row, rng, True)
    img = _paint(L)
    # lamp strip in the lintel: teal-white glow, spilling onto the landing
    lamp = (yy >= 2) & (yy < 4) & (xx >= 16) & (xx < S - 16)
    img[lamp] = C["cer2"] if v != 1 else C["teal4"]
    img[(yy >= 2) & (yy < 4) & (xx >= 22) & (xx < S - 22)] = C["white"]
    spill = (yy >= 4) & (yy < 6) & (xx >= 14) & (xx < S - 14)
    img[spill] = C["cer1"]
    steps = (yy >= top) & (xx >= RAIL) & (xx < S - RAIL)
    img = _wear(img, rng, steps & (yy > S // 2), v, S)
    # rust weeping down a riser or two
    for _ in range(int(rng.integers(1, 4))):
        k = int(rng.integers(0, 4))
        x = int(rng.integers(RAIL + 2, S - RAIL - 2))
        y0 = S - (k + 1) * STEP + 6
        img[y0:y0 + 2, x] = C["brown1"]
        if y0 + 2 < S:
            img[y0 + 2, x] = C["brown0"]
    # worn walk line: centre of the nosings polished one notch brighter
    for k in range(n_steps):
        y0 = S - (k + 1) * STEP + 4
        img[y0:y0 + 2, 26:38] = ramp(base_levels[k] + NOSE + 1)
    return snap(despeckle(snap(img), passes=1))


# ---------------------------------------------------------------------------
# stair_down: falling north into darkness
# ---------------------------------------------------------------------------

def stair_down(v):
    S = T
    rng = np.random.default_rng(7200 + v)
    kind = v % 3
    yy, xx = np.mgrid[0:S, 0:S]
    L = np.zeros((S, S), np.int32)
    n_steps = S // STEP                 # 8 blocks, the far ones swallowed by the dark
    lvl_row = np.zeros(S, np.int32)
    base_levels = [6 - j for j in range(n_steps)]   # steel2 at the landing, sinking
    for j in range(n_steps):
        y0 = S - (j + 1) * STEP
        b = base_levels[j]
        lvl_row[y0:y0 + STEP] = b
        ly = yy[y0:y0 + STEP] - y0
        lx = xx[y0:y0 + STEP] + (3 if (j % 2 and kind == 0) else 0)
        blk = np.full((STEP, S), b + TREAD)
        hole, hi = _tread_pattern(kind, lx, ly - 2)
        tread = (ly >= 2) & (ly < 6)
        blk[tread & hole] = b + HOLE
        blk[tread & hi] = b + 1
        blk[ly < 2] = b + NOSE                       # far lip, catching the light
        if j > 0:
            blk[ly >= 6] = b + SHADOW                # cast by the step nearer the viewer
        L[y0:y0 + STEP] = blk
    L = _rails(L, lvl_row, rng, False)
    img = _paint(L)
    steps = (xx >= RAIL) & (xx < S - RAIL)
    img = _wear(img, rng, steps & (yy > S // 2), v, S)
    # worn walk line on the lips
    for j in range(n_steps):
        y0 = S - (j + 1) * STEP
        img[y0:y0 + 2, 26:38] = ramp(base_levels[j] + NOSE + 1)
    # rust bleeding over a lip
    for _ in range(int(rng.integers(1, 3))):
        j = int(rng.integers(0, 3))
        x = int(rng.integers(RAIL + 2, S - RAIL - 2))
        y0 = S - (j + 1) * STEP
        img[y0:y0 + 3, x] = C["brown1"]
    # soft dark vignette at the far (north) edge: ordered-dither ramp to black
    b = np.tile(BAYER4, (S // 4 + 1, S // 4 + 1))[:S, :S]
    depth = np.clip((28 - yy) / 26.0, 0, 1)                     # 0 at y>=28, 1 at the edge
    side = np.clip(1 - np.minimum(xx, S - 1 - xx) / 12.0, 0, 1) * 0.35
    field = np.clip(depth + side * depth, 0, 1)
    img[(field * 0.9 > b + 1e-6)] = C["ink"]
    img[(field - 0.45) * 1.8 > b + 1e-6] = C["black"]
    return snap(img)


# ---------------------------------------------------------------------------
# landing overlay: worn hazard chevrons pointing north (RGBA decal)
# ---------------------------------------------------------------------------

def landing_overlay(v):
    S = T
    rng = np.random.default_rng(7300 + v)
    yy, xx = np.mgrid[0:S, 0:S]
    rgb = np.zeros((S, S, 3), np.float32)
    a = np.zeros((S, S), np.int32)
    dx = np.abs(xx - 31.5)
    wear = tnoise(S, rng, 1.6)
    scuff = tnoise(S, rng, 5)
    chev = np.zeros((S, S), bool)
    apexes = (8, 26) if v == 0 else (12,)
    for ay in apexes:
        d = (yy - ay) - dx * 0.75
        band = (d >= 0) & (d < 4) & (dx < 18)
        chev |= band
    outline = np.zeros((S, S), bool)
    for oy, ox in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1)):
        outline |= np.roll(np.roll(chev, oy, 0), ox, 1)
    outline &= ~chev
    if v == 1:
        # a hazard stripe band along the north edge plus a painted tread arrow
        band = (yy >= 2) & (yy < 8) & (xx >= 6) & (xx < S - 6)
        stripe = ((xx + yy) // 4) % 2 == 0
        rgb[band & stripe] = C["tan2"]
        a[band & stripe] = 128
        rgb[band & ~stripe] = C["ink"]
        a[band & ~stripe] = 64
        shaft = (dx < 2) & (yy >= 28) & (yy < 46)
        rgb[shaft] = C["tan"]
        a[shaft] = 64
    rgb[outline] = C["ink"]
    a[outline] = 64
    rgb[chev] = C["tan2"]
    a[chev] = 128
    brite = chev & ((yy - dx * 0.75) % 4 < 1.5)
    rgb[brite] = C["sand"]
    a[brite] = 192
    # wear: chipped paint (holes) and a scuffed walk line down the middle
    painted = a > 0
    chip = painted & (wear > 0.78)
    a[chip] = 0
    fade = painted & ~chip & ((wear > 0.62) | ((scuff > 0.6) & (dx < 8)))
    a[fade] = np.minimum(a[fade], 128)
    thin = painted & ~chip & (wear < 0.12)
    a[thin] = np.minimum(a[thin], 64)
    rgb = snap(rgb).astype(np.float32)
    out = np.dstack([rgb, a]).astype(np.uint8)
    out[a == 0] = 0
    return out


# ---------------------------------------------------------------------------
# downscale + contact sheet
# ---------------------------------------------------------------------------

def down_opaque(img):
    small = np.asarray(kcentroid(Image.fromarray(img, "RGB"), BASE_T, BASE_T).convert("RGB"))
    return snap(small)


def down_rgba(img):
    """2x2 blocks: keep the block's majority alpha step, colour from its
    most-opaque pixel (k-centroid assumes hard alpha, these decals are stepped)."""
    f = T // BASE_T
    out = np.zeros((BASE_T, BASE_T, 4), np.uint8)
    for j in range(BASE_T):
        for i in range(BASE_T):
            blk = img[j * f:(j + 1) * f, i * f:(i + 1) * f].reshape(-1, 4)
            al = blk[:, 3]
            if (al > 0).sum() * 2 < len(al):
                continue
            k = int(np.argmax(al))
            vals, counts = np.unique(al[al > 0], return_counts=True)
            out[j, i, :3] = blk[k, :3]
            out[j, i, 3] = vals[counts.argmax()]
    return out


def contact_sheet(hires_dir, base_dir, names, refs, out, scale=4):
    pad = 6
    cell = T * scale + pad
    bg = (16, 16, 20)
    rows = []
    rows.append([Image.open(hires_dir / f"{r}.png").convert("RGBA") for r in refs])
    rows.append([Image.open(hires_dir / f"{n}.png").convert("RGBA") for n in names])
    rows.append([Image.open(base_dir / f"{n}.png").convert("RGBA").resize((T, T), Image.NEAREST)
                 for n in names])
    # overlays composited on a hall deck tile, and stairs in context (landing below)
    hall = Image.open(hires_dir / "hall-5.png").convert("RGBA")
    ctx = []
    for n in names:
        if n.startswith("landing"):
            c = hall.copy()
            c.alpha_composite(Image.open(hires_dir / f"{n}.png").convert("RGBA"))
            ctx.append(c)
    rows.append(ctx)
    cols = max(len(r) for r in rows)
    sheet = Image.new("RGBA", (cols * cell + pad, len(rows) * cell + pad + 2 * T * scale + pad), bg + (255,))
    for ri, r in enumerate(rows):
        for ci, im in enumerate(r):
            sheet.paste(im.resize((T * scale, T * scale), Image.NEAREST), (pad + ci * cell, pad + ri * cell))
    # in-context strip: deck / landing / stair, stacked north-up, for up and down
    y0 = pad + len(rows) * cell
    lo = hall.copy()
    lo.alpha_composite(Image.open(hires_dir / "landing-overlay-0.png").convert("RGBA"))
    for ci, stair in enumerate(("stair_up-0", "stair_down-0", "stair_up-1", "stair_down-2")):
        col = Image.new("RGBA", (T, 2 * T))
        col.paste(Image.open(hires_dir / f"{stair}.png").convert("RGBA"), (0, 0))
        col.paste(lo, (0, T))
        sheet.paste(col.resize((T * scale // 1, 2 * T * scale // 1), Image.NEAREST), (pad + ci * cell, y0))
    sheet.convert("RGB").save(out)


def main():
    hires, base, contact = HIRES_DEFAULT, BASE_DEFAULT, Path("/tmp/stairs-contact.png")
    for a in sys.argv[1:]:
        if a.startswith("--hires="):
            hires = Path(a.split("=", 1)[1])
        elif a.startswith("--base="):
            base = Path(a.split("=", 1)[1])
        elif a.startswith("--contact="):
            contact = Path(a.split("=", 1)[1])
    hires.mkdir(parents=True, exist_ok=True)
    base.mkdir(parents=True, exist_ok=True)
    names = []
    for fn, stem, n in ((stair_up, "stair_up", 3), (stair_down, "stair_down", 3)):
        for v in range(n):
            img = fn(v)
            Image.fromarray(img, "RGB").save(hires / f"{stem}-{v}.png")
            Image.fromarray(down_opaque(img), "RGB").save(base / f"{stem}-{v}.png")
            names.append(f"{stem}-{v}")
            print(f"  {stem}-{v}: lum={lum(img):.1f}", flush=True)
    for v in range(2):
        img = landing_overlay(v)
        Image.fromarray(img, "RGBA").save(hires / f"landing-overlay-{v}.png")
        Image.fromarray(down_rgba(img), "RGBA").save(base / f"landing-overlay-{v}.png")
        names.append(f"landing-overlay-{v}")
        print(f"  landing-overlay-{v}: coverage={(img[..., 3] > 0).mean():.2f}", flush=True)
    if contact:
        contact_sheet(hires, base, names, ["hall-0", "hall-5", "grate-0", "grate-2", "plating-0", "hull-0"],
                      contact)
        print(f"contact sheet -> {contact}")


if __name__ == "__main__":
    main()
