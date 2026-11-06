#!/usr/bin/env python3
"""A periodic six-legged scuttle in place for skeleton.py, any of the five drawn directions. No Blender.

  python3 rig_hexapod.py --dir se --ref keyframe.png --out <dir> [--period 16] [--stride .5] [--lift .22]
  python3 skeleton.py <dir> --stick 5 --ref keyframe.png

Gait: alternating tripod (default). Front and rear legs of one side step with the middle leg of the other
(L0 R1 L2, then R0 L1 R2), duty 0.5, so three feet are always down and the body dips once per tripod swap.
`--gait ripple` is a crawl wave: each side swings rear, middle, front in turn, the two sides half a cycle
apart, so with `--duty .67` two feet are up at a time (never two neighbours on one side). Every foot's path
is a function of phase, so frame `period` equals frame 0 exactly.

`--axis upright` is for a body that stands on its legs rather than lying along them (brood-sac's egg): the
drawn axis is a short vertical stub from the hips up into the body, and the fit outline is the whole
ellipsoid sitting on the hips, not the upper half of a heap.

The body is rigid (gloom-lurker's bubble heap): it only bobs. The creature is posed in its own frame
(forward -Y, up +Z, ground z 0), turned by the direction's yaw (s 0, se 45, e 90, ne 135, n 180), and
projected by an orthographic camera at `--elev` degrees. `--ref` fits the projection to the keyframe:
the rig's outline at rest (legs plus the heap's ellipsoid, which is not drawn) is scaled and placed onto
the keyframe's non-white bounding box in the Wan clip's 848x480 pixels.

Writes joints-NN.json: {"w", "h", "body": [[x, y, z]...], "legs": {name: [[x, y, z]...]}}, z the view
depth (larger = farther), the layout skeleton.py draws; and fit.json with the numbers used.
"""
import argparse
import json
import math
import os

W, H = 848, 480
YAW = {"s": 0.0, "se": 45.0, "e": 90.0, "ne": 135.0, "n": 180.0}


def v_add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def v_sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def v_mul(a, k):
    return [a[0] * k, a[1] * k, a[2] * k]


def v_len(a):
    return math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2)


def v_norm(a):
    n = v_len(a) or 1e-9
    return [a[0] / n, a[1] / n, a[2] / n]


def v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


class Plan:
    """The body plan in the creature's frame (units: the heap's half-length is about 1)."""

    def __init__(self, a):
        self.body_z = a.body_z
        self.femur, self.tibia = a.femur, a.tibia
        self.stride, self.lift, self.duty, self.bob = a.stride, a.lift, a.duty, a.bob
        # (hip y, rest-foot angle from lateral, degrees, + = forward), front to back, one side
        self.legs = [(-0.55, 40.0), (0.0, 2.0), (0.55, -38.0)]
        self.hip_x, self.foot_r = a.hip_x, a.foot_r
        self.pole_up = a.pole_up
        self.heap = (a.heap_w, a.heap_l, a.heap_h)   # ellipsoid semi-axes x, y, z, centred over the body
        # the drawn body axis, head to tail: head tip, head, shell middle, heap top, rear plate
        self.gait, self.upright = a.gait, a.axis == "upright"
        if self.upright:
            self.axis = [(0, 0, self.body_z), (0, 0, self.body_z + self.heap[2] * 0.6)]
        else:
            self.axis = [(0, -1.25, self.body_z * 0.9), (0, -0.95, self.body_z * 1.1), (0, -0.1, self.body_z + 0.35),
                         (0, 0.35, self.body_z + self.heap[2] * 0.75), (0, 1.0, self.body_z + 0.15)]

    def foot(self, rest, phase):
        """Stance: the foot slides back at constant speed (in place). Swing: it arcs forward."""
        if phase < self.duty:
            s, z = self.stride * (0.5 - phase / self.duty), 0.0
        else:
            u = (phase - self.duty) / (1 - self.duty)
            s = self.stride * (-0.5 + (0.5 - 0.5 * math.cos(math.pi * u)))
            z = self.lift * math.sin(math.pi * u)
        return [rest[0], rest[1] - s, rest[2] + z]

    def pose(self, t):
        """{leg name: [hip, knee, mid, tip]} and the body axis, in the creature frame, at phase t."""
        dip = self.bob * (0.5 - 0.5 * math.cos((4 if self.gait == "tripod" else 6) * math.pi * t))
        legs = {}
        for sx, side in ((-1, "L"), (1, "R")):
            for i, (hy, ang) in enumerate(self.legs):
                hip = [sx * self.hip_x, hy, self.body_z - dip]
                a = math.radians(ang)
                rest = [hip[0] + sx * self.foot_r * math.cos(a), hy - self.foot_r * math.sin(a), 0.0]
                if self.gait == "tripod":
                    phase = 0.0 if (i % 2 == 0) == (side == "L") else 0.5
                else:  # ripple: swing starts rear (i 2) to front (i 0) a third apart, R half a cycle after L
                    start = (2 - i) / 3 + (0.5 if side == "R" else 0.0)
                    phase = (self.duty - start) % 1.0
                tip = self.foot(rest, (t + phase) % 1.0)
                d = v_sub(tip, hip)
                dist = min(max(v_len(d), abs(self.femur - self.tibia) + 1e-3), self.femur + self.tibia - 1e-3)
                u = v_norm(d)
                out = v_norm([rest[0] - hip[0], rest[1] - hip[1], 0.0])
                pole = v_norm(v_add(out, [0, 0, self.pole_up]))
                v = v_norm(v_sub(pole, v_mul(u, v_dot(pole, u))))
                x = (self.femur ** 2 - self.tibia ** 2 + dist ** 2) / (2 * dist)
                knee = v_add(v_add(hip, v_mul(u, x)), v_mul(v, math.sqrt(max(0.0, self.femur ** 2 - x * x))))
                tip = v_add(hip, v_mul(u, dist))
                mid = v_add(knee, v_mul(v_sub(tip, knee), 0.5))
                legs[f"{side}{i}"] = [hip, knee, mid, tip]
        body = [[p[0], p[1], p[2] - dip] for p in self.axis]
        return legs, body

    def outline(self):
        """Points of the resting creature's visible extent: legs, axis and the heap ellipsoid's surface."""
        legs, body = self.pose(0.0)
        pts = [p for chain in legs.values() for p in chain] + body
        hw, hl, hh = self.heap
        cz, js = (self.body_z + hh, range(1, 24)) if self.upright else (self.body_z, range(1, 12))
        for i in range(24):
            for j in js:  # a heap shows its upper half; an upright body all of it, sitting on the hips
                th, ph = 2 * math.pi * i / 24, math.pi * j / 24
                pts.append([hw * math.sin(ph) * math.cos(th), hl * math.sin(ph) * math.sin(th),
                            cz + hh * math.cos(ph)])
        return pts


