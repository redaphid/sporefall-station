#!/usr/bin/env python3
"""Improved temporally-stable post for the cn1 vine-ranger.

Over the shipped trace.py post it adds two stabilizers that kill the frame-to-
frame "boil" the owner rejected, WITHOUT touching the silhouette (still pinned
by the Blender alpha) or the motion (still the real feet bob + limb swing):

  1. A CHARACTER-LOCKED sub-palette pooled across ALL 40 frames+dirs. The full
     34-colour theme palette lets a flat teal panel wobble between adjacent
     teals frame to frame (micro-shading noise from the AI re-develop). We pool
     every downscaled body pixel across the whole set, k-means to K clusters,
     snap each cluster to its nearest THEME-palette colour (stays on-theme), and
     quantise every frame to THAT ~12-colour set. Adjacent-entry wobble is gone
     because the wobble targets collapse to one entry.

  2. A temporal MODE denoise over the stable-body region (pixels opaque in
     f-1,f,f+1): a colour that disagrees with the 3-frame majority is a one-
     frame sparkle -> snap to the mode. Looser than trace.py's exact-neighbour-
     agreement rule (which a walk cycle rarely satisfies), so it actually fires.

Usage: improve_post.py OUTDIR CANVAS CONTENT KCOLORS
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = "/home/hypnodroid/Projects/mobile-streets-of-rogue/.claude/worktrees/agent-a43934eaf21bdcfea/scripts/assets"
sys.path.insert(0, HERE)
from palette import RGB  # noqa: E402
import post as P          # noqa: E402

_PAL = np.array(RGB, dtype=np.float32)

STAGE = "/tmp/swampspace-stage/rotoscope"
# BLEND (the 1024px proxy color+depth) is shared across every trace resolution;
# TRACED (the AI-restyled frames) can point at a higher-res run via env.
BLEND = os.environ.get("ROTO_BLEND", os.path.join(STAGE, "blender"))
TRACED = os.environ.get("ROTO_TRACED", os.path.join(STAGE, "traced"))
CHAR = "vine-ranger"
DIRS = ["s", "se", "e", "ne", "n"]
FRAMES = list(range(8))

OUTDIR = sys.argv[1]
CANVAS = int(sys.argv[2]) if len(sys.argv) > 2 else 48
CONTENT = int(sys.argv[3]) if len(sys.argv) > 3 else CANVAS - 2
KCOLORS = int(sys.argv[4]) if len(sys.argv) > 4 else 12


def blend_path(d, f):
    return os.path.join(BLEND, f"walk-{d}-{f}.png")


def traced_path(d, f):
    return os.path.join(TRACED, f"walk-{d}-{f}.png")


def union_window(pad=4):
    x0 = y0 = 10**9
    x1 = y1 = -1
    for d in DIRS:
        for f in FRAMES:
            a = np.asarray(Image.open(blend_path(d, f)).convert("RGBA"))[..., 3]
            ys, xs = np.where(a > 24)
            x0, x1 = min(x0, xs.min()), max(x1, xs.max())
            y0, y1 = min(y0, ys.min()), max(y1, ys.max())
    return (int(x0 - pad), int(y0 - pad), int(x1 + 1 + pad), int(y1 + 1 + pad))


def raw_downscaled(d, f, win):
    """Mask traced RGB with Blender alpha (+ the signature-orange rescue from
    trace.py), crop the shared window, k-centroid to content size. Returns a
    uint8 RGBA on the CANVAS (feet-anchored) but BEFORE palette snap."""
    src = Image.open(blend_path(d, f)).convert("RGBA")
    alpha = np.asarray(src)[..., 3]
    rgb = np.asarray(Image.open(traced_path(d, f)).convert("RGB").resize(src.size, Image.LANCZOS))
    bl = np.asarray(src)[..., :3].astype(np.float32)
    r, g, b = bl[..., 0], bl[..., 1], bl[..., 2]
    cap = (r > 140) & (g > 55) & (g < 185) & (b < 95) & (r > g * 1.3) & (alpha > 100)
    rgbf = rgb.astype(np.float32)
    rgbf[cap] = rgbf[cap] * 0.35 + np.float32([255, 144, 50]) * 0.65
    rgb = rgbf.clip(0, 255).astype(np.uint8)
    im = Image.fromarray(np.dstack([rgb, np.where(alpha > 100, 255, 0).astype("uint8")]),
                         "RGBA").crop(win)
    w, h = im.size
    th = CONTENT
    tw = max(1, round(w * th / h))
    small = np.asarray(P.kcentroid(im, tw, th)).astype(np.uint8)
    out = np.zeros((CANVAS, CANVAS, 4), np.uint8)
    x = (CANVAS - tw) // 2
    y = CANVAS - th - 1
    out[y:y + th, x:x + tw] = small
    return out


# Signature accents that MUST survive even though they are a tiny pixel
# fraction (k-means alone drops them, muting the visor/eyes/vine the owner
# named). Forced into the char palette regardless of cluster mass.
_FORCED_HEX = ["#ff9032", "#e04a2a", "#ffd83e", "#46e078", "#3ce0d8",
               "#67873c", "#86a750", "#141a16"]


def _hex(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


FORCED = np.array([_hex(h) for h in _FORCED_HEX], dtype=np.float32)


def build_char_palette(raws, k):
    """Pool every opaque downscaled body pixel across ALL frames, k-means to k,
    snap each centroid to the nearest THEME-palette colour, dedupe, then UNION
    the forced signature accents so the visor/eyes/vine can never drop out."""
    pool = []
    for a in raws:
        px = a[a[..., 3] > 0][:, :3].astype(np.float32)
        pool.append(px)
    pool = np.concatenate(pool, 0)
    # k-means (deterministic init: evenly-spaced by luminance percentile)
    lum = pool @ np.array([0.299, 0.587, 0.114], np.float32)
    order = np.argsort(lum)
    cents = pool[order[np.linspace(0, len(order) - 1, k).astype(int)]].copy()
    for _ in range(12):
        d = ((pool[:, None, :] - cents[None, :, :]) ** 2).sum(-1)
        lab = d.argmin(1)
        for i in range(k):
            m = lab == i
            if m.any():
                cents[i] = pool[m].mean(0)
    # snap each cluster centroid to nearest locked theme colour, dedupe
    d = ((cents[:, None, :] - _PAL[None, :, :]) ** 2).sum(-1)
    snapped = _PAL[d.argmin(1)]
    both = np.concatenate([snapped, FORCED], 0)
    uniq = np.unique(both.astype(np.uint8), axis=0).astype(np.float32)
    # Ban blown-out specular white/light-metal: at 48px k-centroid turns cyan
    # arm highlights into pure #f2f6ea streaks that flicker frame to frame and
    # aren't part of the look. Drop them so those pixels resolve to body teal.
    ban = np.array([_hex(h) for h in ["#f2f6ea", "#a2adb4"]], np.float32)
    keep = np.array([not any((c == b).all() for b in ban) for c in uniq])
    return uniq[keep]


def quantize(a, charpal):
    out = a.copy()
    m = a[..., 3] > 0
    px = a[m][:, :3].astype(np.float32)
    d = ((px[:, None, :] - charpal[None, :, :]) ** 2).sum(-1)
    out_rgb = out[..., :3]
    out_rgb[m] = charpal[d.argmin(1)].astype(np.uint8)
    out[..., 3] = np.where(a[..., 3] > 0, 255, 0)
    return out


def temporal_mode(frames, passes=2):
    """Snap one-frame sparkle to the 3-frame majority over the stable-body
    region (opaque in f-1,f,f+1). Repeats to catch 2-wide wobble."""
    out = [a.copy() for a in frames]
    for _ in range(passes):
        cur = [a.copy() for a in out]
        for f in range(8):
            a, b, c = cur[(f - 1) % 8], cur[f], cur[(f + 1) % 8]
            stable = (a[..., 3] > 0) & (b[..., 3] > 0) & (c[..., 3] > 0)
            # majority: where b disagrees with BOTH neighbours, take neighbour a
            # if a==c (clear mode); else keep b (genuine transition)
            neigh_agree = (a[..., :3] == c[..., :3]).all(-1)
            b_differs = (b[..., :3] != a[..., :3]).any(-1)
            fix = stable & neigh_agree & b_differs
            out[f][fix, :3] = a[fix, :3]
        # second rule: 3-frame temporal median per channel on stable px
        for f in range(8):
            a, b, c = cur[(f - 1) % 8], cur[f], cur[(f + 1) % 8]
            stable = (a[..., 3] > 0) & (b[..., 3] > 0) & (c[..., 3] > 0)
            med = np.median(np.stack([a[..., :3], b[..., :3], c[..., :3]]), 0).astype(np.uint8)
            out[f][stable, :3] = med[stable]
    return out


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    win = union_window()
    print(f"window {win} canvas={CANVAS} content={CONTENT} k={KCOLORS}")
    raws = {(d, f): raw_downscaled(d, f, win) for d in DIRS for f in FRAMES}
    charpal = build_char_palette(list(raws.values()), KCOLORS)
    print(f"char palette ({len(charpal)}): " +
          " ".join("#%02x%02x%02x" % tuple(c.astype(int)) for c in charpal))
    for d in DIRS:
        frames = [quantize(raws[(d, f)], charpal) for f in FRAMES]
        frames = temporal_mode(frames)
        for f in FRAMES:
            Image.fromarray(frames[f], "RGBA").save(
                os.path.join(OUTDIR, f"{CHAR}-{d}-walk-{f}.png"))
    # idle: pick the standing frame per dir. Frame 0 for s (feet together);
    # for the rest reuse walk-0 as idle (engine idles on frame 0 of the cycle).
    for d in DIRS:
        Image.open(os.path.join(OUTDIR, f"{CHAR}-{d}-walk-0.png")).save(
            os.path.join(OUTDIR, f"{CHAR}-{d}-idle.png"))
        # step = walk-4 (opposite stride) for the 2-frame idle/step fallback
        Image.open(os.path.join(OUTDIR, f"{CHAR}-{d}-walk-4.png")).save(
            os.path.join(OUTDIR, f"{CHAR}-{d}-step.png"))
    print(f"wrote {len(os.listdir(OUTDIR))} files to {OUTDIR}")


if __name__ == "__main__":
    main()
