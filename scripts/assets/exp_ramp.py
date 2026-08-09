#!/usr/bin/env python3
"""Try candidate colour ramps for a sprite raw and measure them (art-loop).

Fixing cinder-husk's silhouette turned its colour into a blocker: the shipped
cinder ramp is the carapace-brute's tan ramp with one entry removed, which was
survivable while cinder was a humanoid and is not now that it is also a
quadruped. This renders a raw through several candidate ramps at 48px and 96px
and prints the same metrics `palette_metrics.py` gates on, so a ramp can be
chosen against the cast band rather than by eye alone — then looked at, because
the band is one-sided and a neon centipede passed it once (art-colour.md).

  python3 exp_ramp.py <raw.png> --out D:/tmp/art-loop/ramps.png
"""
import argparse
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BG = (24, 26, 30, 255)

# Ramps must be monotonic in luma and hue-coherent (or turn hue exactly once,
# monotonically): art-colour.md measured that zigzagging hues down a ramp
# MANUFACTURES grey and scored worse than the un-graded original. Ramp LENGTH
# also caps palette_n, and the cast band wants >= 9, so these run 9 entries.
CANDIDATES = {
    # what ships today -- the brute's tan ramp. Included as the baseline.
    "shipped-tan": dict(
        ramp=["#08080c", "#1c1420", "#2e1e10", "#4a3419", "#6b4d26",
              "#8f6c38", "#b08d50", "#cbb277"],
        accent="#ff9032", accent_q=0.93, equalize=0.45),
    # charcoal body climbing into fire. One hue turn (neutral dark -> warm),
    # monotonic luma: 8,21,23,33,55,79,103,161,213.
    "ember": dict(
        ramp=["#08080c", "#141a16", "#1c1420", "#2e1e10", "#4a3419",
              "#6b4d26", "#e04a2a", "#ff9032", "#ffd83e"],
        accent="#ffd83e", accent_q=0.95, equalize=0.35),
    # darker still: hold the body in the near-blacks longer so the creature
    # reads as charcoal with hot cracks rather than as a brown animal.
    "ember-dark": dict(
        ramp=["#08080c", "#08080c", "#141a16", "#1c1420", "#2e1e10",
              "#4a3419", "#e04a2a", "#ff9032", "#ffd83e"],
        accent="#ffd83e", accent_q=0.96, equalize=0.30),
    # same idea but reaching red sooner, so more of the body is ember-lit.
    "ember-hot": dict(
        ramp=["#08080c", "#141a16", "#1c1420", "#2e1e10", "#e04a2a",
              "#ff9032", "#ff9032", "#ffd83e", "#f2f6ea"],
        accent="#ffd83e", accent_q=0.94, equalize=0.45),
}


def build_with(raw, spec, px, content, ink):
    import post as P
    import restyle as R
    src = Image.open(raw)
    if not P.has_alpha(src):
        import numpy as np
        bg_lum = float(P.corner_bg(src) @ np.array([0.299, 0.587, 0.114]))
        src = P.flat_key(src) if bg_lum > 128 else P.black_key(src)
    src, _ = P.strip_ground_shadow(src)
    im = P.bbox_crop(src)
    im = R.denoise(im, content)
    im = R.ramp_grade(im, spec["ramp"], spec.get("accent"),
                      spec.get("accent_q", 0.94), spec.get("equalize", 0.85))
    w, h = im.size
    if w >= h:
        tw, th = content, max(1, round(content * h / w))
    else:
        tw, th = max(1, round(content * w / h)), content
    im = P.to_palette(P.kcentroid(im, tw, th))
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(im, ((px - tw) // 2, max(0, px - th - 1)))
    return R.ink_rim(out) if ink else out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raw")
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=int, default=4)
    a = ap.parse_args()

    import palette_metrics as PM
    from pathlib import Path

    S = a.scale
    cell96, cell48 = 96 * S, 48 * S
    lab = 130
    rows = list(CANDIDATES)
    W = lab + cell96 + 12 + cell48 + 12
    H = len(rows) * (cell96 + 10)
    sheet = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(sheet)

    print(f"{'ramp':<14}{'sat_frac':>9}{'chroma_p90':>12}{'value_rng':>11}"
          f"{'palette_n':>11}{'coverage':>10}")
    print("  cast band: sat .118-.573  chroma_p90 70-87  value_range .487-.636  "
          "palette_n 9-43")
    for r, name in enumerate(rows):
        spec = CANDIDATES[name]
        big = build_with(a.raw, spec, 96, 92, True)
        small = build_with(a.raw, spec, 48, 46, False)
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as t:
            small.save(t.name)
            m = PM.measure(Path(t.name))
        os.unlink(t.name)
        print(f"{name:<14}{m['sat_frac']:>9.3f}{m['chroma_p90']:>12.1f}"
              f"{m['value_range']:>11.3f}{m['palette_n']:>11d}{m['coverage']:>10.3f}")
        y = r * (cell96 + 10)
        d.text((6, y + cell96 // 2), name, fill=(225, 225, 225, 255))
        b = big.resize((cell96, cell96), Image.NEAREST)
        sheet.paste(b, (lab, y), b)
        s = small.resize((cell48, cell48), Image.NEAREST)
        sheet.paste(s, (lab + cell96 + 12, y + cell96 - cell48), s)
    sheet.save(a.out)
    print(f"\n{a.out} {sheet.size}")


if __name__ == "__main__":
    main()
