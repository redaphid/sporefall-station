#!/usr/bin/env python3
"""Motion capture -> the skeleton rig_action.py writes: per-frame 2D keypoints of a filmed (or generated)
actor, retargeted onto one character's fitted keyframe, cleaned, and closed on its rest pose. The
Flashback route: the timing, weight shift and follow-through come from a body, not from easing curves.

  python3 mocap_rig.py fit.json KPS.json --window 8:44 --out <dir> [--lead 2] [--sigma 0.8]
  python3 skeleton.py <dir> --stick 5 --ref keyframe.png
  python3 fun_control.py --depth <dir> --glob 'skel-*.png' ...

KPS.json: a list, one entry per clip frame, each {"people": [{"pose_keypoints_2d": [x, y, conf] * 18}]}
in OpenPose COCO-18 order (mocap_ref.py pose writes it; any OpenPose/DWPose export does). Pixels, or
0-1 with canvas_width/canvas_height. The actor must face the way the fit faces (side view, screen right
for an `e` fit); `near` is the actor's right side, the gun hand, as in rig_action.

Retarget, per bone: the fit's bone turned by the angle the actor's bone has turned since the window's
first frame (so the fit's proportions stay the character's own, and an unturned bone IS the fit). The
pelvis moves by the actor's pelvis displacement scaled by height; the ankles are pinned the same way and
the knees solved by IK (no foot slide from a scaled thigh). The drift between the window's first and last
frame is spread over the window, so the clip starts and ends exactly on the fit: the shipped idle.

The held pistol is a prop (rig_action's `props`, painted by cast_action post --props): in the hand along
the forearm from the frame the hand leaves the holster to the frame it comes back.

Writes joints-NN.json (NN < period = lead + window length), keys.json, mocap.json (the source frame
per rig frame, per-frame speeds, the gun window and `picks`: clip indices for cast_action --clip that
keep the anticipation, the snap and the settle) and src-NN.png strips for review.
"""
import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rig_action import Body, bend_of, ik2  # noqa: E402

COCO = {"nose": 0, "neck": 1, "r_sho": 2, "r_elb": 3, "r_wri": 4, "l_sho": 5, "l_elb": 6, "l_wri": 7,
        "r_hip": 8, "r_knee": 9, "r_ank": 10, "l_hip": 11, "l_knee": 12, "l_ank": 13,
        "r_eye": 14, "l_eye": 15, "r_ear": 16, "l_ear": 17}
SIDES = (("sho", "elb", "wri"), ("hip", "knee", "ank"))


def load_kps(path):
    """(T, 18, 3) array of x, y, conf; the most confident person per frame; NaN where missing."""
    raw = json.load(open(path))
    out = np.full((len(raw), 18, 3), np.nan)
    for t, fr in enumerate(raw):
        people = fr.get("people") or []
        if not people:
            continue
        p = max(people, key=lambda q: np.nansum(np.array(q["pose_keypoints_2d"], float)[2::3]))
        k = np.array(p["pose_keypoints_2d"], float).reshape(-1, 3)[:18]
        if np.nanmax(k[:, :2]) <= 1.5:  # normalised
            k[:, 0] *= fr.get("canvas_width", 1)
            k[:, 1] *= fr.get("canvas_height", 1)
        k[k[:, 2] <= 0.05, :2] = np.nan
        out[t] = k
    return out


def unswap(K):
    """DWPose in profile flips left and right now and then. Per frame, per limb pair, keep the labelling
    that moves least from the previous frame."""
    K = K.copy()
    for part in SIDES:
        r = [COCO[f"r_{j}"] for j in part]
        l_ = [COCO[f"l_{j}"] for j in part]
        for t in range(1, len(K)):
            same = np.nansum(np.linalg.norm(K[t, r, :2] - K[t - 1, r, :2], axis=1)) + \
                np.nansum(np.linalg.norm(K[t, l_, :2] - K[t - 1, l_, :2], axis=1))
            swap = np.nansum(np.linalg.norm(K[t, l_, :2] - K[t - 1, r, :2], axis=1)) + \
                np.nansum(np.linalg.norm(K[t, r, :2] - K[t - 1, l_, :2], axis=1))
            if swap < 0.6 * same:
                K[t, r + l_] = K[t, l_ + r]
    return K


def clean(K, sigma):
    """Fill gaps by linear interpolation, then a 3-tap median (kills single-frame pops) and a narrow
    Gaussian (sigma in frames; under 1 keeps a 2-frame snap a snap)."""
    T = len(K)
    out = K.copy()
    t = np.arange(T)
    for j in range(18):
        for c in range(2):
            v = out[:, j, c]
            ok = ~np.isnan(v)
            if ok.sum() == 0:
                continue
            v = np.interp(t, t[ok], v[ok])
            med = np.array([np.median(v[max(0, i - 1):i + 2]) for i in range(T)])
            if sigma > 0:
                r = int(math.ceil(3 * sigma))
                w = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
                w /= w.sum()
                pad = np.pad(med, r, mode="edge")
                med = np.convolve(pad, w, mode="valid")
            out[:, j, c] = med
    return out


