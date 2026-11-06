#!/usr/bin/env python3
"""hive-spire by rigid parts: no video model. The shipped 96 px s-idle is cut into three layers (crown cap,
shaft, rooted base) and keyframed in pixel space, so every frame keeps the shipped pixels and the locked palette:

  idle    the shaft breathes (squashes up to SQUASH rows, widens a pixel), the crown cap lifts off its rim and
          shows an essence-glow seam, and a spore bud under the rim swells and shrinks. Frame 8 = frame 0.
  attack  (hiveSpawn / hiveSpread) the cap lifts wide, the bud swells, drops to the roots and bursts, then the
          spire settles. Starts and ends on idle frame 0.

The bud hangs on the side the spire faces (s front, e right edge, n behind the shaft), so the five directions
are one structure turned, not five drawings.

  python3 rig_spire.py SRC96.png --out DIR [--attack] [--install]

Writes DIR/{96,48}/<dir>-idle-<n>.png (and -attack-<n>.png). The 48 px pack is a 2x2 block reduction of the
96 px frame (majority alpha, modal colour), aligned the way the shipped 48 px s-idle sits.
"""
import argparse
import json
import math
import os
import shutil

import numpy as np
from PIL import Image

DIRS = {"s": 0, "se": 45, "e": 90, "ne": 135, "n": 180}

# Layer cuts on the shipped 96 px s-idle (rows): the cap's pyramid ends at TIP_END, its rim runs to RIM_END, the
# shaft runs to BASE_Y; the root flare and the moss pad below BASE_Y never move.
TIP_END, RIM_END, BASE_Y = 18, 26, 62
CX = 47.5  # shaft axis, x
SHAFT_R = 9.0  # where a bud on the shaft's surface sits, from the axis

GLOW_HOT, GLOW, RIM_DARK = (166, 255, 190), (70, 224, 120), (34, 56, 15)
BUD_SKIN, BUD_SHADE = (103, 135, 60), (53, 81, 26)
SPLAT = (76, 107, 40)
SHADOW = (20, 26, 22)

# idle keyframes per frame: shaft rows dropped, cap lift (px), bud diameter
IDLE = {"drop": [0, 1, 2, 3, 3, 2, 1, 0], "lift": [0, 0, 1, 2, 2, 1, 0, 0], "bud": [6, 6, 7, 8, 9, 8, 7, 6]}
# attack: bud_dy is how far the bud has fallen; burst draws a splat at the roots in place of the bud
ATTACK = {"drop": [0, 2, 3, 1, 0, 1, 1, 0], "lift": [0, 2, 3, 3, 2, 1, 0, 0], "bud": [6, 9, 11, 10, 0, 0, 0, 6],
          "bud_dy": [0, 0, 1, 14, 0, 0, 0, 0], "burst": [0, 0, 0, 0, 1, 2, 0, 0]}


def nn_rows(layer, h):
    """Resample a layer's rows to height h (nearest), so a row is dropped or doubled, never blended."""
    src = layer.shape[0]
    if h == src:
        return layer.copy()
    idx = np.minimum((np.arange(h) * src / h + src / (2 * h)).astype(int), src - 1)
    return layer[idx]


def widen(rows, extra):
    """Widen each row about the axis by `extra` px in total (nearest), the bottom rows least."""
    if extra <= 0:
        return rows
    out = np.zeros_like(rows)
    n = rows.shape[0]
    xs = np.arange(rows.shape[1])
    for y in range(n):
        k = min(1.0, (n - 1 - y) / max(1, n * 0.4))  # ramp to 0 at the shaft's foot so it stays rooted
        sx = 1 + extra * k / 20.0
        src = np.round(CX + (xs - CX) / sx).astype(int)
        ok = (src >= 0) & (src < rows.shape[1])
        out[y, ok] = rows[y, src[ok]]
    return out


