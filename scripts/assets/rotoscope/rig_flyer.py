#!/usr/bin/env python3
"""A periodic wing-beat flight cycle by rigid parts: no video model. The body is one direction's keyframe; each
wing is one flat textured plate hinged on the body, flapped about the body's travel axis and drawn through an
orthographic camera, so every direction gets the same beat seen from its own side. Frame P equals frame 0 by
construction, so the loop finder sees a seam of 0.

  python3 rig_flyer.py fit.json --out <take dir> [--period 16] [--length 81]

fit.json:
  wing        RGBA texture of the right wing (the one on screen right in the s view), hinge at its left edge
  wing_hinge  [u, v] texture px of the hinge point (u along the span, v along the chord)
  wing_px     3D length of one texture px, in clip px
  elev        camera elevation, degrees
  up, down    the stroke's top and bottom flap angles, degrees above the horizontal
  down_share  share of the cycle in the downstroke (the power stroke)
  bob         clip px the body rises over the downstroke
  lag         phase lag of the body's rise behind the wing, cycles
  dirs: {d: {keyframe, az, hinge: [dx, dy, dz]}}
    keyframe  the direction's body still on a plain white backdrop (any size; keyed and scaled by `body_h`)
    az        facing, degrees: s 0, se 45, e 90, ne 135, n 180
    hinge     a wing's hinge from the body centre, clip px: x out to the side, y up, z forward; the other
              wing mirrors x
  outline_px  dark rim drawn under each wing at clip scale (about 4 for one pixel at 96)
  body_h      body height in clip px; centre      [x, y] clip px of the body centre (its bbox centre)

Writes <out>/raw/walk-<d>/NNNN.png (848x480, white), <out>/raw/<d>-keyframe.png and a sheet.json whose loop is
spritesheet's own pick, the layout `cast_walk.py assemble --take <d>=<out>` reads.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import spritesheet as S  # noqa: E402

W, H = 848, 480


def flap(phi, up, down, share):
    """Flap angle in degrees at cycle phase phi: an eased fall from `up` to `down` over `share` of the cycle (the
    power stroke), then an eased rise back."""
    p = phi % 1.0
    if p < share:
        s = p / share
        return up + (down - up) * (1 - math.cos(math.pi * s)) / 2
    s = (p - share) / (1 - share)
    return down + (up - down) * (1 - math.cos(math.pi * s)) / 2


def basis(az):
    """World: x screen right, y up, z toward the camera. Facing f, the body's right r (its own right hand)."""
    a = math.radians(az)
    f = np.array([math.sin(a), 0.0, math.cos(a)])
    r = np.array([-math.cos(a), 0.0, math.sin(a)])
    return f, r


def project(v, elev):
    """Orthographic camera above the south: screen (x right, y down) and depth toward the camera."""
    e = math.radians(elev)
    return np.array([v[0], -v[1] * math.cos(e) + v[2] * math.sin(e)]), v[2] * math.cos(e) + v[1] * math.sin(e)


def plate(tex, origin, su, sv, min_px=3.0):
    """Draw texture `tex` as the affine image origin + u*su + v*sv (screen px per texture px) on a WxH layer.
    A plate seen edge-on keeps `min_px` of thickness so it never vanishes."""
    n = np.array([-su[1], su[0]])
    nl = np.linalg.norm(n)
    if nl > 1e-6:
        n /= nl
        thick = abs(float(sv @ n)) * tex.height
        if thick < min_px:
            sv = sv + n * (min_px - thick) / tex.height * (1 if sv @ n >= 0 else -1)
    m = np.array([[su[0], sv[0]], [su[1], sv[1]]])
    inv = np.linalg.inv(m)
    c = -inv @ origin
    return tex.transform((W, H), Image.AFFINE, (inv[0, 0], inv[0, 1], c[0], inv[1, 0], inv[1, 1], c[1]),
                         resample=Image.BICUBIC)


def outlined(layer, px):
    """A dark rim `px` clip px wide under a plate. The texture's own outline shrinks with the plate's scale and is
    gone by 96 px; this one is drawn at clip scale, so it survives the reduction as about one pixel."""
    if px <= 0:
        return layer
    from scipy import ndimage
    a = np.asarray(layer)[..., 3] > 96
    rim = ndimage.binary_dilation(a, iterations=round(px))
    out = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    rimarr = np.zeros((layer.height, layer.width, 4), np.uint8)
    rimarr[rim] = (20, 26, 22, 255)
    out.alpha_composite(Image.fromarray(rimarr, "RGBA"))
    out.alpha_composite(layer)
    return out