def src_joints(k):
    """The actor's joints in rig_action's names (near = his right), from one COCO-18 frame."""
    g = lambda n: k[COCO[n], :2]  # noqa: E731
    pel = 0.5 * (g("r_hip") + g("l_hip"))
    neck = g("neck")
    head = np.nanmean([g("r_ear"), g("nose"), g("r_eye")], axis=0)
    J = {"pelvis": pel, "neck": neck, "head": head}
    for side, w in (("r", "near"), ("l", "far")):
        J[f"shoulder_{w}"], J[f"elbow_{w}"], J[f"hand_{w}"] = g(f"{side}_sho"), g(f"{side}_elb"), g(f"{side}_wri")
        J[f"hip_{w}"], J[f"knee_{w}"], J[f"ankle_{w}"] = g(f"{side}_hip"), g(f"{side}_knee"), g(f"{side}_ank")
    return J


def ang(v):
    return math.atan2(v[1], v[0])


def rot(v, a):
    c, s = math.cos(a), math.sin(a)
    return np.array([c * v[0] - s * v[1], s * v[0] + c * v[1]])


# (fit bone from, fit bone to, actor bone from, actor bone to): the actor bone's turn drives the fit bone.
# The far arm rides the torso: in profile the actor's far arm is behind his body, and DWPose puts its wrist
# on whatever the near hand holds (11-06: both wrists on the pistol through the whole aim).
BONES = [("pelvis", "chest", "pelvis", "neck"), ("chest", "neck", "pelvis", "neck"), ("neck", "head_top", "neck", "head"),
         ("chest", "shoulder_near", "pelvis", "neck"), ("chest", "shoulder_far", "pelvis", "neck"),
         ("shoulder_near", "elbow_near", "shoulder_near", "elbow_near"), ("elbow_near", "hand_near", "elbow_near", "hand_near"),
         ("shoulder_far", "elbow_far", "pelvis", "neck"), ("elbow_far", "hand_far", "pelvis", "neck"),
         ("pelvis", "hip_near", "pelvis", "neck"), ("pelvis", "hip_far", "pelvis", "neck")]


def retarget(F, S, S0, S1, x, scale):
    """One frame: fit F posed by actor frame S, relative to the window's ends S0 (x=0) and S1 (x=1)."""
    J = {}
    d_pel = (S["pelvis"] - ((1 - x) * S0["pelvis"] + x * S1["pelvis"])) * scale
    J["pelvis"] = F["pelvis"] + d_pel

    def turn(a, b):
        t = ang(S[b] - S[a])
        t0, t1 = ang(S0[b] - S0[a]), ang(S1[b] - S1[a])
        drift = (t1 - t0 + math.pi) % (2 * math.pi) - math.pi
        return (t - t0 - x * drift + math.pi) % (2 * math.pi) - math.pi
    for fa, fb, sa, sb in BONES:
        J[fb] = J[fa] + rot(F[fb] - F[fa], turn(sa, sb))
    for w in ("near", "far"):  # ankles pinned (plus the actor's own foot travel), knees by IK
        d_ank = (S[f"ankle_{w}"] - ((1 - x) * S0[f"ankle_{w}"] + x * S1[f"ankle_{w}"])) * scale
        J[f"ankle_{w}"] = F[f"ankle_{w}"] + d_ank
        J[f"toe_{w}"] = F[f"toe_{w}"] + d_ank
        a = np.linalg.norm(F[f"hip_{w}"] - F[f"knee_{w}"])
        b = np.linalg.norm(F[f"knee_{w}"] - F[f"ankle_{w}"])
        J[f"knee_{w}"] = ik2(J[f"hip_{w}"], J[f"ankle_{w}"], a, b, bend_of(F[f"hip_{w}"], F[f"knee_{w}"], F[f"ankle_{w}"]))
    return J


def gun_window(S, H):
    """(grab, aim_in, aim_out, back) window frames: the hand's farthest reach back (the holster) before the
    aim; the first and last frames the arm is within 5% of its full reach; the first frame after the aim
    the hand is back within 0.1 height of where it rests. The pistol is out strictly between grab and back."""
    reach = np.array([s["hand_near"][0] - s["shoulder_near"][0] for s in S]) / H
    full = np.nonzero(reach >= reach.max() - 0.05 * (reach.max() - reach.min()))[0]
    a_in, a_out = int(full[0]), int(full[-1])
    grab = int(np.argmin(reach[:a_in + 1]))
    rest = S[-1]["hand_near"]
    home = [i for i in range(a_out, len(S)) if np.linalg.norm(S[i]["hand_near"] - rest) < 0.1 * H]
    return grab, a_in, a_out, (home[0] if home else len(S) - 1), reach


