#!/usr/bin/env python3
"""SD-refined tile sets: ComfyUI img2img over the procedural tile bases.

The procedural generator (tilesets.py) nails palette + structure; this pass
adds the painted texture density it can't (moss growth patterns, root veins,
water sheen) via img2img at moderate denoise, holding identity:

  per surface:
    2x2 mosaic of the 4 procedural variants (64px) -> nearest-upscale 1024
    -> img2img (SDXL + skormino pixel LoRA, seamless offset+heal pass)
    -> k-centroid downscale back to 64 -> quantize to the locked palette
    -> slice into 4 co-tiling 32px quadrant variants

Usage: python3 scripts/assets/tilesets_sd.py <proc_dir> <out_dir> [surface...]
Requires ComfyUI at localhost:8188 (see docs/sprite-generation.md).
"""

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from comfy import build_graph, run  # noqa: E402
from post import kcentroid, to_palette  # noqa: E402

NEG = ("photo, photorealistic, blurry, smooth gradients, 3d render, text, "
       "watermark, frame, border, object, creature, character, figure")

# Per-surface img2img recipe: prompt + denoise (how much painting freedom).
SURFACES = {
    "grass": (
        "masterpiece, pixpix, 8-bit, pixel_art, top-down swamp moss ground tile, "
        "dense mossy bog undergrowth, clumps of olive green swamp grass, tiny "
        "glowing spores, dark peat between tufts, SNES rpg terrain texture, "
        "seamless game tile, flat top-down view",
        0.5,
    ),
    "street": (
        "masterpiece, pixpix, 8-bit, pixel_art, top-down dark bog water tile, "
        "still swamp water channel, teal ripples and surface sheen, floating "
        "moss flecks, deep murky water, SNES rpg water texture, seamless game "
        "tile, flat top-down view",
        0.45,
    ),
    "sidewalk": (
        "masterpiece, pixpix, 8-bit, pixel_art, top-down metal deck plating "
        "tile, riveted steel walkway plates, worn scratched metal, moss "
        "creeping in panel seams, derelict space station floor, SNES sci-fi "
        "texture, seamless game tile, flat top-down view",
        0.45,
    ),
    "floor": (
        "masterpiece, pixpix, 8-bit, pixel_art, top-down overgrown deck floor "
        "tile, mossy metal decking planks, green growth over steel, scattered "
        "bolts, derelict station interior floor, SNES rpg dungeon floor "
        "texture, seamless game tile, flat top-down view",
        0.5,
    ),
    "wall": (
        "masterpiece, pixpix, 8-bit, pixel_art, side view game wall tile, "
        "root-woven steel bulkhead, thick brown roots growing over dark metal "
        "wall, lit steel cap on top edge, teal conduit glints, SNES platformer "
        "wall texture, straight-on view",
        0.35,  # low: the top-face/front-face split must survive
    ),
}


def mosaic(proc_dir: Path, name: str, n: int) -> Image.Image:
    """2x2 mosaic of the procedural variants — the structured img2img init."""
    out = Image.new("RGB", (64, 64))
    for i in range(4):
        im = Image.open(proc_dir / f"{name}-{i % n}.png").convert("RGB")
        out.paste(im, ((i % 2) * 32, (i // 2) * 32))
    return out


def refine(proc_dir: Path, out_dir: Path, name: str, n_variants: int, seed: int) -> None:
    pos, denoise = SURFACES[name]
    init = mosaic(proc_dir, name, n_variants)
    init_path = out_dir / f"_{name}-init.png"
    init.resize((1024, 1024), Image.NEAREST).save(init_path)
    graph = build_graph(
        pos=pos, neg=NEG, seed=seed, init=str(init_path), denoise=denoise,
        seamless=(name != "wall"),  # the wall's top-cap band must not wrap
        alpha=False, prefix=f"tileset-{name}",
    )
    raw = run(graph, str(out_dir / "raw"))
    im = Image.open(raw[-1]).convert("RGB")
    small = to_palette(kcentroid(im, 64, 64)).convert("RGB")
    small.save(out_dir / f"_{name}-64.png")
    for i in range(4):
        small.crop(((i % 2) * 32, (i // 2) * 32, (i % 2) * 32 + 32, (i // 2) * 32 + 32)).save(
            out_dir / f"{name}-{i}.png"
        )
    print(f"{name}: refined (denoise {denoise})")


def main() -> None:
    proc_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    names = sys.argv[3:] or list(SURFACES)
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {"grass": 4, "street": 4, "sidewalk": 4, "floor": 4, "wall": 3}
    for i, name in enumerate(names):
        refine(proc_dir, out_dir, name, counts[name], seed=31337 + i * 101)


if __name__ == "__main__":
    main()
