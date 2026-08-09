#!/usr/bin/env python3
"""Give the six creature sprites the cast's colour, without regenerating them.

WHY NOT REGENERATE: the previous run already tried matching the cast by
switching checkpoint (dreamshaper_8 @512) and the output was worse -- muddy and
unreadable at 48px. The silhouettes we have are approved. The problem is
strictly colour, so the fix should be strictly colour.

WHY THE SPRITES CAME OUT GREY (measured, see palette_metrics.py):
every asset is snapped to the 33-colour locked palette by nearest RGB. The
palette's "station metals" ramp is blue-tinted grey. The SDXL raws for these six
are low-chroma and *cool* -- dominant hue 240 deg (blue) for cinder-husk,
gloom-lurker and mireclaw-stalker, against 60-180 deg (olive/green/teal) for the
cast raws. A desaturated blue-grey has exactly one neighbourhood in this
palette: the metals. So the body mass funnelled into 4 greys and stayed there.
It was never the checkpoint's "style"; it was hue plus nearest-neighbour.

Boosting saturation alone does not fix that -- it would amplify a hue the
palette cannot represent (there is no saturated blue) and the pixels would snap
straight back to the metals, plus it would amplify sensor-noise hue into
speckle. What works is to stop treating the raw's hue as signal and keep only
what it is actually good at: VALUE. Diffusion gave us a well-formed light-and-
shadow reading of a creature. That is the part worth keeping.

So: map luma onto a hand-picked palette ramp, per archetype.

  luma -> percentile-normalised t in [0,1] -> interpolate along the ramp

Three properties make this the right tool rather than a hack:

  1. FORM IS PRESERVED. The mapping is monotonic in luma, so every lit top stays
     lighter than every shadowed underside. The creature keeps the modelling
     that made it readable.
  2. THE SILHOUETTE IS UNTOUCHABLE. Only RGB is written; the alpha path is byte
     for byte the one that produced the approved sprites. `--verify-alpha`
     asserts this, so a colour change can never quietly reshape a creature that
     already passed the consistency gate.
  3. IT CANNOT GO OFF-PALETTE. The ramps are drawn from palette.py, and the
     result still goes through `to_palette` afterwards.

Percentile normalisation (p2..p98, not min..max) is what buys the contrast: it
stretches whatever range the raw happened to occupy across the full ramp, so a
flat mid-grey raw comes out with a dark underside and a lit top. Clipping at the
2nd/98th percentile keeps one stray hot pixel from eating the whole range.

Usage:
    python restyle.py --dry-run     # metrics only, writes nothing
    python restyle.py               # rewrite both theme packs
    python restyle.py --verify-alpha
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import post as P
from palette import rgb

ROOT = Path(__file__).resolve().parents[2]
RAWS = Path(__file__).resolve().parent / "raws"

_LUMA_W = np.array([0.299, 0.587, 0.114], dtype=np.float32)

# Per-archetype ramps, dark -> light, every entry lifted from palette.py.
#
# Chosen so the six do not all become the same olive: a cast reads as a cast
# because its members are told apart by colour as well as shape, and these six
# have to survive being on screen together. Each ramp follows the creature's
# description from the generation run rather than a generic "make it green".
#
# `accent` recolours the brightest `accent_q` quantile -- reserved for creatures
# whose design is literally "dark body, glowing part". Applied after the ramp so
# it overrides it.
RAMPS: dict[str, dict] = {
    # Hunched quadruped beast. Chitin: warm brown shell over near-black joints.
    "carapace-brute": {
        "ramp": ["#141a16", "#2e1e10", "#4a3419", "#6b4d26", "#8f6c38", "#b08d50"],
    },
    # Charcoal husk with ember eyes. Stays the darkest of the six on purpose;
    # its read comes from the embers, not from the body.
    "cinder-husk": {
        "ramp": ["#08080c", "#1c1420", "#2e1e10", "#4a3419", "#6b4d26", "#8f6c38"],
        "accent": "#ff9032", "accent_q": 0.94,
    },
    # Knee-high mushroom-cap critter. Full olive ramp, the bog-foliage family.
    "sporeling-mite": {
        "ramp": ["#141a16", "#22380f", "#35511a", "#4c6b28", "#67873c", "#86a750", "#a8c46a"],
    },
    # Low six-legged scavenger. Teal/water family -- the one cold creature, and
    # the palette does have a saturated teal to land on.
    "mireclaw-stalker": {
        "ramp": ["#08080c", "#163a3e", "#24565c", "#3a7a80", "#5aa4ae", "#7ecbd2"],
    },
    # Domed shell, tucked legs. Dark olive shell; sits between brute and mite.
    "gloom-lurker": {
        "ramp": ["#08080c", "#22380f", "#35511a", "#4c6b28", "#67873c", "#86a750"],
    },
    # Egg sac with a glowing split seam. Rot-tan sac, bioluminescent seam.
    "brood-sac": {
        "ramp": ["#1c1420", "#2e1e10", "#4a3419", "#6b4d26", "#b08d50", "#cbb277"],
        "accent": "#46e078", "accent_q": 0.93,
    },
}


def ramp_grade(im: Image.Image, ramp: list[str], accent: str | None = None,
               accent_q: float = 0.94, equalize: float = 0.85) -> Image.Image:
    """Replace RGB by mapping luma along `ramp`. Alpha is passed through.

    `equalize` blends two ways of turning luma into a ramp position:

      linear    (p2..p98 stretch) preserves the raw's relative spacing, so a
                subtle shadow stays subtle.
      equalized (rank within the sprite's own luma histogram) forces the mass to
                spread evenly across the ramp.

    Linear alone was measured to be not enough. The two darkest creatures came
    out with LESS value range than they started with, because their luma piles
    up in one narrow band and a linear stretch keeps it piled -- it just moves
    the pile. Every pixel then landed on the same two dark ramp steps, which in
    this palette are also the two lowest-chroma ones (chroma above 60 does not
    exist below luma 82), so they stayed dark AND stayed grey.

    Rank equalization fixes exactly that by construction: with a K-step ramp,
    roughly 1/K of the sprite lands on each step, so the bright saturated end
    always gets used. Pure equalization is too aggressive -- it stretches flat
    regions into visible banding and exaggerates downscaling noise -- so this
    blends, defaulting to mostly-equalized.
    """
    a = np.asarray(im.convert("RGBA"), dtype=np.float32).copy()
    opaque = a[..., 3] > 128
    if not opaque.any():
        return im

    luma = a[..., :3] @ _LUMA_W
    vals = luma[opaque]
    lo, hi = np.percentile(vals, 2), np.percentile(vals, 98)
    if hi - lo < 1e-3:
        hi = lo + 1.0
    t_lin = np.clip((luma - lo) / (hi - lo), 0.0, 1.0)

    # Rank of each pixel's luma among the opaque pixels, via the empirical CDF.
    order = np.sort(vals)
    t_eq = np.searchsorted(order, luma, side="left") / max(len(order) - 1, 1)
    t_eq = np.clip(t_eq, 0.0, 1.0)

    t = (1.0 - equalize) * t_lin + equalize * t_eq

    cols = np.array([rgb(c) for c in ramp], dtype=np.float32)   # (K,3)
    pos = t * (len(cols) - 1)
    i0 = np.floor(pos).astype(int)
    i1 = np.minimum(i0 + 1, len(cols) - 1)
    f = (pos - i0)[..., None]
    graded = cols[i0] * (1 - f) + cols[i1] * f

    if accent is not None:
        thr = np.quantile(t[opaque], accent_q)
        hot = opaque & (t >= thr)
        graded[hot] = np.array(rgb(accent), dtype=np.float32)

    a[..., :3] = np.where(opaque[..., None], graded, a[..., :3])
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def denoise(im: Image.Image, content: int) -> Image.Image:
    """Median-filter RGB before grading. Alpha is deliberately NOT filtered.

    Equalization is a gain stage, and like any gain stage it lifts the noise
    floor with the signal. Diffusion output is full of low-amplitude speckle
    that was invisible while everything was grey and became visible dirt the
    moment the ramp spread it across six colours -- worst on carapace-brute and
    brood-sac, whose surfaces are meant to read as one mass.

    A median (not a blur) is the right filter: it removes isolated outliers
    while leaving edges hard, which is what k-centroid downscaling needs to keep
    the outline crisp.

    The window is derived from the scale factor rather than hardcoded, so this
    behaves the same on a 512px raw and a 1024px one: aim for a window about
    0.4 output pixels wide, i.e. large enough to erase detail that cannot
    survive the downscale anyway, small enough to preserve everything that can.
    """
    k = int(round(im.width / max(content, 1) / 2.5))
    k = max(1, k | 1)  # odd, >= 1
    if k < 3:
        return im
    a = np.asarray(im.convert("RGBA")).copy()
    a[..., :3] = np.asarray(
        Image.fromarray(a[..., :3], "RGB").filter(ImageFilter.MedianFilter(k)))
    return Image.fromarray(a, "RGBA")


def build(name: str, px: int, content: int) -> Image.Image:
    """Reproduce post.sprite() for `name`, with the ramp inserted before the
    downscale. Every alpha-affecting step is the original, in the original
    order; only RGB is touched, and only between shadow-strip and k-centroid."""
    spec = RAMPS[name]
    src = Image.open(RAWS / f"char.{name}.s-idle.png")

    if not P.has_alpha(src):
        bg_lum = float(P.corner_bg(src) @ _LUMA_W)
        src = P.flat_key(src) if bg_lum > 128 else P.black_key(src)
    src, _ = P.strip_ground_shadow(src)
    im = P.bbox_crop(src)
    im = denoise(im, content)

    im = ramp_grade(im, spec["ramp"], spec.get("accent"), spec.get("accent_q", 0.94))

    w, h = im.size
    if w >= h:
        tw, th = content, max(1, round(content * h / w))
    else:
        tw, th = max(1, round(content * w / h)), content
    im = P.to_palette(P.kcentroid(im, tw, th))

    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(im, ((px - tw) // 2, max(0, px - th - 1)))
    return out


TARGETS = [("swampspace", 48, 46), ("swampspace-hires", 96, 92)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-alpha", action="store_true",
                    help="assert the restyled alpha is byte-identical to shipped")
    args = ap.parse_args()

    bad_alpha = []
    for theme, px, content in TARGETS:
        outdir = ROOT / "public" / "themes" / theme / "chars"
        for name in RAMPS:
            dst = outdir / f"{name}-s-idle.png"
            new = build(name, px, content)

            if args.verify_alpha and dst.exists():
                old_a = np.asarray(Image.open(dst).convert("RGBA"))[..., 3]
                if not np.array_equal(old_a, np.asarray(new)[..., 3]):
                    n = int((old_a != np.asarray(new)[..., 3]).sum())
                    bad_alpha.append(f"{theme}/{name}: {n}px")

            if not args.dry_run:
                new.save(dst)
        print(f"{'(dry) ' if args.dry_run else ''}{theme}: {len(RAMPS)} sprites")

    if args.verify_alpha:
        if bad_alpha:
            print("\nALPHA CHANGED (silhouette would move):")
            for b in bad_alpha:
                print("  " + b)
            return 1
        print("\nalpha byte-identical to shipped for all sprites — silhouettes intact")
    return 0


if __name__ == "__main__":
    sys.exit(main())
