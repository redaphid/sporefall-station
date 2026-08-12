#!/usr/bin/env python3
"""Take curated prop generations from exp_props.py into the shipping theme packs.

THE DIVISION OF LABOUR, which is the point of this script:

  DIFFUSION SUPPLIES SHAPE. exp_props.py drops the env IPAdapter anchor and adds
  NEG_GROUND plus named anti-tombstone negatives, and that fixed the silhouettes
  outright -- the barrel is a squat cylinder with a rim and a lid, the locker is
  a tall door with a keypad and hinges. No moss caps, no ground plinths.

  THE RAMP SUPPLIES COLOUR. The new raws came out near-WHITE (the previous set
  was near-grey; the pixel LoRA plus a white backdrop pulls hard in that
  direction, and fighting it with prompt words is a seed lottery). It does not
  matter, and that is not luck: `ramp_grade` keeps only VALUE and throws hue
  away by construction. A clean white-and-grey render has an excellent value
  structure -- lit top, shadowed underside, dark seams -- which is precisely
  what the ramp wants as input. So the model is never asked for colour at all.

That composition is why this is one script and not two: post -> ramp -> palette
-> ink, written to both packs at their respective footprints.

Nothing here picks seeds. `CURATED` is a hand-edited list, chosen off a contact
sheet at game size.

    python install_props.py --dry-run
    python install_props.py
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from PIL import Image

import post as P
from palette_metrics import CAST, band, measure
from restyle import ink_rim, ramp_grade

ROOT = Path(__file__).resolve().parents[2]
GEN = Path("D:/tmp/props-gen")

# subject -> (run tag, seed, destination filename, ramp spec)
#
# Ramps follow restyle_props.py's two rules (>=8 entries so `palette_n` can
# clear the cast floor of 9; span from near #08080c to luma 145+ so
# `value_range` can clear 0.487) and are chosen so a furnished room is told
# apart by hue: warm tan desk, teal cabinet, rust barrel, olive locker.
CURATED: dict[str, dict] = {
    "work-desk": dict(
        tag="g2", seed=2000, dst="work-desk.png",
        ramp=["#08080c", "#141a16", "#2e1e10", "#4a3419", "#6b4d26",
              "#8f6c38", "#b08d50", "#cbb277", "#f2f6ea"],
        accent="#46e078", accent_q=0.985,
    ),
    "supply-cabinet": dict(
        tag="g2", seed=2000, dst="supply-cabinet.png",
        ramp=["#08080c", "#141a16", "#163a3e", "#24565c", "#3a7a80",
              "#5aa4ae", "#7ecbd2", "#a2adb4", "#f2f6ea"],
        accent="#46e078", accent_q=0.99,
    ),
    "spore-barrel": dict(
        tag="g2", seed=2001, dst="spore-barrel.png",
        ramp=["#08080c", "#2e1e10", "#4a3419", "#6b4d26", "#8f6c38",
              "#b08d50", "#cbb277", "#a8c46a", "#ffd83e"],
        accent="#ffd83e", accent_q=0.99,
    ),
    "weapons-locker": dict(
        tag="g2", seed=2000, dst="weapons-locker.png",
        ramp=["#08080c", "#141a16", "#22380f", "#35511a", "#4c6b28",
              "#67873c", "#86a750", "#a8c46a", "#cbb277"],
        accent="#ffd83e", accent_q=0.99,
    ),
    "wall-screen": dict(
        tag="g2", seed=2000, dst="wall-screen.png",
        ramp=["#08080c", "#141a16", "#23282e", "#3c444d", "#59636d",
              "#7b8791", "#a2adb4", "#7ecbd2", "#f2f6ea"],
        accent="#46e078", accent_q=0.96,
    ),
}

# (theme, canvas px, content px, ink the rim) -- props bake to TILE_PX 32
# logical; the hi-res pack authors at 2x and is the one that carries the cast's
# 1px ink line (see restyle.ink_rim).
TARGETS = [("swampspace", 32, 30, False), ("swampspace-hires", 64, 60, True)]


def build(name: str, spec: dict, px: int, content: int, ink: bool) -> Image.Image:
    """Raw -> keyed -> shadow-stripped -> ramped -> k-centroid -> palette -> ink.

    The ramp goes in BEFORE the downscale, exactly as restyle.build does, so it
    grades a full-resolution value field rather than a handful of surviving
    quantized levels. restyle_props.py had to work the other way round (no raws
    existed) and paid for it with a `palette_n` regression; these have raws.
    """
    src = GEN / spec["tag"] / name / f"seed{spec['seed']:05d}.png"
    if not src.exists():
        raise SystemExit(f"missing raw: {src}")
    im = Image.open(src)

    if not P.has_alpha(im):
        bg_lum = float(P.corner_bg(im) @ [0.299, 0.587, 0.114])
        im = P.flat_key(im) if bg_lum > 128 else P.black_key(im)
    im, _ = P.strip_ground_shadow(im)
    im = P.bbox_crop(im)

    im = ramp_grade(im, spec["ramp"], spec.get("accent"),
                    spec.get("accent_q", 0.98), spec.get("equalize", 0.85))

    w, h = im.size
    if w >= h:
        tw, th = content, max(1, round(content * h / w))
    else:
        tw, th = max(1, round(content * w / h)), content
    im = P.to_palette(P.kcentroid(im, tw, th))

    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(im, ((px - tw) // 2, max(0, px - th - 1)))
    return ink_rim(out) if ink else out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", action="append")
    args = ap.parse_args()

    names = args.only or list(CURATED)
    root = ROOT / "public" / "themes" / "swampspace" / "chars"
    b = band({n: measure(root / f"{n}.png") for n in CAST})
    tmp = ROOT / ".install-props-tmp.png"

    for theme, px, content, ink in TARGETS:
        outdir = ROOT / "public" / "themes" / theme / "props"
        print(f"\n{'(dry) ' if args.dry_run else ''}{theme}")
        print(f"  {'sprite':<20}{'sat_frac':>10}{'chroma_p90':>12}{'value_range':>13}{'palette_n':>11}   vs cast floor")
        for name in names:
            spec = CURATED[name]
            im = build(name, spec, px, content, ink)
            im.save(tmp)
            m = measure(tmp)
            flags = [k for k in ("sat_frac", "chroma_p90", "value_range", "palette_n")
                     if m[k] < b[k]["min"]]
            print(f"  {spec['dst']:<20}{m['sat_frac']:>10.3f}{m['chroma_p90']:>12.0f}"
                  f"{m['value_range']:>13.3f}{m['palette_n']:>11d}   "
                  + (("UNDER: " + ", ".join(flags)) if flags else "all clear"))
            if not args.dry_run:
                im.save(outdir / spec["dst"])
        print(f"  cast floors: sat {b['sat_frac']['min']:.3f}  chroma {b['chroma_p90']['min']:.0f}"
              f"  value {b['value_range']['min']:.3f}  palette_n {b['palette_n']['min']}")

    tmp.unlink(missing_ok=True)
    if not args.dry_run:
        # Keep the chosen raws next to the other curated sources so a future
        # restyle pass has a full-resolution input instead of a shipped PNG.
        raws = Path(__file__).resolve().parent / "raws"
        for name in names:
            spec = CURATED[name]
            src = GEN / spec["tag"] / name / f"seed{spec['seed']:05d}.png"
            shutil.copy2(src, raws / f"prop.{Path(spec['dst']).stem}.png")
        print(f"\n  archived {len(names)} raws into scripts/assets/raws/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
