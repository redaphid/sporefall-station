#!/usr/bin/env python3
"""AI tracer: Blender walk-cycle frames -> pack-style 48px sprite frames.

The modern rotoscope stage: each 3D motion-source frame goes through ComfyUI
img2img at LOW denoise (the 3D render fixes composition + pose + color
regions; diffusion only re-develops the surface into pack pixel-art style),
anchored on the character's curated IPAdapter reference, then masked by the
BLENDER frame's own alpha (zero frame-to-frame alpha flicker, unlike rembg)
and downscaled through ONE fixed window shared by all frames/directions
(k-centroid + locked palette) so scale and feet anchoring never pump.

  python3 trace.py                 # trace + post all 5 dirs x 8 frames
  python3 trace.py --dirs e,s --frames 0,4   # subset (pilot runs)
  python3 trace.py --post-only     # redo post from already-traced raws
  python3 trace.py --no-trace      # skip AI entirely: post the raw Blender
                                   # frames (palette-quantized 3D fallback)

Env: SWAMPSPACE_STAGE, COMFY, DENOISE (0.35), SEED (414977), CHAR
(vine-ranger), OUTDIR (default public/themes/swampspace/chars).
Stage layout: $SWAMPSPACE_STAGE/rotoscope/{blender,white,traced}/
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
sys.path.insert(0, ASSETS)

import generate as G  # noqa: E402  (job tables, DIRS wording, anchors)
import post as P      # noqa: E402

STAGE = os.path.join(G.STAGE, "rotoscope")
BLEND = os.path.join(STAGE, "blender")
WHITE = os.path.join(STAGE, "white")
TRACED = os.path.join(STAGE, "traced")
CHAR = os.environ.get("CHAR", "vine-ranger")
OUTDIR = os.environ.get("OUTDIR", os.path.join(G.THEME, "chars"))
DENOISE = float(os.environ.get("DENOISE", "0.35"))
SEED = int(os.environ.get("SEED", "414977"))
CANVAS, CONTENT = 48, 46

DIRS = ["s", "se", "e", "ne", "n"]
FRAMES = list(range(8))
# IPAdapter weight per direction (from the pack playbook: away-facing poses
# drop the anchor weight so the anchor's front view can't fight the pose —
# here pose is nailed by the init image, but face bleed-through still applies)
IPW = {"s": 0.8, "se": 0.7, "e": 0.55, "ne": 0.5, "n": 0.5}
DIR_NEG = {
    "e": "facing the viewer, front view, symmetrical face",
    "ne": "face, eyes, mouth, facing the viewer, front view",
    "n": "face, eyes, mouth, visor on the front, facing the viewer, front view",
}


def blend_path(d, f):
    return os.path.join(BLEND, f"walk-{d}-{f}.png")


def prep_white(d, f):
    """Composite the transparent Blender frame onto flat white (the pack's
    generation background convention) for img2img."""
    os.makedirs(WHITE, exist_ok=True)
    dest = os.path.join(WHITE, f"walk-{d}-{f}.png")
    im = Image.open(blend_path(d, f)).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    bg.convert("RGB").save(dest)
    return dest


def _download(im, dest):
    import urllib.parse
    import urllib.request
    import comfy
    q = urllib.parse.urlencode({"filename": im["filename"],
                                "subfolder": im.get("subfolder", ""),
                                "type": im["type"]})
    with urllib.request.urlopen(f"{comfy.HOST}/view?{q}") as r, open(dest, "wb") as fh:
        fh.write(r.read())


def harvest_history(want):
    """Fill missing traced frames from the server's history — a killed client
    loses nothing that already rendered (shared-GPU reality: polls get killed).
    `want`: {(d, f): dest_path}. Returns the (d, f) keys still missing."""
    import json
    import urllib.request
    import comfy
    try:
        hist = json.load(urllib.request.urlopen(f"{comfy.HOST}/history", timeout=60))
    except Exception:
        return set(want)
    missing = set(want)
    for entry in hist.values():
        for out in entry.get("outputs", {}).values():
            for im in out.get("images", []):
                for (d, f) in list(missing):
                    if im["filename"].startswith(f"roto-{CHAR}-{d}-{f}-"):
                        _download(im, want[(d, f)])
                        print(f"harvested {d}-{f} from server history")
                        missing.discard((d, f))
    return missing


def trace(dirs, frames):
    """Fire-and-forget: submit every missing frame, then poll history and
    download as results land. Resumable — frames already in $TRACED are
    skipped, and orphans from killed runs are harvested before submitting."""
    import time
    import comfy
    desc = G.CHARS["player"][1]
    anchor = os.path.join(G.ANCHORS, f"{CHAR}-s-idle.png")
    refs = [anchor] if os.path.exists(anchor) else None
    os.makedirs(TRACED, exist_ok=True)
    want = {(d, f): os.path.join(TRACED, f"walk-{d}-{f}.png")
            for d in dirs for f in frames
            if not os.path.exists(os.path.join(TRACED, f"walk-{d}-{f}.png"))}
    if not want:
        return
    def submit(d, f):
        pos = (f"{G.TRIGGER}, full body game character sprite, {desc}, "
               f"{G.DIRS[d]}, {G.STEP}, {G.BG_CHAR}, {G.LOOK}")
        neg = ", ".join([p for p in (DIR_NEG.get(d, ""),) if p]
                        + [f"two characters, crowd, cropped, close-up, portrait, {G.NEG_BASE}"])
        g = comfy.build_graph(
            pos=pos, neg=neg, seed=SEED, batch=1, refs=refs,
            ip_weight=IPW[d], init=prep_white(d, f), denoise=DENOISE, alpha=False,
            prefix=f"roto-{CHAR}-{d}-{f}",
        )
        pid = comfy.post("/prompt", {"prompt": g})["prompt_id"]
        print(f"queued {d}-{f}", flush=True)
        return pid

    # Waves of <=8 in flight: the GPU is shared — don't monopolize the queue.
    to_submit = sorted(harvest_history(want))
    pending = {}  # prompt_id -> (d, f)
    import json
    import urllib.request
    deadline = time.time() + 3600 * 6
    while (pending or to_submit) and time.time() < deadline:
        while to_submit and len(pending) < 8:
            d, f = to_submit.pop(0)
            pending[submit(d, f)] = (d, f)
        time.sleep(15)
        for pid, (d, f) in list(pending.items()):
            try:
                h = json.load(urllib.request.urlopen(f"{comfy.HOST}/history/{pid}", timeout=30))
            except Exception:
                continue
            if pid not in h:
                continue
            entry = h[pid]
            if entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError(f"{d}-{f}: " + json.dumps(entry["status"])[:2000])
            outs = [o for o in entry["outputs"].values() if "images" in o]
            if not outs:
                continue
            _download(outs[-1]["images"][0], os.path.join(TRACED, f"walk-{d}-{f}.png"))
            del pending[pid]
            print(f"traced {d}-{f}  ({len(pending)} to go)", flush=True)
    if pending:
        raise TimeoutError(f"still pending: {sorted(pending.values())}")


def union_window(dirs, frames, pad=18):
    """One crop window (from the BLENDER frames' alpha) shared by every frame:
    frame-to-frame scale/position stay rigid, feet bob stays real."""
    import numpy as np
    x0 = y0 = 10**9
    x1 = y1 = -1
    for d in dirs:
        for f in frames:
            a = np.asarray(Image.open(blend_path(d, f)).convert("RGBA"))[..., 3]
            ys, xs = np.where(a > 24)
            x0, x1 = min(x0, xs.min()), max(x1, xs.max())
            y0, y1 = min(y0, ys.min()), max(y1, ys.max())
    return (int(x0 - pad), int(y0 - pad), int(x1 + 1 + pad), int(y1 + 1 + pad))


def post_frame(d, f, win, use_trace=True):
    """Mask traced RGB with the Blender alpha, crop the fixed window,
    k-centroid + palette to the 48px canvas (feet bottom-anchored)."""
    import numpy as np
    src = Image.open(blend_path(d, f)).convert("RGBA")
    alpha = np.asarray(src)[..., 3]
    tp = os.path.join(TRACED, f"walk-{d}-{f}.png")
    if use_trace:
        rgb = np.asarray(Image.open(tp).convert("RGB").resize(src.size, Image.LANCZOS))
    else:
        rgb = np.asarray(src)[..., :3]
    im = Image.fromarray(np.dstack([rgb, np.where(alpha > 100, 255, 0).astype("uint8")]),
                         "RGBA").crop(win)
    w, h = im.size
    th = CONTENT
    tw = max(1, round(w * th / h))
    im = P.to_palette(P.kcentroid(im, tw, th))
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.paste(im, ((CANVAS - tw) // 2, CANVAS - th - 1))
    return out


def strips(dirs):
    """Per-direction film strips (contact sheets) for eyeballing/docs."""
    for d in dirs:
        row = [(f"{d}-{i}", Image.open(os.path.join(OUTDIR, f"{CHAR}-{d}-walk-{i}.png")))
               for i in FRAMES]
        sheet = P.contact_sheet(row, cols=8, cell=96, scale=2)
        dest = os.path.join(STAGE, f"strip-{d}.png")
        sheet.save(dest)
        print(f"strip -> {dest}")


if __name__ == "__main__":
    args = sys.argv[1:]

    def opt(name, default):
        for a in args:
            if a.startswith(name + "="):
                return a.split("=", 1)[1]
        return default

    dirs = [d for d in opt("--dirs", ",".join(DIRS)).split(",") if d]
    frames = [int(f) for f in opt("--frames", ",".join(map(str, FRAMES))).split(",")]
    bad = [d for d in dirs if d not in DIRS]
    if bad:
        sys.exit(f"unknown dirs {bad}")
    use_trace = "--no-trace" not in args
    if use_trace and "--post-only" not in args:
        trace(dirs, frames)
    win = union_window(DIRS, FRAMES)  # always ALL frames: window must be global
    print(f"window {win} denoise={DENOISE} seed={SEED} trace={use_trace}")
    os.makedirs(OUTDIR, exist_ok=True)
    for d in dirs:
        for f in frames:
            out = post_frame(d, f, win, use_trace=use_trace)
            dest = os.path.join(OUTDIR, f"{CHAR}-{d}-walk-{f}.png")
            out.save(dest)
            print(f"{d}-{f} -> {dest}")
    if frames == FRAMES:
        strips(dirs)
