#!/usr/bin/env python3
"""Ship a one-shot action clip (draw, fidget, attack ...) for a character whose walk already shipped.

    python3 scripts/assets/cast_action.py post BASE --kind drowned-diver --state draw \
        --clip s=RUN:1,4,6,8,11,16 [--clip e=...] --out DIR
    python3 scripts/assets/cast_action.py export DIR --kind drowned-diver --state draw [--arch drowner]
    python3 scripts/assets/cast_action.py sheet DIR --kind drowned-diver --state draw

BASE is the walk run the packs were exported from (`.../best-pal`). RUN is a Fun-Control take of the
action (`rig_action.py` + `fun_control.py`): its clip is raw/walk-<dir>/NNNN.png, and the indices pick
the shipped frames in order, the first and last on the rest pose.

post    each frame through its walk direction's own crop window, scale and pixel grid (spritesheet's
        `fixed_windows` on BASE's raws, exactly as export re-posts the walk), extended over the whole
        canvas so a reach past every walk frame is kept; colours snapped to BASE's s-idle palette, then
        the locked palette. Writes DIR/<px>/<kind>-<dir>-<state>-<n>.png for both packs with the take's
        flow embedded, and DIR/post.json: per frame the shift from the shipped idle (registration of
        frame 0) and the share of pixels that differ from it.
export  copies DIR's frames into both packs and sets char.<arch>.<dir>-<state>-<n> for every archetype
        whose keys point at chars/<kind>-*, after that archetype's last key; the take's flows go to
        flows/cast/<kind>/<dir>-<state>.json (+ _api.json). Directions not in DIR are left alone.
sheet   per direction a row: shipped idle | the action frames | shipped idle, at 96 px x3 on the game
        background, and a GIF at 3x playing idle, the action, idle in all directions side by side.
"""
import argparse
import glob
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cast_walk as CW  # noqa: E402
import post as P  # noqa: E402
import spritesheet as S  # noqa: E402
from palette import RGB as LOCKED  # noqa: E402

DIRS = CW.DIRS
PACKS = CW.PACKS


def _clips(specs):
    out = {}
    for spec in specs:
        d, _, rest = spec.partition("=")
        run, _, idx = rest.rpartition(":")
        out[d] = (os.path.abspath(run), [int(i) for i in idx.split(",")])
    return out


def _flow(run, d):
    names = (f"{run}/flow-{d}_api.json", f"{run}/flow-{d}.json")
    return tuple(open(n, "rb").read() if os.path.exists(n) else None for n in names)


def _locked(im):
    """Every opaque pixel onto the locked 34 (the s-idle palette is a subset; this only guards it)."""
    a = np.asarray(im).copy()
    L = np.array(LOCKED, np.float32)
    m = a[..., 3] > 0
    px = a[m][:, :3].astype(np.float32)
    a[..., :3][m] = L[((px[:, None] - L[None]) ** 2).sum(-1).argmin(1)].astype(np.uint8)
    return Image.fromarray(a, "RGBA")


def register(frame, idle, reach=3):
    """(dx, dy, share): the integer shift of `frame` that best matches `idle`'s alpha, and the share of
    the union's pixels that still differ in colour after it."""
    fa, ia = np.asarray(frame), np.asarray(idle)
    best = None
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            sh = np.roll(np.roll(fa, dy, 0), dx, 1)
            err = ((sh[..., 3] > 0) != (ia[..., 3] > 0)).sum()
            if best is None or err < best[0]:
                best = (err, dx, dy, sh)
    _, dx, dy, sh = best
    union = (sh[..., 3] > 0) | (ia[..., 3] > 0)
    diff = union & np.any(sh != ia, -1)
    return int(dx), int(dy), round(float(diff.sum() / max(1, union.sum())), 3)