def paste(dst, layer, top):
    """Alpha-over a full-width layer at row `top` (rows that fall off the canvas are cut)."""
    for y in range(layer.shape[0]):
        ty = top + y
        if 0 <= ty < dst.shape[0]:
            m = layer[y, :, 3] > 0
            dst[ty, m] = layer[y, m]


def disc(dst, cx, cy, d, fill, shade, rim, front_mask=None):
    """A pixel bud of diameter d: dark rim, skin, a glow core, the lower-right in shade."""
    if d <= 0:
        return
    r = d / 2
    for y in range(int(cy - r) - 1, int(cy + r) + 2):
        for x in range(int(cx - r) - 1, int(cx + r) + 2):
            if not (0 <= y < dst.shape[0] and 0 <= x < dst.shape[1]):
                continue
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            q = (dx * dx + dy * dy) / (r * r)
            if q > 1.0:
                continue
            if front_mask is not None and not front_mask[y, x]:
                continue
            if q > 0.6:
                c = rim
            elif dx + dy > r * 0.35:
                c = shade
            else:
                c = fill
            dst[y, x] = (*c, 255)
    if d >= 5:  # the essence inside: a glow core that grows with the bud, hot pixel up-left
        gx, gy = int(math.floor(cx - 0.5)), int(math.floor(cy - 0.5))
        k = 2 if d < 8 else 3
        core = [((gx + i - (k == 3), gy + j - (k == 3)), GLOW) for i in range(k) for j in range(k)]
        core[0] = (core[0][0], GLOW_HOT)
        if k == 3:
            core[4] = (core[4][0], GLOW_HOT)
        for (x, y), c in core:
            if (front_mask is None or front_mask[y, x]) and dst[y, x, 3]:
                dst[y, x] = (*c, 255)


def splat(dst, cx, cy, size):
    """The burst bud at the roots: a low glow ring that spreads (size 1) and fades to moss (size 2)."""
    w = 4 + 3 * size
    for x in range(int(cx - w), int(cx + w) + 1):
        for y in (cy - 1, cy):
            dx = abs(x + 0.5 - cx) / w
            if dx > 1 or (y == cy - 1 and dx > 0.6):
                continue
            c = (GLOW if dx < 0.5 else GLOW_HOT) if size == 1 else SPLAT
            dst[int(y), x] = (*c, 255)


def frame(src, az, drop, lift, bud, bud_dy=0, burst=0):
    tip, rim, shaft, base = src[:TIP_END], src[TIP_END:RIM_END], src[RIM_END:BASE_Y], src[BASE_Y:]
    out = np.zeros_like(src)
    paste(out, base, BASE_Y)
    sh = widen(nn_rows(shaft, shaft.shape[0] - drop), 2 if drop >= 2 else 0)
    shaft_top = BASE_Y - sh.shape[0]
    rim_top = shaft_top - rim.shape[0]
    tip_top = rim_top - tip.shape[0] - lift

    a = math.radians(az)
    bx, depth = CX + SHAFT_R * math.sin(a), math.cos(a)
    behind = depth < -0.2
    by = shaft_top + 2 + bud / 2 + bud_dy
    if bud and behind:  # drawn first, so the shaft covers all but the rim that shows past its edge
        disc(out, bx, by, bud, BUD_SKIN, BUD_SHADE, RIM_DARK)
    paste(out, sh, shaft_top)
    paste(out, rim, rim_top)
    paste(out, tip, tip_top)
    if lift:  # the open seam under the cap: shadow at its ends, essence glow in its middle, hottest low and central
        foot = np.nonzero(tip[-1, :, 3] > 0)[0]
        half = (foot.max() - foot.min()) / 2 - 1
        for y in range(rim_top - lift, rim_top):
            up = rim_top - 1 - y  # 0 on the rim
            for x in range(foot.min() + 1, foot.max()):
                t = abs(x + 0.5 - CX) / half
                if t > 1:
                    continue
                c = SHADOW if t > 0.75 - 0.2 * up else GLOW_HOT if (t < 0.3 and up == 0) else GLOW
                out[y, x] = (*c, 255)
    if bud and not behind:
        disc(out, bx, by, bud, BUD_SKIN, BUD_SHADE, RIM_DARK)
    if burst:
        splat(out, bx, 84 + int(3 * depth), burst)
    return out


