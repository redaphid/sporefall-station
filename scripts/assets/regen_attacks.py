#!/usr/bin/env python3
"""Hi-res attack frames via img2img: the shipped 48px attack pose (upscaled) is
the pose-preserving init, the character's curated anchor supplies identity, and
moderate denoise restores real detail. Post to 96px. Batch by ckpt via env.
Usage: regen_attacks.py <arch> <frame> [<arch> <frame> ...]
"""
import os
import sys

HERE = "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/scripts/assets"
sys.path.insert(0, HERE)
import generate as G  # noqa: E402
import comfy  # noqa: E402
import post as P  # noqa: E402
from PIL import Image  # noqa: E402

WT = "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea"
HIRES = f"{WT}/public/themes/swampspace-hires/chars"
SHIPPED = f"{WT}/public/themes/swampspace/chars"
SIZE = int(os.environ.get("SIZE", "512"))
DENOISE = float(os.environ.get("DENOISE", "0.6"))


def regen(arch, frame):
    spec = G.jobs()[f"char.{arch}.s-idle"]
    pos = spec["pos"] + ", mid-attack lunge, arms striking forward, dynamic action pose"
    neg = spec["neg"]
    anchor = os.path.join(G.ANCHORS, f"{arch}-s-idle.png")
    src = Image.open(f"{SHIPPED}/{arch}-s-attack-{frame}.png").convert("RGBA")
    bg = Image.new("RGBA", src.size, (255, 255, 255, 255))
    bg.alpha_composite(src)
    init_path = f"/tmp/attack-init-{arch}-{frame}.png"
    bg.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS).save(init_path)
    g = comfy.build_graph(pos=pos, neg=neg, seed=414600 + frame, batch=1,
                          refs=[anchor] if os.path.exists(anchor) else None, ip_weight=0.55,
                          init=init_path, denoise=DENOISE, alpha=True,
                          prefix=f"attack-{arch}-{frame}")
    paths = comfy.run(g, f"/tmp/attackgen/{arch}-{frame}")
    out = P.sprite(Image.open(paths[0]), 96, content=92, anchor="bottom")
    out.save(f"{HIRES}/{arch}-s-attack-{frame}.png")
    print(f"{arch}-s-attack-{frame} -> 96px (init {SIZE} denoise {DENOISE})", flush=True)


args = sys.argv[1:]
for i in range(0, len(args), 2):
    regen(args[i], int(args[i + 1]))
