#!/usr/bin/env python3
"""CPU selftest for consistency.check(): what the silhouette gate must still catch
once walk characters get view-aware checks, and what it must stop flagging.

    python3 scripts/assets/consistency_selftest.py
"""
import sys

import consistency as c

REF = dict(height=45, width=23, head_h=36, mass=700, cx=0.0, foot_y=46)
SPEC = {"k": {"ref_frame": "s-idle", "ref": REF, "tol": dict(c.DEFAULT_TOL)}}
WALK = {f"{d}-walk-{i}": dict(REF) for d in ("s", "e") for i in range(8)}


def frame(**over):
    return {**REF, **over}


def run(frames):
    return c.check({"k": frames}, SPEC)


CASES = [
    # (name, frames, expect a violation mentioning this substring, or None for clean)
    ("single-view step still judged as a pose",
     {"s-idle": frame(), "s-step": frame(width=28)}, "s-step: width"),
    ("walk character: step is a stride, not a pose",
     {"s-idle": frame(), "s-step": frame(width=28, head_h=31), **WALK}, None),
    ("walk character: side view may be narrower with a different head block",
     {"s-idle": frame(), "e-idle": frame(width=20, head_h=27), **WALK}, None),
    ("walk character: side view of a different height fails",
     {"s-idle": frame(), "e-idle": frame(height=48), **WALK}, "e-idle: height"),
    ("walk character: side view of a different bulk fails",
     {"s-idle": frame(), "e-idle": frame(mass=450), **WALK}, "e-idle: mass"),
    ("walk character: back view off the foot line fails",
     {"s-idle": frame(), "n-idle": frame(foot_y=44), **WALK}, "n-idle: foot_y"),
    ("walk character: side view off-centre fails",
     {"s-idle": frame(), "e-idle": frame(cx=4.0), **WALK}, "e-idle: cx"),
    ("walk character: the reference's own view still checks width",
     {"s-idle": frame(), "s-attack-1": frame(width=29), **WALK}, "s-attack-1: width"),
    ("walk character: a slimmer walk build fails once",
     {"s-idle": frame(), "s-step": frame(mass=400),
      **{k: frame(mass=400) for k in WALK}}, "DIFFERENT BUILD"),
]


def main():
    bad = 0
    for name, frames, want in CASES:
        probs = run(frames)
        ok = (not probs) if want is None else any(want in p for p in probs)
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"  -> {probs or 'no violation'}"))
    print(f"\n{len(CASES) - bad}/{len(CASES)} PASS")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
