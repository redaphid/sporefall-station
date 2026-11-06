#!/usr/bin/env python3
"""A one-shot action as a closed cycle for skeleton.py: keyframed poses on one fitted keyframe, starting
and ending on the fit's rest pose (the shipped idle), so Fun-Control and the loop finder still see a
clip that repeats every `period` frames. No Blender, no gait: each action is a list of key poses.

  python3 rig_action.py fit.json draw --out <dir> [--period 16]      # biped fit (rig_biped.py's)
  python3 rig_action.py fit.json scratch --out <dir> [--period 16]   # quadruped fit (rig_quadruped.py's)
  python3 skeleton.py <dir> --stick 5 --ref keyframe.png

Poses are written in the body's own frame (forward, the character's right, up) and projected with the
fit's az/elev the way rig_biped/rig_quadruped project a walk, so one action serves all five views.
`near` in a biped fit is the character's RIGHT side (in s that is screen left): the gun hand.
Writes joints-NN.json (NN < period) plus keys.json, which names the key frames (`rest`, `aim` ...).

Actions:
  draw     biped: hand to the hip, draw, snap the arm up to aim along the facing, hold, holster.
  scratch  quadruped: sit back on the haunches, turn the head toward the near side, lift the near hind
           leg to behind the ear, scratch twice, put it down.
"""
import argparse
import json
import math
import os

import numpy as np


class Body:
    """The fit, its projection, and the joint layout skeleton.py draws."""

    def __init__(self, fit):
        self.fit = {k: np.array(v, float) for k, v in fit.items() if isinstance(v, list)}
        az, elev = math.radians(fit["az"]), math.radians(fit["elev"])
        self.fwd = np.array([math.cos(az), -math.sin(az) * math.sin(elev)])
        self.side = np.array([math.sin(az), math.cos(az) * math.sin(elev)])
        self.biped = "pelvis" in fit
        ys = [p[1] for p in self.fit.values()]
        self.height = max(ys) - min(ys)

    def proj(self, f=0.0, s=0.0, u=0.0):
        """A body-frame offset (forward, his right, up) in screen pixels."""
        return f * self.fwd + s * self.side + np.array([0.0, -u])

    def layout(self, J):
        def pt(k, depth):
            return [float(J[k][0]), float(J[k][1]), depth]
        if self.biped:
            body = [pt(k, 0.0) for k in ("head_top", "neck", "chest", "pelvis")]
            legs = {}
            for w in ("near", "far"):
                dz = 1.0 if w == "near" else 2.0
                legs[f"leg-{w}"] = [pt("pelvis", dz)] + [pt(f"{j}_{w}", dz) for j in ("hip", "knee", "ankle", "toe")]
                legs[f"arm-{w}"] = [pt("chest", dz)] + [pt(f"{j}_{w}", dz) for j in ("shoulder", "elbow", "hand")]
        else:
            body = [pt(k, 0.0) for k in ("head_top", "neck", "withers", "rump")]
            legs = {}
            for L in ("fore_near", "fore_far", "hind_near", "hind_far"):
                dz = 1.0 if "near" in L else 2.0
                root = "withers" if L.startswith("fore") else "rump"
                legs[L] = [pt(root, dz)] + [pt(f"{L}_{j}", dz) for j in ("top", "mid", "low", "toe")]
        return {"w": 848, "h": 480, "body": body, "legs": legs}


def ik3(T, a, b, pole):
    """Two-bone IK in the body frame from the origin to T: the middle joint, bent toward `pole`."""
    T, pole = np.asarray(T, float), np.asarray(pole, float)
    d = max(1e-6, min(np.linalg.norm(T), a + b - 1e-3))
    t = T / max(np.linalg.norm(T), 1e-6)
    x = (a * a - b * b + d * d) / (2 * d)
    h = math.sqrt(max(0.0, a * a - x * x))
    n = pole - pole.dot(t) * t
    n = n / max(np.linalg.norm(n), 1e-6)
    return x * t + h * n


def ik2(top, low, a, b, bend):
    """Two-bone IK on screen from `top` to `low`: the middle joint on side `bend` of the line. Out of
    reach, the limb points straight at `low` and stretches (a skeleton is a guide, not a body)."""
    v = low - top
    d = max(np.linalg.norm(v), 1e-6)
    if d >= a + b:
        return top + v * a / (a + b)
    x = (a * a - b * b + d * d) / (2 * d)
    h = math.sqrt(max(0.0, a * a - x * x))
    u = v / d
    return top + x * u + bend * h * np.array([-u[1], u[0]])


def bend_of(top, mid, low):
    """+1 or -1: which side of top->low the fitted middle joint sits on (ik2's `bend`)."""
    v, m = low - top, mid - top
    return 1.0 if (v[0] * m[1] - v[1] * m[0]) < 0 else -1.0


# ---- draw (biped) -----------------------------------------------------------------------------------

