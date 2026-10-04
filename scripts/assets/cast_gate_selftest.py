#!/usr/bin/env python3
"""Controls for the cast_walk.py gates that were re-measured: each must pass known-good art and
fail art it exists to catch.

    python3 scripts/assets/cast_gate_selftest.py          # all controls (the VLM ones need Ollama)
    python3 scripts/assets/cast_gate_selftest.py --cpu    # gate 5 and the palette gate only

Known good: the frog's shipped loops (the approved video-route character) and the mycologist.
Known bad: the sporefall-art hi-fps clips rejected for boil (the judge's own calibration set),
seeded synthetic boil on the frog's east loop, front and back views submitted as the wrong
direction, another character's back view for identity, a blurred sprite and a painted 3D render
for style, a channel-rotated frame for palette.
Exit code = number of controls that came out wrong.
"""
import glob
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("VERIFY_THEME", "swampspace-hires")
import cast_walk as C  # noqa: E402

CHARS = os.path.join(C.THEMES, "swampspace-hires", "chars")
FROG = os.environ.get("FROG_CLIPS", "/mnt/d/projects/puck-sprites/out/frog")
REJECTS = os.path.join(C.JUDGE, "wip", "demos", "hifps")
TMP = tempfile.mkdtemp(prefix="cast-gate-selftest-")
wrong = 0


def expect(name, want_pass, passed, detail):
    global wrong
    ok = want_pass == passed
    wrong += not ok
    print(f"{'  ' if ok else 'XX'} {'pass' if want_pass else 'FAIL'}? {'pass' if passed else 'FAIL'}  {name:34s} {detail}", flush=True)


def frog_loop(d):
    rep = json.load(open(f"{FROG}/atlas96-full/{d}/report.json"))["rows"][0]["loop"]
    return sorted(glob.glob(f"{FROG}/clips/{d}/walkL-s3/frames/*.png")), rep["start"], rep["period"]