def cmd_post(a):
    base = os.path.abspath(a.base)
    meta = json.load(open(f"{base}/sheet.json"))
    dirs, poses = meta["dirs"], meta["poses"]
    raws = {(d, p): Image.open(f"{base}/raw/{d}-{p}.png").convert("RGB")
            for d in dirs for p in poses if os.path.exists(f"{base}/raw/{d}-{p}.png")}
    pal = S.anchor_palette(meta["palette_from"])
    backdrop = P.corner_bg(next(iter(raws.values())))
    pockets, band = S.pocket_key(meta.get("input"), backdrop)
    ghost = S.ghost_pal(meta.get("input"), backdrop, pal)
    keyed = S.key_frames(raws, pockets, ghost, S.clip_beside(base, raws, meta.get("loops", {})), band)
    clips = _clips(a.clip)
    shifts = dict(_clips_shift(s) for s in a.shift or [])
    report = {"base": base, "state": a.state, "clips": {d: [r, i] for d, (r, i) in clips.items()}, "frames": {}}
    for pack, (px, content) in PACKS.items():
        union, scale = S.fixed_windows(keyed, dirs, poses, px, content, bool(meta.get("lock_height")))
        os.makedirs(f"{a.out}/{px}", exist_ok=True)
        for d, (run, idx) in clips.items():
            clip = sorted(glob.glob(f"{run}/raw/walk-{d}/*.png"))
            frames = {}
            for n, t in enumerate(idx):
                beside = tuple(Image.open(clip[k]).convert("RGB") for k in (t - 1, t + 1) if 0 <= k < len(clip))
                k = S.shrink_alpha(S.key_background(Image.open(clip[t]).convert("RGB"), pockets=pockets, pal=ghost,
                                                    beside=beside, band=band), 1)
                frames[(d, f"{a.state}-{n}")] = S.post_fixed(k, union[d], scale[d], px, pal, whole=True)
            frames = S.drop_specks(frames, [d], [p for _, p in frames], px)
            idle = Image.open(os.path.join(CW.THEMES, pack, "chars", f"{a.kind}-{d}-idle.png")).convert("RGBA")
            dx, dy = shifts.get(d, (0, 0))
            dx, dy = round(dx * px / 96), round(dy * px / 96)
            prompt, workflow = _flow(run, d)
            for n in range(len(idx)):
                im = _locked(Image.fromarray(np.roll(np.roll(np.asarray(frames[(d, f"{a.state}-{n}")]), dy, 0), dx, 1)))
                f = f"{a.out}/{px}/{a.kind}-{d}-{a.state}-{n}.png"
                im.save(f)
                if prompt and workflow:
                    png = open(f, "rb").read()
                    open(f, "wb").write(CW._with_flow(png, prompt, workflow))
                report["frames"][f"{px}/{d}-{n}"] = register(im, idle)
            print(f"{pack} {d}: {len(idx)} frames; frame 0 vs idle {report['frames'][f'{px}/{d}-0']}, "
                  f"last vs idle {report['frames'][f'{px}/{d}-{len(idx) - 1}']}")
    json.dump(report, open(f"{a.out}/post.json", "w"), indent=1)


def _clips_shift(spec):
    d, _, v = spec.partition("=")
    x, y = v.split(",")
    return d, (int(x), int(y))


def cmd_export(a):
    src = os.path.abspath(a.dir)
    archs = a.arch or CW.archetypes(a.kind)
    if not archs:
        raise SystemExit(f"no archetype's manifest points at chars/{a.kind}-*; pass --arch")
    rep = json.load(open(f"{src}/post.json"))
    for pack, (px, _) in PACKS.items():
        have = {}
        for d in DIRS:
            fs = sorted(glob.glob(f"{src}/{px}/{a.kind}-{d}-{a.state}-*.png"), key=lambda f: int(f.rsplit("-", 1)[1][:-4]))
            if fs:
                have[d] = len(fs)
                for f in fs:
                    shutil.copyfile(f, os.path.join(CW.THEMES, pack, "chars", os.path.basename(f)))
        mpath = os.path.join(CW.THEMES, pack, "manifest.json")
        text = open(mpath).read()
        indent = len(text.splitlines()[1]) - len(text.splitlines()[1].lstrip())
        m = json.loads(text)
        new = {f"char.{arch}.{d}-{a.state}-{n}": f"chars/{a.kind}-{d}-{a.state}-{n}.png"
               for arch in archs for d in DIRS if d in have for n in range(have[d])}
        old = {k: v for k, v in m["sprites"].items() if k not in new and not any(
            k.startswith(f"char.{arch}.{d}-{a.state}-") for arch in archs for d in have)}
        last = {arch: max(i for i, k in enumerate(old) if k.startswith(f"char.{arch}.")) for arch in archs}
        sprites = {}
        for i, (k, v) in enumerate(old.items()):
            sprites[k] = v
            for arch in archs:
                if i == last[arch]:
                    sprites.update({nk: nv for nk, nv in new.items() if nk.startswith(f"char.{arch}.")})
        m["sprites"] = sprites
        with open(mpath, "w") as fh:
            json.dump(m, fh, indent=indent, ensure_ascii=False)
            fh.write("\n")
        print(f"{pack}: {sum(have.values())} frames ({have}), keys for {', '.join(archs)}")
    os.makedirs(os.path.join(CW.FLOWS, a.kind), exist_ok=True)
    for d, (run, _) in rep["clips"].items():
        prompt, workflow = _flow(run, d)
        for name, blob in ((f"{d}-{a.state}_api.json", prompt), (f"{d}-{a.state}.json", workflow)):
            if blob:
                open(os.path.join(CW.FLOWS, a.kind, name), "wb").write(blob)


