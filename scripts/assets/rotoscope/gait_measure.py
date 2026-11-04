#!/usr/bin/env python3
"""Per-take numbers for one direction's walk frames, as the game draws them: crest, gait, feet, crumbs.

  python3 gait_measure.py --kind mireclaw-stalker --dir se --out cmp-gait shipped=<dir> A=<run>-pal-96/frames

Each <dir> holds <kind>-<dir>-{idle,step,walk-0..7}.png. Prints one JSON line per take and writes
<out>-gait.json plus <out>-foot-kymo.png (x across, time down, three loops: the lowest opaque pixel per
column in the leg band, brighter = lower).

Gait is read from that foot profile B(x, t), per column, by DFT over the loop:
- `lift_px`: mean first-harmonic amplitude over the moving columns. 0 = the legs do not move.
- `k1_share`: first harmonic's share of the AC energy. 1 = one clean cycle per loop, about .27 = white noise.
- `phase_R`: energy-weighted resultant of the columns' phases. Near 1 = every leg moves together (a pulse);
  near 0 = the legs are in different phases, which an alternating gait needs. `--selftest` builds a pulse,
  a two-group alternating gait and frame noise to prove the three numbers separate them.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cast_walk import BG  # noqa: E402
from compare_takes import bone_top  # noqa: E402

WALKS = [f"walk-{i}" for i in range(8)]
LEG_BAND = 0.55  # the leg band starts this far down the walk's union silhouette
LUM = np.array([0.3, 0.6, 0.1])
VISIBLE = 40  # lum under this reads as floor (BG lum is about 18); the gate case's near-black cut


def lum(a):
    return (a[..., :3] * LUM).sum(-1)


def foot_profile(frames):
    """B[t, x]: lowest opaque row per column in the leg band, in rows below the band's top. 0 = nothing there."""
    solid = np.stack([f[..., 3] > 127 for f in frames])
    rows = np.where(solid.any(0).any(1))[0]
    top, bot = rows.min(), rows.max()
    cut = top + int(LEG_BAND * (bot - top))
    band = solid[:, cut:bot + 1]
    h = band.shape[1]
    low = h - np.argmax(band[:, ::-1], axis=1)  # first opaque from the bottom, as a height from band top
    return np.where(band.any(1), low, 0).astype(float)


def gait(frames):
    B = foot_profile(frames)
    F = np.fft.rfft(B - B.mean(0), axis=0) / len(B)
    amp = 2 * np.abs(F)
    power = (np.abs(F[1:]) ** 2) * 2
    power[-1] /= 2  # Nyquist is not doubled
    tot = power.sum(0)
    moving = tot > 0.25  # a column whose foot height changes by under about a pixel carries no phase
    if not moving.any():
        return {"lift_px": 0.0, "k1_share": 0.0, "phase_R": 0.0, "moving_cols": 0}, B
    w = power[0][moving]
    ph = np.angle(F[1][moving])
    return {"lift_px": round(float(amp[1][moving].mean()), 2),
            "k1_share": round(float(w.sum() / tot[moving].sum()), 3),
            "phase_R": round(float(np.abs((w * np.exp(1j * ph)).sum()) / max(w.sum(), 1e-9)), 3),
            "moving_cols": int(moving.sum())}, B


def crumbs(a):
    """Pieces detached from the body by over 2.5 px (the 2026-11-04 gate case's measure of floating crumbs)."""
    lab, n = ndimage.label(a[..., 3] > 0, structure=np.ones((3, 3)))
    if n < 2:
        return 0, 0
    size = np.bincount(lab.ravel())
    size[0] = 0
    gap = ndimage.distance_transform_edt(lab != size.argmax())
    pieces, px = 0, 0
    for c in range(1, n + 1):
        if c != size.argmax() and gap[lab == c].min() > 2.5:
            pieces, px = pieces + 1, px + int(size[c])
    return pieces, px


