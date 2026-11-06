#!/usr/bin/env python3
"""A heavy crab's walk in place for skeleton.py, any of the five drawn directions. No Blender.

  python3 rig_crab.py --dir se --ref keyframe.png --out <dir> [--period 16] [--stride .3] [--lift .2]
  python3 skeleton.py <dir> --stick 5 --ref keyframe.png

Body plan (mireclaw-alpha's shipped s-idle): a wide low shell, `--pairs` walking legs per side that
step, and `--arms` raised clawed limbs per side that never touch the ground and sway with the body.

Gait: diagonal sets, as rig_hexapod's tripod: leg i of the left side steps with leg i+1 of the right
side (L0 R1 / R0 L1 for two pairs, L0 R1 L2 R3 / R0 L1 R2 L3 for four). `--duty` above 0.5 keeps every
foot down for a moment between sets, a heavy walk. The shell bobs twice a cycle and rolls side to side
once (`--roll`), onto the set that is down; the raised limbs lag the roll. Every path is a function of
phase, so frame `period` equals frame 0 exactly.

Camera, projection and the fit onto a keyframe are rig_hexapod's (`--heap-*` is the shell ellipsoid).
Writes joints-NN.json (the raised limbs are chains in "legs" named A<side><i>) and fit.json.
"""
import argparse
import json
import math
import os

from rig_hexapod import H, W, YAW, Camera, fit, ref_box, v_add, v_dot, v_len, v_mul, v_norm, v_sub


