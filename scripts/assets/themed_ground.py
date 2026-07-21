#!/usr/bin/env python3
"""Art-direct a COHERENT, on-theme ground set. Two phases:

  hero:  generate N candidates of one themed prompt (varied seeds), post them,
         write a contact sheet — pick the best as the style anchor.
  set:   generate the shipped pool anchored to the hero via IPAdapter (so every
         variant is the SAME material, only varied) + varied seeds, post, and
         write a field preview assembled exactly like the engine.

Theme (docs/genesis-upgrade.md + owner note): an abandoned space outpost SINKING
into an alien swamp — dark, murky, tangled vines and roots over sunken metal,
faint glowing green spores and amber embers, overgrown, moody, low light. NOT a
clean lawn. Juggernaut Ragnarok + no LoRA (comfy.py default); k-centroid+palette
is the pixel-art step.

Usage:
  SWAMPSPACE_STAGE=/tmp/swampspace-stage python3 themed_ground.py hero <surface> [n]
  SWAMPSPACE_STAGE=/tmp/swampspace-stage python3 themed_ground.py set  <surface> <hero.png> [count]
"""
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import comfy  # noqa: E402
from comfy import build_graph, run  # noqa: E402
from post import kcentroid  # noqa: E402
import tiles_genesis as G  # noqa: E402
from tiles_genesis_sd import seamless_kcentroid  # noqa: E402

# TILE RECIPE: Juggernaut Ragnarok + Pixel Art XL LoRA @ 0.7. Juggernaut alone is
# painterly, so its downscaled output reads as noisy AI-texture noodles (amateurish);
# Pixel Art XL (NeriJS, the community standard — NOT the skormino halftone LoRA)
# resolves the detail into deliberate, chunky, crafted pixel clusters. 0.7 keeps
# organic detail; 1.0 over-blocks. Env LORA=/LORA_W= override.
comfy.LORA = os.environ.get("LORA", "XL/pixel-art-xl.safetensors")
comfy.LORA_W = float(os.environ.get("LORA_W", "0.7"))

STAGE = Path(os.environ.get("SWAMPSPACE_STAGE", "/tmp/swampspace-stage")) / "themed"
T = 64

GEN = ("hand-crafted 16-bit pixel art game tile, sega genesis, careful pixel "
       "shading, crisp defined shapes, deliberate dithering")
NEG = ("photo, photorealistic, blurry, smooth gradients, 3d render, isometric, "
       "perspective, depth of field, text, watermark, frame, border, vignette, "
       "object, creature, character, figure, face, clean lawn, bright cheerful, "
       "grass field, camouflage, low contrast, washed out")

# DARK, low-contrast BASE prompts — no bright glow (that's reserved for accents,
# per the tile-theming research: base reads as one calm material, features live
# in ~15% accent tiles). One wrapping master is generated and SLICED so every
# base variant shares material/lighting and co-tiles (Red Blob / SLYNYRD).
BASE_PROMPTS = {
    "grass": ("top-down dark alien swamp bog floor, thin tangled dark vines and "
              "roots evenly spread over damp olive-green moss, uniform overgrown "
              "ground, dark and moody, even visual density, low contrast, no big "
              "black holes, no empty patches, no bright lights, no glow, "
              f"{GEN}, seamless tileable game terrain, flat top-down orthographic view"),
    "floor": ("top-down derelict space station deck floor, dark tan and gray "
              "riveted metal plates evenly tiled, thin moss and vines creeping in "
              "the panel seams, rust streaks, rot, sinking into swamp, dark and "
              "grimy, even visual density, no big holes, no bright glow, "
              f"{GEN}, seamless tileable game texture, flat top-down orthographic view"),
    "street": ("top-down dark sunken metal causeway half-submerged in black swamp "
               "water, cracked dark asphalt and rusted grating, thin moss veins, "
               "very dark near-black, wet, even density, no bright glow, "
               f"{GEN}, seamless tileable game texture, flat top-down orthographic view"),
    "wall": ("top-down dark bulkhead wall, near-black rusted metal panels woven "
             "with thick dark roots and vines, wet, overgrown, grimy, even "
             "density, no bright glow, "
             f"{GEN}, seamless tileable game texture, straight-on view"),
    "sidewalk": ("top-down weathered gray metal walkway plates, pale dark-gray "
                 "riveted panels with mossy expansion joints, grimy and worn, wet, "
                 "even density, subdued, "
                 f"{GEN}, seamless tileable game texture, flat top-down orthographic view"),
}

# Themed prompts per surface — the swamp-outpost fiction, not generic ground.
PROMPTS = {
    "grass": ("top-down dark alien swamp bog floor, tangled dark vines and "
              "roots creeping over wet olive moss and murky peat, a few faint "
              "glowing green spore dots and dim amber embers, patches of sunken "
              "rusted metal grating half swallowed by moss, overgrown abandoned "
              f"space outpost, dark and moody, {GEN}, seamless tileable game "
              f"terrain, flat top-down orthographic view"),
    "floor": ("top-down derelict space station deck floor, dark tan metal "
              "plates sinking into swamp, moss and vines creeping across seams, "
              "faint green glow in the cracks, rust and rot, abandoned outpost, "
              f"{GEN}, seamless tileable game texture, flat top-down orthographic view"),
    "street": ("top-down dark sunken causeway of cracked metal and asphalt half "
               "submerged in black swamp water, moss veins, faint glowing spores, "
               f"very dark and murky, {GEN}, seamless tileable game texture, "
               f"flat top-down orthographic view"),
}


