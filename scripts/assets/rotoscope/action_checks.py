#!/usr/bin/env python3
"""Post-step fixes and gates for a drawn action clip, judged against the character's SHIPPED idle in the
same facing (the frame the clip cuts in from).

  python3 action_checks.py face  IDLE.png FRAME.png ...        # exit 1 when a frame's face is gone (or appears)
  python3 action_checks.py snap  IDLE.png --learn F0.png --cut Y0 [--cut-for FRAME=Y ...] FRAME.png ... --out DIR
  python3 action_checks.py drift IDLE.png FRAME.png ...        # per-band colour share vs the idle (a report)

face   The owner, 11-06: "the mocap weapon draw sprite also makes the character's face disappear at the end."
       Fun-Control redrew the head as its back when the retargeted skeleton nodded. Per frame, the head box
       (the top fifth of the figure, across the columns of its top rows) is read for SKIN pixels (the
       palette's warm light tones: hue 18-45, saturation .25-.65, value > .55; the copper hair is far
       redder and more saturated). Against the idle in the same facing:
         - a facing that shows the face (idle skin >= MIN_FACE px): fail when the frame has under 60% of the
           idle's skin, or when its skin sits on the other side of the head (a side view turned away);
         - a back view (idle skin < MIN_FACE): fail when skin appears (a face where the back of the head is).
snap   The trouser drift (the shipped idle's brown, the clip's blue-grey): a palette MAP learned from the
       clip's own rest frame (`--learn`, the frame posed as the idle) against the shipped idle, pixel by
       pixel after registration, separately above and below the belt (`--cut`, the pelvis row in sprite
       px), so a grey that is the shirt above the belt and the trousers below it maps to each. A colour
       maps only on a clear majority (>= 60% of >= 4 votes); anything unlearned (the gun, a raised arm's
       sleeve seen only later) keeps its colour. Applied to every frame of that facing.
"""
import argparse
import colorsys
import json
import os
import sys

import numpy as np
from PIL import Image

MIN_FACE = 10
HEAD_SHARE = 0.20


def rgba(path_or_im):
    im = path_or_im if isinstance(path_or_im, Image.Image) else Image.open(path_or_im)
    return np.asarray(im.convert("RGBA"))


def is_skin(rgb):
    r, g, b = (float(v) / 255 for v in rgb)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return 18 <= h * 360 <= 45 and 0.25 <= s <= 0.65 and v > 0.55


def head_box(a):
    """(y0, y1, x0, x1) of the head: the top HEAD_SHARE of the figure, across its top rows' columns."""
    ys, xs = np.nonzero(a[..., 3] > 0)
    if len(ys) == 0:
        return None
    top, H = ys.min(), ys.max() - ys.min() + 1
    y1 = top + max(4, int(round(HEAD_SHARE * H)))
    crown = (ys < top + max(3, int(0.12 * H)))
    x0, x1 = xs[crown].min() - 2, xs[crown].max() + 3
    return int(top), int(y1), int(max(0, x0)), int(min(a.shape[1], x1))


def face_stats(a):
    """(skin px, skin centroid offset from the head box centre as a share of its width, head box)."""
    box = head_box(a)
    if box is None:
        return 0, 0.0, None
    y0, y1, x0, x1 = box
    sub = a[y0:y1, x0:x1]
    m = sub[..., 3] > 0
    skin = np.zeros(m.shape, bool)
    cache = {}
    for y, x in zip(*np.nonzero(m)):
        c = tuple(int(v) for v in sub[y, x, :3])
        if c not in cache:
            cache[c] = is_skin(c)
        skin[y, x] = cache[c]
    n = int(skin.sum())
    if n == 0:
        return 0, 0.0, box
    cx = np.nonzero(skin)[1].mean()
    return n, float((cx - (x1 - x0 - 1) / 2) / max(1, x1 - x0)), box


def face_verdict(idle, frame):
    """(ok, reason, stats) for one frame against the idle of its facing."""
    si, oi, _ = face_stats(rgba(idle))
    sf, of, box = face_stats(rgba(frame))
    st = {"idle_skin": si, "idle_off": round(oi, 2), "skin": sf, "off": round(of, 2), "head": box}
    if si >= MIN_FACE:
        if sf < 0.6 * si:
            return False, f"face gone: {sf} skin px in the head vs the idle's {si}", st
        if abs(oi) > 0.12 and of * oi < 0 and abs(of) > 0.08:
            return False, f"head turned away: face on the other side ({of:+.2f} vs the idle's {oi:+.2f})", st
        return True, "face reads", st
    if sf > max(MIN_FACE, 3 * si):
        return False, f"a face where the back of the head should be: {sf} skin px vs the idle's {si}", st
    return True, "back of the head reads", st


def register(frame, idle, reach=4):
    """The integer (dx, dy) that best overlays frame's alpha on idle's."""
    best = None
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            sh = np.roll(np.roll(frame[..., 3] > 0, dy, 0), dx, 1)
            err = int((sh != (idle[..., 3] > 0)).sum())
            if best is None or err < best[0]:
                best = (err, dx, dy)
    return best[1], best[2]


