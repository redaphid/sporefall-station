#!/usr/bin/env python3
"""A periodic biped walk-in-place for skeleton.py, fitted to one keyframe. No Blender: the joints are
placed on the keyframe by hand (a JSON of screen points at the Wan clip's 848x480) and animated there.

  python3 rig_biped.py fit.json --out <dir> [--period 20] [--stride 50] [--lift 34] [--swing 34]
  python3 skeleton.py <dir> --stick 5 --ref keyframe.png

fit.json holds head_top, neck, chest, pelvis, shoulder_{near,far}, elbow_{near,far}, hand_{near,far},
hip_{near,far}, knee_{near,far}, ankle_{near,far}, toe_{near,far}, each [x, y], and az, elev: the facing
in degrees from screen right toward away from the camera, and the camera's elevation. A leg works in the
plane of the walk direction and screen up. Writes joints-NN.json, the layout skeleton.py reads.
"""
import argparse
import json
import math
import os

STANCE = 0.6  # of the cycle with the foot on the ground, moving back at constant speed


def foot(phase, stride, lift):
    """(along the walk direction, height, toe drop 0-1) for one foot. Forward-most at phase 0."""
    p = phase % 1.0
    if p < STANCE:
        return stride * (1 - 2 * p / STANCE), 0.0, 0.0
    s = (p - STANCE) / (1 - STANCE)
    e = s * s * (3 - 2 * s)
    return stride * (2 * e - 1), lift * math.sin(math.pi * s), math.sin(math.pi * s)


def knee_in_plane(u, v, thigh, shin):
    """Two-bone IK with the hip at the origin, v up and the ankle at (u, v): the knee, bent forward (+u)."""
    d = max(1e-6, min(math.hypot(u, v), thigh + shin - 1e-3))
    a = (thigh * thigh - shin * shin + d * d) / (2 * d)
    h = math.sqrt(max(0.0, thigh * thigh - a * a))
    ux, uy = u / d, v / d
    return a * ux - h * uy, a * uy + h * ux


def build(fit, period, stride, lift, swing, bob, sway):
    az, elev = math.radians(fit["az"]), math.radians(fit["elev"])
    fwd = (math.cos(az), -math.sin(az) * math.sin(elev))  # one unit of walking on screen, x right y down
    side = (math.sin(az), math.cos(az) * math.sin(elev))  # his right, on screen

    def at(p, u, v=0.0):
        return [p[0] + u * fwd[0], p[1] + u * fwd[1] - v]

    # crouch so the hip reaches the foot at full stride
    legs = {}
    for w in ("near", "far"):
        hip, knee, ankle = fit[f"hip_{w}"], fit[f"knee_{w}"], fit[f"ankle_{w}"]
        thigh, shin = math.dist(hip, knee), math.dist(knee, ankle)
        legs[w] = dict(thigh=thigh, shin=shin, reach=hip[1] - ankle[1])
    longest = min(l["thigh"] + l["shin"] for l in legs.values())
    crouch = longest - math.sqrt(longest * longest - stride * stride) + 2.0

    frames = []
    for i in range(period):
        phi = i / period
        drop = crouch + bob * (1 - math.cos(4 * math.pi * (phi - STANCE / 2))) / 2 * -1
        lean = sway * math.sin(2 * math.pi * (phi - STANCE / 2))  # over the foot that's on the ground
        shift = (lean * side[0], lean * side[1] + drop)
        moved = lambda p, k=1.0: [p[0] + shift[0] * k, p[1] + shift[1] * k]  # noqa: B023
        chains = {}
        for w, off, arm_sign in (("near", 0.0, -1.0), ("far", 0.5, 1.0)):
            l = legs[w]
            d, h, toe = foot(phi + off, stride, lift)
            hip = moved(fit[f"hip_{w}"])
            ankle_rest = fit[f"ankle_{w}"]
            # the ground stays put: the ankle is measured from the rest ankle, not from the moved hip
            ankle = at(ankle_rest, d, h)
            u = (ankle[0] - hip[0]) / max(abs(fwd[0]), 1e-6) * (1 if fwd[0] >= 0 else -1)
            lateral = ankle_rest[0] - fit[f"hip_{w}"][0]
            u = d - shift[0] / fwd[0] if abs(fwd[0]) > 1e-6 else d
            v = -(ankle[1] - hip[1])
            ku, kv = knee_in_plane(u, v, l["thigh"], l["shin"])
            knee = [hip[0] + ku * fwd[0] + lateral * (-kv / (l["thigh"] + l["shin"])), hip[1] - kv + ku * fwd[1]]
            rest_toe = [fit[f"toe_{w}"][0] - ankle_rest[0], fit[f"toe_{w}"][1] - ankle_rest[1]]
            toe_pt = [ankle[0] + rest_toe[0] * (1 - 0.25 * toe), ankle[1] + rest_toe[1] + 16 * toe]
            chains[f"leg-{w}"] = [moved(fit["pelvis"]), hip, knee, ankle, toe_pt]
            # an arm swings against the leg on its own side
            a = arm_sign * swing * math.cos(2 * math.pi * phi)
            shoulder = at(moved(fit[f"shoulder_{w}"]), 0.15 * a)
            elbow = at(moved(fit[f"elbow_{w}"]), 0.5 * a)
            hand = at(moved(fit[f"hand_{w}"]), a, abs(a) * 0.25)
            chains[f"arm-{w}"] = [moved(fit["chest"]), shoulder, elbow, hand]
        body = [moved(fit["head_top"]), moved(fit["neck"]), moved(fit["chest"]), moved(fit["pelvis"])]
        frames.append({"w": 848, "h": 480, "body": [p + [0.0] for p in body],
                       "legs": {k: [p + [1.0 if "near" in k else 2.0] for p in c] for k, c in chains.items()}})
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fit")
    ap.add_argument("--out", required=True)
    ap.add_argument("--period", type=int, default=20)
    ap.add_argument("--stride", type=float, default=50.0, help="half a stride along the walk direction, px")
    ap.add_argument("--lift", type=float, default=34.0)
    ap.add_argument("--swing", type=float, default=34.0)
    ap.add_argument("--bob", type=float, default=6.0)
    ap.add_argument("--sway", type=float, default=3.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    frames = build(json.load(open(a.fit)), a.period, a.stride, a.lift, a.swing, a.bob, a.sway)
    for i, f in enumerate(frames):
        json.dump(f, open(os.path.join(a.out, f"joints-{i:02d}.json"), "w"))
    print(f"{len(frames)} frames -> {a.out}")


if __name__ == "__main__":
    main()