def feet(frames):
    """How much of the legs survives on the dark floor: lower-half near-black share, the visible share of the
    bottom 15% of the sprite (the feet), and the blobs of visible pixels in its bottom fifth."""
    dark, shown, tips = [], [], []
    for a in frames:
        m = a[..., 3] > 127
        ys = np.where(m.any(1))[0]
        top, bot = ys.min(), ys.max()
        L = lum(a)
        low = m.copy()
        low[:(top + bot) // 2] = False
        dark.append(float((L[low] < VISIBLE).mean()))
        foot = m.copy()
        foot[:bot - int(0.15 * (bot - top))] = False
        shown.append(float((L[foot] >= VISIBLE).mean()))
        band = m & (L >= VISIBLE)
        band[:bot - (bot - top) // 5] = False
        tips.append(ndimage.label(band, structure=np.ones((3, 3)))[1])
    return {"dark_share": round(float(np.mean(dark)), 3), "foot_visible": round(float(np.mean(shown)), 3),
            "tip_blobs": round(float(np.mean(tips)), 1)}


def bone_low(a):
    """Bone-coloured pixels below the crest (bone_top's hue range): the fangs and knee spurs."""
    rgb = a[..., :3] / 255.0
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = np.where(mx > mn, mx - mn, 1)
    hue = 60 * np.where(mx == rgb[..., 0], ((rgb[..., 1] - rgb[..., 2]) / d) % 6, 0)
    sat = np.where(mx > 0, (mx - mn) / np.where(mx > 0, mx, 1), 0)
    solid = a[..., 3] > 127
    ys = np.where(solid.any(1))[0]
    cut = ys.min() + int(0.4 * (ys.max() - ys.min()))
    bone = solid & (hue >= 25) & (hue <= 55) & (sat >= .15) & (sat <= .6) & (mx >= .45) & (mx == rgb[..., 0])
    return int(bone[cut + 1:].sum())


def glints(a):
    """Pale pixels on the legs (lum over 120 in the sprite's lower 45%): motion blur the key left behind."""
    solid = a[..., 3] > 127
    ys = np.where(solid.any(1))[0]
    cut = ys.max() - int(0.45 * (ys.max() - ys.min()))
    return int((solid[cut:] & (lum(a)[cut:] > 120)).sum())


def diff(a, b):
    aa, ab = a[..., 3] > 0, b[..., 3] > 0
    u = aa | ab
    d = (aa != ab) | ((aa & ab) & (np.abs(a[..., :3] - b[..., :3]).sum(2) > 30))
    return float(d[u].mean())


def measure(kind, d, path):
    load = lambda p: np.asarray(Image.open(os.path.join(path, f"{kind}-{d}-{p}.png")).convert("RGBA")).astype(float)  # noqa: E731
    w = [load(p) for p in WALKS]
    idle, step = load("idle"), load("step")
    g, B = gait(w)
    steps = [diff(w[i], w[(i + 1) % 8]) for i in range(8)]
    all10 = [crumbs(a) for a in w + [idle, step]]
    mass = [int((a[..., 3] > 0).sum()) for a in w]
    crest = [bone_top(Image.open(os.path.join(path, f"{kind}-{d}-{p}.png"))) for p in WALKS]
    bbox = [(np.where((a[..., 3] > 0).any(1))[0], np.where((a[..., 3] > 0).any(0))[0]) for a in w]
    return {"crest": round(float(np.mean(crest)), 1), "crest_min": min(crest), "bone_low": round(float(np.mean([bone_low(a) for a in w])), 1),
            "glints": round(float(np.mean([glints(a) for a in w])), 1), "idle_vs_nearest_walk": round(min(diff(idle, x) for x in w), 3),
            "gait": g, "feet": feet(w),
            "crumbs_pieces": sum(p for p, _ in all10), "crumbs_px": sum(x for _, x in all10),
            "wrap_x_step": round(steps[7] / float(np.median(steps[:7])), 2), "step_share": round(float(np.median(steps[:7])), 3),
            "mass": [min(mass), max(mass)], "h": [int(min(y.max() - y.min() + 1 for y, _ in bbox)), int(max(y.max() - y.min() + 1 for y, _ in bbox))],
            "w": [int(min(x.max() - x.min() + 1 for _, x in bbox)), int(max(x.max() - x.min() + 1 for _, x in bbox))]}, B


def kymo(profiles, out, scale=4):
    h = max(b.shape[1] for _, b in profiles)
    canvas = Image.new("RGB", (sum((b.shape[1] * scale + 8) for _, b in profiles), 24 * scale), BG)
    x = 0
    for _, b in profiles:
        t = np.tile(b, (3, 1))
        im = np.clip(t / max(t.max(), 1) * 255, 0, 255).astype(np.uint8)
        canvas.paste(Image.fromarray(im).resize((b.shape[1] * scale, 24 * scale), Image.NEAREST), (x, 0))
        x += b.shape[1] * scale + 8
    canvas.save(out)
    return h


def selftest():
    """The three gait numbers must separate a pulse, an alternating gait and noise."""
    def frame(feet_y):
        a = np.zeros((96, 96, 4))
        a[20:50, 20:76] = (40, 100, 110, 255)
        for x, y in feet_y:
            a[50:y, x:x + 4] = (40, 100, 110, 255)
        return a
    xs = list(range(22, 74, 8))
    pulse = [frame([(x, 80 + round(5 * np.sin(2 * np.pi * t / 8))) for x in xs]) for t in range(8)]
    alt = [frame([(x, 80 + round(5 * np.sin(2 * np.pi * t / 8 + np.pi * (i % 2)))) for i, x in enumerate(xs)]) for t in range(8)]
    wave = [frame([(x, 80 + round(5 * np.sin(2 * np.pi * t / 8 + 2 * np.pi * i / len(xs)))) for i, x in enumerate(xs)]) for t in range(8)]
    r = np.random.default_rng(0)
    noise = [frame([(x, 80 + int(r.integers(-5, 6))) for x in xs]) for _ in range(8)]
    still = [frame([(x, 80) for x in xs]) for _ in range(8)]
    pu, al, wa, no, st = (gait(f)[0] for f in (pulse, alt, wave, noise, still))
    print(json.dumps({"pulse": pu, "alternating": al, "wave": wa, "noise": no, "still": st}))
    ok = pu["phase_R"] > .9 and al["phase_R"] < .3 and wa["phase_R"] < .3 and no["k1_share"] < .6 \
        and pu["k1_share"] > .9 and al["k1_share"] > .9 and st["lift_px"] == 0
    print("selftest", "ok" if ok else "WRONG")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", default="mireclaw-stalker")
    ap.add_argument("--dir", default="se")
    ap.add_argument("--out")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("takes", nargs="*", help="name=dir of frames")
    a = ap.parse_args()
    if a.selftest:
        raise SystemExit(selftest())
    res, prof = {}, []
    for t in a.takes:
        n, p = t.split("=", 1)
        res[n], B = measure(a.kind, a.dir, p)
        prof.append((n, B))
        print(n, json.dumps(res[n]))
    if a.out:
        json.dump(res, open(f"{a.out}-gait.json", "w"), indent=1)
        kymo(prof, f"{a.out}-foot-kymo.png")


if __name__ == "__main__":
    main()
