#!/usr/bin/env python3
"""Measure how a sprite reads AT GAME SCALE, so "does it match the cast?" stops
being an eyeball question.

Six creature sprites shipped looking grey and soft next to the existing cast and
nobody could say by how much, because the only gate was someone squinting at a
1024px render. Everything here is therefore computed on the 48px PNG the player
actually sees, over OPAQUE pixels only (transparent padding would drag every
average toward zero and make a small sprite look darker than a big one).

A METRIC THAT WAS TRIED AND REJECTED, because it is the obvious one and the
next person will reach for it too: `grey_frac`, the fraction of literally
colourless pixels (chroma < 12/255). The six sprites everyone agreed looked grey
scored 0.00 on it, and the cast scored up to 0.53. The cast contains far MORE
pure grey than the six do -- it is full of deliberate near-black outline and
station-metal plating. What makes the cast read as colourful is not the absence
of grey but the presence, next to that grey, of genuinely saturated pixels. The
six had neither: no true grey, no true colour, just a uniform weak tint. So
"how much of this is grey" is the wrong question and "how much of this is
COLOURED" is the right one.

The metrics, and why each is here:

  sat_frac      THE HEADLINE. Fraction of pixels with chroma > 60/255 -- i.e.
                genuinely coloured rather than a tinted neutral. Separates the
                two groups with no overlap at all: cast 0.12-0.57, the six
                0.02-0.10.
  chroma_p90    How colourful the coloured part is. 90th percentile of chroma,
                so a body of neutrals cannot hide behind a few hot pixels, and a
                few hot pixels cannot rescue a body of neutrals. The cleanest
                single number available: cast 70-87 vs the six 20-22, a 3x gap.
  rim_dark_frac Bold dark outlines. Of the pixels on the alpha boundary (opaque,
                8-adjacent to transparent), the fraction with luma <= 48 -- the
                palette's outline darks. Measures the cast's inked-edge look
                directly instead of inferring it from overall contrast.
  value_range   p95-p5 of luma. Separates a flat mid-toned mass from a form with
                a lit top and a shadowed underside. Percentiles not min/max so
                one stray pixel cannot fake a full range.
  palette_n     Distinct palette entries used. A blunt richness check: the six
                shipped using 5-9 of the 33 available, the cast uses 9-22.

Chroma throughout is max(RGB)-min(RGB), deliberately NOT HSV saturation. S is
chroma divided by value, so a near-black pixel with a two-step tint scores as
fully "saturated" -- which is exactly the failure mode being measured. Chroma
stays honest about the difference between olive-green and dark grey.

`coverage` (opaque fraction of the canvas) is reported but NOT gated -- it is a
readability floor, not a style target. A sprite could hit every colour number by
shrinking, so coverage is tracked to prove it did not.

One caveat on the band, stated rather than hidden: the floor for
`rim_dark_frac` is 0.000 because spore-drone is a wispy translucent thing with
no inked edge at all. That metric therefore cannot fail anything. It is reported
because it is informative, not because it gates.

The target band is the existing cast, not a designer's guess. `--check` fails a
sprite that sits outside it. Usage:

    python palette_metrics.py                 # table: cast band + the six
    python palette_metrics.py --check         # exit 1 if any of the six is out
    python palette_metrics.py --json out.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

THEMES = Path(__file__).resolve().parents[2] / "public" / "themes"

# The cast that shipped first and that the owner reads as correct. These define
# the band; they are not measured against it.
CAST = [
    "vine-ranger-s-idle",
    "spore-drone-s-idle",
    "bog-mutant-s-idle",
    "mycologist-s-idle",
    "frog-settler-s-idle",
    "derelict-bot-s-idle",
]

# The six under test.
NEW = [
    "carapace-brute-s-idle",
    "cinder-husk-s-idle",
    "sporeling-mite-s-idle",
    "mireclaw-stalker-s-idle",
    "gloom-lurker-s-idle",
    "brood-sac-s-idle",
]

# Above this chroma a pixel reads as a colour rather than a tinted neutral. Set
# from the palette itself: its neutrals (the darks and the station-metal ramp)
# top out at chroma 22, and its lowest-chroma genuine colour is 30. 60 sits
# clear of the neutrals with margin.
SAT_CHROMA = 60.0
# Luma at or below this is an outline dark. The palette's darks are 8..28 luma;
# the darkest station metal is ~39. 48 admits an inked edge, excludes body grey.
OUTLINE_LUMA = 48.0
# Rec.601 luma. Matches how the eye weights the palette's greens.
_LUMA_W = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def _load_opaque(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (RGB float array HxWx3, opaque bool mask HxW)."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im, dtype=np.float32)
    return a[..., :3], a[..., 3] > 128


def _rim_mask(opaque: np.ndarray) -> np.ndarray:
    """Opaque pixels with at least one transparent 8-neighbour.

    Padding with False (transparent) is intentional: a sprite touching the canvas
    edge still has an outline there and should be judged on it.
    """
    p = np.pad(opaque, 1, mode="constant", constant_values=False)
    neighbours_all_opaque = np.ones_like(opaque, dtype=bool)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            if dy == 1 and dx == 1:
                continue
            neighbours_all_opaque &= p[dy:dy + opaque.shape[0], dx:dx + opaque.shape[1]]
    return opaque & ~neighbours_all_opaque


def measure(path: Path) -> dict:
    rgb, opaque = _load_opaque(path)
    n = int(opaque.sum())
    if n == 0:
        return {"sat_frac": 0.0, "chroma_p90": 0.0, "rim_dark_frac": 0.0,
                "value_range": 0.0, "palette_n": 0, "coverage": 0.0, "opaque_px": 0}

    px = rgb[opaque]                                  # (n,3)
    chroma = px.max(1) - px.min(1)                    # 0..255
    luma_all = rgb @ _LUMA_W
    luma = luma_all[opaque]

    rim = _rim_mask(opaque)
    rim_luma = luma_all[rim]
    rim_dark_frac = float((rim_luma <= OUTLINE_LUMA).mean()) if rim.sum() else 0.0

    return {
        "sat_frac": float((chroma > SAT_CHROMA).mean()),
        "chroma_p90": float(np.percentile(chroma, 90)),
        "rim_dark_frac": rim_dark_frac,
        "value_range": float((np.percentile(luma, 95) - np.percentile(luma, 5)) / 255.0),
        "palette_n": len({tuple(p) for p in px.astype(int).tolist()}),
        "coverage": float(n / opaque.size),
        "opaque_px": n,
    }


# Every style metric here is "more is more like the cast", so the band is
# one-sided: a sprite that is MORE colourful than the least colourful cast
# member is not a problem, and only falling under the cast's floor is.
HIGHER_IS_CAST = {"sat_frac": True, "chroma_p90": True,
                  "rim_dark_frac": True, "value_range": True, "palette_n": True}
STYLE_METRICS = list(HIGHER_IS_CAST)


def band(rows: dict[str, dict]) -> dict[str, dict]:
    """Cast band per metric: min/max/mean across the cast."""
    out = {}
    for m in STYLE_METRICS + ["coverage"]:
        vals = [r[m] for r in rows.values()]
        out[m] = {"min": min(vals), "max": max(vals),
                  "mean": float(np.mean(vals))}
    return out


def failures(row: dict, b: dict[str, dict]) -> list[str]:
    """Which style metrics fall under the cast band's floor."""
    bad = []
    for m in HIGHER_IS_CAST:
        lo = b[m]["min"]
        if row[m] < lo:
            bad.append(f"{m} {row[m]:.3f} < cast floor {lo:.3f}")
    return bad


