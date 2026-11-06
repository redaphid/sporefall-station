#!/usr/bin/env python3
"""A periodic four-legged trot in place for skeleton.py, posed on one side-view keyframe. No Blender.

The side-only rig of the PIPELINE-NONBIPED proof (carapace-brute e, docs/pipeline-nonbiped-1105 1f743f30 +
5c602498), kept beside rig_quadruped.py (gloam-hound's, which also does 3/4 and front/back views) so the
proof's fit format (examples/quadruped-fit-carapace-brute-e.json) still runs.

  python3 rig_quadruped.py fit.json --out <dir> [--period 16] [--stride 45] [--lift 30] [--gait trot]
  python3 skeleton.py <dir> --stick 5 --ref keyframe-848.png

The fit is the TARGET posture in Wan clip pixels (848x480), not a trace of the keyframe: a creature drawn
hunched gets a level, raised spine here, and Fun-Control redraws it in that pose. fit.json holds:

  spine:   [[x, y], ...] tail end to head top (the body axis; it bobs as one piece)
  ground:  y of the floor
  far:     [dx, dy] screen offset of the far-side legs from the near-side ones
  fore:    {top, mid, ankle, toe}  near foreleg at rest: shoulder, elbow, wrist, toe tip
  hind:    {top, mid, ankle, toe}  near hind leg at rest: hip, stifle, hock, toe tip

Gaits: `trot` moves diagonal pairs together (near-fore with far-hind, then far-fore with near-hind),
duty 0.5. `walk` is the lateral-sequence four-beat walk (hind, fore, hind, fore a quarter apart), duty
0.7. Every foot's path is a function of phase, so frame `period` equals frame 0 exactly.

Writes joints-NN.json: {"w", "h", "body": [[x, y, z]...], "legs": {name: [[x, y, z]...]}}, z 1 near,
2 far, the layout skeleton.py draws.
"""
import argparse
import json
import math
import os

GAITS = {  # phase offset per leg, stance fraction
    "trot": ({"fore-near": 0.0, "hind-far": 0.0, "fore-far": 0.5, "hind-near": 0.5}, 0.5),
    "walk": ({"hind-near": 0.0, "fore-near": 0.25, "hind-far": 0.5, "fore-far": 0.75}, 0.7),
}


def foot(phase, stride, lift, stance):
    """(dx, height, fold 0-1) of a toe about its rest point. Forward-most (+x) at phase 0."""
    p = phase % 1.0
    if p < stance:
        return stride * (1 - 2 * p / stance), 0.0, 0.0
    s = (p - stance) / (1 - stance)
    e = s * s * (3 - 2 * s)
    return stride * (2 * e - 1), lift * math.sin(math.pi * s), math.sin(math.pi * s)


def two_bone(top, end, a, b, bend):
    """The middle joint of top-a-mid-b-end, bent toward +x when bend > 0 (stifle) or -x (elbow, hock)."""
    dx, dy = end[0] - top[0], end[1] - top[1]
    d = max(1e-6, min(math.hypot(dx, dy), a + b - 1e-3))
    along = (a * a - b * b + d * d) / (2 * d)
    h = math.sqrt(max(0.0, a * a - along * along))
    ux, uy = dx / d, dy / d
    # the two perpendiculars are (-uy, ux) and (uy, -ux); pick the one whose x has the sign of `bend`
    px, py = (-uy, ux) if (-uy) * bend >= 0 else (uy, -ux)
    return [top[0] + along * ux + h * px, top[1] + along * uy + h * py]


def build(fit, period, stride, lift, gait, bob, fold):
    offsets, stance = GAITS[gait]
    far = fit["far"]
    frames = []
    for i in range(period):
        phi = i / period
        # the body dips at each footfall: twice a cycle in a trot, four times in a walk
        beats = 2 if gait == "trot" else 4
        dip = bob * (1 - math.cos(2 * math.pi * beats * phi)) / 2
        legs = {}
        for name, off in offsets.items():
            limb, side = name.split("-")
            L = fit[limb]
            sh = far if side == "far" else (0.0, 0.0)
            top = [L["top"][0] + sh[0], L["top"][1] + sh[1] + dip]
            mid0, ank0, toe0 = L["mid"], L["ankle"], L["toe"]
            a = math.dist(L["top"], mid0)
            b = math.dist(mid0, ank0)
            dx, h, f = foot(phi + off, stride, lift, stance)
            toe = [toe0[0] + sh[0] + dx, toe0[1] + sh[1] - h]
            # in swing the foot folds back under the leg: the toe trails behind the wrist or hock
            rest = (ank0[0] - toe0[0], ank0[1] - toe0[1])
            ang = math.atan2(rest[1], rest[0]) + fold * (1.0 if limb == "fore" else 0.7) * f
            r = math.hypot(*rest)
            ank = [toe[0] + r * math.cos(ang), toe[1] + r * math.sin(ang)]
            bend = 1.0 if limb == "hind" else -1.0
            mid = two_bone(top, ank, a, b, bend)
            z = 2.0 if side == "far" else 1.0
            legs[name] = [p + [z] for p in (top, mid, ank, toe)]
        body = [[x, y + dip, 0.0] for x, y in fit["spine"]]
        frames.append({"w": 848, "h": 480, "body": body, "legs": legs})
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fit")
    ap.add_argument("--out", required=True)
    ap.add_argument("--period", type=int, default=16)
    ap.add_argument("--stride", type=float, default=45.0, help="half a stride, px")
    ap.add_argument("--lift", type=float, default=30.0)
    ap.add_argument("--gait", choices=sorted(GAITS), default="trot")
    ap.add_argument("--bob", type=float, default=4.0)
    ap.add_argument("--fold", type=float, default=1.1, help="radians the paw folds at mid-swing")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    frames = build(json.load(open(a.fit)), a.period, a.stride, a.lift, a.gait, a.bob, a.fold)
    for i, f in enumerate(frames):
        json.dump(f, open(os.path.join(a.out, f"joints-{i:02d}.json"), "w"))
    print(f"{len(frames)} frames ({a.gait}) -> {a.out}")


if __name__ == "__main__":
    main()