class Camera:
    def __init__(self, yaw, elev):
        self.c, self.s = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
        e = math.radians(elev)
        self.fwd = [0.0, math.cos(e), -math.sin(e)]   # view direction (into the screen)
        self.up = [0.0, math.sin(e), math.cos(e)]
        self.k, self.ox, self.oy = 100.0, W / 2, H / 2

    def world(self, p):
        """Turn the creature by yaw about +Z: forward -Y goes to +X (screen right) at yaw 90."""
        return [p[0] * self.c - p[1] * self.s, p[0] * self.s + p[1] * self.c, p[2]]

    def raw(self, p):
        w = self.world(p)
        return w[0], -v_dot(w, self.up), v_dot(w, self.fwd)

    def px(self, p):
        x, y, z = self.raw(p)
        return [self.ox + self.k * x, self.oy + self.k * y, z]


def ref_box(path, thresh=235):
    """Non-white bounding box of the keyframe, in 848x480 pixels (the keyframe is 16:9 like the clip)."""
    from PIL import Image
    im = Image.open(path).convert("L").resize((W, H), Image.LANCZOS)
    mask = im.point(lambda v: 255 if v < thresh else 0)
    return mask.getbbox()


def fit(cam, plan, box, fill):
    """Scale and place the camera so the resting outline lands on `box` (x0, y0, x1, y1): centred in x,
    feet on the box bottom, scale the mean of the width and height fits times `fill`."""
    pts = [cam.raw(p) for p in plan.outline()]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    k = fill * 0.5 * ((box[2] - box[0]) / w + (box[3] - box[1]) / h)
    cam.k = k
    cam.ox = (box[0] + box[2]) / 2 - k * (max(xs) + min(xs)) / 2
    cam.oy = box[3] - k * max(ys)
    return {"box": list(box), "k": k, "ox": cam.ox, "oy": cam.oy, "outline_wh": [w, h]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, choices=sorted(YAW))
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref", help="the direction's keyframe; fits the rig onto it")
    ap.add_argument("--yaw", type=float, help="override the direction's yaw, for a keyframe not drawn square on")
    ap.add_argument("--elev", type=float, default=30.0)
    ap.add_argument("--fill", type=float, default=1.0, help="scale on top of the fit")
    ap.add_argument("--dx", type=float, default=0.0, help="nudge the fit, px")
    ap.add_argument("--dy", type=float, default=0.0)
    ap.add_argument("--period", type=int, default=16)
    ap.add_argument("--stride", type=float, default=0.5, help="a foot's travel along the body, units")
    ap.add_argument("--lift", type=float, default=0.22)
    ap.add_argument("--duty", type=float, default=0.5)
    ap.add_argument("--gait", choices=("tripod", "ripple"), default="tripod")
    ap.add_argument("--axis", choices=("beetle", "upright"), default="beetle")
    ap.add_argument("--bob", type=float, default=0.03)
    ap.add_argument("--body-z", type=float, default=0.38)
    ap.add_argument("--femur", type=float, default=0.62)
    ap.add_argument("--tibia", type=float, default=0.66)
    ap.add_argument("--pole-up", type=float, default=0.7, help="how far the knees bow up rather than out")
    ap.add_argument("--hip-x", type=float, default=0.5)
    ap.add_argument("--foot-r", type=float, default=0.75)
    ap.add_argument("--heap-w", type=float, default=0.85)
    ap.add_argument("--heap-l", type=float, default=1.05)
    ap.add_argument("--heap-h", type=float, default=0.8)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    plan = Plan(a)
    cam = Camera(YAW[a.dir] if a.yaw is None else a.yaw, a.elev)
    info = {"dir": a.dir, "args": vars(a)}
    if a.ref:
        info.update(fit(cam, plan, ref_box(a.ref), a.fill))
    cam.ox += a.dx
    cam.oy += a.dy
    for i in range(a.period):
        legs, body = plan.pose(i / a.period)
        js = {"w": W, "h": H, "body": [cam.px(p) for p in body],
              "legs": {n: [cam.px(p) for p in chain] for n, chain in legs.items()}}
        json.dump(js, open(os.path.join(a.out, f"joints-{i:02d}.json"), "w"))
    json.dump(info, open(os.path.join(a.out, "fit.json"), "w"), indent=1)
    print(f"{a.period} frames ({a.gait}) {a.dir} -> {a.out}")


if __name__ == "__main__":
    main()
