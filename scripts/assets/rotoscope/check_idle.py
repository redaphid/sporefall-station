"""The walk gate's per-frame and per-loop checks that apply to an idle-only kind, run on the shipped frames.
cast_walk.py gate needs a run's sheet.json and the walk poses, so it cannot run here; this calls its own
functions (off_palette, boil, judge thresholds from cast-gate-spec.json) and spritesheet's seam unit.
  python3 check_idle.py WORKTREE KIND CLIP"""
import os, sys, json
import numpy as np
from PIL import Image
wt, kind, clip = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(wt, "scripts", "assets"))
os.chdir(os.path.join(wt, "scripts", "assets"))
import cast_walk as C
import spritesheet as S
lim = C.SPEC["judge"]
DIRS = ["s", "se", "e", "ne", "n"]
out = {}
for d in DIRS:
    paths = {px: [os.path.join(C.THEMES, pack, "chars", f"{kind}-{d}-{clip}-{n}.png") for n in range(8)]
             for px, pack in ((96, "swampspace-hires"), (48, "swampspace"))}
    ims = [Image.open(p).convert("RGBA") for p in paths[96]]
    # clip-like frames: 4x NEAREST on white, the backdrop the judge and loop finder expect
    big = []
    for im in ims:
        bg = Image.new("RGBA", (96 * 4, 96 * 4), (255, 255, 255, 255))
        up = im.resize((96 * 4, 96 * 4), Image.NEAREST)
        bg.alpha_composite(up)
        big.append(bg.convert("RGB"))
    small = S._small(big)
    steps = [float(np.abs(small[(t + 1) % 8] - small[t]).mean()) for t in range(8)]
    med = float(np.median(steps[:7]))
    # gate 1's seam is frame s against frame s+P (find_loop): a constructed 8-frame loop plays frame 0 again
    # after frame 7, so it is 0 by construction. What can still go wrong is a jump at the wrap: report the
    # 7 -> 0 step against the median step (a normal step = 1.0) and call a wrap bigger than every other step a jump.
    seam = round(float(np.abs(small[0] - small[0]).mean()) / med, 3)
    wrap = round(steps[7] / med, 3)
    rgb = [np.asarray(b, dtype=np.float32) for b in big]
    rep = C._judge().measure(rgb)
    bo = C.boil(rgb * 2)  # two passes of the loop, the wrap included
    r = {"seam": seam, "wrap_over_median": wrap, "step_max_over_median": round(max(steps) / med, 3),
         "boil": bo, **{k: rep[k] for k in ("identity_drift", "head_drift", "sharpness", "coverage_jitter")},
         "off_palette_96": C.off_palette(paths[96]), "off_palette_48": C.off_palette(paths[48])}
    r["pass"] = {"seam": seam <= C.SPEC.get("seam_max_dir", {}).get(d, C.SPEC["seam_max"]),
                 "wrap_no_jump": steps[7] <= max(steps[:7]),
                 "boil": bo <= lim["boil_max"], "identity_drift": rep["identity_drift"] <= lim["identity_drift_max"],
                 "head_drift": rep["head_drift"] <= lim["head_drift_max"], "sharpness": rep["sharpness"] >= lim["sharpness_min"],
                 "coverage_jitter": rep["coverage_jitter"] <= lim["coverage_jitter_max"],
                 "palette": r["off_palette_96"] <= C.SPEC["palette"]["off_max"] and r["off_palette_48"] <= C.SPEC["palette"]["off_max"]}
    out[d] = r
    print(d, {k: v for k, v in r.items() if k != "pass"}, "FAIL:" + ",".join(k for k, v in r["pass"].items() if not v) if not all(r["pass"].values()) else "ok", flush=True)
# colour drift vs s-idle (gate 2), over this clip's frames
c = C.SPEC["colour"]
for pack in ("swampspace-hires",):
    chars = os.path.join(C.THEMES, pack, "chars")
    acols, acounts = C._cols(os.path.join(chars, f"{kind}-{c['anchor']}.png"))
    dom = acols[acounts >= c["anchor_share"] * acounts.sum()]
    for d in DIRS:
        tot = {}
        for n in range(8):
            for col, k in zip(*C._cols(os.path.join(chars, f"{kind}-{d}-{clip}-{n}.png"))):
                tot[tuple(col)] = tot.get(tuple(col), 0) + int(k)
        T = sum(tot.values())
        far = {col: k / T for col, k in tot.items() if k / T >= c["min_share"] and np.sqrt(((dom - np.array(col)) ** 2).sum(1)).min() > c["far_rgb"]}
        out[d]["colour_drift"] = round(sum(far.values()), 4)
        out[d]["pass"]["colour"] = out[d]["colour_drift"] <= c["drift_max"]
print("colour drift", {d: out[d]["colour_drift"] for d in DIRS}, "max", c["drift_max"])
json.dump(out, open(f"/mnt/d/tmp/cast-walks/{kind}/check-{clip}.json", "w"), indent=1, default=float)
print("ALL PASS" if all(all(r["pass"].values()) for r in out.values()) else "SOME FAIL")