_COLS = [("sat_frac", "sat-frac"), ("chroma_p90", "chr-p90"),
         ("rim_dark_frac", "rim-dark"), ("value_range", "val-rng"),
         ("palette_n", "pal-n"), ("coverage", "cover")]


def _print_table(title: str, rows: dict[str, dict], b: dict | None = None) -> int:
    print(f"\n{title}")
    print(f"  {'sprite':<24}" + "".join(f"{lbl:>10}" for _, lbl in _COLS)
          + ("   verdict" if b else ""))
    nbad = 0
    for name, r in rows.items():
        line = f"  {name:<24}" + "".join(
            f"{r[k]:>10d}" if k == "palette_n" else f"{r[k]:>10.3f}" for k, _ in _COLS)
        if b is not None:
            bad = failures(r, b)
            nbad += bool(bad)
            line += "   FAIL" if bad else "   ok"
        print(line)
        if b is not None:
            for f in failures(r, b):
                print(f"      - {f}")
    return nbad


def run(theme: str = "swampspace") -> tuple[dict, dict, dict]:
    root = THEMES / theme / "chars"
    cast = {n: measure(root / f"{n}.png") for n in CAST}
    new = {n: measure(root / f"{n}.png") for n in NEW}
    return cast, new, band(cast)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="swampspace")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if any of the six is outside the cast band")
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    cast, new, b = run(args.theme)

    _print_table(f"CAST (defines the band) — {args.theme} @48px", cast)
    print(f"\n  {'BAND min..max':<24}"
          + "".join(f"{b[k]['min']:>5.2f}..{b[k]['max']:<5.2f}" for k, _ in _COLS))
    nbad = _print_table(f"\nTHE SIX — {args.theme} @48px", new, b)

    print(f"\n  {nbad}/{len(new)} outside the cast band")

    if args.json:
        args.json.write_text(json.dumps(
            {"theme": args.theme, "cast": cast, "new": new, "band": b}, indent=2))
        print(f"  wrote {args.json}")

    return 1 if (args.check and nbad) else 0


if __name__ == "__main__":
    sys.exit(main())