def draw(B, period, yaw=14.0):
    F = B.fit
    a = np.linalg.norm(F["shoulder_near"] - F["elbow_near"])
    b = np.linalg.norm(F["elbow_near"] - F["hand_near"])
    L = a + b
    drop = F["hip_near"][1] - F["shoulder_near"][1]  # shoulder to hip, screen px: the holster's height

    def arm(J, T, pole, lift=0.0):
        sh = F["shoulder_near"] + B.proj(u=lift)
        J["shoulder_near"] = sh
        J["elbow_near"] = sh + B.proj(*ik3(T, a, b, pole))
        J["hand_near"] = sh + B.proj(*T)

    def pose(kind):
        J = dict(F)
        if kind == "grab":  # hand on the holster at the right hip (the shoulder sits outside the hip), elbow back
            arm(J, (-0.06 * L, -0.02 * L, -drop), (-1.0, 0.6, 0.0))
        elif kind == "draw":  # the pistol clears the holster: hand forward at the waist, elbow down
            arm(J, (0.42 * L, 0.0, -0.55 * drop), (-0.4, 0.4, -1.0))
        elif kind in ("aim", "hold"):  # the arm straight along the facing, turned `yaw` to his right, a little up
            turn, pitch = math.radians(yaw), math.radians(12 if kind == "aim" else 15)
            T = 0.97 * L * np.array([math.cos(pitch) * math.cos(turn), math.cos(pitch) * math.sin(turn), math.sin(pitch)])
            arm(J, T, (0.0, 0.3, -1.0), lift=0.04 * L)
            J["chest"] = F["chest"] + B.proj(f=0.02 * L)  # the body squares up behind the shot
            J["head_top"] = F["head_top"] + B.proj(f=0.03 * L)
        return J

    keys = [(0, "rest"), (2, "rest"), (4, "grab"), (6, "draw"), (8, "aim"), (11, "hold"), (14, "grab")]
    return keys, pose


# ---- scratch (quadruped) ----------------------------------------------------------------------------

def scratch(B, period):
    F = B.fit
    H = B.height
    legs = ("fore_near", "fore_far", "hind_near", "hind_far")
    lens = {L: (np.linalg.norm(F[f"{L}_top"] - F[f"{L}_mid"]), np.linalg.norm(F[f"{L}_mid"] - F[f"{L}_low"]),
                bend_of(F[f"{L}_top"], F[f"{L}_mid"], F[f"{L}_low"])) for L in legs}

    def settle(J, L):  # the foot stays put, the leg follows its moved top
        a, b, bend = lens[L]
        J[f"{L}_mid"] = ik2(J[f"{L}_top"], J[f"{L}_low"], a, b, bend)

    def pose(kind):
        J = dict(F)
        if kind == "rest":
            return J
        # sit back: the rump drops and slides forward, the hips with it; the front stays planted
        sit = B.proj(f=0.10 * H, u=-0.14 * H)
        for k in ("rump", "hind_near_top", "hind_far_top"):
            J[k] = F[k] + sit
        J["withers"] = F["withers"] + B.proj(u=-0.03 * H)
        for L in ("fore_near_top", "fore_far_top"):
            J[L] = F[L] + B.proj(u=-0.03 * H)
        # the head turns back and down toward the near side, to meet the foot
        turn = B.proj(f=-0.10 * H, s=0.10 * H, u=-0.08 * H)
        J["head_top"] = F["head_top"] + turn
        J["neck"] = F["neck"] + 0.6 * turn
        for L in ("fore_near", "fore_far", "hind_far"):
            settle(J, L)
        if kind == "sit":
            settle(J, "hind_near")
            return J
        # the near hind foot comes up behind the ear: between the turned head's top and its neck, near side
        ear = 0.55 * J["head_top"] + 0.45 * J["neck"] + B.proj(f=-0.03 * H, s=0.06 * H)
        ear = ear + B.proj(u={"up": 0.0, "scratch": -0.05 * H, "lift": -0.18 * H}[kind])
        a, b, bend = lens["hind_near"]
        toe = F["hind_near_toe"] - F["hind_near_low"]
        J["hind_near_low"] = ear - 0.35 * toe
        J["hind_near_toe"] = ear + 0.25 * toe
        J["hind_near_mid"] = ik2(J["hind_near_top"], J["hind_near_low"], a, b, bend)
        return J

    keys = [(0, "rest"), (1, "rest"), (3, "sit"), (5, "lift"), (6, "up"), (7, "scratch"), (8, "up"),
            (9, "scratch"), (10, "up"), (12, "lift"), (14, "sit")]
    return keys, pose


ACTIONS = {"draw": draw, "scratch": scratch}


def ease(x):
    return x * x * (3 - 2 * x)


def build(B, action, period, **kw):
    keys, pose = ACTIONS[action](B, period, **kw)
    keys = [k for k in keys if k[0] < period] + [(period, "rest")]  # closed: frame `period` is frame 0
    posed = [(t, pose(name)) for t, name in keys]
    frames = []
    for i in range(period):
        j = max(n for n, (t, _) in enumerate(posed) if t <= i)
        (t0, A), (t1, C) = posed[j], posed[j + 1]
        x = ease((i - t0) / (t1 - t0))
        frames.append(B.layout({k: (1 - x) * A[k] + x * C[k] for k in A}))
    return frames, [[t, name] for t, name in keys]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fit")
    ap.add_argument("action", choices=sorted(ACTIONS))
    ap.add_argument("--out", required=True)
    ap.add_argument("--period", type=int, default=16)
    ap.add_argument("--yaw", type=float, help="draw: the aim's turn to his right, degrees (default 14); a view "
                                               "that looks along the facing (s, n) reads an aim better turned ~30")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    B = Body(json.load(open(a.fit)))
    frames, keys = build(B, a.action, a.period, **({"yaw": a.yaw} if a.yaw is not None else {}))
    for i, f in enumerate(frames):
        json.dump(f, open(os.path.join(a.out, f"joints-{i:02d}.json"), "w"))
    json.dump(keys, open(os.path.join(a.out, "keys.json"), "w"))
    print(f"{a.action}: {len(frames)} frames -> {a.out} (keys {keys})")


if __name__ == "__main__":
    main()
