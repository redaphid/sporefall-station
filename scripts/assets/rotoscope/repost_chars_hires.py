#!/usr/bin/env python3
"""Faithful hi-res NPC idles from the curated s-idle anchor raws (512px, the
approved originals saved in scripts/assets/anchors). Black-key the background,
keep the largest connected component, k-centroid + locked palette to 96px,
feet-anchored — then derive the s-step. No GPU, no drift: the anchor IS the
approved art, just posted into a bigger sprite than the shipped 48px.
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ASSETS = "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/scripts/assets"
sys.path.insert(0, ASSETS)
import post as P  # noqa: E402

HIRES = "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/public/themes/swampspace-hires/chars"
ANCHORS = os.path.join(ASSETS, "anchors")
NPCS = ["bog-mutant", "spore-drone", "mycologist", "derelict-bot", "frog-settler"]
CANVAS, CONTENT = 96, 92


def black_key(im):
    """Alpha from distance-to-black; keep the largest connected component so
    stray background sparkle is dropped but the whole figure is kept."""
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    dist = np.sqrt((a ** 2).sum(-1))
    lum = a @ np.array([0.299, 0.587, 0.114], np.float32)
    mask = (dist > 30) | (lum > 22)
    mask = ndimage.binary_closing(mask, iterations=2)
    mask = ndimage.binary_fill_holes(mask)
    lbl, n = ndimage.label(mask)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
        mask = lbl == (1 + int(np.argmax(sizes)))
    rgba = np.dstack([np.asarray(im.convert("RGB")),
                      np.where(mask, 255, 0).astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")


for kind in NPCS:
    src = os.path.join(ANCHORS, f"{kind}-s-idle.png")
    keyed = black_key(Image.open(src))
    idle = P.sprite(keyed, CANVAS, content=CONTENT, anchor="bottom")
    idle.save(os.path.join(HIRES, f"{kind}-s-idle.png"))
    step = P.derive_step(idle)
    step.save(os.path.join(HIRES, f"{kind}-s-step.png"))
    print(f"{kind}: idle+step -> 96px (opaque px {int((np.asarray(idle)[...,3]>0).sum())})")
print("done")