def boiled(paths, amp, seed=0):
    """Smooth per-frame colour noise inside the silhouette: texture that re-rolls every frame."""
    rs, out = np.random.RandomState(seed), []
    for i, p in enumerate(paths):
        f = np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)
        h, w = f.shape[:2]
        n = Image.fromarray((rs.normal(0, 1, (h // 16 + 1, w // 16 + 1, 3)) * 40 + 128).clip(0, 255).astype(np.uint8))
        n = np.asarray(n.resize((w // 16 * 16 + 16, h // 16 * 16 + 16), Image.BILINEAR), np.float32)[:h, :w] - 128
        m = C._judge()._mask(f)
        f[m] = (f + n / 40 * amp)[m].clip(0, 255)
        out.append(os.path.join(TMP, f"boil{amp}-{i:04d}.png"))
        Image.fromarray(f.astype(np.uint8)).save(out[-1])
    return out


def gate5(name, want_pass, paths, start, period):
    _, r = C.judge_loop(paths, start, period)
    bad = [k for k, v in r["gates"].items() if not v]
    expect(name, want_pass, r["pass"], f"boil {r['boil']:.3f} head {r['head_drift']:.3f} ident {r['identity_drift']:.3f} "
                                       f"(flicker {r['flicker']:.1f}) {bad or ''}")


print(f"gate 5: boil <= {C.SPEC['judge']['boil_max']}, head_drift <= {C.SPEC['judge']['head_drift_max']}")
for d in C.DIRS:
    gate5(f"frog {d} shipped loop", True, *frog_loop(d))
paths, s, p = frog_loop("e")
gate5("frog e + synthetic boil 12", False, boiled(paths[s:s + p], 12), 0, p)
for clip in ("muck_slog", "net_cast", "run"):
    out = os.path.join(TMP, clip)
    os.makedirs(out)
    subprocess.run([os.path.expanduser("~/.local/bin/ffmpeg"), "-v", "error",
                    "-i", f"{REJECTS}/{clip}_40fps_15s.mp4", "-vf", "fps=16", "-frames:v", "40", f"{out}/%04d.png"], check=True)
    gate5(f"rejected boil clip {clip} @16fps", False, sorted(glob.glob(f"{out}/*.png")), 8, 16)

print(f"gate 6b: off-palette share <= {C.SPEC['palette']['off_max']}")
myco = [os.path.join(CHARS, f"mycologist-{d}-{q}.png") for d in C.DIRS for q in C.POSES]
v = C.off_palette(myco)
expect("mycologist 50 frames", True, v <= C.SPEC["palette"]["off_max"], v)
a = np.asarray(Image.open(myco[0]).convert("RGBA")).copy()
a[..., :3] = np.roll(a[..., :3], 1, axis=2)
Image.fromarray(a).save(os.path.join(TMP, "hue.png"))
v = C.off_palette([os.path.join(TMP, "hue.png")])
expect("mycologist s-idle, channels rotated", False, v <= C.SPEC["palette"]["off_max"], v)

if "--cpu" not in sys.argv:
    os.environ["OLLAMA"] = C.VLM
    import verify as V

    print("gate 4a: view per direction, against the character's own s-idle and n-idle")
    for kind in ("mycologist", "frog-settler"):
        for q in C.POSES:
            _, probs = V.check(os.path.join(CHARS, f"{kind}-e-{q}.png"), {"cat": "char", "dir": "e", "kind": kind, "path": ""})
            expect(f"{kind} e-{q} as e", True, not probs, probs)
    for kind, src, d in (("mycologist", "s-idle", "e"), ("mycologist", "n-idle", "e"), ("mycologist", "s-idle", "n"),
                         ("mycologist", "s-idle", "ne"), ("frog-settler", "s-idle", "e"), ("frog-settler", "s-idle", "n"),
                         ("mycologist", "n-idle", "s")):
        v, probs = V.check(os.path.join(CHARS, f"{kind}-{src}.png"), {"cat": "char", "dir": d, "kind": kind, "path": ""})
        expect(f"{kind} {src} as {d}", False, not probs, f"view {v.get('view')} {probs}")

    print("gate 4b same: a back view against its own front passes; another character's back fails")
    for kind in ("mycologist", "drowned-diver", "vine-ranger", "frog-settler", "blast-diver"):
        for q in ("ne-idle", "n-idle"):
            _, probs = V.check_same(os.path.join(CHARS, f"{kind}-s-idle.png"), os.path.join(CHARS, f"{kind}-{q}.png"))
            expect(f"{kind} {q} vs own s-idle", True, not probs, probs)
    for front, back in (("drowned-diver", "mycologist"), ("mycologist", "drowned-diver"), ("vine-ranger", "drowned-diver"),
                        ("drowned-diver", "vine-ranger"), ("frog-settler", "mycologist"), ("mycologist", "vine-ranger"),
                        ("drowned-diver", "blast-diver"), ("blast-diver", "drowned-diver")):
        for q in ("ne-idle", "n-idle"):
            _, probs = V.check_same(os.path.join(CHARS, f"{front}-s-idle.png"), os.path.join(CHARS, f"{back}-{q}.png"))
            expect(f"{back} {q} vs {front} s-idle", False, not probs, probs)

    print("gate 6: style vs the frog, rendering only; a negative counts as caught by 6 or 6b")
    anchors = [os.path.join(C.THEMES, "swampspace-hires", a) for a in C.SPEC["style"]["anchors"]]
    for q in ("s-idle", "e-walk-3", "n-step"):
        _, probs = V.check_style(os.path.join(CHARS, f"mycologist-{q}.png"), anchors)
        expect(f"mycologist {q}", True, not probs, probs)
    blurred = os.path.join(TMP, "blurred.png")
    Image.open(os.path.join(CHARS, "mycologist-s-idle.png")).convert("RGBA").resize((384, 384), Image.BICUBIC) \
        .filter(ImageFilter.GaussianBlur(4)).resize((96, 96), Image.BICUBIC).save(blurred)
    painted = os.path.join(TMP, "muck_slog", "0001.png")
    for name, p in (("mycologist s-idle, blurred", blurred), ("painted 3D render (muck_slog)", painted)):
        _, probs = V.check_style(p, anchors)
        off = C.off_palette([p]) if p.endswith(".png") and Image.open(p).mode == "RGBA" else None
        caught = bool(probs) or (off is not None and off > C.SPEC["palette"]["off_max"])
        expect(f"{name} (6 or 6b)", False, not caught, f"style {probs or 'ok'}, off-palette {off}")

print(f"\n{wrong} wrong verdict(s)")
sys.exit(min(wrong, 120))
