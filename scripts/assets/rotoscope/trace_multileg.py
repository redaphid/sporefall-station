#!/usr/bin/env python3
"""The plain rotoscope route on the multileg proxy, for comparison with Fun-Control: every proxy frame
traced on its own (juggernautXL img2img from the colour-blocked render, union-promax depth ControlNet on
the proxy's depth, IPAdapter on the character keyframe, one fixed seed), masked by the proxy's alpha,
then optionally snapped to the s-idle palette (the palette lock).

  python3 trace_multileg.py --proxy .../proxy/se --ref .../se-keyframe.png --describe-file ... \
      --out /mnt/d/tmp/cast-walks/rnd-multileg/roto-se [--length 81]

Writes <out>/raw/walk-se/NNNN.png (the cycle tiled to --length, so loop_measure reads it like a clip) and
<out>/raw-pal/walk-se/ (palette-locked). Take GPU-WAN.lock before running; /free after.
"""
import argparse
import glob
import json
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import comfy  # noqa: E402
import generate as G  # noqa: E402
import spritesheet as S  # noqa: E402

SQ = 1024


def square(im, fill):
    """Pad a 848x480 frame to a centred 848x848 square, then scale to SQ."""
    w, h = im.size
    sq = Image.new(im.mode, (w, w), fill)
    sq.paste(im, (0, (w - h) // 2))
    return sq.resize((SQ, SQ), Image.LANCZOS)


def unsquare(im, w, h):
    return im.resize((w, w), Image.LANCZOS).crop((0, (w - h) // 2, w, (w - h) // 2 + h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--proxy", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--describe-file", required=True)
    ap.add_argument("--palette", default="public/themes/swampspace-hires/chars/mireclaw-stalker-s-idle.png")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=414977)
    ap.add_argument("--denoise", type=float, default=0.85)
    ap.add_argument("--cn", type=float, default=0.85)
    ap.add_argument("--ipw", type=float, default=0.5)
    ap.add_argument("--length", type=int, default=81)
    a = ap.parse_args()
    colors = sorted(glob.glob(os.path.join(a.proxy, "color-*.png")))
    depths = sorted(glob.glob(os.path.join(a.proxy, "depth-*.png")))
    prep = os.path.join(a.out, "prep")
    traced = os.path.join(a.out, "traced")
    os.makedirs(prep, exist_ok=True)
    os.makedirs(traced, exist_ok=True)
    kf = Image.open(a.ref).convert("RGB")
    side = min(kf.size)
    ref = kf.crop(((kf.width - side) // 2, (kf.height - side) // 2, (kf.width + side) // 2, (kf.height + side) // 2))
    ref.resize((SQ, SQ), Image.LANCZOS).save(os.path.join(prep, "ref.png"))
    desc = open(a.describe_file).read().strip()
    pos = (f"{G.TRIGGER}, full body game character sprite, {desc}, {G.DIRS['se']}, walking, "
           f"{G.BG_CHAR}, {G.LOOK}")
    neg = f"two characters, crowd, cropped, close-up, portrait, 3d render, {G.NEG_BASE}"
    pids = {}
    for i, (c, d) in enumerate(zip(colors, depths)):
        col = Image.open(c).convert("RGBA")
        white = Image.new("RGB", col.size, (255, 255, 255))
        white.paste(col, (0, 0), col)
        square(white, (255, 255, 255)).save(os.path.join(prep, f"init-{i:02d}.png"))
        square(Image.open(d).convert("RGB"), (0, 0, 0)).save(os.path.join(prep, f"depth-{i:02d}.png"))
        g = comfy.build_graph(pos=pos, neg=neg, seed=a.seed, refs=[os.path.join(prep, "ref.png")], ip_weight=a.ipw,
                              init=os.path.join(prep, f"init-{i:02d}.png"), denoise=a.denoise, alpha=False,
                              prefix=f"rnd-multileg/roto-{i:02d}", size=SQ,
                              control=os.path.join(prep, f"depth-{i:02d}.png"),
                              controlnet="xinsir-controlnet-union-sdxl-1.0-promax.safetensors",
                              cn_union_type="depth", cn_strength=a.cn)
        pids[comfy.post("/prompt", {"prompt": g})["prompt_id"]] = i
    json.dump({"pos": pos, "neg": neg, "seed": a.seed, "denoise": a.denoise, "cn": a.cn, "ipw": a.ipw},
              open(os.path.join(a.out, "run.json"), "w"), indent=1)
    print(f"queued {len(pids)}", flush=True)
    t0 = time.time()
    while pids and time.time() - t0 < 3600:
        time.sleep(10)
        for pid, i in list(pids.items()):
            h = json.load(urllib.request.urlopen(f"{comfy.HOST}/history/{pid}", timeout=30))
            if pid not in h:
                continue
            outs = [o for o in h[pid]["outputs"].values() if "images" in o]
            if h[pid].get("status", {}).get("status_str") == "error" or not outs:
                raise SystemExit(f"frame {i}: {json.dumps(h[pid].get('status'))[:1500]}")
            S.fetch(outs[-1]["images"][0]).save(os.path.join(traced, f"{i:02d}.png"))
            del pids[pid]
    pal = S.anchor_palette(a.palette)
    for sub, snap in (("raw", False), ("raw-pal", True)):
        o = os.path.join(a.out, sub, "walk-se")
        os.makedirs(o, exist_ok=True)
        cyc = []
        for i, c in enumerate(colors):
            col = Image.open(c).convert("RGBA")
            tr = unsquare(Image.open(os.path.join(traced, f"{i:02d}.png")).convert("RGB"), *col.size)
            if snap:
                tr = S.snap(tr, pal).convert("RGB")
            out = Image.new("RGB", col.size, (255, 255, 255))
            out.paste(tr, (0, 0), col.getchannel("A").point(lambda v: 255 if v > 127 else 0))
            cyc.append(out)
        for k in range(a.length):
            cyc[k % len(cyc)].save(os.path.join(o, f"{k:04d}.png"))
    print(f"-> {a.out}/raw, raw-pal")


if __name__ == "__main__":
    main()
