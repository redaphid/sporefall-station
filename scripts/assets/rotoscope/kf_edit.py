#!/usr/bin/env python3
"""Redraw one direction's video keyframe with Qwen-Image-Edit at the keyframe's own size, so a Fun-Control take
can use it as --ref. For a fix the Wan prompt cannot make, because the ref image draws it (mireclaw-stalker n:
a dark wedge under the dome that the gate's VLM reads as a front-facing mouth).

  python3 kf_edit.py KEYFRAME --text-file EDIT.txt --out DIR [--seeds 3 11 23 1004]
  -> DIR/edit-s<seed>.png (ComfyUI's PNG, flow embedded), DIR/strip.png (the source, then each seed)

Edits already in DIR are reused; --force redraws. Needs GPU-WAN.lock.
"""
import argparse
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import spritesheet as ss  # noqa: E402


def edit(src_name, seed, text, w, h, q, prefix):
    g = ss.Graph()
    g.band("models + keyframe", "#335")
    m, clip, vae, s, neg = ss._qwen_loaders(g, q, src_name)
    lat = g.add("EmptySD3LatentImage", {"width": w, "height": h, "batch_size": 1}, col=1)
    steps, cfg = (4, 1.0) if q.get("lightning") else (20, 2.5)
    g.band("keyframe -> edited keyframe")
    pos = g.add("TextEncodeQwenImageEditPlus", {"clip": [clip, 0], "vae": [vae, 0], "image1": [s, 0], "prompt": text},
                "edit prompt")
    pos = g.add("FluxKontextMultiReferenceLatentMethod",
                {"conditioning": [pos, 0], "reference_latents_method": "index_timestep_zero"})
    ks = g.add("KSampler", {"model": [m, 0], "positive": [pos, 0], "negative": [neg, 0], "latent_image": [lat, 0],
                            "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                            "denoise": 1.0}, "sampler", col=1)
    dec = g.add("VAEDecode", {"samples": [ks, 0], "vae": [vae, 0]}, col=1)
    g.add("SaveImage", {"images": [dec, 0], "filename_prefix": f"{prefix}/s{seed}"}, "edit", col=2)
    res = ss.wait(ss.queue(g.nodes, g.workflow()))
    return ss.fetch_bytes([i for v in res.values() for i in v][0])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("keyframe")
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seeds", type=int, nargs="+", default=[3, 11, 23, 1004])
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    src = Image.open(a.keyframe).convert("RGB")
    w, h = src.size
    text = open(a.text_file).read().strip()
    need = [s for s in a.seeds if a.force or not os.path.exists(f"{a.out}/edit-s{s}.png")]
    if need:
        q, _ = ss.detect_qwen({"unet": None, "lightning": None, "clip": None, "vae": None})
        name = ss.upload(src, f"kf-edit-{os.path.basename(a.out.rstrip('/'))}.png")
        for seed in need:
            open(f"{a.out}/edit-s{seed}.png", "wb").write(edit(name, seed, text, w, h, q, "sprite-sheet/kf-edit"))
            print("edit", seed, flush=True)
    cells = [src] + [Image.open(f"{a.out}/edit-s{s}.png").convert("RGB") for s in a.seeds]
    cw, ch = 640, 360
    strip = Image.new("RGB", (cw * len(cells), ch), (255, 255, 255))
    for i, c in enumerate(cells):
        strip.paste(c.resize((cw, ch), Image.LANCZOS), (i * cw, 0))
    strip.save(f"{a.out}/strip.png")
    print(f"-> {a.out}/strip.png (source, then seeds {a.seeds})")


if __name__ == "__main__":
    main()
