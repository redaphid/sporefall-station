#!/usr/bin/env python3
"""Two takes of one action side by side, the way a sprite artist judges them: a frame strip at 4x nearest
(one row per take, the shipped idle at both ends), and GIFs at 1x and 3x playing idle, the action, idle,
both takes in lockstep at the engine's cadence (tpf 2 at 30 ticks/s = 67 ms a frame).

  python3 compare_actions.py --idle IDLE.png --take hand=DIR_A/96 --take mocap=DIR_B/96 \
      --glob 'vine-ranger-e-draw-*.png' --out OUT/prefix

Writes OUT/prefix-strip4x.png, -1x.gif, -3x.gif. Takes of different lengths play at the same frame
rate, so a longer take runs longer: timing is part of what is being compared.
"""
import argparse
import glob
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import cast_walk as CW  # noqa: E402


def frames(d, pat):
    fs = glob.glob(os.path.join(d, pat))
    return [Image.open(f).convert("RGBA") for f in sorted(fs, key=lambda f: int(f.rsplit("-", 1)[1][:-4]))]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--idle", required=True)
    ap.add_argument("--take", action="append", required=True, help="label=dir")
    ap.add_argument("--glob", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ms", type=int, default=67)
    a = ap.parse_args()
    idle = Image.open(a.idle).convert("RGBA")
    takes = [(lab, frames(d, a.glob)) for lab, d in (t.split("=", 1) for t in a.take)]
    px = idle.width
    k, gap, lw = 4, 4, 70
    cols = max(len(f) for _, f in takes) + 2
    strip = Image.new("RGB", (lw + cols * (px * k + gap), len(takes) * (px * k + gap) + 20), CW.BG)
    dr = ImageDraw.Draw(strip)
    dr.text((lw, 4), "idle | frames | idle   (4x nearest)", fill=(220, 220, 200))
    for r, (lab, fs) in enumerate(takes):
        y = 20 + r * (px * k + gap)
        dr.text((6, y + px * k // 2), f"{lab}\n{len(fs)} f", fill=(220, 220, 200))
        for c, im in enumerate([idle] + fs + [idle]):
            big = im.resize((px * k, px * k), Image.NEAREST)
            strip.paste(big, (lw + c * (px * k + gap), y), big)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    strip.save(f"{a.out}-strip4x.png")
    seqs = [[idle] * 6 + fs + [idle] * 8 for _, fs in takes]
    n = max(len(s) for s in seqs)
    for scale in (1, 3):
        cell = px * scale
        out = []
        for i in range(n):
            f = Image.new("RGB", (len(seqs) * (cell + 8 * scale), cell + 12 * scale), CW.BG)
            d = ImageDraw.Draw(f)
            for c, s in enumerate(seqs):
                im = s[min(i, len(s) - 1)].resize((cell, cell), Image.NEAREST)
                f.paste(im, (c * (cell + 8 * scale), 0), im)
                if scale > 1:
                    d.text((c * (cell + 8 * scale) + 4, cell), takes[c][0], fill=(220, 220, 200))
            out.append(f)
        out[0].save(f"{a.out}-{scale}x.gif", save_all=True, append_images=out[1:], duration=a.ms, loop=0)
    print(f"{a.out}-strip4x.png {a.out}-1x.gif {a.out}-3x.gif ({', '.join(f'{lab} {len(fs)}' for lab, fs in takes)})")


if __name__ == "__main__":
    main()
