#!/usr/bin/env python3
"""Macro-tile redesign of the swampspace FLOOR + STREET surfaces.

The old interior floors were dark plates under uniform bright-green speckle —
"confetti moss": high-frequency noise with no plate structure that fought the
sprites for attention, and 32px tiling repeated visibly. This pass rebuilds
both surfaces on three principles (see docs/themes.md "macroTiles"):

1. MACRO-TILES: each surface is authored as 64x64 (= 2x2 game tiles) macro
   images sliced into 4 co-tiling variants; the renderer places slices by
   (tx mod 2, ty mod 2) so plate seams and large water features span tiles and
   the visible repeat period doubles. Two macros per surface -> pool of 8.
2. QUIET INTERIORS: texture inside a surface stays within a close-valued ramp
   (~±2 value steps); contrast is reserved for surface boundaries and objects.
   No bright pixels inside the deck. The deck reads as plates: darker seam
   lines, occasional rivets, subtle per-plate tone shifts, one rare buckled
   plate with roots (macro 1).
3. MOSS AS PLACEMENT: overgrowth ships as RGBA overlay DECALS
   (floor-overlay-N.png) that the renderer places by context — wall bases,
   door thresholds, plate seams, room corners (tileSelect.planTileOverlays) —
   instead of being speckled uniformly into the base texture. Decals are
   organic clumps with dark edges, mass biased toward the TOP tile edge (the
   renderer rotates them toward the wall/seam that earned them).

Deterministic: fixed-seed PRNG per asset; re-running reproduces byte-for-byte.

Usage:
  python3 tilesets_floor.py proc [outdir]      # macros + slices + overlays + accents
  python3 tilesets_floor.py sd <procdir> <outdir>   # ComfyUI img2img refine of the macros
  python3 tilesets_floor.py final <procdir> <sddir|-> <outdir> [--sd floor,street]
        # slice the chosen macros into the shipped pool + copy decals/accents
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path

from PIL import Image

M = 64  # macro side (2x2 game tiles)
T = 32  # game tile side
MACROS = {"floor": 2, "street": 3}  # macro count per surface (pool = 4 * count)

# ---- Close-valued deck ramp (anchored between palette #141a16/#23282e/#22380f)
SEAM = (16, 20, 18)
DECK_A = (30, 36, 32)
DECK_B = (34, 41, 36)
DECK_C = (38, 46, 40)
RIVET = (48, 56, 50)
SCUFF = (26, 32, 28)
CAVITY = (8, 8, 12)

# Moss family (locked-palette olives, dark end only for stains)
MOSS_STAIN = (30, 40, 20)
MOSS_DEEP = (28, 43, 18)
MOSS_DARK = (47, 71, 23)
MOSS_BASE = (53, 81, 26)
MOSS_LIGHT = (76, 107, 40)

ROOT_BASE = (46, 30, 16)
ROOT_MID = (74, 52, 25)
ROOT_LIGHT = (107, 77, 38)

# Bog water (locked-palette teals + one intermediate)
BOG_DEEP = (14, 26, 30)
BOG_DIM = (18, 32, 38)
BOG_BASE = (24, 42, 48)
BOG_LIFT = (30, 58, 64)
BOG_MID = (36, 86, 92)
BOG_SHEEN = (58, 122, 128)
BOG_GLINT = (96, 168, 168)

FLOOR_FAMILY = [CAVITY, SEAM, SCUFF, DECK_A, DECK_B, DECK_C, RIVET,
                MOSS_STAIN, MOSS_DEEP, MOSS_DARK, ROOT_BASE, ROOT_MID]
STREET_FAMILY = [CAVITY, BOG_DEEP, BOG_DIM, BOG_BASE, BOG_LIFT, BOG_MID,
                 BOG_SHEEN, MOSS_DEEP, MOSS_DARK, ROOT_BASE, ROOT_MID]


class Painter:
    def __init__(self, seed: int, size: int, base=None):
        self.rng = random.Random(seed)
        self.size = size
        mode = "RGB" if base is not None else "RGBA"
        fill = base if base is not None else (0, 0, 0, 0)
        self.im = Image.new(mode, (size, size), fill)
        self.px = self.im.load()

    def set(self, x: int, y: int, c, wrap: bool = False) -> None:
        if wrap:
            x, y = x % self.size, y % self.size
        if 0 <= x < self.size and 0 <= y < self.size:
            self.px[x, y] = c

    def blob(self, cx: float, cy: float, r: float, color, dither: float = 0.5, wrap: bool = False) -> None:
        for y in range(int(cy - r - 1), int(cy + r + 2)):
            for x in range(int(cx - r - 1), int(cx + r + 2)):
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if d <= r * 0.6 or (d <= r and self.rng.random() < dither):
                    self.set(x, y, color, wrap)

    def worm(self, x: float, y: float, steps: int, color, jitter: float = 1.2, wrap: bool = False) -> None:
        ang = self.rng.uniform(0, 6.283)
        for _ in range(steps):
            self.set(int(x), int(y), color, wrap)
            ang += self.rng.uniform(-jitter, jitter) * 0.5
            x += math.cos(ang)
            y += math.sin(ang)


# ---------------------------------------------------------------------------
# FLOOR: interior deck plates (64px macro, seams on the macro border so the
# 2-tile macro grid IS the plate seam grid the overlay planner keys on).

def floor_macro(idx: int) -> Image.Image:
    p = Painter(7000 + idx, M, DECK_B)
    rng = p.rng
    # Plate layout: seams on the border (x=0/y=0) + interior seams at varied
    # offsets so plates span game tiles once sliced.
    xs = [0, 26] if idx == 0 else [0, 40]
    ys = [0, 38] if idx == 0 else [0, 22, 46]
    # per-plate base tone (±1 value step around DECK_B)
    tones = [DECK_A, DECK_B, DECK_B, DECK_C]
    plates = []
    for yi, y0 in enumerate(ys):
        y1 = (ys + [M])[yi + 1]
        for xi, x0 in enumerate(xs):
            x1 = (xs + [M])[xi + 1]
            plates.append((x0, y0, x1, y1))
    for (x0, y0, x1, y1) in plates:
        tone = rng.choice(tones)
        for y in range(y0, y1):
            for x in range(x0, x1):
                p.set(x, y, tone)
        # per-pixel micro noise, one step, sparse — texture without sparkle
        for y in range(y0, y1):
            for x in range(x0, x1):
                r = rng.random()
                if r < 0.05:
                    p.set(x, y, DECK_A if tone != DECK_A else SCUFF)
                elif r < 0.08:
                    p.set(x, y, DECK_C if tone != DECK_C else DECK_B)
    # seam lines: 1px dark + a faint bevel line beside (broken, subtle)
    for y0 in ys:
        for x in range(M):
            if rng.random() < 0.96:
                p.set(x, y0, SEAM)
            if rng.random() < 0.5:
                p.set(x, (y0 + 1) % M, DECK_C)
    for x0 in xs:
        for y in range(M):
            if rng.random() < 0.96:
                p.set(x0, y, SEAM)
            if rng.random() < 0.4:
                p.set((x0 + 1) % M, y, DECK_C)
    # rivets at plate corners (inset 3px), most corners
    for (x0, y0, x1, y1) in plates:
        for (rx, ry) in [(x0 + 3, y0 + 3), (x1 - 4, y0 + 3), (x0 + 3, y1 - 4), (x1 - 4, y1 - 4)]:
            if rng.random() < 0.75:
                p.set(rx, ry, RIVET)
                p.set(rx + 1, ry + 1, SEAM)
    # wear scuffs
    for _ in range(rng.randint(2, 4)):
        p.blob(rng.randrange(M), rng.randrange(M), rng.uniform(2, 4), SCUFF, 0.4, wrap=True)
    # faint moss staining where seams meet (dark, low contrast — the bright
    # growth lives in the context-placed overlay decals, not here)
    for _ in range(rng.randint(2, 3)):
        sx = rng.choice(xs)
        sy = rng.choice(ys)
        p.blob(sx + rng.uniform(-2, 2), sy + rng.uniform(-2, 2), rng.uniform(1.5, 2.5), MOSS_STAIN, 0.45, wrap=True)
        if rng.random() < 0.6:
            p.blob(sx, sy, 1.2, MOSS_DEEP, 0.5, wrap=True)
    if idx == 1:
        # one buckled plate with roots pushing through (rare: 1 slice in 8)
        x0, y0, x1, y1 = plates[2]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        for y in range(y0, y1):
            for x in range(x0, x1):
                if rng.random() < 0.5:
                    p.set(x, y, DECK_A)
        p.blob(cx, cy, 3.2, CAVITY, 0.7)
        for _ in range(4):
            p.worm(cx + rng.uniform(-2, 2), cy + rng.uniform(-2, 2), rng.randint(6, 11), ROOT_MID)
        for _ in range(2):
            p.worm(cx + rng.uniform(-1, 1), cy + rng.uniform(-1, 1), rng.randint(3, 6), ROOT_LIGHT)
        for _ in range(3):
            p.worm(cx + rng.uniform(-3, 3), cy + rng.uniform(-3, 3), rng.randint(4, 8), SEAM)
        p.blob(cx, cy, 5.5, MOSS_DEEP, 0.25)
    return p.im


# ---------------------------------------------------------------------------
# STREET: bog-water channel (64px macro — fewer, LARGER ripple features).

def street_macro(idx: int) -> Image.Image:
    p = Painter(8000 + idx, M, BOG_BASE)
    rng = p.rng
    # broad depth mottle (soft, wraps)
    for _ in range(rng.randint(4, 6)):
        p.blob(rng.randrange(M), rng.randrange(M), rng.uniform(6, 12), BOG_DIM, 0.35, wrap=True)
    for _ in range(rng.randint(2, 3)):
        p.blob(rng.randrange(M), rng.randrange(M), rng.uniform(4, 7), BOG_DEEP, 0.35, wrap=True)
    def ring(cx: float, cy: float, rx: float, keep: float, color, lit: bool = False) -> None:
        ry = rx * 0.55  # top-down squash
        for i in range(int(rx * 10)):
            a = i / (rx * 10) * 6.283
            x, y = cx + rx * math.cos(a), cy + ry * math.sin(a)
            if rng.random() < keep:
                p.set(int(x), int(y), color, wrap=True)
                if lit and -2.6 < a - 3.9 < 0.8 and rng.random() < 0.3:
                    p.set(int(x), int(y) - 1, BOG_SHEEN, wrap=True)
    if idx == 0:
        # one large double ripple ring — a slow bloom in still water. Only
        # macro 0 carries the big feature: rings land on ~1/3 of macro cells,
        # so the pattern stops reading as a periodic grid at far zoom.
        cx, cy = 30, 26
        ring(cx, cy, 20, 0.5, BOG_MID, lit=True)
        ring(cx, cy, 12, 0.65, BOG_MID)
        ring(cx, cy, 5, 0.5, BOG_LIFT)
    elif idx == 1:
        # calm water with a single wavering drift line
        y = 40.0
        for x in range(0, 44):
            y += rng.uniform(-0.5, 0.5)
            if rng.random() < 0.75:
                p.set(x, int(y), BOG_MID, wrap=True)
            if rng.random() < 0.1:
                p.set(x, int(y) - 1, BOG_SHEEN, wrap=True)
        ring(48, 16, 5, 0.45, BOG_LIFT)  # faint dying ripple, small
    else:
        # near-still water: mottle, a couple of soft short dashes, nothing more
        for _ in range(3):
            y0, x0 = rng.randrange(M), rng.randrange(M)
            for i in range(rng.randint(5, 9)):
                if rng.random() < 0.7:
                    p.set((x0 + i) % M, y0, BOG_LIFT, wrap=True)
        ring(rng.randrange(M), rng.randrange(M), 4, 0.4, BOG_LIFT)
    # sparse floating moss flecks
    for _ in range(rng.randint(4, 6)):
        x, y = rng.randrange(M), rng.randrange(M)
        p.set(x, y, MOSS_DEEP)
        if rng.random() < 0.6:
            p.set(x + 1, y, MOSS_DARK, wrap=True)
    # a single glint per macro
    p.set(rng.randrange(M), rng.randrange(M), BOG_GLINT)
    return p.im


def street_lily_accent() -> Image.Image:
    """Rare scum/lily patch feature tile (32px, full-tile accent)."""
    p = Painter(8500, T, BOG_BASE)
    rng = p.rng
    for _ in range(3):
        p.blob(rng.randrange(T), rng.randrange(T), rng.uniform(4, 6), BOG_DIM, 0.35, wrap=True)
    # scum film
    for _ in range(rng.randint(14, 18)):
        x, y = rng.randrange(T), rng.randrange(T)
        p.set(x, y, MOSS_STAIN)
    # pads: irregular dark-olive discs with a notch and a dim rim
    for (cx, cy, r) in [(9, 10, 4.2), (21, 8, 3.2), (14, 21, 4.8), (25, 20, 2.6)]:
        p.blob(cx, cy, r + 1, BOG_DEEP, 0.5)   # water shadow under the pad
        p.blob(cx, cy, r, MOSS_DEEP, 0.75)
        p.blob(cx - 1, cy - 1, r * 0.55, MOSS_DARK, 0.6)
        # notch: carve a wedge back to water
        na = rng.uniform(0, 6.283)
        for d in range(int(r) + 1):
            p.set(int(cx + d * math.cos(na)), int(cy + d * math.sin(na)), BOG_BASE)
        p.set(int(cx), int(cy - r), MOSS_BASE)  # rim catch, single px
    return p.im


# ---------------------------------------------------------------------------
# FLOOR ACCENTS rebased on the new plate deck (grate + root-burst keep their
# jobs, but sit on the same quiet plate texture as the pool).

def _plate_base(seed: int) -> Painter:
    p = Painter(seed, T, DECK_B)
    rng = p.rng
    for y in range(T):
        for x in range(T):
            r = rng.random()
            if r < 0.05:
                p.set(x, y, DECK_A)
            elif r < 0.08:
                p.set(x, y, DECK_C)
    for x in range(T):  # border seam so the accent reads as its own plate
        if rng.random() < 0.9:
            p.set(x, 0, SEAM)
    for y in range(T):
        if rng.random() < 0.9:
            p.set(0, y, SEAM)
    return p


def floor_accent(n: int) -> Image.Image:
    if n == 0:
        # ventilation grate, faint teal under-glow
        p = _plate_base(9000)
        for x in range(7, 25):
            p.set(x, 9, RIVET)
            p.set(x, 24, SEAM)
        for y in range(9, 25):
            p.set(7, y, RIVET)
            p.set(24, y, SEAM)
        for y in range(11, 24, 3):
            for x in range(9, 23):
                p.set(x, y, SEAM)
                if y + 1 < 24:
                    p.set(x, y + 1, (28, 46, 44))  # dim teal glow between slats
        return p.im
    # n == 1: roots bursting through a cracked plate
    p = _plate_base(9100)
    rng = p.rng
    p.blob(16, 17, 4.5, CAVITY, 0.6)
    for _ in range(5):
        p.worm(16 + rng.uniform(-2, 2), 17 + rng.uniform(-2, 2), rng.randint(6, 11), ROOT_MID)
    for _ in range(3):
        p.worm(16 + rng.uniform(-1, 1), 17 + rng.uniform(-1, 1), rng.randint(3, 6), ROOT_LIGHT)
    for _ in range(4):
        p.worm(16 + rng.uniform(-3, 3), 17 + rng.uniform(-3, 3), rng.randint(4, 8), SEAM)
    p.blob(16, 17, 7, MOSS_DEEP, 0.22)
    for _ in range(3):
        p.blob(16 + rng.uniform(-6, 6), 17 + rng.uniform(-6, 6), rng.uniform(1, 1.8), MOSS_DARK, 0.5)
    return p.im


# ---------------------------------------------------------------------------
# OVERLAY DECALS (RGBA): organic moss with dark edges, mass biased to the TOP
# edge; the renderer rotates each decal toward the wall/seam that earned it.

def _rimmed_blob(p: Painter, cx: float, cy: float, r: float) -> None:
    p.blob(cx, cy, r + 1.2, MOSS_DEEP, 0.45)
    p.blob(cx, cy, r, MOSS_DARK, 0.7)
    p.blob(cx - r * 0.25, cy - r * 0.25, r * 0.45, MOSS_BASE, 0.55)


def floor_overlay(n: int) -> Image.Image:
    p = Painter(9500 + n * 37, T)  # RGBA
    rng = p.rng
    if n == 0:
        # moss bank pooling along the wall base (top edge), organic lower lip
        depth = 5.0
        for x in range(T):
            depth = min(10.0, max(2.0, depth + rng.uniform(-1.4, 1.4)))
            d = int(depth)
            for y in range(d + 1):
                if y == d:
                    p.set(x, y, MOSS_DEEP)      # dark edge against the deck
                elif y == 0 or rng.random() < 0.85:
                    p.set(x, y, MOSS_DARK if rng.random() < 0.75 else MOSS_BASE)
        for _ in range(2):  # drips running a little further down
            x = rng.randrange(2, T - 2)
            for y in range(3, 3 + rng.randint(4, 7)):
                p.set(x, y, MOSS_DARK)
                p.set(x, y + 1, MOSS_DEEP)
        for _ in range(4):  # a few lighter tips, never bright
            p.set(rng.randrange(T), rng.randrange(2, 6), MOSS_LIGHT)
    elif n == 1:
        # sparser bank: clumps hugging the top edge
        for (cx, r) in [(5, 3.0), (14, 2.2), (24, 3.4)]:
            _rimmed_blob(p, cx, rng.uniform(2, 4), r)
        for _ in range(5):
            p.set(rng.randrange(T), rng.randrange(0, 7), MOSS_DEEP)
    elif n == 2:
        # corner clump (top-left biased — two of these overlap in room corners)
        _rimmed_blob(p, 6, 5, 4.6)
        _rimmed_blob(p, 13, 2, 2.4)
        _rimmed_blob(p, 2, 12, 2.2)
        p.worm(7, 7, 6, ROOT_MID)
        p.set(5, 4, MOSS_LIGHT)
    else:
        # loose tufts near the top edge + a stray root
        for (cx, cy, r) in [(7, 4, 1.8), (17, 3, 1.4), (26, 6, 2.0), (12, 9, 1.2)]:
            _rimmed_blob(p, cx, cy, r)
        p.worm(20, 5, 7, ROOT_MID)
        p.set(26, 5, MOSS_LIGHT)
    return p.im


# ---------------------------------------------------------------------------

def slice_macro(im: Image.Image) -> list[Image.Image]:
    """Row-major 2x2 slices — index = (ty%2)*2 + tx%2 (tileSelect contract)."""
    return [im.crop(((i % 2) * T, (i // 2) * T, (i % 2) * T + T, (i // 2) * T + T)) for i in range(4)]


def heal(im: Image.Image, family: list[tuple[int, int, int]]) -> Image.Image:
    im = im.convert("RGB")
    px = im.load()
    fam = set(family)
    for y in range(im.height):
        for x in range(im.width):
            c = px[x, y]
            if c not in fam:
                px[x, y] = min(family, key=lambda f: sum((f[i] - c[i]) ** 2 for i in range(3)))
    return im


def restamp_floor(im: Image.Image, idx: int) -> Image.Image:
    """Re-assert the deck's load-bearing structure over an SD-refined macro:
    the img2img pass paints better per-plate wear than procedural noise, but
    tends to erase rivets and the buckled-plate roots — so SD supplies the
    texture and this pass guarantees the structure (same fixed layout the
    procedural macro used; deterministic)."""
    p = Painter(7300 + idx, M)
    p.im = im.convert("RGB")
    p.px = p.im.load()
    rng = p.rng
    xs = [0, 26] if idx == 0 else [0, 40]
    ys = [0, 38] if idx == 0 else [0, 22, 46]
    plates = []
    for yi, y0 in enumerate(ys):
        y1 = (ys + [M])[yi + 1]
        for xi, x0 in enumerate(xs):
            x1 = (xs + [M])[xi + 1]
            plates.append((x0, y0, x1, y1))
    for y0 in ys:  # thin seams (SD thickens them; re-draw crisp 1px)
        for x in range(M):
            if rng.random() < 0.9:
                p.set(x, y0, SEAM)
    for x0 in xs:
        for y in range(M):
            if rng.random() < 0.9:
                p.set(x0, y, SEAM)
    for (x0, y0, x1, y1) in plates:
        for (rx, ry) in [(x0 + 3, y0 + 3), (x1 - 4, y0 + 3), (x0 + 3, y1 - 4), (x1 - 4, y1 - 4)]:
            if rng.random() < 0.75:
                p.set(rx, ry, RIVET)
                p.set(rx + 1, ry + 1, SEAM)
    if idx == 1:  # the buckled plate with roots (a 1-in-8 slice feature)
        x0, y0, x1, y1 = plates[2]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        p.blob(cx, cy, 3.2, CAVITY, 0.7)
        for _ in range(4):
            p.worm(cx + rng.uniform(-2, 2), cy + rng.uniform(-2, 2), rng.randint(6, 11), ROOT_MID)
        for _ in range(2):
            p.worm(cx + rng.uniform(-1, 1), cy + rng.uniform(-1, 1), rng.randint(3, 6), ROOT_LIGHT)
        p.blob(cx, cy, 5.5, MOSS_DEEP, 0.25)
    return p.im


def cmd_proc(outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    for i in range(2):
        floor_macro(i).save(outdir / f"floor-macro-{i}.png")
    for i in range(3):
        street_macro(i).save(outdir / f"street-macro-{i}.png")
    for n in range(4):
        floor_overlay(n).save(outdir / f"floor-overlay-{n}.png")
    for n in range(2):
        floor_accent(n).save(outdir / f"floor-accent-{n}.png")
    street_lily_accent().save(outdir / "street-accent-2.png")
    print(f"proc macros/overlays/accents -> {outdir}")


SD_RECIPES = {
    # img2img prompts hold the value discipline: quiet, dark, low contrast.
    "floor": (
        "masterpiece, pixpix, 8-bit, pixel_art, top-down metal deck floor of a "
        "derelict space station, large riveted deck plates, subtle dark panel "
        "seams, worn scratched dark green-grey steel, faint moss stains in the "
        "seams, muted low contrast, quiet dark surface, SNES rpg dungeon floor "
        "texture, seamless game tile, flat top-down view",
        0.3,  # 0.4 washed the plates; 0.3 keeps structure, adds wear
    ),
    "street": (
        "masterpiece, pixpix, 8-bit, pixel_art, top-down dark bog water, still "
        "swamp channel at night, one large soft ripple ring, calm deep murky "
        "teal water, sparse surface sheen, muted low contrast, SNES rpg water "
        "texture, seamless game tile, flat top-down view",
        0.4,
    ),
}
SD_NEG = ("photo, photorealistic, blurry, smooth gradients, 3d render, text, "
          "watermark, frame, border, object, creature, character, figure, "
          "bright green dots, speckle, noise, confetti, glowing dots")


def cmd_sd(procdir: Path, outdir: Path) -> None:
    sys.path.insert(0, str(Path(__file__).parent))
    from comfy import build_graph, run  # noqa: E402
    from post import kcentroid  # noqa: E402
    outdir.mkdir(parents=True, exist_ok=True)
    fams = {"floor": FLOOR_FAMILY, "street": STREET_FAMILY}
    for si, name in enumerate(SD_RECIPES):
        pos, denoise = SD_RECIPES[name]
        for i in range(MACROS[name]):
            init = procdir / f"{name}-macro-{i}.png"
            big = outdir / f"_{name}-{i}-init.png"
            Image.open(init).resize((1024, 1024), Image.NEAREST).save(big)
            graph = build_graph(pos=pos, neg=SD_NEG, seed=52000 + si * 191 + i * 7,
                                init=str(big), denoise=denoise, seamless=True,
                                alpha=False, prefix=f"macro-{name}-{i}")
            raw = run(graph, str(outdir / "raw"))
            im = Image.open(raw[-1]).convert("RGB")
            small = heal(kcentroid(im, M, M), fams[name])
            if name == "floor":
                small = restamp_floor(small, i)
            small.save(outdir / f"{name}-macro-{i}.png")
            print(f"{name}-macro-{i}: refined (denoise {denoise})")


def cmd_final(procdir: Path, sddir: Path | None, outdir: Path, sd_for: set[str]) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    for name in ("floor", "street"):
        src = sddir if (name in sd_for and sddir is not None) else procdir
        for i in range(MACROS[name]):
            im = Image.open(src / f"{name}-macro-{i}.png").convert("RGB")
            for q, s in enumerate(slice_macro(im)):
                s.save(outdir / f"{name}-{i * 4 + q}.png")
    for n in range(4):
        Image.open(procdir / f"floor-overlay-{n}.png").save(outdir / f"floor-overlay-{n}.png")
    for n in range(2):
        Image.open(procdir / f"floor-accent-{n}.png").convert("RGB").save(outdir / f"floor-accent-{n}.png")
    Image.open(procdir / "street-accent-2.png").convert("RGB").save(outdir / "street-accent-2.png")
    print(f"final pools -> {outdir} (sd for: {sorted(sd_for) or 'none'})")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "proc"
    if cmd == "proc":
        cmd_proc(Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/swampspace-stage/tileset-macro"))
    elif cmd == "sd":
        cmd_sd(Path(sys.argv[2]), Path(sys.argv[3]))
    elif cmd == "final":
        sd_for = set()
        args = [a for a in sys.argv[2:] if not a.startswith("--sd")]
        for a in sys.argv[2:]:
            if a.startswith("--sd="):
                sd_for = set(a.split("=", 1)[1].split(","))
        procdir, sddir, outdir = Path(args[0]), (None if args[1] == "-" else Path(args[1])), Path(args[2])
        cmd_final(procdir, sddir, outdir, sd_for)
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
