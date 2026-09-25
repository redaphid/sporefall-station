#!/usr/bin/env python3
"""Give the six PROP sprites the cast's colour, without regenerating them.

Sibling of restyle.py, which did this for the six creatures. Same technique,
same guarantee, two deliberate differences — both forced by the props' history.

DIFFERENCE 1: THERE ARE NO PROP RAWS.
restyle.py rebuilds each creature from `raws/char.<name>.s-idle.png`, re-running
post.sprite() with the ramp inserted before the downscale. `scripts/assets/raws/`
contains characters only; the 1024px prop generations were never kept. So this
grades the SHIPPED 32px/64px PNGs in place. That is strictly worse — the ramp is
working on already-quantized, already-downscaled pixels, so it has fewer distinct
luma levels to spread across the ramp and cannot recover detail the downscale
threw away. It is what is available, and it is still a large improvement, but
anything regenerated later should go through restyle.py's raw path instead.

DIFFERENCE 2: WHAT THIS CANNOT FIX, STATED UP FRONT.
Only RGB is written; alpha is byte-for-byte untouched (`--verify-alpha` asserts
it). For the creatures that was purely a safety property. For the props it is
also a hard CEILING on the result, because the props' central defect lives in
the alpha:

  Every prop was generated with `refs="env"` (generate.py:399) against
  anchors/env-a.png — a barrel with a moss cap sitting in a puddle of grass —
  and WITHOUT `NEG_GROUND`, the negative that exists precisely to stop a painted
  dirt mound being welded into the sprite's alpha (generate.py:121-126, applied
  to every ground creature, never to props).

The result is that each prop carries a ground-mound plinth inside its silhouette,
and four of the six have no object geometry at all — they are boulders. A colour
ramp turns a grey tombstone into a COLOURED tombstone. `nutrient-dispenser` is
the one prop whose silhouette is genuinely right (an upright machine with a shelf
grid), and it is the one this script actually fixes. The rest need pixels.

Run `python restyle_props.py --dry-run` for the before/after metrics table.

Usage:
    python restyle_props.py --dry-run       # metrics only, writes nothing
    python restyle_props.py                 # rewrite both theme packs
    python restyle_props.py --verify-alpha  # prove silhouettes did not move
    python restyle_props.py --only nutrient-dispenser
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

import post as P
from palette_metrics import CAST, band, measure
from restyle import ink_rim, ramp_grade

ROOT = Path(__file__).resolve().parents[2]

# Per-prop ramps, dark -> light, every entry lifted from palette.py.
#
# Same two construction rules restyle.py learned the hard way: 8-9 entries (a
# K-entry ramp caps `palette_n` at K, and the cast floor is 9), and a span from
# near #08080c to luma 145+ (`value_range` cannot exceed the ramp's own span).
#
# Colour choice is by MATERIAL, so a room's furniture is told apart by hue and
# not only by outline. The props currently share one grey; that is half of why a
# furnished room reads as a graveyard rather than as a room.
RAMPS: dict[str, dict] = {
    # desk + tv + generator. Station tech: dark bulkhead body, cool metal
    # highlights, and the screen's green glow reserved as an accent so the
    # brightest thing on it is the display rather than the casing.
    "console-monitor": {
        "ramp": ["#08080c", "#141a16", "#23282e", "#3c444d", "#59636d",
                 "#7b8791", "#a2adb4", "#7ecbd2", "#f2f6ea"],
        "accent": "#46e078", "accent_q": 0.95,
    },
    # cabinet + vending. THE ONE THIS SCRIPT ACTUALLY FIXES — the silhouette is
    # already an upright machine with a shelf grid. Teal cabinet so it reads as
    # painted station kit rather than raw metal, with the stocked product
    # glowing green behind the window.
    "nutrient-dispenser": {
        "ramp": ["#08080c", "#163a3e", "#24565c", "#3a7a80", "#5aa4ae",
                 "#7ecbd2", "#a2adb4", "#cbb277", "#f2f6ea"],
        "accent": "#46e078", "accent_q": 0.93,
    },
    # barrel. Tan/rust drum with moss — the one prop whose prompt colour
    # (warning stripes on tan metal) was right and got greyed anyway.
    "spore-barrel": {
        "ramp": ["#08080c", "#2e1e10", "#4a3419", "#6b4d26", "#8f6c38",
                 "#b08d50", "#cbb277", "#a8c46a", "#ffd83e"],
    },
    # locker + atm. Painted-steel lockup with a tan panel — warm enough not to
    # be the console's cold grey (these two share a guardpost and must not
    # merge), but NOT the olive-green the first attempt used.
    #
    # The first attempt here is worth recording because the metric endorsed it
    # and the eye rejected it: an olive ramp with `accent #3ce0d8, accent_q
    # 0.96` scored sat_frac 0.003 -> 0.466, a huge apparent win, and looked like
    # a green postbox with a cyan slab stuck to it. The accent quantile is taken
    # over the whole opaque sprite, so on a prop whose brightest 4% is a broad
    # flat panel rather than a small light, it floods. Small lights only: 0.99.
    "cryo-terminal": {
        "ramp": ["#08080c", "#141a16", "#23282e", "#3c444d", "#59636d",
                 "#7b8791", "#8f6c38", "#b08d50", "#cbb277"],
        "accent": "#46e078", "accent_q": 0.99,
    },
    # toilet. Wet ceramic + a hint of teal water. No broad accent, for the same
    # reason as cryo-terminal: at 0.90 the basin's whole lit rim went cyan and
    # the prop read as a boulder sitting in a pool of antifreeze.
    "hydro-recycler": {
        "ramp": ["#08080c", "#141a16", "#23282e", "#3c444d", "#59636d",
                 "#7b8791", "#a2adb4", "#7ecbd2", "#f2f6ea"],
        "accent": "#3ce0d8", "accent_q": 0.985,
    },
    # prop.default. Nothing resolves to it today (every archetype has a mapping),
    # but it is the fallback any future unmapped prop lands on, so it gets a
    # ramp rather than being left the odd grey one out.
    "cargo-pod": {
        "ramp": ["#08080c", "#2e1e10", "#4a3419", "#6b4d26", "#8f6c38",
                 "#b08d50", "#cbb277", "#86a750", "#a6ffbe"],
    },
}

# (theme, whether to ink the rim). Only the hi-res pack is inked, for the reason
# ink_rim() documents: the hi-res cast scores rim_dark_frac 1.000 and the 48px
# cast does not, so inking the small pack would overshoot the band.
TARGETS = [("swampspace", False), ("swampspace-hires", True)]


def restyle(path: Path, spec: dict, ink: bool) -> Image.Image:
    """Grade one shipped prop PNG. Alpha is never written."""
    im = Image.open(path).convert("RGBA")
    im = ramp_grade(im, spec["ramp"], spec.get("accent"),
                    spec.get("accent_q", 0.94), spec.get("equalize", 0.85))
    im = P.to_palette(im)
    return ink_rim(im) if ink else im


def _cast_band() -> dict:
    root = ROOT / "public" / "themes" / "swampspace" / "chars"
    return band({n: measure(root / f"{n}.png") for n in CAST})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-alpha", action="store_true")
    ap.add_argument("--only", action="append", help="restyle only these props")
    args = ap.parse_args()

    names = args.only or list(RAMPS)
    unknown = [n for n in names if n not in RAMPS]
    if unknown:
        print(f"unknown prop(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    b = _cast_band()
    bad_alpha: list[str] = []
    tmp = ROOT / ".props-restyle-tmp.png"

    for theme, ink in TARGETS:
        outdir = ROOT / "public" / "themes" / theme / "props"
        print(f"\n{'(dry) ' if args.dry_run else ''}{theme}")
        print(f"  {'prop':<20}{'sat_frac':>18}{'chroma_p90':>18}{'value_range':>18}{'palette_n':>14}")
        for name in names:
            dst = outdir / f"{name}.png"
            before = measure(dst)
            new = restyle(dst, RAMPS[name], ink)

            new_a = np.asarray(new)[..., 3]
            old_a = np.asarray(Image.open(dst).convert("RGBA"))[..., 3]
            if not np.array_equal(old_a, new_a):
                bad_alpha.append(f"{theme}/{name}: {int((old_a != new_a).sum())}px")

            new.save(tmp)
            after = measure(tmp)

            def cell(k: str) -> str:
                lo, fmt = b[k]["min"], ("d" if k == "palette_n" else ".3f")
                mark = " " if after[k] >= lo else "!"
                return f"{before[k]:{fmt}}->{after[k]:{fmt}}{mark}".rjust(18)

            print(f"  {name:<20}" + "".join(
                cell(k) for k in ("sat_frac", "chroma_p90", "value_range", "palette_n")))

            if not args.dry_run:
                new.save(dst)
        print(f"  cast floors: sat {b['sat_frac']['min']:.3f}  chroma {b['chroma_p90']['min']:.0f}"
              f"  value {b['value_range']['min']:.3f}  palette_n {b['palette_n']['min']}"
              f"   ('!' = still under the floor)")

    tmp.unlink(missing_ok=True)

    if args.verify_alpha:
        if bad_alpha:
            print("\nALPHA CHANGED (silhouette would move):")
            for x in bad_alpha:
                print("  " + x)
            return 1
        print("\nalpha byte-identical for every prop — silhouettes intact")
    return 0


if __name__ == "__main__":
    sys.exit(main())