def body_layer(path, body_h):
    im = Image.open(path).convert("RGB")
    k = S.key_background(im)
    b = S.bbox(k)
    k = k.crop(b)
    s = body_h / k.height
    return k.resize((max(1, round(k.width * s)), round(body_h)), Image.LANCZOS)


def frames(fit, d, period):
    cfg = fit["dirs"][d]
    body = body_layer(cfg["keyframe"], fit["body_h"])
    tex = Image.open(fit["wing"]).convert("RGBA")
    hu, hv = fit["wing_hinge"]
    k = fit["wing_px"]
    f, r = basis(cfg["az"])
    up = np.array([0.0, 1.0, 0.0])
    cx, cy = fit["centre"]
    out = []
    for i in range(period):
        phi = i / period
        th = math.radians(flap(phi, fit["up"], fit["down"], fit["down_share"]))
        rise = fit["bob"] * math.sin(2 * math.pi * (phi - fit["lag"]))  # highest just after the power stroke
        centre = np.array([cx, cy - rise])
        layers = []
        for side in (1, -1):
            hx, hy, hz = cfg["hinge"]
            hinge3 = r * abs(hx) * side + up * hy + f * hz
            hs, hdepth = project(hinge3, fit["elev"])
            # the span points outward from the hinge; on the body's right side it runs screen-left in the s view,
            # so the affine itself mirrors the texture for that wing
            span3 = (r * side * math.cos(th) + up * math.sin(th)) * k
            chord3 = f * k  # texture v runs from the trailing edge (top of the drawn wing) forward
            su, _ = project(span3, fit["elev"])
            sv, _ = project(chord3, fit["elev"])
            origin = centre + hs - su * hu - sv * hv
            mid, mdepth = project(hinge3 + span3 * tex.width / 2, fit["elev"])
            layers.append((mdepth, outlined(plate(tex, origin, su, sv), fit.get("outline_px", 0))))
        frame = Image.new("RGBA", (W, H), (255, 255, 255, 255))
        bl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        bl.paste(body, (round(centre[0] - body.width / 2), round(centre[1] - body.height / 2)))
        for depth, layer in sorted(layers, key=lambda t: t[0]):
            if depth <= 0.5:  # behind or level with the body centre
                frame.alpha_composite(layer)
        frame.alpha_composite(bl)
        for depth, layer in sorted(layers, key=lambda t: t[0]):
            if depth > 0.5:
                frame.alpha_composite(layer)
        out.append(frame.convert("RGB"))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fit")
    ap.add_argument("--out", required=True)
    ap.add_argument("--dirs", default="s,se,e,ne,n")
    ap.add_argument("--period", type=int, default=16)
    ap.add_argument("--length", type=int, default=81)
    ap.add_argument("--base", help="a sheet.json to copy (method, kind, dirs, poses); default: a synthetic one")
    a = ap.parse_args()
    fit = json.load(open(a.fit))
    here = os.path.dirname(os.path.abspath(a.fit))  # relative paths in fit.json are from its own folder
    fit["wing"] = os.path.join(here, fit["wing"])
    for c in fit["dirs"].values():
        c["keyframe"] = os.path.join(here, c["keyframe"])
    meta = json.load(open(a.base)) if a.base else {
        "method": "video", "seed": 0, "input": fit.get("input", ""), "kind": fit.get("kind", ""), "motion": "walk",
        "loops": {}, "models": {}, "mirrored": [], "palette": "swampspace", "canvas": 96,
        "dirs": ["s", "se", "e", "ne", "n"],
        "poses": ["idle", "step"] + [f"walk-{i}" for i in range(8)], "frames": {},
        "note": "rig_flyer.py: rigid-parts wing-beat cycle, no video model"}
    for d in a.dirs.split(","):
        cyc = frames(fit, d, a.period)
        raw = os.path.join(a.out, "raw", f"walk-{d}")
        os.makedirs(raw, exist_ok=True)
        clip = [cyc[i % a.period] for i in range(a.length)]
        for i, im in enumerate(clip):
            im.save(os.path.join(raw, f"{i:04d}.png"))
        cyc[0].save(os.path.join(a.out, "raw", f"{d}-keyframe.png"))
        meta["loops"][d] = S.find_loop(clip)
        print(d, "loop", {k: v for k, v in meta["loops"][d].items() if k in ("period", "start", "seam")}, flush=True)
    json.dump(meta, open(os.path.join(a.out, "sheet.json"), "w"), indent=1)
    json.dump(fit, open(os.path.join(a.out, "fit.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
