#!/usr/bin/env python3
"""Character-consistency harness: silhouette metrics + per-character spec gate.

"Is this the same character in every frame?" — made scriptable, not vibes.
For every frame of every character in the theme's chars/ dir it measures the
silhouette (from the alpha channel):

  height    standing height in px (content bbox height)
  width     max content width in px
  head_h    head-block height: rows from the top of the sprite until row
            occupancy first drops below HEAD_CUT of the head peak (the widest
            row in the top 45%% of the figure) — a bulkier helmet reads as a
            taller/wider head block
  mass      opaque pixel count
  cx        centroid x offset from canvas center (px, signed)
  foot_y    bottom row of content (feet must sit on the canvas floor)

and reports, per character, the max deviation of each metric across frames.
A committed per-character spec (consistency-spec.json, derived from the best
curated frame) turns the report into a gate: `--check` exits nonzero when any
shipped frame drifts outside the spec. The vitest suite runs the same math in
src/render/charConsistency.test.ts against the same spec file — keep the two
in sync if the metric definitions change.

Usage:
  python3 consistency.py                 # report every character in the theme
  python3 consistency.py vine-ranger     # one character
  python3 consistency.py --check         # gate against consistency-spec.json
  python3 consistency.py --write-spec vine-ranger=s-idle ...
        # (re)derive spec from a named reference frame + current tolerances
  python3 consistency.py --files a.png b.png   # ad-hoc: metrics for files
"""
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CHARS_DIR = os.path.join(REPO, "public", "themes", "swampspace", "chars")
SPEC_PATH = os.path.join(HERE, "consistency-spec.json")

ALPHA_MIN = 128       # hard-alpha sprites: opaque means alpha > 128
HEAD_CUT = 0.55       # head block ends when occupancy < 55% of head peak
HEAD_ZONE = 0.45      # head peak searched in the top 45% of the figure

# Default tolerances used by --write-spec (a spec file may hand-tune per char).
DEFAULT_TOL = {
    "height": 2,      # +/- px
    "width": 3,       # +/- px
    "head_h": 2,      # +/- px
    "mass_frac": 0.22,  # +/- fraction of reference mass
    "cx": 2.5,        # +/- px from reference centroid x
    "foot_y": 1,      # +/- px (feet anchored bottom-center by the pipeline)
}


# Face-accent colors (locked palette hot accents: amber/orange/red). Used for
# the FACING check: drawn side art must face RIGHT (the engine mirrors the
# west half — see docs/sprite-generation.md §3). A character whose face carries
# a hot accent (the ranger's amber visor) gets, per side-facing frame, the
# accent centroid measured against the body centroid: for 'e'/'se' the accent
# must sit to the RIGHT of the body axis; for back views ('ne'/'n') the accent
# must be mostly ABSENT (a visor showing from behind means the frame is not a
# back view at all).
ACCENT_RGB = {(255, 216, 62), (255, 144, 50), (224, 74, 42)}


def accent_dx(path):
    """(signed centroid-x offset of accent pixels from body centroid, accent
    fraction of head-zone pixels). (0.0, 0.0) when no accent pixels exist."""
    im = Image.open(path).convert("RGBA")
    arr = np.asarray(im)
    a = arr[..., 3] > ALPHA_MIN
    ys, xs = np.where(a)
    if len(ys) == 0:
        return 0.0, 0.0
    top = int(ys.min())
    height = int(ys.max()) - top + 1
    zone = slice(top, top + max(1, int(height * HEAD_ZONE)))
    acc = np.zeros(a.shape, dtype=bool)
    for (r, g, b) in ACCENT_RGB:
        acc |= (arr[..., 0] == r) & (arr[..., 1] == g) & (arr[..., 2] == b) & a
    ays, axs = np.where(acc[zone])
    head_px = max(1, int(a[zone].sum()))
    if len(axs) == 0:
        return 0.0, 0.0
    return round(float(axs.mean() - xs.mean()), 2), round(len(axs) / head_px, 3)


