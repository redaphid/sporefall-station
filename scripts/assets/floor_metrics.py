#!/usr/bin/env python3
"""How loud a floor is, and whether the cast reads on it. Floors must recede.

    python3 floor_metrics.py                      # every ground pool in swampspace-hires
    python3 floor_metrics.py --pool deck tiles/a.png tiles/b.png ...   # candidates

For each floor pool, a 4x4 field of its tiles (laid the way the tilemap lays a
pool, at the shipped 64 px resolution) is measured on luminance:

  sobel   mean Sobel gradient magnitude: high-frequency energy, the "busy" read
  rms     RMS contrast (std of luminance): how far the floor swings in value
  luma    mean luminance

and for the player, a Mireclaw and a pickup:

  below   the sprite body's median luminance minus the floor's (body = opaque
          pixels inside the 1 px ink outline). Positive: the floor sits below it.
  pop     share of body pixels at least 25 levels away from the floor luminance

  dE      median CIELAB distance from the body's pixels to the floor's mean colour
  popE    share of body pixels at least dE 20 from the floor colour

`gate` holds a floor-class pool to the calm indoor decks at 16 px (spread16,
edge16), keeps it near-neutral (chroma), and needs the characters' bodies to sit
above it in value (below) with every cast sprite's lit half well clear of it (lit).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

THEME = Path(__file__).resolve().parents[2] / "public" / "themes" / "swampspace-hires"
W = np.array([0.299, 0.587, 0.114], np.float32)
CAST = {"player": "chars/vine-ranger-s-idle.png", "mireclaw": "chars/mireclaw-stalker-s-idle.png",
        "pickup": "items/biogel-kit.png"}
# The busy read lives in the big shapes, not the fine noise: measured with every tile
# shrunk to 16 px, the rejected deck spreads 16.0 against plating 8.3 and hall 7.9
# (review of #157). A floor must be at least as quiet as those decks.
SPREAD16_MAX = 7.0
EDGE16_MAX = 6.5
# The floor sits below the characters' body value (owner: "floor values should sit
# clearly below the sprites'"), their lit half stands well above it, and the floor
# carries almost no hue, so the cast's teal and green read as theirs alone (the teal
# deck shared the stalker's hue). popE is reported but not gated: the cast's shadow
# half is dark, so no dark floor scores high on it; it peaks with a floor at luma 80+,
# the bright busy city floor this replaces.
BELOW_MIN = 10.0
LIT_MIN = 40.0
CHROMA_MAX = 8.0


def luma(im, px=None):
    im = im.convert("RGB")
    if px:
        im = im.resize((px, px), Image.BOX)
    return np.asarray(im, np.float32) @ W


def lab(rgb):
    """sRGB (0-255, ...x3) -> CIELAB (D65)."""
    c = np.asarray(rgb, np.float32) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]], np.float32)
    xyz /= np.array([0.9505, 1.0, 1.089], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def field(paths, n=4, px=None):
    """Pool tiles laid n x n (each shrunk to `px` first). A pool of 4k tiles is k 2x2
    macro units, laid in blocks."""
    ts = [luma(Image.open(p), px) for p in paths]
    s = ts[0].shape[0]
    units = max(1, len(ts) // 4)
    out = np.zeros((s * n, s * n), np.float32)
    for y in range(n):
        for x in range(n):
            if len(ts) >= 4:
                t = ts[4 * ((y // 2 + x // 2) % units) + (y % 2) * 2 + x % 2]
            else:
                t = ts[(y * 7 + x * 3) % len(ts)]
            out[y * s:(y + 1) * s, x * s:(x + 1) * s] = t
    return out


def sobel(a):
    p = np.pad(a, 1, mode="wrap")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return float(np.hypot(gx, gy).mean())


def edge(a):
    return float((np.abs(np.diff(a, axis=0)).mean() + np.abs(np.diff(a, axis=1)).mean()) / 2)


def body_rgb(rel):
    a = np.asarray(Image.open(THEME / rel).convert("RGBA"), np.float32)
    op = a[..., 3] > 128
    p = np.pad(op, 1)
    inner = op.copy()
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            inner &= p[dy:dy + op.shape[0], dx:dx + op.shape[1]]
    return a[..., :3][inner]


def floor_rgb(paths):
    return np.concatenate([np.asarray(Image.open(p).convert("RGB"), np.float32).reshape(-1, 3) for p in paths]).mean(0)


def body_luma(rel):
    a = np.asarray(Image.open(THEME / rel).convert("RGBA"), np.float32)
    op = a[..., 3] > 128
    p = np.pad(op, 1)
    inner = op.copy()
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            inner &= p[dy:dy + op.shape[0], dx:dx + op.shape[1]]
    return (a[..., :3] @ W)[inner]


def measure(paths):
    f, f16 = field(paths), field(paths, px=16)
    m = {"spread16": round(float(f16.std()), 1), "edge16": round(edge(f16), 1),
         "sobel": round(sobel(f), 1), "rms": round(float(f.std()), 1), "luma": round(float(f.mean()), 1)}
    fl = lab(floor_rgb(paths))
    m["hue"] = round(float(np.degrees(np.arctan2(fl[2], fl[1]))) % 360)
    m["chroma"] = round(float(np.hypot(fl[1], fl[2])), 1)
    for k, rel in CAST.items():
        b = body_luma(rel)
        de = np.linalg.norm(lab(body_rgb(rel)) - fl, axis=-1)
        m[k] = {"below": round(float(np.median(b)) - m["luma"], 1),
                "lit": round(float(np.percentile(b, 75)) - m["luma"], 1),
                "pop": round(float((np.abs(b - m["luma"]) >= 25).mean()), 2),
                "dE": round(float(np.median(de)), 1),
                "popE": round(float((de >= 20).mean()), 2)}
    return m


def pool(name):
    m = json.loads((THEME / "manifest.json").read_text())["sprites"].get(f"tile.{name}")
    return [THEME / p for p in ([m] if isinstance(m, str) else m or [])]


def gate(paths):
    """(metrics, problems) for a floor-class pool."""
    m = measure(paths)
    probs = []
    if m["spread16"] > SPREAD16_MAX:
        probs.append(f"spread16 {m['spread16']} > {SPREAD16_MAX}")
    if m["edge16"] > EDGE16_MAX:
        probs.append(f"edge16 {m['edge16']} > {EDGE16_MAX}")
    if m["chroma"] > CHROMA_MAX:
        probs.append(f"floor chroma {m['chroma']} > {CHROMA_MAX}")
    for k in CAST:
        if m[k]["lit"] < LIT_MIN:
            probs.append(f"{k} lit half only {m[k]['lit']} above the floor < {LIT_MIN}")
        if k != "pickup" and m[k]["below"] < BELOW_MIN:
            probs.append(f"floor not below the {k}: {m[k]['below']} < {BELOW_MIN}")
    return m, probs


def main():
    if "--pool" in sys.argv:
        i = sys.argv.index("--pool")
        m, probs = gate([Path(p) for p in sys.argv[i + 2:]])
        print(sys.argv[i + 1], json.dumps(m), probs or "PASS")
        return
    for name in ("floor", "causeway", "grass", "boardwalk", "hall", "plating", "tiled", "bog", "deck"):
        ps = pool(name)
        if ps:
            print(f"{name:9s} {json.dumps(measure(ps))}")


if __name__ == "__main__":
    main()
