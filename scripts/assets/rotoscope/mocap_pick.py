#!/usr/bin/env python3
"""Rank reference takes of a draw by urgency and pick each one's window from its own hand-speed curve.

  python3 mocap_pick.py CLIP-kps.json [...] [--json OUT]

Per take (DWPose COCO-18, mocap_rig.load_kps, cleaned the same way): the gun hand's reach along the
facing and its speed in body heights per capture frame. Keys:
  start   the last still frame before the action (hand and head under the jitter floor);
  grab    the last frame before the reach where the hand moves under 30% of its peak (it leaves the holster);
  reach   the first frame within 5% of the full reach (the snap lands);
  settle  the first frame after `reach` from which the hand stays still for 3 frames (the braced hold);
  window  start-1 : settle+3, what mocap_rig --window takes for an `--end aim` clip.
Urgency: frames from grab to reach (fewer is faster) and the peak hand speed. The owner, 11-06: the draw
was "lazy, not urgent, and limp"; the take with the fewest hip-to-aim frames and the highest peak wins.
For a front or back view the reach runs toward or away from the camera, so reach is measured as the
wrist's distance from the hip in the image plane, which a raised gun still grows.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mocap_rig import COCO, clean, load_kps, unswap  # noqa: E402


def analyse(path, sigma=0.8):
    K = clean(unswap(load_kps(path)), sigma)
    wri, sho, hip = K[:, COCO["r_wri"], :2], K[:, COCO["r_sho"], :2], K[:, COCO["r_hip"], :2]
    head = K[:, COCO["nose"], :2]
    ank = 0.5 * (K[:, COCO["r_ank"], :2] + K[:, COCO["l_ank"], :2])
    H = float(np.nanmedian(np.linalg.norm(head - ank, axis=1)))
    reach = np.linalg.norm(wri - hip, axis=1) / H
    up = (hip[:, 1] - wri[:, 1]) / H  # the hand above the hip
    speed = np.r_[0.0, np.linalg.norm(np.diff(wri, axis=0), axis=1) / H]
    hs = np.r_[0.0, np.linalg.norm(np.diff(head, axis=0), axis=1) / H]
    floor = max(0.004, float(np.percentile(speed, 20)) * 2)
    moving = np.nonzero((speed > floor) | (hs > floor))[0]
    start = int(moving[0]) - 1 if len(moving) else 0
    score = reach + up
    full = np.nonzero(score >= score.max() - 0.05 * (score.max() - score[: start + 1].min()))[0]
    r = int(full[0])
    peak = float(speed[start: r + 1].max())
    slow = [i for i in range(start, r) if speed[i] < 0.3 * peak]
    grab = slow[-1] if slow else start  # the snap starts where the hand last dawdled (the holster)
    still = [i for i in range(r, len(speed) - 3) if (speed[i: i + 3] < 1.5 * floor).all()]
    settle = still[0] if still else min(len(speed) - 1, r + 6)
    return {"clip": path, "H_px": round(H, 1), "start": max(0, start), "grab": grab, "reach": r, "settle": settle,
            "window": f"{max(0, start - 1)}:{min(len(speed) - 1, settle + 3)}",
            "hip_to_aim_frames": r - grab, "peak_speed_h_per_frame": round(float(speed[grab: r + 1].max()), 4),
            "speed": [round(float(v), 4) for v in speed]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kps", nargs="+")
    ap.add_argument("--json")
    a = ap.parse_args()
    rows = [analyse(k) for k in a.kps]
    rows.sort(key=lambda r: (r["hip_to_aim_frames"], -r["peak_speed_h_per_frame"]))
    for r in rows:
        print(f"{os.path.basename(r['clip'])}: hip->aim {r['hip_to_aim_frames']} frames, peak {r['peak_speed_h_per_frame']} H/f, "
              f"start {r['start']} grab {r['grab']} reach {r['reach']} settle {r['settle']} window {r['window']}")
    if a.json:
        json.dump(rows, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
