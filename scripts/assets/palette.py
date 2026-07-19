#!/usr/bin/env python3
"""Locked color palette for the swampspace theme pack.

Derived from a dominant-color study of Flashback (Amiga, 1992) level 1 — the
Titan jungle: teal mist, olive-green organic mass swallowing tan/gray tech,
tiny hot accents. (Palette/mood inspiration only; no Flashback art is used or
reproduced anywhere in the pipeline.)

Every curated asset is quantized to THIS palette (nearest color, no dither),
which is what makes the pack read as one coherent set.
"""

PALETTE = [
    # deep darks (outlines, shadow, space)
    "#08080c", "#141a16", "#1c1420",
    # teal mist / water / star-glass
    "#163a3e", "#24565c", "#3a7a80", "#5aa4ae", "#7ecbd2",
    # olive greens (bog foliage, moss, mutant skin)
    "#22380f", "#35511a", "#4c6b28", "#67873c", "#86a750", "#a8c46a",
    # tans / browns (roots, rot, rope, leather)
    "#2e1e10", "#4a3419", "#6b4d26", "#8f6c38", "#b08d50", "#cbb277",
    # station metals (deck plate, bulkhead, drone shell)
    "#23282e", "#3c444d", "#59636d", "#7b8791", "#a2adb4",
    # bioluminescent + hot accents (use sparingly)
    "#46e078", "#a6ffbe", "#3ce0d8", "#ffd83e", "#ff9032", "#e04a2a", "#a05ae0",
    # skin + white
    "#d8a878", "#f2f6ea",
]


def rgb(hexstr: str) -> tuple[int, int, int]:
    h = hexstr.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


RGB = [rgb(c) for c in PALETTE]

if __name__ == "__main__":
    # emit a swatch sheet for eyeballing
    from PIL import Image, ImageDraw
    S = 48
    im = Image.new("RGB", (S * 8, S * ((len(RGB) + 7) // 8)), (20, 20, 20))
    d = ImageDraw.Draw(im)
    for i, c in enumerate(RGB):
        x, y = (i % 8) * S, (i // 8) * S
        d.rectangle((x, y, x + S - 1, y + S - 1), fill=c)
    im.save("palette-swatch.png")
    print(f"{len(RGB)} colors -> palette-swatch.png")