def learn_map(idle, rest, cut, min_votes=3, share=0.5):
    """{(band, colour): idle colour} from the clip's rest frame against the shipped idle, plus per band
    the idle's own colours there (key (band, None)): the family an unlearned shade is mapped into."""
    dx, dy = register(rest, idle)
    r = np.roll(np.roll(rest, dy, 0), dx, 1)
    cut = cut + dy
    both = (r[..., 3] > 0) & (idle[..., 3] > 0)
    votes = {}
    for y, x in zip(*np.nonzero(both)):
        band = int(y >= cut)
        k = (band, tuple(int(v) for v in r[y, x, :3]))
        votes.setdefault(k, {}).setdefault(tuple(int(v) for v in idle[y, x, :3]), 0)
        votes[k][tuple(int(v) for v in idle[y, x, :3])] += 1
    out = {}
    rows = np.arange(idle.shape[0])[:, None]
    for band in (0, 1):
        sel = (idle[..., 3] > 0) & ((rows >= cut - dy) if band else (rows < cut - dy))
        cols, n = np.unique(idle[sel][:, :3], axis=0, return_counts=True)
        out[(band, None)] = [tuple(int(v) for v in c) for c, k in zip(cols, n) if k >= 3]
    for k, v in votes.items():
        tot = sum(v.values())
        best, n = max(v.items(), key=lambda kv: kv[1])
        if tot >= min_votes and n >= share * tot and best != k[1]:
            out[k] = best
    return out


def _lum(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def extend_map(cmap, colour, band, near=45.0):
    """The target for a colour the rest frame never showed in this band (a shade the trousers only take
    when the knee bends): the target family of its nearest learned source colour, shaded by the same
    luminance step. None when nothing learned is within `near`."""
    src = [(k[1], v) for k, v in cmap.items() if k[0] == band and k[1] is not None]
    if not src:
        return None
    d, s, t = min((float(np.linalg.norm(np.subtract(colour, s))), s, t) for s, t in src)
    if d > near:
        return None
    warm = lambda c: c[0] - c[2] > 8  # noqa: E731  # the idle's browns vs its greys and blacks
    family = [f for f in cmap.get((band, None), []) if warm(f) == warm(t)] or [t]
    want = _lum(t) + _lum(colour) - _lum(s)
    return min(family, key=lambda f: abs(_lum(f) - want))


def apply_map(a, cut, cmap):
    a = a.copy()
    m = a[..., 3] > 0
    memo = {}
    for y, x in zip(*np.nonzero(m)):
        k = (int(y >= cut), tuple(int(v) for v in a[y, x, :3]))
        if k not in memo:
            memo[k] = cmap.get(k) or extend_map(cmap, k[1], k[0])
        if memo[k] is not None:
            a[y, x, :3] = memo[k]
    return a


def band_share(idle, frame, cut_idle, cut_frame):
    """Per band, the share of the frame's opaque pixels whose colour the idle's same band never uses."""
    out = {}
    for band in (0, 1):
        def cols(a, cut):
            m = a[..., 3] > 0
            rows = np.arange(a.shape[0])[:, None]
            sel = m & ((rows >= cut) if band else (rows < cut))
            return a[sel][:, :3]
        ci = {tuple(c) for c in cols(idle, cut_idle)}
        cf = cols(frame, cut_frame)
        out[["above", "below"][band]] = round(float(np.mean([tuple(c) not in ci for c in cf])) if len(cf) else 0.0, 3)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("face")
    p.add_argument("idle")
    p.add_argument("frames", nargs="+")
    p = sub.add_parser("snap")
    p.add_argument("idle")
    p.add_argument("--learn", required=True)
    p.add_argument("--cut", type=int, required=True, help="the belt row (sprite px) in the learn frame")
    p.add_argument("--cut-for", action="append", default=[], help="FRAME=row: this frame's belt row (default --cut)")
    p.add_argument("frames", nargs="+")
    p.add_argument("--out", required=True)
    p = sub.add_parser("drift")
    p.add_argument("idle")
    p.add_argument("--cut", type=int, required=True)
    p.add_argument("frames", nargs="+")
    a = ap.parse_args()
    if a.cmd == "face":
        bad = 0
        for f in a.frames:
            ok, why, st = face_verdict(a.idle, f)
            bad += not ok
            print(f"{'ok  ' if ok else 'FAIL'} {os.path.basename(f)}: {why} {json.dumps(st)}")
        sys.exit(1 if bad else 0)
    if a.cmd == "snap":
        idle = rgba(a.idle)
        cmap = learn_map(idle, rgba(a.learn), a.cut)
        cuts = dict(c.split("=", 1) for c in a.cut_for)
        os.makedirs(a.out, exist_ok=True)
        for f in a.frames:
            cut = int(cuts.get(f, cuts.get(os.path.basename(f), a.cut)))
            Image.fromarray(apply_map(rgba(f), cut, cmap), "RGBA").save(os.path.join(a.out, os.path.basename(f)))
        learned = [k for k in cmap if k[1] is not None]
        print(f"{len(learned)} colour maps learned ({sum(1 for k in learned if k[0])} below the belt) -> {a.out}")
    if a.cmd == "drift":
        idle = rgba(a.idle)
        for f in a.frames:
            print(os.path.basename(f), band_share(idle, rgba(f), a.cut, a.cut))


if __name__ == "__main__":
    main()