def metrics(path):
    """Silhouette metrics for one sprite PNG."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im)[..., 3] > ALPHA_MIN
    ys, xs = np.where(a)
    if len(ys) == 0:
        return dict(height=0, width=0, head_h=0, mass=0, cx=0.0, foot_y=0)
    top, bottom = int(ys.min()), int(ys.max())
    height = bottom - top + 1
    occ = a.sum(axis=1)  # per-row opaque count
    # width = widest row (not bbox width: a stray 1px arm pixel shouldn't count
    # the same as a genuinely wider torso — but bbox and max-row agree for
    # hard-alpha sprites, so use bbox width which is what the eye reads)
    width = int(xs.max() - xs.min() + 1)
    # head block: from the top until occupancy drops below HEAD_CUT * head peak
    zone_end = top + max(1, int(height * HEAD_ZONE))
    head_peak = occ[top:zone_end].max()
    head_h = 0
    for y in range(top, bottom + 1):
        if occ[y] < HEAD_CUT * head_peak and head_h > 0:
            break
        if occ[y] >= HEAD_CUT * head_peak:
            head_h = y - top + 1
        elif head_h == 0:
            continue
    mass = int(a.sum())
    cx = float(xs.mean()) - (im.width - 1) / 2.0
    return dict(height=height, width=width, head_h=head_h, mass=mass,
                cx=round(cx, 2), foot_y=bottom)


def collect(char=None):
    """{character: {frame: metrics}} for the shipped chars/ dir, skipping
    borrow-duplicates (identical bytes) is NOT done — every shipped file is a
    frame the player can see."""
    out = {}
    for f in sorted(os.listdir(CHARS_DIR)):
        if not f.endswith(".png"):
            continue
        stem = f[:-4]
        # <kind>-<dir>-<frame>: kind may contain '-', frame may too (attack-1);
        # split on the direction token (s|se|e|ne|n) scanning from the left so
        # e.g. bog-mutant-s-attack-1 -> (bog-mutant, s, attack-1).
        kind = d = frame = None
        toks = stem.split("-")
        for i in range(1, len(toks) - 1):
            if toks[i] in ("s", "se", "e", "ne", "n"):
                kind, d, frame = "-".join(toks[:i]), toks[i], "-".join(toks[i + 1:])
                break
        if kind is None or (char and kind != char):
            continue
        out.setdefault(kind, {})[f"{d}-{frame}"] = metrics(os.path.join(CHARS_DIR, f))
    return out


def report(data):
    for kind, frames in data.items():
        print(f"\n== {kind} ({len(frames)} frames)")
        hdr = f"{'frame':12s} {'height':>6s} {'width':>6s} {'head_h':>6s} {'mass':>6s} {'cx':>6s} {'foot_y':>6s}"
        print(hdr)
        for fr, m in frames.items():
            print(f"{fr:12s} {m['height']:6d} {m['width']:6d} {m['head_h']:6d} "
                  f"{m['mass']:6d} {m['cx']:6.1f} {m['foot_y']:6d}")
        for key in ("height", "width", "head_h", "mass", "cx", "foot_y"):
            vals = [m[key] for m in frames.values()]
            dev = max(vals) - min(vals)
            rel = f" ({dev / max(1e-9, float(np.mean(vals))) * 100:.0f}% of mean)" if key == "mass" else ""
            print(f"  max deviation {key:7s}: {dev:.1f}{rel}")


def load_spec():
    return json.load(open(SPEC_PATH)) if os.path.exists(SPEC_PATH) else {}


def family(frame):
    """Frames split into FAMILIES by animation kind: 'walk' (an 8-frame
    rotoscoped cycle whose stride legitimately swings width/foot_y far more
    than a pose frame) vs 'pose' (idle/step/attack). Each family is measured
    against its own reference, and the families' BUILDS are then compared to
    each other — a walk cycle that is a slimmer character than the idle is the
    exact "not the same character" defect this harness exists to catch, but it
    should report as ONE finding, not one per frame."""
    return "walk" if "-walk-" in f"-{frame}" or frame.split("-")[-2:-1] == ["walk"] else "pose"


# How far a family's BUILD may sit from the character's reference build before
# the families read as different characters. Deliberately looser than the
# per-frame envelope (a stride is not an idle) but tight on the identity cues:
# overall height, head-block (helmet/cap read) and pixel mass (bulk + gear).
FAMILY_TOL = {"height": 3, "head_h": 4, "mass_frac": 0.25}


def check(data, spec):
    """Gate every measured frame against the committed per-character spec.
    Returns a list of violation strings."""
    probs = []
    for kind, frames in data.items():
        s = spec.get(kind)
        if not s:
            probs.append(f"{kind}: no spec committed (run --write-spec)")
            continue
        ref, tol = s["ref"], s["tol"]
        # --- family build check: does each animation family read as the same
        # character as the spec's reference pose?
        fams = {}
        for fr, m in frames.items():
            fams.setdefault(family(fr), []).append(m)
        for fam, ms in sorted(fams.items()):
            if fam == "pose":
                continue  # the pose family IS the reference family
            med = {k: float(np.median([m[k] for m in ms])) for k in ("height", "head_h", "mass")}
            devs = []
            if abs(med["height"] - ref["height"]) > FAMILY_TOL["height"]:
                devs.append(f"height {med['height']:.0f} vs {ref['height']}")
            if abs(med["head_h"] - ref["head_h"]) > FAMILY_TOL["head_h"]:
                devs.append(f"head_h {med['head_h']:.0f} vs {ref['head_h']}")
            if abs(med["mass"] - ref["mass"]) / max(1, ref["mass"]) > FAMILY_TOL["mass_frac"]:
                devs.append(f"mass {med['mass']:.0f} vs {ref['mass']} "
                            f"({(med['mass'] / ref['mass'] - 1) * 100:+.0f}%)")
            if devs:
                probs.append(
                    f"{kind}: the '{fam}' frames are a DIFFERENT BUILD from the "
                    f"'{s['ref_frame']}' reference — {'; '.join(devs)}. "
                    f"({len(ms)} frames; regenerate the {fam} set against this "
                    f"character's spec, or the player changes shape when they move.)")
        # --- per-frame envelope, within each family
        for fr, m in frames.items():
            if family(fr) != "pose":
                continue  # non-pose families are judged by the build check above
            checks = [
                ("height", abs(m["height"] - ref["height"]), tol["height"]),
                ("width", abs(m["width"] - ref["width"]), tol["width"]),
                ("head_h", abs(m["head_h"] - ref["head_h"]), tol["head_h"]),
                ("mass", abs(m["mass"] - ref["mass"]) / max(1, ref["mass"]), tol["mass_frac"]),
                ("cx", abs(m["cx"] - ref["cx"]), tol["cx"]),
                ("foot_y", abs(m["foot_y"] - ref["foot_y"]), tol["foot_y"]),
            ]
            for key, dev, lim in checks:
                if dev > lim + 1e-9:
                    probs.append(f"{kind} {fr}: {key} off by {dev:.2f} (limit {lim})")
            # facing: drawn side art faces RIGHT (west is engine-mirrored)
            acc = s.get("accent")
            if acc:
                d = fr.split("-")[0]
                dx, frac = accent_dx(os.path.join(CHARS_DIR, f"{kind}-{fr}.png"))
                if d in ("e", "se"):
                    if frac <= 0:
                        probs.append(f"{kind} {fr}: face accent missing (cannot face right without a face)")
                    elif dx < acc["min_dx"]:
                        probs.append(f"{kind} {fr}: faces LEFT (accent dx {dx:+.1f} < {acc['min_dx']}) — "
                                     "drawn side art must face right; flip the raw and re-final")
                if d in ("ne", "n"):
                    # A cap CROWN is legitimately visible from behind (modest,
                    # centered-or-right accent); a face-sized accent or a
                    # left-shifted one means the frame is not a right-turned
                    # back view at all.
                    if frac > acc["back_max_frac"]:
                        probs.append(f"{kind} {fr}: back view shows a face-sized accent "
                                     f"(frac {frac:.3f} > {acc['back_max_frac']})")
                    elif frac > 0 and dx < acc["back_min_dx"]:
                        probs.append(f"{kind} {fr}: back view accent is left-shifted "
                                     f"(dx {dx:+.1f} < {acc['back_min_dx']}) — faces left")
    return probs


def write_spec(assignments):
    """assignments: ['vine-ranger=s-idle', ...] — derive each character's spec
    from the named reference frame's metrics + DEFAULT_TOL (hand-tune after)."""
    spec = load_spec()
    for a in assignments:
        kind, frame = a.split("=")
        m = metrics(os.path.join(CHARS_DIR, f"{kind}-{frame}.png"))
        old_tol = spec.get(kind, {}).get("tol", {})
        spec[kind] = {"ref_frame": frame, "ref": m,
                      "tol": {**DEFAULT_TOL, **old_tol}}
        print(f"{kind}: spec from {frame} -> {m}")
    json.dump(spec, open(SPEC_PATH, "w"), indent=1)
    print(f"wrote {SPEC_PATH}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--files" in sys.argv:
        for f in args:
            print(f, metrics(f))
        return
    if "--write-spec" in sys.argv:
        write_spec(args)
        return
    data = collect(args[0] if args else None)
    if "--check" in sys.argv:
        probs = check(data, load_spec())
        for p in probs:
            print("FAIL", p)
        print(f"\n{len(probs)} violations")
        sys.exit(min(len(probs), 120))
    report(data)


if __name__ == "__main__":
    main()
