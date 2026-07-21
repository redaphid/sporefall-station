#!/usr/bin/env python3
"""Genesis-upgrade tiles, stage 2: ComfyUI img2img repaint of the banded bases.

For each surface unit (a 2x2 macro supertile or a 2x2 mosaic of variants):
  banded base (tiles_genesis.py) -> x8 nearest to 1024 -> img2img sweep
  (Juggernaut Ragnarok + Pixel Art XL LoRA @ 0.7, circular seamless, N seeds) ->
  circular k-centroid -> palette snap + despeckle -> band re-enforcement
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
import comfy  # noqa: E402
from comfy import build_graph, run  # noqa: E402
from post import kcentroid  # noqa: E402
import tiles_genesis as G  # noqa: E402

# TILE RECIPE: Juggernaut Ragnarok + Pixel Art XL LoRA @ 0.7 — painterly Juggernaut
# alone downscales to noisy noodles; Pixel Art XL (NeriJS standard, NOT skormino)
# resolves detail into crafted, chunky pixel clusters. See themed_ground.py.
comfy.LORA = os.environ.get("LORA", "XL/pixel-art-xl.safetensors")
comfy.LORA_W = float(os.environ.get("LORA_W", "0.7"))


def seamless_kcentroid(im, res):
    """Downscale so the result WRAPS: tile the source 3x3, k-centroid the whole
    thing, crop the center. Every edge pixel of the crop is averaged from a
    continuous neighborhood that includes the opposite side, so left==right and
    top==bottom by construction. Fixes the repeat-seam that independent-edge
    downscaling (plain kcentroid) leaves behind — the tile-continuity the field
    needs to assemble without visible seams."""
    a = np.asarray(im.convert("RGB"))
    tiled = np.tile(a, (3, 3, 1))
    big = kcentroid(Image.fromarray(tiled, "RGB"), 3 * res, 3 * res).convert("RGB")
    b = np.asarray(big)
    return Image.fromarray(b[res:2 * res, res:2 * res], "RGB")

STAGE = Path(os.environ.get("SWAMPSPACE_STAGE", "/tmp/swampspace-stage")) / "genesis-tiles"
T = int(os.environ.get("TILE_T", "64"))

# Juggernaut Ragnarok + no LoRA recipe (comfy.py defaults): the model draws real
# detail at high denoise and the k-centroid+palette downscale IS the pixel-art
# step. Prompts ask for hand-crafted pixel art + explicit VALUE (the value plan);
# enforce_band re-snaps the band after.
GEN = ("hand-crafted 16-bit pixel art game tile, sega genesis, careful pixel "
       "shading, crisp defined shapes, deliberate dithering")
NEG = ("photo, photorealistic, blurry, smooth gradients, 3d render, depth of "
       "field, text, watermark, frame, border, vignette, object, creature, "
       "character, figure, face, camouflage, military camo, low contrast, "
       "muddy, washed out")

# surface -> (unit kind, unit count, prompt, denoise, seamless)
# Prompts name the VALUE of the surface explicitly — the value plan is the
# whole point (docs/genesis-upgrade.md) — and the band is re-enforced after.
UNITS = {
    "floor": ("macro", 4,
              f"top-down derelict space station deck floor, dark tan and gray "
              f"riveted metal plates with dark seams, moss and thin vines creeping "
              f"in the seams, rust streaks, rot, grimy interior floor sinking into "
              f"swamp, {GEN}, seamless tileable game texture, flat top-down "
              f"orthographic view", 0.5, True),
    "street": ("macro", 4,
               f"top-down dark sunken metal causeway, near-black wet rusted "
               f"grating and cracked asphalt half-submerged in black swamp water, "
               f"thin moss veins in the cracks, very dark, {GEN}, seamless "
               f"tileable game texture, flat top-down orthographic view", 0.5, True),
    # grass is a uniform detailed carpet: individual seamless tiles (no macro,
    # no edge-flattening); high denoise so Juggernaut draws real blades.
    "grass": ("field", 12,
              f"top-down pixel art grass tile, dense tufts of green swamp grass, "
              f"individual grass blades, careful dithered light and shadow "
              f"shading, {GEN}, seamless tileable game terrain, flat top-down "
              f"orthographic view", 0.82, True),
    "sidewalk": ("mosaic", 1,
                 f"top-down weathered gray metal walkway plates, worn dark-gray "
                 f"riveted panels with mossy expansion joints, grimy, wet, "
                 f"subdued, large flat plates, {GEN}, "
                 f"seamless game texture, flat top-down view", 0.32, True),
    "wall": ("mosaic", 1,
             f"top-down game wall tile, near-black rusted metal bulkhead woven "
             f"with thick dark roots and vines, a dim lit steel cap strip along "
             f"the top edge, wet and overgrown, {GEN}, "
             f"straight-on view", 0.35, False),
    "exit": ("single", 1,
             f"top-down glowing green launch pad game tile, a bright "
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

# Organic-field surfaces calmed to a shared border color for cross-tile
# continuity. Grass no longer needs it — the high-freq detailed blades hide
# cross-variant seams and edge-calm would flatten the detail. Kept for future
# smooth surfaces.
EDGE_CALM = {}


def base_unit(surface, unit_idx):
    """The structural init image for one unit, author-res (2T for macro/mosaic)."""
    kind = UNITS[surface][0]
    if kind == "macro":
        fn = {"floor": G.floor_macro, "street": G.street_macro}[surface]
        return G.snap(fn(T, unit_idx)), 2 * T
    if kind == "field":  # one detailed seamless tile per unit (grass)
        return G.snap(G.bog_tile(T, unit_idx)), T
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
        small = seamless_kcentroid(im, res)  # wrap-safe downscale (continuity)
        clean = G.despeckle(small, passes=4 if surface in G.FLAT else 2)
        arr = np.asarray(clean, np.float32)
        # organic fields: pull every variant's border to a SHARED green so an
        # arbitrary mix of macros tiles seamlessly across cell boundaries.
        if surface in EDGE_CALM:
            arr = G.edge_calm(arr, EDGE_CALM[surface], px=4)
        banded = G.enforce_band(arr, surface)
        cand_path = udir / f"unit-{unit_idx}-seed{s}.png"
        Image.fromarray(banded, "RGB").save(cand_path)
        candidates.append((score(banded, surface), s, banded))
        print(f"  {surface}[{unit_idx}] seed{s}: lum={G.lum(banded):.1f} "
              f"(target {G.BAND[surface]:.0f}) score={candidates[-1][0]:.1f}")

    candidates.sort(key=lambda c: -c[0])
    _, best_s, best = candidates[0]
    print(f"  {surface}[{unit_idx}] -> seed{best_s}")

    # slice row-major into shipped tile files
    counts = {"floor": 16, "street": 16, "grass": 12, "sidewalk": 4, "wall": 3, "exit": 1}
    if kind == "single":
        Image.fromarray(best, "RGB").save(outdir / f"{surface}-0.png")
        return
    if kind == "field":  # one tile per unit, no slicing
        Image.fromarray(best, "RGB").save(outdir / f"{surface}-{unit_idx}.png")
        return
    for q in range(4):
        v = unit_idx * 4 + q
        if v >= counts[surface]:
            break
        y, x = divmod(q, 2)
        Image.fromarray(best[y * T:(y + 1) * T, x * T:(x + 1) * T], "RGB").save(
            outdir / f"{surface}-{v}.png")


def _surface_base_tile(surface, v, outdir):
    """A real shipped base tile of `surface` — used to restore an accent's
    border so it seats in the field instead of sitting in a box."""
    import glob as _g
    fs = sorted(_g.glob(str(outdir / f"{surface}-[0-9]*.png")))
    return np.asarray(Image.open(fs[(v * 5) % len(fs)]).convert("RGB"), np.float32) if fs else None


def _blend_border(accent, base, feather=6):
    """Keep the accent CENTER, restore the base at the EDGES (feathered)."""
    if base is None:
        return accent
    H, W = accent.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    edge = np.minimum.reduce([yy, xx, H - 1 - yy, W - 1 - xx])
    c = np.clip((edge - feather) / feather, 0, 1)[..., None]
    return accent.astype(np.float32) * c + base * (1 - c)


def repaint_accent(name, v, seeds, outdir):
    count, fn, hint, denoise = ACCENTS[name]
    surface = ACCENT_BAND[name]
    udir = STAGE / name
    udir.mkdir(parents=True, exist_ok=True)
    # init from a REAL base tile with the procedural feature over it, so the
    # accent's border already matches the field.
    surf_base = _surface_base_tile(surface, v, outdir)
    feat = G.snap(fn(T, v))
    base = feat if surf_base is None else _blend_border(feat.astype(np.float32), surf_base, 8).astype(np.uint8)
    init_path = udir / f"init-{v}.png"
    Image.fromarray(base, "RGB").resize((1024, 1024), Image.NEAREST).save(init_path)
    pos = f"top-down dark alien swamp game tile, {hint}, {GEN}, flat top-down orthographic view"
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
        # restore the exact base border so the accent seats in the field
        blended = _blend_border(np.asarray(clean, np.float32), surf_base)
        banded = G.enforce_band(blended, surface, tol=0.25)
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
    import theme_config as _tc; outdir = Path(_tc.THEME["tiles_dir"])
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