def cmd_sheet(a):
    src = os.path.abspath(a.dir)
    k, cell = 3, 96 * 3
    rows, gif = [], {}
    for d in DIRS:
        fs = sorted(glob.glob(f"{src}/96/{a.kind}-{d}-{a.state}-*.png"), key=lambda f: int(f.rsplit("-", 1)[1][:-4]))
        if not fs:
            continue
        idle = os.path.join(CW.THEMES, "swampspace-hires", "chars", f"{a.kind}-{d}-idle.png")
        seq = [idle] + fs + [idle]
        rows.append((d, [Image.open(f).convert("RGBA").resize((cell, cell), Image.NEAREST) for f in seq]))
        gif[d] = [Image.open(f).convert("RGBA").resize((cell, cell), Image.NEAREST) for f in [idle] * 3 + fs + [idle] * 4]
    if not rows:
        raise SystemExit(f"no {a.state} frames in {src}/96")
    wmax = max(len(r) for _, r in rows)
    sheet = Image.new("RGB", (40 + wmax * (cell + 6), len(rows) * (cell + 6) + 30), CW.BG)
    dr = ImageDraw.Draw(sheet)
    dr.text((44, 8), f"{a.kind} {a.state}: idle | frames 0..n | idle   (96 px x{k})", fill=(220, 220, 200))
    for r, (d, ims) in enumerate(rows):
        y = 30 + r * (cell + 6)
        dr.text((8, y + cell // 2), d, fill=(220, 220, 200))
        for c, im in enumerate(ims):
            sheet.paste(im, (40 + c * (cell + 6), y), im)
    out = a.out or os.path.join(CW.out_dir(a.kind), "actions")
    os.makedirs(out, exist_ok=True)
    sheet.save(f"{out}/{a.kind}-{a.state}-sheet.png")
    n = max(len(v) for v in gif.values())
    frames = []
    for i in range(n):
        f = Image.new("RGB", (len(gif) * cell, cell), CW.BG)
        for c, (d, ims) in enumerate(gif.items()):
            im = ims[min(i, len(ims) - 1)]
            f.paste(im, (c * cell, 0), im)
        frames.append(f)
    frames[0].save(f"{out}/{a.kind}-{a.state}-3x.gif", save_all=True, append_images=frames[1:], duration=133, loop=0)
    print(f"{out}/{a.kind}-{a.state}-sheet.png\n{out}/{a.kind}-{a.state}-3x.gif")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("post")
    p.add_argument("base")
    p.add_argument("--kind", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--clip", action="append", required=True, help="dir=RUN:i,j,k (clip frame indices, in order)")
    p.add_argument("--shift", action="append", help="dir=dx,dy in 96 px pixels, applied to every frame (registration)")
    p.add_argument("--out", required=True)
    p = sub.add_parser("export")
    p.add_argument("dir")
    p.add_argument("--kind", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--arch", nargs="+")
    p = sub.add_parser("sheet")
    p.add_argument("dir")
    p.add_argument("--kind", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--out")
    a = ap.parse_args()
    {"post": cmd_post, "export": cmd_export, "sheet": cmd_sheet}[a.cmd](a)


if __name__ == "__main__":
    main()
