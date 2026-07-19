#!/usr/bin/env python3
"""Gate the rotoscoped walk-cycle frames before they ship.

Three layers, exit code = number of failures (CI-gate style):

1. DETERMINISTIC (no GPU): every frame is 48x48, hard alpha (0|255), every
   opaque pixel is in the locked theme palette, feet touch the bottom rows,
   and content height stays rigid across the cycle (no scale pumping).
2. COHERENCE (no GPU): per direction, the fraction of pixels that change
   between adjacent frames (cyclic). A frame whose delta spikes far above the
   direction's median is AI-tracing flicker — the failure mode that kills the
   rotoscoped read. Also fails if the mean delta itself is huge.
3. VLM (Ollama qwen3-vl, majority vote — reuses scripts/assets/verify.py):
   facing convention per frame (n/ne: no face; e: profile; s: not away) and a
   same-character contract between the two contact poses (frames 0 and 4).

  python3 gate.py                      # gate the shipped theme frames
  python3 gate.py --no-vlm             # deterministic + coherence only
  python3 gate.py --dirs e,s           # subset
Env: CHAR (vine-ranger), OUTDIR (public/themes/swampspace/chars), OLLAMA, VOTES.
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
sys.path.insert(0, ASSETS)

import generate as G      # noqa: E402
import verify as V        # noqa: E402
from palette import RGB   # noqa: E402

CHAR = os.environ.get("CHAR", "vine-ranger")
OUTDIR = os.environ.get("OUTDIR", os.path.join(G.THEME, "chars"))
DIRS = ["s", "se", "e", "ne", "n"]
FRAMES = list(range(8))
PAL = set(tuple(c) for c in RGB)
RGBL = [tuple(c) for c in RGB]


def frame_path(d, f):
    return os.path.join(OUTDIR, f"{CHAR}-{d}-walk-{f}.png")


def deterministic(dirs):
    fails = []
    heights = {}
    for d in dirs:
        for f in FRAMES:
            p = frame_path(d, f)
            tag = f"{d}-{f}"
            if not os.path.exists(p):
                fails.append(f"{tag}: missing file")
                continue
            im = Image.open(p).convert("RGBA")
            a = np.asarray(im)
            if im.size != (48, 48):
                fails.append(f"{tag}: size {im.size} != (48, 48)")
            alpha = a[..., 3]
            if not np.isin(alpha, (0, 255)).all():
                fails.append(f"{tag}: soft alpha values present")
            op = a[alpha > 0]
            if len(op) < 120:
                fails.append(f"{tag}: nearly empty ({len(op)} opaque px)")
                continue
            off = [tuple(px[:3]) for px in op if tuple(px[:3]) not in PAL]
            if off:
                fails.append(f"{tag}: {len(off)} px off-palette (e.g. {off[0]})")
            rows = np.where(alpha.any(axis=1))[0]
            # gait bob legitimately lifts the lowest pixel a few rows
            # (heel-strike toe-up, push-off) — the pure-3D control set does
            # the same, so only flag frames well off the ground
            if rows[-1] < 40:
                fails.append(f"{tag}: feet float (lowest opaque row {rows[-1]} < 40)")
            heights[(d, f)] = rows[-1] - rows[0] + 1
        hs = [heights[(d, f)] for f in FRAMES if (d, f) in heights]
        if hs and max(hs) - min(hs) > 6:
            fails.append(f"{d}: content height pumps across cycle ({min(hs)}..{max(hs)})")
    return fails


def coherence(dirs, spike=3.0, mean_cap=0.88, hist_cap=0.45):
    # hist_cap calibration: after temporal smoothing, honest 48px back-view
    # cycles measure up to ~0.38 (the yawing torso genuinely exposes different
    # shade areas mid-swing); the cap-color identity flicker this check exists
    # for measured ~0.45+ on affected frames. 0.45 splits the two.
    fails = []
    for d in dirs:
        ims = []
        for f in FRAMES:
            p = frame_path(d, f)
            if not os.path.exists(p):
                return fails  # missing already reported
            ims.append(np.asarray(Image.open(p).convert("RGBA"), dtype=np.int16))
        deltas = []
        for f in FRAMES:
            a, b = ims[f], ims[(f + 1) % 8]
            changed = (np.abs(a - b).sum(axis=-1) > 40)
            union = (a[..., 3] > 0) | (b[..., 3] > 0)
            deltas.append(changed.sum() / max(1, union.sum()))
        med = sorted(deltas)[len(deltas) // 2]
        mean = sum(deltas) / len(deltas)
        print(f"  {d}: adjacent-frame deltas "
              + " ".join(f"{x:.2f}" for x in deltas) + f" (median {med:.2f})")
        # Calibration: at 48px, swinging limbs alone flip 0.4-0.8 of the union
        # (the pure-3D control set measures 0.44-0.85), so the pixel delta only
        # catches catastrophic per-frame identity swaps…
        if mean > mean_cap:
            fails.append(f"{d}: mean adjacent delta {mean:.2f} > {mean_cap} (flicker)")
        for f, x in enumerate(deltas):
            if med > 0.02 and x > spike * med:
                fails.append(f"{d}: delta {f}->{(f + 1) % 8} = {x:.2f} spikes over "
                             f"{spike}x median {med:.2f} (frame pops)")
        # …while APPEARANCE flicker (e.g. the cap reading orange in one frame,
        # tan in the next) shows up as a palette-histogram outlier even when
        # the pose barely moves. L1 distance of each frame's palette-color
        # distribution from the direction's mean distribution.
        hists = []
        for im in ims:
            op = im[im[..., 3] > 0][:, :3]
            hv = np.zeros(len(RGBL))
            for i, c in enumerate(RGBL):
                hv[i] = (np.abs(op - np.array(c)).sum(axis=1) == 0).sum()
            hists.append(hv / max(1, len(op)))
        meanh = np.mean(hists, axis=0)
        for f, hv in enumerate(hists):
            dist = float(np.abs(hv - meanh).sum())
            if dist > hist_cap:
                fails.append(f"{d}-{f}: palette histogram drifts {dist:.2f} > "
                             f"{hist_cap} from the cycle mean (appearance flicker)")
    return fails


def vlm(dirs):
    fails = []
    maj = V.VOTES // 2 + 1
    for d in dirs:
        for f in FRAMES:
            votes = [V.ask(frame_path(d, f)) for _ in range(V.VOTES)]

            def count(key, *vals):
                return sum(1 for v in votes if v.get(key) in vals)

            tag = f"{d}-{f}"
            if d in ("n", "ne") and count("face_visible", True) >= maj:
                fails.append(f"{tag}: face visible on a back view")
            if d == "s" and count("facing", "away") >= maj:
                fails.append(f"{tag}: 's' frame reads as facing away")
            if d == "e" and count("facing", "toward-viewer", "away") >= maj:
                fails.append(f"{tag}: 'e' frame does not read as a profile")
            print(f"  vlm {tag}: {votes[-1].get('subject')} facing={votes[-1].get('facing')}"
                  f" face={votes[-1].get('face_visible')}")
        v, probs = V.check_pair(frame_path(d, 0), frame_path(d, 4))
        print(f"  vlm {d}: contact-pose pair {v} {probs}")
        if "same_character" in probs or "same_gear" in probs:
            fails.append(f"{d}: contact poses 0/4 fail same-character contract: {probs}")
    return fails


if __name__ == "__main__":
    args = sys.argv[1:]
    dirs = DIRS
    for a in args:
        if a.startswith("--dirs="):
            dirs = a.split("=", 1)[1].split(",")
    fails = deterministic(dirs)
    print(f"[deterministic] {len(fails)} failures")
    c = coherence(dirs)
    print(f"[coherence] {len(c)} failures")
    fails += c
    if "--no-vlm" not in args:
        v = vlm(dirs)
        print(f"[vlm] {len(v)} failures")
        fails += v
    for f in fails:
        print("FAIL", f)
    print(f"\n{len(fails)} total failures")
    sys.exit(min(len(fails), 120))
