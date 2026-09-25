#!/usr/bin/env python3
"""Textured map previews of WALL CAPS (the lit top strip on wall tiles), composed
without a browser (headless WebGL is unreliable on the dev box).

Mirrors src/render/tilemap.ts + src/render/wallCaps.ts:

  --mode before   the art as-is: every wall tile wears whatever cap its sprite
                  has baked in (historically: always along the NORTH edge, so a
                  vertical wall run reads as a ladder of grey dashes).
  --mode after    capless wall bodies + `tile.<wall|hull>.cap` strips laid on
                  every edge that faces open ground (rotated to that edge), plus
                  `.cap.inner` nubs in concave corners — the cap line runs
                  continuously along runs, corners and T-junctions.

Bevelled corner tiles (ids 6-9) are drawn over the ground they expose, with the
cap following the 45-degree cut in `after` mode.

    pnpm exec tsx scripts/assets/dump_complex_levels.mts /tmp/levels.json 3:3 3:4
    python3 scripts/assets/wall_caps_preview.py /tmp/levels.json OUT_DIR --mode after
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from indoor_preview import (ACCENT_EVERY, BIOME_TINT, THEME, TILE_ID,  # noqa: E402
                            coord_hash, pick_variant)

WALLS = {3, 6, 7, 8, 9, 14}
CUT_OUTSIDE = {6: (-1, -1), 7: (1, -1), 8: (1, 1), 9: (-1, 1)}
SIDES = {"n": (0, -1), "e": (1, 0), "s": (0, 1), "w": (-1, 0)}
QUARTER = {"n": 0, "e": 1, "s": 2, "w": 3}  # clockwise quarter turns from the N-authored strip
CORNERS = {"nw": ("n", "w", -1, -1, 0), "ne": ("n", "e", 1, -1, 1),
           "se": ("s", "e", 1, 1, 2), "sw": ("s", "w", -1, 1, 3)}


def load_theme(px):
    m = json.load(open(os.path.join(THEME, "manifest.json")))
    sp, macro = m["sprites"], m.get("macroTiles", {})

    def load(f, mode="RGB"):
        return np.asarray(Image.open(os.path.join(THEME, f)).convert(mode).resize((px, px), Image.NEAREST), np.float32)

    def pool(key):
        v = sp.get(key)
        return [load(f) for f in (v if isinstance(v, list) else [v])] if v else []

    pools = {n: pool(f"tile.{n}") for n in TILE_ID}
    accents = {n: pool(f"tile.{n}.accent") for n in TILE_ID}
    caps = {}
    for fam in ("wall", "hull"):
        e, i = sp.get(f"tile.{fam}.cap"), sp.get(f"tile.{fam}.cap.inner")
        if e and i:
            caps[fam] = (load(e if isinstance(e, str) else e[0], "RGBA"), load(i if isinstance(i, str) else i[0], "RGBA"))
    return pools, accents, macro, caps


def over(cell, rgba, mask=None):
    a = rgba[..., 3:4] / 255.0
    if mask is not None:
        a = a * mask[..., None]
    cell[:] = cell * (1 - a) + rgba[..., :3] * a


def cut_mask(tid, px):
    """1 inside the KEPT wall polygon of a bevel tile (the cut is half a tile)."""
    dx, dy = CUT_OUTSIDE[tid]
    yy, xx = np.mgrid[0:px, 0:px] + 0.5
    u = xx / px if dx < 0 else 1 - xx / px
    v = yy / px if dy < 0 else 1 - yy / px
    return (u + v >= 0.5).astype(np.float32)


def diagonal_cap(tid, strip, px):
    """The edge-cap strip laid along the bevel's hypotenuse, inside the kept area."""
    dx, dy = CUT_OUTSIDE[tid]
    yy, xx = np.mgrid[0:px, 0:px] + 0.5
    u = xx / px if dx < 0 else 1 - xx / px
    v = yy / px if dy < 0 else 1 - yy / px
    d = (u + v - 0.5) / np.sqrt(2) * px  # inward distance from the cut, in px
    along = ((u - v) / np.sqrt(2) * px) % px
    rows = np.clip(d.astype(int), 0, px - 1)
    out = strip[rows, along.astype(int) % px].copy()
    out[..., 3] *= (d >= 0)
    return out