def post_tile(im, surface):
    small = seamless_kcentroid(im, T)
    clean = G.despeckle(small, passes=2)
    return G.enforce_band(np.asarray(clean, np.float32), surface if surface in G.BAND else "grass")


def hero(surface, n):
    d = STAGE / surface / "hero"
    d.mkdir(parents=True, exist_ok=True)
    pos = PROMPTS[surface]
    base = G.snap(G.bog_tile(T, 0) if surface == "grass" else
                  (G.floor_macro(T, 0)[:T, :T] if surface == "floor" else G.street_macro(T, 0)[:T, :T]))
    ip = d / "init.png"
    Image.fromarray(base, "RGB").resize((1024, 1024), Image.NEAREST).save(ip)
    tiles = []
    for s in range(n):
        seed = 8100 + s * 733
        g = build_graph(pos=pos, neg=NEG, seed=seed, init=str(ip), denoise=0.8,
                        seamless=True, alpha=False, prefix=f"hero-{surface}-{s}")
        raw = run(g, str(d / "raw"))
        t = post_tile(Image.open(raw[-1]).convert("RGB"), surface)
        p = d / f"cand-{s}.png"
        Image.fromarray(t, "RGB").save(p)
        tiles.append((s, t))
        print(f"  hero {surface} seed{s}: lum={G.lum(t):.1f}")
    # contact sheet: 2x2 field per candidate
    cols = min(4, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    W = 260
    sheet = Image.new("RGB", (cols * (W + 6), rows * (W + 24)), (16, 16, 20))
    dr = ImageDraw.Draw(sheet)
    for i, (s, t) in enumerate(tiles):
        fld = Image.fromarray(np.tile(t, (2, 2, 1)), "RGB").resize((W, W), Image.NEAREST)
        x, y = (i % cols) * (W + 6), (i // cols) * (W + 24)
        sheet.paste(fld, (x + 3, y + 20))
        dr.text((x + 5, y + 4), f"seed {s}", fill=(120, 230, 140))
    sheet.save(d / "contact.png")
    print(f"hero contact -> {d/'contact.png'}")


def build_set(surface, hero_path, count):
    d = STAGE / surface / "set"
    d.mkdir(parents=True, exist_ok=True)
    pos = PROMPTS[surface]
    tiles = []
    for v in range(count):
        seed = 9200 + v * 617
        # IPAdapter anchor = hero → coherent material; moderate denoise keeps
        # structure varied but on-material. Env anchor is the hero tile itself.
        g = build_graph(pos=pos, neg=NEG, seed=seed, init=hero_path, denoise=0.55,
                        seamless=True, alpha=False, refs=[hero_path], ip_weight=0.6,
                        prefix=f"set-{surface}-{v}")
        raw = run(g, str(d / "raw"))
        t = post_tile(Image.open(raw[-1]).convert("RGB"), surface)
        Image.fromarray(t, "RGB").save(d / f"{surface}-{v}.png")
        tiles.append(t)
        print(f"  set {surface}[{v}]: lum={G.lum(t):.1f}")
    return d


def gen_master(surface, tiles_per_side, band_target, seeds, seed_base, d):
    """Best-of-`seeds` wrapping master, dark-banded, at (tiles_per_side*T)px."""
    pos = BASE_PROMPTS[surface]
    base = G.snap(G.bog_tile(T, 0))
    ip = d / "init.png"
    Image.fromarray(base, "RGB").resize((1024, 1024), Image.NEAREST).save(ip)
    N = tiles_per_side * T
    best, best_score = None, -1e9
    for s in range(seeds):
        g = build_graph(pos=pos, neg=NEG, seed=seed_base + s * 811, init=str(ip),
                        denoise=0.82, seamless=True, alpha=False,
                        prefix=f"master-{surface}-{seed_base}-{s}")
        raw = run(g, str(d / "raw"))
        big = seamless_kcentroid(Image.open(raw[-1]).convert("RGB"), N)
        clean = G.despeckle(big, passes=1)
        arr = np.asarray(clean, np.float32)
        arr = np.clip(arr * ((band_target + 12.75) / (G.lum(arr) + 12.75)), 0, 255)
        master = G.snap(arr, dither=0.0)
        err = abs(G.lum(master) - band_target)
        rng = min(float(np.asarray(master, float).std()), 30)
        # even visual weight: penalize spread of per-slice mean luminance (the
        # dark/light checkerboard the research warns about).
        a = np.asarray(master, float)
        L = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
        slice_means = [L[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T].mean()
                       for ty in range(tiles_per_side) for tx in range(tiles_per_side)]
        checker = float(np.std(slice_means))
        score = -err + rng * 0.3 - checker * 1.2
        print(f"  master {surface} seed{seed_base}+{s}: lum={G.lum(master):.1f} "
              f"std={rng:.1f} checker={checker:.1f} score={score:.1f}")
        if score > best_score:
            best, best_score = master, score
    return best


def master_slice(surface, tiles_per_side, band_target, seeds, outdir, n_masters=2):
    """Generate `n_masters` wrapping masters and slice each into a tiles_per_side^2
    macro (placed by POSITION so vines flow across tiles; the engine alternates
    masters per macro-cell → variety with a tiles_per_side-tile repeat period).
    The research's slice-a-wrapping-master method, upgraded to macro placement so
    structured (high-contrast vine) base tiles stay continuous."""
    d = STAGE / surface / "master"
    d.mkdir(parents=True, exist_ok=True)
    per = tiles_per_side * tiles_per_side
    for m in range(n_masters):
        best = gen_master(surface, tiles_per_side, band_target, seeds, 7700 + m * 5000, d)
        for q in range(per):
            ty, tx = divmod(q, tiles_per_side)
            v = m * per + q
            Image.fromarray(best[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T], "RGB").save(
                outdir / f"{surface}-{v}.png")
        print(f"{surface}: master {m} -> {per} slices (lum {G.lum(best):.1f})")
    print(f"{surface}: {n_masters} masters, {n_masters*per} base tiles -> {outdir}")


def vary_master(surface, tiles_per_side, band_target, hero_tiles_dir, n_variations, outdir):
    """Keep macro 0 as the hero, then generate n_variations MORE masters as
    img2img of the hero (low denoise + IPAdapter anchor) so every macro is the
    SAME material, only rearranged — continuous AND varied. Reads the hero from
    grass-0..(per-1) already in outdir, writes variations after it."""
    d = STAGE / surface / "vary"
    d.mkdir(parents=True, exist_ok=True)
    per = tiles_per_side * tiles_per_side
    # reconstruct hero master from its shipped slices
    N = tiles_per_side * T
    hero = np.zeros((N, N, 3), np.uint8)
    for q in range(per):
        ty, tx = divmod(q, tiles_per_side)
        hero[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T] = np.asarray(
            Image.open(Path(hero_tiles_dir) / f"{surface}-{q}.png").convert("RGB"))
    hero_path = d / "hero.png"
    Image.fromarray(hero, "RGB").resize((1024, 1024), Image.NEAREST).save(hero_path)
    pos = BASE_PROMPTS[surface]
    for m in range(1, n_variations + 1):
        g = build_graph(pos=pos, neg=NEG, seed=4400 + m * 971, init=str(hero_path),
                        denoise=0.5, seamless=True, alpha=False, refs=[str(hero_path)],
                        ip_weight=0.7, prefix=f"vary-{surface}-{m}")
        raw = run(g, str(d / "raw"))
        big = seamless_kcentroid(Image.open(raw[-1]).convert("RGB"), N)
        clean = G.despeckle(big, passes=1)
        arr = np.clip(np.asarray(clean, np.float32) *
                      ((band_target + 12.75) / (G.lum(clean) + 12.75)), 0, 255)
        var = G.snap(arr, dither=0.0)
        for q in range(per):
            ty, tx = divmod(q, tiles_per_side)
            Image.fromarray(var[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T], "RGB").save(
                Path(outdir) / f"{surface}-{m * per + q}.png")
        print(f"{surface}: variation {m} (lum {G.lum(var):.1f})")


if __name__ == "__main__":
    mode = sys.argv[1]
    surface = sys.argv[2]
    if mode == "hero":
        hero(surface, int(sys.argv[3]) if len(sys.argv) > 3 else 6)
    elif mode == "set":
        build_set(surface, sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 12)
    elif mode == "master":
        # master <surface> <tiles_per_side> <band> <seeds> <n_masters> [outdir]
        tps = int(sys.argv[3]) if len(sys.argv) > 3 else 4
        band = float(sys.argv[4]) if len(sys.argv) > 4 else 50.0
        sd = int(sys.argv[5]) if len(sys.argv) > 5 else 3
        nm = int(sys.argv[6]) if len(sys.argv) > 6 else 2
        outd = Path(sys.argv[7]) if len(sys.argv) > 7 else Path("../../public/themes/swampspace-hires/tiles")
        master_slice(surface, tps, band, sd, outd, nm)
    elif mode == "vary":
        # vary <surface> <tiles_per_side> <band> <n_variations> [outdir]
        tps = int(sys.argv[3]) if len(sys.argv) > 3 else 4
        band = float(sys.argv[4]) if len(sys.argv) > 4 else 54.0
        nv = int(sys.argv[5]) if len(sys.argv) > 5 else 2
        outd = Path(sys.argv[6]) if len(sys.argv) > 6 else Path("../../public/themes/swampspace-hires/tiles")
        vary_master(surface, tps, band, outd, nv, outd)