def picks(speed, lead, n, must):
    """`n` rig frames from a period: the ends on rest, the `must` keys, the rest spread by cumulative
    motion so the fast snap gets frames in proportion to how far it travels and a held aim gets few."""
    c = np.concatenate([[0], np.cumsum(speed)])
    targets = np.linspace(0, c[-1], n)
    idx = sorted(({int(np.argmin(np.abs(c - v))) for v in targets} | set(must)) - {len(c) - 1})
    while len(idx) > n:  # drop the pick closest to its neighbours that is not a key
        gaps = [(c[idx[i + 1]] - c[idx[i - 1]], i) for i in range(1, len(idx) - 1) if idx[i] not in must]
        idx.pop(min(gaps)[1])
    return [lead + i for i in idx]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fit")
    ap.add_argument("kps")
    ap.add_argument("--window", required=True, help="a:b, the clip frames from the last rest before the action to the "
                                                    "first rest after it (both ends become the fit's pose)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lead", type=int, default=2, help="rest frames before the action (Fun-Control settles on the ref)")
    ap.add_argument("--speed", type=float, default=1.0, help="play the capture this much faster (2 = every other "
                                                             "frame): generated actors often move in slow motion")
    ap.add_argument("--sigma", type=float, default=0.8)
    ap.add_argument("--frames", type=int, default=14, help="how many frames `picks` chooses")
    ap.add_argument("--mirror", action="store_true", help="the actor faces screen left: flip x first")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    fit = json.load(open(a.fit))
    B = Body(fit)
    F = B.fit
    K = load_kps(a.kps)
    if a.mirror:
        W = json.load(open(a.kps))[0].get("canvas_width", 848)
        K[..., 0] = W - K[..., 0]
    K = clean(unswap(K), a.sigma)
    s0, s1 = (int(v) for v in a.window.split(":"))
    src_t = np.arange(s0, s1 + 1e-9, a.speed)
    S = []
    for t in src_t:  # resample in time (linear between capture frames)
        i = min(int(t), len(K) - 2)
        f = t - i
        S.append(src_joints((1 - f) * K[i] + f * K[i + 1]))
    Hs = np.nanmedian([np.linalg.norm(s["head"] - 0.5 * (s["ankle_near"] + s["ankle_far"])) for s in S])
    Hf = np.linalg.norm(F["head_top"] - 0.5 * (F["ankle_near"] + F["ankle_far"]))
    scale = Hf / Hs
    n = len(S)
    g0, a_in, a_out, g1, reach = gun_window(S, Hs)
    frames = [B.layout({**F, "gun_rear": F["hip_near"], "gun_muzzle": F["hip_near"], "gun_on": np.array([0.0, 0.0])})
              for _ in range(a.lead)]
    G = 0.30 * (np.linalg.norm(F["shoulder_near"] - F["elbow_near"]) + np.linalg.norm(F["elbow_near"] - F["hand_near"]))
    for i, s in enumerate(S):
        x = i / (n - 1)
        J = {**F, **retarget(F, s, S[0], S[-1], x, scale)}
        J["gun_on"] = np.array([1.0 if g0 < i < g1 else 0.0, 0.0])
        u = J["hand_near"] - J["elbow_near"]
        u = u / max(np.linalg.norm(u), 1e-6)
        J["gun_rear"] = J["hand_near"] - 0.15 * G * u
        J["gun_muzzle"] = J["hand_near"] + 0.85 * G * u
        frames.append(B.layout(J))
    frames.pop()  # the last window frame IS the fit's rest, i.e. frame 0 of the next period
    period = len(frames)
    for i, f in enumerate(frames):
        json.dump(f, open(os.path.join(a.out, f"joints-{i:02d}.json"), "w"))
    # per rig frame: how far the near hand and the head travel (screen px), what picks spreads frames by
    pts = lambda f: np.array([f["legs"]["arm-near"][-1][:2], f["body"][0][:2]])  # noqa: E731
    speed = [float(np.abs(pts(frames[(i + 1) % period]) - pts(frames[i])).sum()) for i in range(a.lead, period)]
    keys = {"rest": a.lead, "grab": a.lead + g0, "aim": a.lead + a_in, "hold": a.lead + a_out, "home": a.lead + g1,
            "end": period}
    must = [0, g0, a_in, a_out, min(g1, n - 2)]
    pk = picks(speed, a.lead, a.frames - 1, must) + [period]  # the clip's frame `period` is rest again
    json.dump([[v, k] for k, v in sorted(keys.items(), key=lambda kv: kv[1])], open(os.path.join(a.out, "keys.json"), "w"))
    json.dump({"fit": os.path.abspath(a.fit), "kps": os.path.abspath(a.kps), "window": [s0, s1], "speed": a.speed,
               "lead": a.lead, "period": period, "scale": round(float(scale), 3), "source_frame": [round(float(t), 2) for t in src_t[:-1]],
               "gun": [a.lead + g0 + 1, a.lead + g1 - 1], "keys": keys, "hand_speed": [round(v, 1) for v in speed],
               "picks": pk}, open(os.path.join(a.out, "mocap.json"), "w"), indent=1)
    print(f"{n - 1} capture frames (x{a.speed}) + {a.lead} lead = period {period}; scale {scale:.3f}; "
          f"gun out {a.lead + g0 + 1}-{a.lead + g1 - 1}; keys {keys}\npicks ({len(pk)}): {','.join(map(str, pk))}")


if __name__ == "__main__":
    main()