def compose(level, theme, px, mode):
    pools, accents, macro, caps = theme
    w, h, tiles = level["w"], level["h"], level["tiles"]
    name_by_id = {v: k for k, v in TILE_ID.items()}
    img = np.zeros((h * px, w * px, 3), np.float32)
    ramp = np.linspace(0.42, 0.0, max(2, px // 8))

    def at(x, y):
        return tiles[y * w + x] if 0 <= x < w and 0 <= y < h else None

    def solid(x, y):
        t = at(x, y)
        return t is None or t in WALLS  # off-map counts as wall: no cap on the void

    def art(name, tx, ty):
        if name not in pools or not pools[name]:
            name = "wall" if name in ("wall", "hull") else "floor"
        hsh = coord_hash(tx, ty)
        acc = accents.get(name)
        if acc and hsh % ACCENT_EVERY == 0:
            return acc[(hsh >> 5) % len(acc)].copy()
        return pools[name][pick_variant(len(pools[name]), macro.get(name), tx, ty, hsh)].copy()

    for ty in range(h):
        for tx in range(w):
            t = tiles[ty * w + tx]
            if t in CUT_OUTSIDE:
                dx, dy = CUT_OUTSIDE[t]
                g = at(tx + dx, ty + dy)
                cell = art(name_by_id.get(g, "sidewalk") if g is not None and g not in WALLS else "sidewalk", tx, ty)
                body = pools["wall"][0]
                m = cut_mask(t, px)
                cell = cell * (1 - m[..., None]) + body * m[..., None]
            else:
                cell = art(name_by_id.get(t, "wall" if t in WALLS else "floor"), tx, ty)
            if t not in WALLS:
                for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
                    if at(tx + dx, ty + dy) in WALLS:
                        n = len(ramp)
                        if dy == -1:
                            cell[:n] *= (1 - ramp)[:, None, None]
                        elif dy == 1:
                            cell[-n:] *= (1 - ramp[::-1])[:, None, None]
                        elif dx == -1:
                            cell[:, :n] *= (1 - ramp)[None, :, None]
                        else:
                            cell[:, -n:] *= (1 - ramp[::-1])[None, :, None]
            elif mode == "after":
                fam = "hull" if t == TILE_ID["hull"] else "wall"
                if fam in caps:
                    edge, inner = caps[fam]
                    baked = set()
                    if t in CUT_OUTSIDE:
                        dx, dy = CUT_OUTSIDE[t]
                        baked = {"w" if dx < 0 else "e", "n" if dy < 0 else "s"}
                        m = cut_mask(t, px)
                        for s in baked:
                            over(cell, np.rot90(edge, -QUARTER[s]), m)
                        over(cell, diagonal_cap(t, edge, px), m)
                    for s, (dx, dy) in SIDES.items():
                        if s not in baked and not solid(tx + dx, ty + dy):
                            over(cell, np.rot90(edge, -QUARTER[s]))
                    for c, (a, b, dx, dy, k) in CORNERS.items():
                        (adx, ady), (bdx, bdy) = SIDES[a], SIDES[b]
                        if solid(tx + adx, ty + ady) and solid(tx + bdx, ty + bdy) and not solid(tx + dx, ty + dy):
                            over(cell, np.rot90(inner, -k))
            img[ty * px:(ty + 1) * px, tx * px:(tx + 1) * px] = cell
    tint = BIOME_TINT.get(level.get("biome") or "", 0xFFFFFF)
    img *= np.array([(tint >> 16) & 255, (tint >> 8) & 255, tint & 255], np.float32) / 255
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("levels")
    ap.add_argument("out")
    ap.add_argument("--mode", choices=["before", "after"], required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for lv in json.load(open(args.levels)):
        kind = lv["biome"] or "city"
        tag = f"{args.mode}-seed{lv['seed']}-floor{lv['floor']}-{kind}"
        p = os.path.join(args.out, f"map-{tag}.png")
        compose(lv, load_theme(32), 32, args.mode).save(p)
        print(p)
        # native-res (64px) close-up around the map centre
        full = compose(lv, load_theme(64), 64, args.mode)
        cw, ch = 24, 14
        x0, y0 = (lv["w"] - cw) // 2, (lv["h"] - ch) // 2
        p = os.path.join(args.out, f"closeup-{tag}.png")
        full.crop((x0 * 64, y0 * 64, (x0 + cw) * 64, (y0 + ch) * 64)).save(p)
        print(p)


if __name__ == "__main__":
    main()
