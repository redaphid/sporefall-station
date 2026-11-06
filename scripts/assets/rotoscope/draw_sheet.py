#!/usr/bin/env python3
"""Zoom sheet and timed GIFs for a drawn one-shot that cuts in from idle and hands into another pose.

  python3 draw_sheet.py --take NAME=DIR[:TIMING] [--take ...] --kind vine-ranger --state draw \
      --after aim --dirs s,se,e,ne,n --out PREFIX

Each take is a dir of <px>/<kind>-<dir>-<state>-<n>.png (cast_action post's layout) or a pack's chars dir;
TIMING is a JSON file with a list of per-frame ticks (mocap.json `durations`) or a comma list; without
it every frame lasts 2 ticks (the engine's default draw cadence). Writes:
  PREFIX-zoom4x.png  per take, per facing a row: shipped idle | frames | shipped <after> pose (or the
                     take's last frame when the pack has none), 4x nearest on the game background;
  PREFIX-1x.gif / PREFIX-3x.gif  the takes side by side, each facing, idle held 12 ticks, the clip at
                     its own timing, then <after> held 24 ticks: the speed read at game size.
"""
import argparse
import glob
import json
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
THEMES = os.path.normpath(os.path.join(HERE, "..", "..", "..", "public", "themes"))
BG = (22, 26, 30)
TICK_MS = 1000 / 30


def frames_of(d, kind, dr, state, px=96):
    fs = glob.glob(os.path.join(d, str(px), f"{kind}-{dr}-{state}-*.png")) or glob.glob(os.path.join(d, f"{kind}-{dr}-{state}-*.png"))
    return [Image.open(f).convert("RGBA") for f in sorted(fs, key=lambda f: int(f.rsplit("-", 1)[1][:-4]))]


def timing_of(spec, n):
    if not spec:
        return [2] * n
    if os.path.exists(spec):
        v = json.load(open(spec))
        v = v.get("durations", v) if isinstance(v, dict) else v
    else:
        v = [int(x) for x in spec.split(",")]
    return [int(v[k]) if k < len(v) else 2 for k in range(n)]


def pack_pose(kind, dr, name, px=96):
    pack = "swampspace-hires" if px == 96 else "swampspace"
    for f in (f"{kind}-{dr}-{name}.png", f"{kind}-{dr}-{name}-0.png"):
        p = os.path.join(THEMES, pack, "chars", f)
        if os.path.exists(p):
            return Image.open(p).convert("RGBA")
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--take", action="append", required=True)
    ap.add_argument("--kind", required=True)
    ap.add_argument("--state", default="draw")
    ap.add_argument("--after", default="aim", help="the pose the clip hands into (falls back to the take's last frame)")
    ap.add_argument("--dirs", default="s,se,e,ne,n")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    takes = []
    for t in a.take:
        name, _, rest = t.partition("=")
        d, _, tim = rest.partition(":")
        takes.append((name, d, tim))
    dirs = a.dirs.split(",")
    k, cell = 4, 96 * 4
    rows = []
    for name, d, tim in takes:
        for dr in dirs:
            fr = frames_of(d, a.kind, dr, a.state)
            if not fr:
                continue
            idle = pack_pose(a.kind, dr, "idle")
            after = pack_pose(a.kind, dr, a.after)
            rows.append((f"{name} {dr}", [idle] + fr + [after or fr[-1]], after is not None))
    wmax = max(len(r[1]) for r in rows)
    sheet = Image.new("RGB", (150 + wmax * (cell + 4), 34 + len(rows) * (cell + 20)), BG)
    dr_ = ImageDraw.Draw(sheet)
    dr_.text((8, 8), f"{a.kind} {a.state}: shipped idle | frames 0..n | {a.after} (shipped, or the take's last frame)  4x",
             fill=(220, 220, 200))
    for r, (label, ims, real_after) in enumerate(rows):
        y = 34 + r * (cell + 20)
        dr_.text((8, y + cell // 2), label, fill=(220, 220, 200))
        for c, im in enumerate(ims):
            x = 150 + c * (cell + 4)
            if im is not None:
                big = im.resize((cell, cell), Image.NEAREST)
                sheet.paste(big, (x, y), big)
            tag = "idle" if c == 0 else (a.after + ("" if real_after else " (own)") if c == len(ims) - 1 else str(c - 1))
            dr_.text((x + 4, y + cell + 3), tag, fill=(150, 150, 140))
    sheet.save(f"{a.out}-zoom4x.png")

    # GIFs: per tick, every take x facing side by side
    lanes = []
    for name, d, tim in takes:
        for dr in dirs:
            fr = frames_of(d, a.kind, dr, a.state)
            if not fr:
                continue
            idle = pack_pose(a.kind, dr, "idle")
            after = pack_pose(a.kind, dr, a.after) or fr[-1]
            seq = [idle] * 12
            for im, t in zip(fr, timing_of(tim, len(fr))):
                seq += [im] * t
            seq += [after] * 24
            lanes.append(seq)
    n = max(len(s) for s in lanes)
    for scale, suffix in ((1, "1x"), (3, "3x")):
        c = 96 * scale
        out = []
        for i in range(n):
            f = Image.new("RGB", (len(lanes) * c, c), BG)
            for j, s in enumerate(lanes):
                im = s[min(i, len(s) - 1)].resize((c, c), Image.NEAREST)
                f.paste(im, (j * c, 0), im)
            out.append(f)
        out[0].save(f"{a.out}-{suffix}.gif", save_all=True, append_images=out[1:], duration=round(TICK_MS), loop=0)
    print(f"{a.out}-zoom4x.png {a.out}-1x.gif {a.out}-3x.gif ({len(lanes)} lanes, {n} ticks)")


if __name__ == "__main__":
    main()