def to48(f96):
    """2x2 block reduction aligned like the shipped 48 px s-idle (48 row i = 96 rows 2i+2, 2i+3)."""
    pad = np.zeros((100, 96, 4), dtype=f96.dtype)
    pad[:96] = f96
    out = np.zeros((48, 48, 4), dtype=f96.dtype)
    for i in range(48):
        for j in range(48):
            blk = pad[2 * i + 2:2 * i + 4, 2 * j:2 * j + 2].reshape(-1, 4)
            op = blk[blk[:, 3] > 128]
            if len(op) < 2:
                continue
            cols, n = np.unique(op[:, :3], axis=0, return_counts=True)
            best = max(range(len(cols)), key=lambda k: (n[k], -int(cols[k].sum())))
            out[i, j] = (*cols[best], 255)
    return out


THEMES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "public", "themes")
PACKS = {"swampspace-hires": "96", "swampspace": "48"}
KIND, ARCH = "hive-spire", "hivespire"


def install(out, clips):
    """Copy the frames into both packs and key them: per direction the legacy idle/step pair (the s still, which
    is now s idle-0), then each clip's <state>-<n>. The manifest keeps its own indent and key order."""
    for pack, px in PACKS.items():
        chars = os.path.join(THEMES, pack, "chars")
        for f in sorted(os.listdir(os.path.join(out, px))):
            shutil.copyfile(os.path.join(out, px, f), os.path.join(chars, f"{KIND}-{f}"))
        shutil.copyfile(os.path.join(out, px, "s-idle-0.png"), os.path.join(chars, f"{KIND}-s-idle.png"))
        mpath = os.path.join(THEMES, pack, "manifest.json")
        text = open(mpath).read()
        indent = len(text.splitlines()[1]) - len(text.splitlines()[1].lstrip())
        m = json.loads(text)
        sprites = {}
        for k, v in m["sprites"].items():
            if not k.startswith(f"char.{ARCH}."):
                sprites[k] = v
                continue
            if f"char.{ARCH}.s-idle" in sprites:
                continue
            for d in DIRS:
                sprites[f"char.{ARCH}.{d}-idle"] = sprites[f"char.{ARCH}.{d}-step"] = f"chars/{KIND}-s-idle.png"
                for c in clips:
                    for n in range(8):
                        sprites[f"char.{ARCH}.{d}-{c}-{n}"] = f"chars/{KIND}-{d}-{c}-{n}.png"
        m["sprites"] = sprites
        with open(mpath, "w") as fh:
            json.dump(m, fh, indent=indent, ensure_ascii=False)
            fh.write("\n")
        print(f"{pack}: {sum(k.startswith(f'char.{ARCH}.') for k in sprites)} {ARCH} keys")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--attack", action="store_true")
    ap.add_argument("--install", action="store_true", help="copy into both theme packs and key the manifests")
    a = ap.parse_args()
    src = np.asarray(Image.open(a.src).convert("RGBA")).copy()
    src[src[..., 3] <= 128] = 0
    clips = {"idle": IDLE}
    if a.attack:
        clips["attack"] = ATTACK
    for px in (96, 48):
        os.makedirs(os.path.join(a.out, str(px)), exist_ok=True)
    for d, az in DIRS.items():
        for name, k in clips.items():
            for n in range(8):
                f = frame(src, az, k["drop"][n], k["lift"][n], k["bud"][n], k.get("bud_dy", [0] * 8)[n],
                          k.get("burst", [0] * 8)[n])
                Image.fromarray(f).save(os.path.join(a.out, "96", f"{d}-{name}-{n}.png"))
                Image.fromarray(to48(f)).save(os.path.join(a.out, "48", f"{d}-{name}-{n}.png"))
    if a.install:
        install(a.out, clips)
    print(a.out)


if __name__ == "__main__":
    main()
