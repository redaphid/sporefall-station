#!/usr/bin/env python3
"""Measure how a sprite reads AT GAME SCALE, so "does it match the cast?" stops
being an eyeball question.

Six creature sprites shipped looking grey and soft next to the existing cast and
nobody could say by how much, because the only gate was someone squinting at a
1024px render. Everything here is therefore computed on the 48px PNG the player
actually sees, over OPAQUE pixels only (transparent padding would drag every
average toward zero and make a small sprite look darker than a big one).

The four numbers, and why each one is here:

  chroma_mean   How colourful. Mean of (max(RGB)-min(RGB))/255. Deliberately not
                HSV saturation: S is chroma divided by value, so a near-black
                pixel with a two-step tint scores as "saturated". Chroma stays
                honest about the difference between olive-green and grey.
  grey_frac     Fraction of the sprite that is literally colourless
                (chroma < 12/255, ~1 palette step). The headline number: this is
                the thing the owner saw. A mean can be dragged up by one hot
                accent pixel while 80% of the body stays grey; this cannot.
  rim_dark_frac Bold dark outlines. Of the pixels on the alpha boundary (opaque,
                8-adjacent to transparent), the fraction whose luma <= 48 — i.e.
                sitting on the palette's outline darks. Measures the cast's
                inked-edge look directly, rather than inferring it from overall
                contrast.
  value_range   p95-p5 of luma. Separates a flat mid-grey mass from a form with
                lit tops and shadowed underside. Percentiles not min/max so a
                single stray pixel cannot fake a full range.

`coverage` (opaque fraction of the canvas) is reported but is NOT a style
metric -- it is a readability floor. A sprite can hit every colour target by
becoming smaller and denser, so coverage is tracked to prove it did not.

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

# A pixel below this chroma is colourless to the eye at 48px (~one palette step).
GREY_CHROMA = 12.0
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
        return {"coverage": 0.0, "chroma_mean": 0.0, "grey_frac": 1.0,
                "rim_dark_frac": 0.0, "value_range": 0.0, "opaque_px": 0}

    px = rgb[opaque]                                  # (n,3)
    chroma = px.max(1) - px.min(1)                    # 0..255
    luma_all = rgb @ _LUMA_W
    luma = luma_all[opaque]

    rim = _rim_mask(opaque)
    rim_luma = luma_all[rim]
    rim_dark_frac = float((rim_luma <= OUTLINE_LUMA).mean()) if rim.sum() else 0.0

    return {
        "chroma_mean": float(chroma.mean() / 255.0),
        "grey_frac": float((chroma < GREY_CHROMA).mean()),
        "rim_dark_frac": rim_dark_frac,
        "value_range": float((np.percentile(luma, 95) - np.percentile(luma, 5)) / 255.0),
        "coverage": float(n / opaque.size),
        "opaque_px": n,
    }


# Direction each metric must move to look MORE like the cast. Used to build a
# one-sided band: a sprite that is *more* colourful than the least colourful cast
# member is fine, so only the weak side is a failure.
HIGHER_IS_CAST = {"chroma_mean": True, "grey_frac": False,
                  "rim_dark_frac": True, "value_range": True}
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
    """Which style metrics fall outside the cast band, on the weak side only."""
    bad = []
    for m, higher in HIGHER_IS_CAST.items():
        lo, hi = b[m]["min"], b[m]["max"]
        if higher and row[m] < lo:
            bad.append(f"{m} {row[m]:.3f} < cast min {lo:.3f}")
        elif not higher and row[m] > hi:
            bad.append(f"{m} {row[m]:.3f} > cast max {hi:.3f}")
    return bad


_COLS = [("chroma_mean", "chroma"), ("grey_frac", "grey%"),
         ("rim_dark_frac", "rim-dark"), ("value_range", "val-rng"),
         ("coverage", "cover")]


def _print_table(title: str, rows: dict[str, dict], b: dict | None = None) -> int:
    print(f"\n{title}")
    print(f"  {'sprite':<24}" + "".join(f"{lbl:>10}" for _, lbl in _COLS)
          + ("   verdict" if b else ""))
    nbad = 0
    for name, r in rows.items():
        line = f"  {name:<24}" + "".join(f"{r[k]:>10.3f}" for k, _ in _COLS)
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
          + "".join(f"{b[k]['min']:>4.2f}..{b[k]['max']:<4.2f}" for k, _ in _COLS))
    nbad = _print_table(f"\nTHE SIX — {args.theme} @48px", new, b)

    print(f"\n  {nbad}/{len(new)} outside the cast band")

    if args.json:
        args.json.write_text(json.dumps(
            {"theme": args.theme, "cast": cast, "new": new, "band": b}, indent=2))
        print(f"  wrote {args.json}")

    return 1 if (args.check and nbad) else 0


if __name__ == "__main__":
    sys.exit(main())