class Crab:
    """The body plan in the creature's frame: forward -Y, up +Z, ground z 0; the shell's half-width is about 1."""

    def __init__(self, a):
        self.body_z = a.body_z
        self.femur, self.tibia = a.femur, a.tibia
        self.stride, self.lift, self.duty, self.bob, self.roll = a.stride, a.lift, a.duty, a.bob, a.roll
        self.pole_up = a.pole_up
        # (hip y, rest-foot angle from lateral in degrees, + = forward), front to back, one side
        ys = [0.0] if a.pairs == 1 else [-a.leg_span / 2 + a.leg_span * i / (a.pairs - 1) for i in range(a.pairs)]
        f = [i / max(1, a.pairs - 1) for i in range(a.pairs)]
        self.legs = [(y, a.fore_ang + (a.hind_ang - a.fore_ang) * f[i], a.foot_r + (a.hind_foot_r - a.foot_r) * f[i],
                      a.hip_x + (a.hind_hip_x - a.hip_x) * f[i]) for i, y in enumerate(ys)]
        self.heap = (a.heap_w, a.heap_l, a.heap_h)
        # raised limbs, inner first: shoulder on the shell's side, an elbow bowed out, wrist, tip; (x, y, z above body_z)
        reach = [float(v) for v in a.arm_reach.split(",")]
        high = [float(v) for v in a.arm_len.split(",")]
        self.arms = []
        for i in range(a.arms):
            y, tx, tz = -0.3 + 0.4 * i, reach[min(i, len(reach) - 1)], high[min(i, len(high) - 1)]
            fw = a.arm_fwd
            self.arms.append([(a.heap_w * 0.75, y, a.heap_h * 0.3), (tx + 0.35, y - 0.5 * fw, tz * 0.45),
                              (tx + 0.15, y - 0.75 * fw, tz * 0.85), (tx - 0.1, y - fw, tz)])
        self.sway = a.arm_sway
        self.axis = [(0, -a.heap_l * 1.05, self.body_z * 0.85), (0, -a.heap_l * 0.7, self.body_z + a.heap_h * 0.3),
                     (0, 0.0, self.body_z + a.heap_h * 0.8), (0, a.heap_l * 0.85, self.body_z + a.heap_h * 0.2)]

    def foot(self, rest, phase):
        """Stance: the foot slides back at constant speed (in place). Swing: it arcs forward."""
        if phase < self.duty:
            s, z = self.stride * (0.5 - phase / self.duty), 0.0
        else:
            u = (phase - self.duty) / (1 - self.duty)
            s = self.stride * (-0.5 + (0.5 - 0.5 * math.cos(math.pi * u)))
            z = self.lift * math.sin(math.pi * u)
        return [rest[0], rest[1] - s, rest[2] + z]

    def shell(self, t):
        """(dx, dz): the roll toward the left set's stance (t 0 .. duty) and the dip at each set's footfall."""
        dz = -self.bob * (0.5 - 0.5 * math.cos(4 * math.pi * t))
        dx = self.roll * math.sin(2 * math.pi * (t - self.duty / 2 + 0.25))
        return dx, dz

    def leg(self, hip, rest, tip):
        d = v_sub(tip, hip)
        dist = min(max(v_len(d), abs(self.femur - self.tibia) + 1e-3), self.femur + self.tibia - 1e-3)
        u = v_norm(d)
        out = v_norm([rest[0] - hip[0], rest[1] - hip[1], 0.0])
        pole = v_norm(v_add(out, [0, 0, self.pole_up]))
        v = v_norm(v_sub(pole, v_mul(u, v_dot(pole, u))))
        x = (self.femur ** 2 - self.tibia ** 2 + dist ** 2) / (2 * dist)
        knee = v_add(v_add(hip, v_mul(u, x)), v_mul(v, math.sqrt(max(0.0, self.femur ** 2 - x * x))))
        tip = v_add(hip, v_mul(u, dist))
        return [hip, knee, v_add(knee, v_mul(v_sub(tip, knee), 0.5)), tip]

    def pose(self, t):
        """{chain name: joints} and the body axis, in the creature frame, at phase t."""
        dx, dz = self.shell(t)
        legs = {}
        for sx, side in ((-1, "L"), (1, "R")):
            for i, (hy, ang, fr, hx) in enumerate(self.legs):
                a = math.radians(ang)
                hip0 = [sx * hx, hy, self.body_z]
                rest = [hip0[0] + sx * fr * math.cos(a), hy - fr * math.sin(a), 0.0]
                phase = 0.0 if (i % 2 == 0) == (side == "L") else 0.5
                tip = self.foot(rest, (t + phase) % 1.0)
                legs[f"{side}{i}"] = self.leg([hip0[0] + dx, hy, self.body_z + dz], rest, tip)
            for i, chain in enumerate(self.arms):
                # the limbs lag the roll by a quarter cycle and lift a little as their side rolls up
                lag = math.sin(2 * math.pi * (t - self.duty / 2) + sx * 0.5 + i * 0.6)
                pts = []
                for j, (o, f, u) in enumerate(chain):
                    k = j / (len(chain) - 1)
                    pts.append([sx * o + dx + self.sway * k * lag * 0.6, f, self.body_z + dz + u + self.sway * k * lag])
                legs[f"A{side}{i}"] = pts
        body = [[p[0] + dx, p[1], p[2] + dz] for p in self.axis]
        return legs, body

    def outline(self):
        """Points of the resting creature's visible extent: legs, raised limbs, axis and the shell's upper half."""
        legs, body = self.pose(0.0)
        pts = [p for chain in legs.values() for p in chain] + body
        hw, hl, hh = self.heap
        for i in range(24):
            for j in range(1, 12):
                th, ph = 2 * math.pi * i / 24, math.pi * j / 24
                pts.append([hw * math.sin(ph) * math.cos(th), hl * math.sin(ph) * math.sin(th),
                            self.body_z + hh * math.cos(ph)])
        return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, choices=sorted(YAW))
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref", help="the direction's keyframe; fits the rig onto it")
    ap.add_argument("--yaw", type=float, help="override the direction's yaw, for a keyframe not drawn square on")
    ap.add_argument("--elev", type=float, default=25.0)
    ap.add_argument("--fill", type=float, default=1.0, help="scale on top of the fit")
    ap.add_argument("--dx", type=float, default=0.0, help="nudge the fit, px")
    ap.add_argument("--dy", type=float, default=0.0)
    ap.add_argument("--period", type=int, default=16)
    ap.add_argument("--pairs", type=int, default=2, help="walking legs per side")
    ap.add_argument("--arms", type=int, default=2, help="raised clawed limbs per side")
    ap.add_argument("--leg-span", type=float, default=0.6, help="hip y from the first pair to the last, units")
    ap.add_argument("--fore-ang", type=float, default=35.0, help="the front pair's rest-foot angle, deg forward")
    ap.add_argument("--hind-ang", type=float, default=-25.0)
    ap.add_argument("--stride", type=float, default=0.3, help="a foot's travel along the body, units")
    ap.add_argument("--lift", type=float, default=0.2)
    ap.add_argument("--duty", type=float, default=0.6)
    ap.add_argument("--bob", type=float, default=0.04)
    ap.add_argument("--roll", type=float, default=0.04, help="the shell's side-to-side shift, units")
    ap.add_argument("--arm-reach", default="1.0,1.8", help="each raised limb's tip, units out from the midline")
    ap.add_argument("--arm-len", default="1.7,1.3", help="each raised limb's tip height above the shell's base")
    ap.add_argument("--arm-fwd", type=float, default=0.2, help="how far forward each raised limb's tip reaches")
    ap.add_argument("--arm-sway", type=float, default=0.08)
    ap.add_argument("--body-z", type=float, default=1.5)
    ap.add_argument("--femur", type=float, default=0.9)
    ap.add_argument("--tibia", type=float, default=1.2)
    ap.add_argument("--pole-up", type=float, default=1.5, help="how far the knees arch up rather than out")
    ap.add_argument("--hip-x", type=float, default=0.7)
    ap.add_argument("--foot-r", type=float, default=0.3, help="the front pair's foot, out from its hip")
    ap.add_argument("--hind-foot-r", type=float, default=1.2)
    ap.add_argument("--hind-hip-x", type=float, default=1.0)
    ap.add_argument("--heap-w", type=float, default=1.0)
    ap.add_argument("--heap-l", type=float, default=0.8)
    ap.add_argument("--heap-h", type=float, default=0.6)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    plan = Crab(a)
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
    print(f"{a.period} frames (crab, {a.pairs} pairs + {a.arms} raised) {a.dir} -> {a.out}")


if __name__ == "__main__":
    main()
