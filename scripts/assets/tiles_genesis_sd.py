#!/usr/bin/env python3
"""Genesis-upgrade tiles, stage 2: ComfyUI img2img repaint of the banded bases.

For each surface unit (a 2x2 macro supertile or a 2x2 mosaic of variants):
  banded base (tiles_genesis.py) -> x8 nearest to 1024 -> img2img sweep
  (SDXL + skormino pixel LoRA, seamless model patch, N seeds) -> k-centroid
  back to author res -> Bayer-dither palette snap -> band re-enforcement
  (enforce_band: diffusion may not drift the value plan) -> score & pick ->
  slice row-major into the shipped tile files.

Every seed's post-processed unit is kept in the stage dir with a contact
sheet per surface, so a human (or VLM) can re-pick; the auto-pick maximizes
in-band fit + detail energy. Gate afterwards with contrast_audit.py.

Usage:
  SWAMPSPACE_STAGE=/tmp/swampspace-stage python3 tiles_genesis_sd.py \
      [--seeds 3] [--out ../../public/themes/swampspace-hires/tiles] [surface...]
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

STAGE = Path(os.environ.get("SWAMPSPACE_STAGE", "/tmp/swampspace-stage")) / "genesis-tiles"
T = int(os.environ.get("TILE_T", "64"))

PIX = "masterpiece, pixpix, 8-bit, pixel_art"
GEN = ("sega genesis 16-bit game art, bold flat color areas, ordered dither "
       "shading, crisp chunky pixel clusters, high value contrast")
NEG = ("photo, photorealistic, blurry, smooth gradients, 3d render, text, "
       "watermark, frame, border, vignette, object, creature, character, "
       "figure, face, low contrast, murky, washed out")

# surface -> (unit kind, unit count, prompt, denoise, seamless)
# Prompts name the VALUE of the surface explicitly — the value plan is the
# whole point (docs/genesis-upgrade.md) — and the band is re-enforced after.
UNITS = {
    "floor": ("macro", 2,
              f"{PIX}, top-down warm tan sci-fi deck floor tile, light caramel "
              f"metal plates with dark seams and rivets, small moss tufts in "
              f"the seams, bright readable interior floor, {GEN}, seamless "
              f"game texture, flat top-down view", 0.42, True),
    "street": ("macro", 3,
               f"{PIX}, top-down dark asphalt street tile, near-black cracked "
               f"tarmac with faint cool gray wear patches, thin moss veins in "
               f"the cracks, dark ground texture, {GEN}, seamless game "
               f"texture, flat top-down view", 0.42, True),
    "grass": ("macro", 2,
              f"{PIX}, top-down swamp moss ground, chunky clumps of "
              f"olive and bright green bog grass tufts, big irregular dark "
              f"peat hollows, a few glowing spore dots, no repeating pattern, "
              f"{GEN}, seamless game texture, flat top-down view", 0.5, True),
    "sidewalk": ("mosaic", 1,
                 f"{PIX}, top-down light gray metal walkway tile, pale bright "
                 f"riveted plates with dark expansion joints, tiny moss "
                 f"flecks in the joints, large flat plates, {GEN}, "
                 f"seamless game texture, flat top-down view", 0.32, True),
    "wall": ("mosaic", 1,
             f"{PIX}, top-down game wall tile, near-black root-woven metal "
             f"bulkhead with a pale lit steel cap strip along the top edge of "
             f"each tile, thick dark roots over dark panels, {GEN}, "
             f"straight-on view", 0.35, False),
    "exit": ("single", 1,
             f"{PIX}, top-down glowing green launch pad game tile, a bright "
             f"bioluminescent ring pad on dark teal metal, radiant green "
             f"light, {GEN}, flat top-down view", 0.35, False),
}

ACCENTS = {  # name -> (count, base fn, prompt hint, denoise)
    "street-accent": (3, G.street_accent, "dark asphalt with a detail feature "
                      "(manhole cover / glowing spore patch / tar patch)", 0.4),
    "floor-accent": (2, G.floor_accent, "warm tan deck floor with a detail "
                     "feature (dark vent grate / glowing fungus cluster)", 0.4),
    "grass-accent": (3, G.grass_accent, "swamp moss ground with a detail "
                     "feature (root cluster / glowing flowers / teal pool)", 0.45),
}

# Which band each accent must sit near (accents may pop a little hotter).
ACCENT_BAND = {"street-accent": "street", "floor-accent": "floor", "grass-accent": "grass"}


def base_unit(surface, unit_idx):
    """The structural init image for one unit, author-res (2T for macro/mosaic)."""
    kind = UNITS[surface][0]
    if kind == "macro":
        fn = {"floor": G.floor_macro, "street": G.street_macro, "grass": G.bog_macro}[surface]
        return G.snap(fn(T, unit_idx)), 2 * T
    if kind == "single":
        return G.snap(G.exit_tile(T)), T
    # mosaic: 2x2 of consecutive variants
    gen = {"grass": G.bog_tile, "sidewalk": G.sidewalk_tile, "wall": G.wall_tile}[surface]
    counts = {"grass": 8, "sidewalk": 4, "wall": 3}[surface]
    out = np.zeros((2 * T, 2 * T, 3), np.uint8)
    for q in range(4):
        v = (unit_idx * 4 + q) % counts
        y, x = divmod(q, 2)
        out[y * T:(y + 1) * T, x * T:(x + 1) * T] = G.snap(gen(T, v))
    return out, 2 * T


def detail_energy(img):
    a = np.asarray(img, np.float32)
    return float(np.abs(np.diff(a, axis=0)).mean() + np.abs(np.diff(a, axis=1)).mean())


def score(img, surface):
    """In-band fit first, then reward crisp detail."""
    t = G.BAND[surface]
    m = G.lum(img)
    band_err = abs(m - t) / (t + 12.75)
    return -band_err * 100 + min(detail_energy(img), 40)


def repaint(surface, unit_idx, seeds, outdir):
    kind, n_units, pos, denoise, seamless = UNITS[surface]
    base, res = base_unit(surface, unit_idx)
    udir = STAGE / surface
    udir.mkdir(parents=True, exist_ok=True)
    init_path = udir / f"init-{unit_idx}.png"
    Image.fromarray(base, "RGB").resize((1024, 1024), Image.NEAREST).save(init_path)

    candidates = []
    for s in range(seeds):
        seed = 606000 + unit_idx * 97 + s * 1009
        graph = build_graph(pos=pos, neg=NEG, seed=seed, init=str(init_path),
                            denoise=denoise, seamless=seamless, alpha=False,
                            prefix=f"genesis-{surface}-{unit_idx}")
        raw = run(graph, str(udir / "raw"))
        im = Image.open(raw[-1]).convert("RGB")
        small = kcentroid(im, res, res).convert("RGB")
        clean = G.despeckle(small, passes=4 if surface in G.FLAT else 2)
        banded = G.enforce_band(np.asarray(clean, np.float32), surface)
        cand_path = udir / f"unit-{unit_idx}-seed{s}.png"
        Image.fromarray(banded, "RGB").save(cand_path)
        candidates.append((score(banded, surface), s, banded))
        print(f"  {surface}[{unit_idx}] seed{s}: lum={G.lum(banded):.1f} "
              f"(target {G.BAND[surface]:.0f}) score={candidates[-1][0]:.1f}")

    candidates.sort(key=lambda c: -c[0])
    _, best_s, best = candidates[0]
    print(f"  {surface}[{unit_idx}] -> seed{best_s}")

    # slice row-major into shipped tile files
    counts = {"floor": 8, "street": 12, "grass": 8, "sidewalk": 4, "wall": 3, "exit": 1}
    if kind == "single":
        Image.fromarray(best, "RGB").save(outdir / f"{surface}-0.png")
        return
    for q in range(4):
        v = unit_idx * 4 + q
        if v >= counts[surface]:
            break
        y, x = divmod(q, 2)
        Image.fromarray(best[y * T:(y + 1) * T, x * T:(x + 1) * T], "RGB").save(
            outdir / f"{surface}-{v}.png")


def repaint_accent(name, v, seeds, outdir):
    count, fn, hint, denoise = ACCENTS[name]
    surface = ACCENT_BAND[name]
    udir = STAGE / name
    udir.mkdir(parents=True, exist_ok=True)
    base = G.snap(fn(T, v))
    init_path = udir / f"init-{v}.png"
    Image.fromarray(base, "RGB").resize((1024, 1024), Image.NEAREST).save(init_path)
    pos = f"{PIX}, top-down game tile, {hint}, {GEN}, flat top-down view"
    best, best_score = None, -1e9
    for s in range(seeds):
        seed = 707000 + v * 131 + s * 1013
        graph = build_graph(pos=pos, neg=NEG, seed=seed, init=str(init_path),
                            denoise=denoise, seamless=False, alpha=False,
                            prefix=f"genesis-{name}-{v}")
        raw = run(graph, str(udir / "raw"))
        im = Image.open(raw[-1]).convert("RGB")
        small = kcentroid(im, T, T).convert("RGB")
        clean = G.despeckle(small, passes=2)
        banded = G.enforce_band(np.asarray(clean, np.float32), surface, tol=0.2)
        Image.fromarray(banded, "RGB").save(udir / f"acc-{v}-seed{s}.png")
        sc = score(banded, surface)
        if sc > best_score:
            best, best_score = banded, sc
    Image.fromarray(best, "RGB").save(outdir / f"{name}-{v}.png")
    print(f"  {name}-{v}: lum={G.lum(best):.1f}")


def contact_sheet(surface):
    udir = STAGE / surface
    files = sorted(udir.glob("unit-*-seed*.png")) or sorted(udir.glob("acc-*-seed*.png"))
    if not files:
        return
    ims = [Image.open(f) for f in files]
    w, h = ims[0].size
    cols = min(4, len(ims))
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + 4), rows * (h + 4)), (16, 16, 20))
    for i, im in enumerate(ims):
        sheet.paste(im, ((i % cols) * (w + 4) + 2, (i // cols) * (h + 4) + 2))
    sheet.save(udir / "contact-sheet.png")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    seeds = 3
    outdir = Path("../../public/themes/swampspace-hires/tiles")
    for a in sys.argv[1:]:
        if a.startswith("--seeds"):
            seeds = int(a.split("=")[1])
        if a.startswith("--out"):
            outdir = Path(a.split("=", 1)[1])
    outdir.mkdir(parents=True, exist_ok=True)
    surfaces = args or list(UNITS) + list(ACCENTS)

    for surface in surfaces:
        if surface in UNITS:
            print(f"[{surface}]")
            for u in range(UNITS[surface][1]):
                repaint(surface, u, seeds, outdir)
            contact_sheet(surface)
        elif surface in ACCENTS:
            print(f"[{surface}]")
            for v in range(ACCENTS[surface][0]):
                repaint_accent(surface, v, seeds, outdir)
            contact_sheet(surface)
    # overlays ship procedurally (alpha decals)
    if not args or "overlays" in args:
        for v in range(4):
            Image.fromarray(G.floor_overlay(T, v), "RGBA").save(outdir / f"floor-overlay-{v}.png")
        print("[overlays] procedural RGBA decals written")


if __name__ == "__main__":
    main()
