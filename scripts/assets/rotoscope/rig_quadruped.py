#!/usr/bin/env python3
"""A periodic four-legged trot in place for skeleton.py, fitted to one keyframe. No Blender: the joints are
placed on the keyframe by hand (a JSON of screen points at the Wan clip's 848x480) and animated there.

  python3 rig_quadruped.py fit.json --out <dir> [--period 16] [--stride 40] [--lift 22]
  python3 skeleton.py <dir> --stick 5 --ref keyframe.png

The legs move in diagonal pairs (a trot): fore_near with hind_far, then fore_far with hind_near.

fit.json holds head_top, neck, withers, rump, and for each leg L in fore_near, fore_far, hind_near,
hind_far: L_top, L_mid, L_low, L_toe (shoulder or hip, elbow or knee, wrist or ankle, toe), each [x, y],
plus az and elev: the facing in degrees from screen right toward away from the camera, and the camera's
elevation. Each leg works in the plane of the walk direction and screen up, and keeps the bend direction
its fitted mid joint shows. Writes joints-NN.json, the layout skeleton.py reads.
"""
import argparse
import json
import math
import os

PAIRS = {"fore_near": 0.0, "hind_far": 0.0, "fore_far": 0.5, "hind_near": 0.5}


def foot(phase, stride, lift, stance):
    """(along the walk direction, height, toe drop 0-1) for one foot. Forward-most at phase 0."""
    p = phase % 1.0
    if p < stance:
        return stride * (1 - 2 * p / stance), 0.0, 0.0
    s = (p - stance) / (1 - stance)
    e = s * s * (3 - 2 * s)
    return stride * (2 * e - 1), lift * math.sin(math.pi * s), math.sin(math.pi * s)


def two_bone(u, v, a_len, b_len, bend):
    """Two-bone IK from the origin to (u, v): the middle joint, on the side `bend` (+1 or -1) of the line."""
    d = max(1e-6, min(math.hypot(u, v), a_len + b_len - 1e-3))
    a = (a_len * a_len - b_len * b_len + d * d) / (2 * d)
    h = math.sqrt(max(0.0, a_len * a_len - a * a))
    ux, uy = u / d, v / d
    return a * ux - bend * h * uy, a * uy + bend * h * ux


def build(fit, period, stride, lift, stance, bob):
    az, elev = math.radians(fit["az"]), math.radians(fit["elev"])
    fwd = (math.cos(az), -math.sin(az) * math.sin(elev))  # one unit of walking on screen, x right y down
    assert abs(fwd[0]) > 0.2, "this rig needs a view with some sideways travel (se, e, ne)"

    def to_uv(p, o):  # screen offset p - o -> (along the walk, up)
        u = (p[0] - o[0]) / fwd[0]
        return u, -((p[1] - o[1]) - u * fwd[1])

    def to_xy(o, u, v):
        return [o[0] + u * fwd[0], o[1] + u * fwd[1] - v]

    legs = {}
    for L in PAIRS:
        top, mid, low = fit[f"{L}_top"], fit[f"{L}_mid"], fit[f"{L}_low"]
        mu, mv = to_uv(mid, top)
        lu, lv = to_uv(low, top)
        bend = 1.0 if (lu * mv - lv * mu) > 0 else -1.0
        legs[L] = dict(a=math.hypot(mu, mv), b=math.hypot(lu - mu, lv - mv), bend=bend)

    frames = []
    for i in range(period):
        phi = i / period
        drop = bob * (1 - math.cos(4 * math.pi * phi)) / 2  # down twice a cycle, once per diagonal pair
        moved = lambda p: [p[0], p[1] + drop]  # noqa: E731
        chains = {}
        for L, off in PAIRS.items():
            l = legs[L]
            d, h, toe = foot(phi + off, stride, lift, stance)
            top = moved(fit[f"{L}_top"])
            low = to_xy(fit[f"{L}_low"], d, h)  # the ground stays put: measured from the rest foot
            u, v = to_uv(low, top)
            mu, mv = two_bone(u, v, l["a"], l["b"], l["bend"])
            mid = to_xy(top, mu, mv)
            rest_toe = [fit[f"{L}_toe"][0] - fit[f"{L}_low"][0], fit[f"{L}_toe"][1] - fit[f"{L}_low"][1]]
            toe_pt = [low[0] + rest_toe[0] * (1 - 0.3 * toe), low[1] + rest_toe[1] + 10 * toe]
            root = moved(fit["withers"] if L.startswith("fore") else fit["rump"])
            chains[L] = [root, top, mid, low, toe_pt]
        body = [moved(fit[k]) for k in ("head_top", "neck", "withers", "rump")]
        frames.append({"w": 848, "h": 480, "body": [p + [0.0] for p in body],
                       "legs": {k: [p + [1.0 if "near" in k else 2.0] for p in c] for k, c in chains.items()}})
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fit")
    ap.add_argument("--out", required=True)
    ap.add_argument("--period", type=int, default=16)
    ap.add_argument("--stride", type=float, default=40.0, help="half a stride along the walk direction, px")
    ap.add_argument("--lift", type=float, default=22.0)
    ap.add_argument("--stance", type=float, default=0.5, help="share of the cycle a foot is down; a trot is 0.5")
    ap.add_argument("--bob", type=float, default=4.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    frames = build(json.load(open(a.fit)), a.period, a.stride, a.lift, a.stance, a.bob)
    for i, f in enumerate(frames):
        json.dump(f, open(os.path.join(a.out, f"joints-{i:02d}.json"), "w"))
    print(f"{len(frames)} frames -> {a.out}")


if __name__ == "__main__":
    main()
