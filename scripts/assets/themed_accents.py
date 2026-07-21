#!/usr/bin/env python3
"""Themed grass ACCENT tiles: rare feature tiles (~6% via TILE_ACCENT_EVERY) that
sit ON the dark bog base so their EDGES blend but their CENTER carries a bright
feature — glowing spore pods, amber embers, a deep peat pool. Init = a real
shipped dark grass tile with a procedural feature blob painted in the middle, so
img2img keeps the bog border and elaborates the feature. Reserves brightness for
these (per tile-theming research: features are rare, not on every base tile).

Usage: SWAMPSPACE_STAGE=/tmp/swampspace-stage python3 themed_accents.py [n_each]
"""
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comfy import build_graph, run  # noqa: E402
from post import kcentroid  # noqa: E402
import tiles_genesis as G  # noqa: E402

STAGE = Path(os.environ.get("SWAMPSPACE_STAGE", "/tmp/swampspace-stage")) / "grass-accents"
TILES = Path("../../public/themes/swampspace-hires/tiles")
T = 64
GEN = ("hand-crafted 16-bit pixel art game tile, sega genesis, careful pixel "
       "shading, crisp defined shapes")
NEG = ("photo, photorealistic, blurry, 3d render, isometric, perspective, text, "
       "watermark, frame, border, object, creature, character, figure, face")

# accent -> (feature prompt, center blob colors [dim->bright], denoise)
FEATURES = {
    0: ("a cluster of glowing bioluminescent green spore pods nestled in dark "
        "swamp moss, soft green glow", ["#22380f", "#35511a", "#46e078", "#a6ffbe"], 0.55),
    1: ("dim glowing amber embers and orange fungus glowing faintly in dark "
        "swamp peat", ["#2e1e10", "#6b4d26", "#ff9032", "#ffd83e"], 0.55),
    2: ("a deep pool of black swamp water with faint teal reflections amid dark "
        "moss and roots", ["#141a16", "#163a3e", "#24565c", "#3a7a80"], 0.5),
}


def feature_init(v, colors):
    """A real dark bog tile with a soft radial feature blob painted in the
    center — border stays bog, center seeds the feature."""
    src = sorted(TILES.glob("grass-[0-9]*.png"))[v * 5 % 32]
    img = np.asarray(Image.open(src).convert("RGB"), np.float32)
    cx = cy = T / 2 - 0.5
    yy, xx = np.mgrid[0:T, 0:T]
    r = np.hypot(yy - cy, xx - cx) + G.tnoise(T, np.random.default_rng(300 + v), T / 6) * 6
    cols = [G.hexc(c) for c in colors]
    img[r < T * 0.32] = cols[1]
    img[r < T * 0.22] = cols[2]
    img[r < T * 0.12] = cols[-1]
    # ring of the darkest color to seat it
    img[(r >= T * 0.32) & (r < T * 0.37)] = cols[0]
    return G.snap(img.astype(np.float32), dither=0.0)


def main():
    STAGE.mkdir(parents=True, exist_ok=True)
    seeds = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    for v, (feat, colors, denoise) in FEATURES.items():
        base = feature_init(v, colors)
        ip = STAGE / f"init-{v}.png"
        Image.fromarray(base, "RGB").resize((1024, 1024), Image.NEAREST).save(ip)
        pos = (f"top-down dark alien swamp bog tile, {feat}, dark moody "
               f"overgrown, {GEN}, seamless tileable, flat top-down orthographic view")
        best, best_lum_ok = None, -1
        for s in range(seeds):
            g = build_graph(pos=pos, neg=NEG, seed=5300 + v * 211 + s * 907,
                            init=str(ip), denoise=denoise, seamless=False,
                            alpha=False, prefix=f"gacc-{v}-{s}")
            raw = run(g, str(STAGE / "raw"))
            small = kcentroid(Image.open(raw[-1]).convert("RGB"), T, T).convert("RGB")
            clean = G.despeckle(small, passes=2)
            out = G.snap(np.asarray(clean, np.float32), dither=0.0)
            Image.fromarray(out, "RGB").save(STAGE / f"acc-{v}-seed{s}.png")
            # prefer a candidate that stays mostly dark (feature is local, not the
            # whole tile) but has a bright peak
            a = np.asarray(out, float)
            lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
            ok = (lum.mean() < 75) and (lum.max() > 150)
            if best is None or (ok and best_lum_ok < 1):
                best, best_lum_ok = out, 1 if ok else 0
        Image.fromarray(best, "RGB").save(TILES / f"grass-accent-{v}.png")
        print(f"  grass-accent-{v}: lum={G.lum(best):.1f}")


if __name__ == "__main__":
    main()
