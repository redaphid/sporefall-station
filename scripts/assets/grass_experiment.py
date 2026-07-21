#!/usr/bin/env python3
"""Fast single-tile grass A/B: try checkpoint / LoRA / denoise / prompt combos,
post exactly like the real pipeline, write a labelled contact sheet so the look
can be judged before committing to a full sweep. Addresses: attentive pixel-art
grass (not camo blobs), no center cross, Juggernaut Ragnarok base.
"""
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import comfy
from comfy import build_graph, run
from post import kcentroid
import tiles_genesis as G

STAGE = Path(os.environ.get("SWAMPSPACE_STAGE", "/tmp/swampspace-stage")) / "grass-exp"
STAGE.mkdir(parents=True, exist_ok=True)
T = 64

NEG = ("photo, photorealistic, blurry, smooth, 3d render, text, watermark, "
       "frame, border, vignette, object, creature, figure, camouflage, "
       "military camo, blobs, low contrast, muddy")

# Each trial: label -> (ckpt, lora, denoise, seamless_heal, prompt, init_base?)
BASE_GRASS = (
    "top-down pixel art grass tile, dense tufts of green swamp grass, individual "
    "grass blades, hand-drawn 16-bit pixel art, careful dithered light and shadow "
    "shading, sega genesis game terrain, seamless tileable texture, flat top-down view"
)
JUG = "SDXL1.0/juggernautXL_ragnarokBy.safetensors"
PIXLORA = "pixel_art_style_by_skormino_v7.05_test_72img.safetensors"

TRIALS = {
    "A-jug-noLora-0.85": (JUG, "", 0.85, 0.6, BASE_GRASS, True),
    "B-jug-noLora-init0.7": (JUG, "", 0.7, 0.55, BASE_GRASS, True),
    "C-jug-pixLora-0.8": (JUG, PIXLORA, 0.8, 0.6, BASE_GRASS, True),
    "D-pixelwave-0.85": ("pixelwave_11.safetensors", "", 0.85, 0.6, BASE_GRASS, True),
    # low-strength pixel LoRA on the Juggernaut winner (LORA_W env set in gen)
    "E-jug-pixLora0.3-0.85": (JUG, PIXLORA, 0.85, 0.6, BASE_GRASS, True),
    "F-jug-pixLora0.5-0.85": (JUG, PIXLORA, 0.85, 0.6, BASE_GRASS, True),
}
LORA_W = {"E-jug-pixLora0.3-0.85": 0.3, "F-jug-pixLora0.5-0.85": 0.5}


def gen(label, ckpt, lora, denoise, heal, prompt, use_base):
    comfy.CKPT = ckpt
    comfy.LORA = lora
    comfy.LORA_W = LORA_W.get(label, 1.0)
    os.environ["SEAMLESS_HEAL"] = str(heal)
    init = None
    if use_base:
        base = G.snap(G.bog_macro(T, 0))
        ip = STAGE / f"init-{label}.png"
        Image.fromarray(base, "RGB").resize((1024, 1024), Image.NEAREST).save(ip)
        init = str(ip)
    graph = build_graph(pos=prompt, neg=NEG, seed=4242, init=init, denoise=denoise,
                        seamless=True, alpha=False, prefix=f"gexp-{label}")
    raw = run(graph, str(STAGE / "raw"))
    im = Image.open(raw[-1]).convert("RGB")
    # macro is 2T; post like the pipeline
    small = kcentroid(im, 2 * T, 2 * T).convert("RGB")
    banded = G.enforce_band(np.asarray(small, np.float32), "grass")
    out = STAGE / f"{label}.png"
    Image.fromarray(banded, "RGB").save(out)
    return out


def contact():
    labels = list(TRIALS)
    tiles = []
    for lb in labels:
        f = STAGE / f"{lb}.png"
        if f.exists():
            # show as a 3x3 field to see tiling + look
            im = np.asarray(Image.open(f).convert("RGB"))
            fld = np.tile(im, (3, 3, 1))
            tiles.append((lb, Image.fromarray(fld, "RGB").resize((384, 384), Image.NEAREST)))
    if not tiles:
        return
    cols = 2
    rows = (len(tiles) + cols - 1) // cols
    W, H = 384, 384
    sheet = Image.new("RGB", (cols * (W + 8), rows * (H + 28)), (16, 16, 20))
    d = ImageDraw.Draw(sheet)
    for i, (lb, im) in enumerate(tiles):
        x, y = (i % cols) * (W + 8), (i // cols) * (H + 28)
        sheet.paste(im, (x + 4, y + 24))
        d.text((x + 6, y + 6), lb, fill=(120, 230, 140))
    sheet.save(STAGE / "contact.png")
    print(f"contact -> {STAGE/'contact.png'}")


if __name__ == "__main__":
    only = sys.argv[1:] or list(TRIALS)
    for lb in only:
        ckpt, lora, dn, heal, pr, ub = TRIALS[lb]
        print(f"[{lb}] ckpt={ckpt.split('/')[-1]} lora={'yes' if lora else 'no'} denoise={dn}")
        gen(lb, ckpt, lora, dn, heal, pr, ub)
    contact()
