#!/usr/bin/env python3
"""cast.py: animate a character through the puck-sprites engine, from a committed recipe.

    python3 scripts/assets/cast/cast.py doctor [CHAR]
    python3 scripts/assets/cast/cast.py init CHAR --who "a stocky green frog villager ..."
    python3 scripts/assets/cast/cast.py sweep CHAR DIR --seeds 3 11 12     # Qwen keyframe candidates
    python3 scripts/assets/cast/cast.py pick CHAR DIR SEED                 # commit one keyframe
    python3 scripts/assets/cast/cast.py walk CHAR [--dirs ...]             # Wan clips (GPU)
    python3 scripts/assets/cast/cast.py cut CHAR [--dirs ...] [--pin]      # premat + video2atlas
    python3 scripts/assets/cast/cast.py export CHAR [--check]              # both packs + manifests
    python3 scripts/assets/cast/cast.py gate CHAR [--no-vlm]               # silhouette + qwen3-vl
    python3 scripts/assets/cast/cast.py rebuild CHAR --check               # regenerate and compare
    python3 scripts/assets/cast/cast.py status CHAR
    python3 scripts/assets/cast/cast.py selftest                           # CPU tests, no GPU

The runbook is docs/sprite-cast-runbook.md. Everything a character needs is committed under
scripts/assets/cast/<char>/: recipe.json, keyframes/<dir>.png (+ .json provenance) and
atlas/<dir>.png (+ .json). Uncommitted intermediates live in $CAST_STAGE/<char>/.

Two runtimes. This file runs under WSL python3 and owns the repo side (post.to_palette,
manifests, verify.py, consistency.py). Every engine step runs under the pinned Windows v2a
venv ($CAST_V) with D:/ paths, through engine_runner.py or the engine's own scripts, because
bit-identical output depends on that venv's numpy and Pillow. Before any engine step the
engine checkout must be at the recipe's pinned commit and clean modulo CRLF.

Every verb can be rerun and resumes after a crash: finished work is recognised by a key
over its inputs and skipped, and every file is written to a temporary path and renamed.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(ASSETS))
sys.path.insert(0, HERE)
sys.path.insert(0, ASSETS)
import pack  # noqa: E402

ENGINE = os.environ.get("CAST_ENGINE", "/mnt/d/projects/puck-sprites")
V = os.environ.get("CAST_V", "/mnt/c/Users/hypnodroid/.venvs/v2a/Scripts/python.exe")
STAGE = os.environ.get("CAST_STAGE", "/mnt/d/tmp/sporefall-cast")
RUNNER = os.path.join(HERE, "engine_runner.py")
DIRS = ("s", "se", "e", "ne", "n")
FRAMES = 81  # Wan clip length in the engine's L/R graphs


# ------------------------------------------------------------------ small tools
def die(msg):
    print(f"\ncast: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(2)


def say(msg):
    print(msg, flush=True)


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(path):
    with open(path, "rb") as f:
        return sha_bytes(f.read())


def pixel_sha(path):
    """sha256 over decoded pixels. Wan frames embed their prompt, timestamped save prefix
    included, in a PNG text chunk, so file bytes differ between identical renders."""
    from PIL import Image
    im = Image.open(path)
    h = hashlib.sha256(f"{im.mode}:{im.size[0]}x{im.size[1]}:".encode())
    h.update(im.tobytes())
    return h.hexdigest()


def frames_digest(frames_dir):
    """(count, digest) of a clip: sha256 of the per-frame pixel sha256s, one per line, in order."""
    files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    shas = [pixel_sha(os.path.join(frames_dir, f)) for f in files]
    return len(files), sha_bytes("\n".join(shas).encode())


def key_of(obj):
    return sha_bytes(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode())


def write_bytes(path, data):
    """Atomic write; returns False (and touches nothing) when the file already holds `data`."""
    if os.path.exists(path) and open(path, "rb").read() == data:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.partial-{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return True


def dump_json(obj):
    return (json.dumps(obj, indent=1, ensure_ascii=False) + "\n").encode()


def write_json(path, obj):
    return write_bytes(path, dump_json(obj))


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def win(path):
    """WSL path -> D:/... path for the Windows venv (forward slashes, as the frog run used)."""
    m = re.match(r"^/mnt/([a-z])(/.*)?$", path)
    if m:
        return f"{m.group(1).upper()}:{m.group(2) or '/'}"
    return subprocess.run(["wslpath", "-m", path], capture_output=True, text=True, check=True).stdout.strip()


def replace_dir(partial, final):
    if os.path.isdir(final):
        shutil.rmtree(final)
    os.replace(partial, final)


def fresh(path, key):
    """True when `path` holds finished work for exactly these inputs."""
    k = os.path.join(path, "cast-key.json")
    return os.path.exists(k) and read_json(k).get("key") == key


def mark(path, key, **extra):
    write_json(os.path.join(path, "cast-key.json"), {"key": key, **extra})


# ------------------------------------------------------------------ recipe + paths
def char_dir(char):
    return os.path.join(HERE, char)


def stage(char, *parts):
    p = os.path.join(STAGE, char, *parts)
    os.makedirs(os.path.dirname(p) if os.path.splitext(p)[1] else p, exist_ok=True)
    return p


def load(char):
    p = os.path.join(char_dir(char), "recipe.json")
    if not os.path.exists(p):
        die(f"no recipe at {os.path.relpath(p, REPO)}. Start one with: cast.py init {char} --who '...'")
    r = read_json(p)
    for k in ("char", "engine", "anchor", "keyframes", "walk", "cut", "export"):
        if k not in r:
            die(f"{p}: missing section '{k}'")
    if r["char"] != char:
        die(f"{p}: recipe is for '{r['char']}', not '{char}'")
    return r


def save(r):
    write_json(os.path.join(char_dir(r["char"]), "recipe.json"), r)


def dirs_arg(a):
    ds = a.dirs or list(DIRS)
    bad = [d for d in ds if d not in DIRS]
    if bad:
        die(f"unknown direction(s) {bad}; use {DIRS}")
    return ds


def no_todo(text, where):
    if "TODO" in text:
        die(f"{where} still contains TODO. Write the real prompt into recipe.json first "
            "(this is the art-direction step, see the runbook).")


# ------------------------------------------------------------------ the engine
def git(*args, check=True):
    p = subprocess.run(["git", "-C", ENGINE, *args], capture_output=True, text=True)
    if check and p.returncode not in (0, 1):
        die(f"git {' '.join(args)} failed in {ENGINE}: {p.stderr.strip()}")
    return p


def engine_state():
    head = git("rev-parse", "HEAD").stdout.strip()
    dirty = git("diff", "HEAD", "--ignore-cr-at-eol", "--quiet").returncode != 0
    stat = git("diff", "HEAD", "--ignore-cr-at-eol", "--stat").stdout.strip() if dirty else ""
    untracked = git("ls-files", "--others", "--exclude-standard").stdout.split()
    return head, stat, untracked


def run_engine(char, cmd, **job):
    """Run one engine_runner command under the v2a venv; returns its result JSON."""
    jobs = stage(char, "_jobs")
    tag = f"{cmd}-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    job_path, res_path = os.path.join(jobs, f"{tag}.json"), os.path.join(jobs, f"{tag}.result.json")
    write_json(job_path, {"cmd": cmd, "engine": win(ENGINE), "result": win(res_path), **job})
    p = subprocess.run([V, win(RUNNER), win(job_path)], cwd=ENGINE)
    if p.returncode != 0 or not os.path.exists(res_path):
        die(f"engine step '{cmd}' failed (exit {p.returncode}); job file {job_path}")
    return read_json(res_path)


def run_script(script, args, log):
    """One of the engine's own CLI scripts under the v2a venv, output to `log`."""
    with open(log, "w", encoding="utf-8") as f:
        p = subprocess.run([V, f"scripts/{script}", *args], cwd=ENGINE, stdout=f, stderr=subprocess.STDOUT)
    if p.returncode != 0:
        tail = open(log, encoding="utf-8", errors="replace").read()[-2000:]
        die(f"{script} failed (exit {p.returncode}):\n{tail}")


def engine_ready(r, gpu=False):
    """Refuse to run an engine step unless the engine is exactly the one the recipe pins
    (sprite-pipeline-wan.md section 7: a pipeline the repo does not pin is folklore)."""
    pin = r["engine"]
    head, stat, untracked = engine_state()
    problems = []
    if head != pin["commit"]:
        problems.append(f"HEAD is {head}, the recipe pins {pin['commit']}")
    if stat:
        problems.append(f"tracked files differ from HEAD beyond CRLF:\n{stat}")
    if untracked:
        problems.append(f"untracked files: {untracked[:8]}")
    if problems:
        die("ENGINE PIN CHECK FAILED for " + ENGINE + "\n  - " + "\n  - ".join(problems) +
            "\nDo not edit puck-sprites to make this pass. Check out the pinned commit, or re-pin the "
            "recipe deliberately and rebuild (runbook: 'Re-pinning the engine').")
    rt = run_engine(r["char"], "runtime")
    want = pin.get("runtime", {}).get("v2a", {})
    drift = {k: (want[k], rt.get(k)) for k in ("numpy", "Pillow") if k in want and want[k] != rt.get(k)}
    if drift and not os.environ.get("CAST_ALLOW_DRIFT"):
        die(f"v2a venv drifted from the recipe {drift}: output would not be bit-identical. "
            "Restore the venv from the engine's requirements.txt (or set CAST_ALLOW_DRIFT=1 to "
            "make a new sample on purpose).")
    if gpu:
        h = run_engine(r["char"], "health")
        if h["comfyui"] != pin["comfyui"] and not os.environ.get("CAST_ALLOW_DRIFT"):
            die(f"ComfyUI is {h['comfyui']}, the recipe's clips were made on {pin['comfyui']}")
    return head


def wsl_runtime():
    import numpy
    import PIL
    import scipy
    return {"python": sys.version.split()[0], "numpy": numpy.__version__,
            "Pillow": PIL.__version__, "scipy": scipy.__version__}


def wsl_drift(r):
    want = r["engine"].get("runtime", {}).get("wsl", {})
    have = wsl_runtime()
    drift = {k: (want[k], have[k]) for k in ("numpy", "Pillow", "scipy") if k in want and want[k] != have[k]}
    if drift:
        say(f"WARNING: WSL python3 packages drifted from the recipe {drift}; export bytes may change. "
            "Run `export --check` and read the result before trusting it.")


# ------------------------------------------------------------------ staged inputs
def stage_ref(r, ref):
    """A recipe picture reference -> a content-addressed PNG on D: (the upload name is the
    basename, so two characters can never clobber each other's input in ComfyUI)."""
    char, inputs = r["char"], stage(r["char"], "inputs")
    if ref == "anchor":
        src = os.path.join(REPO, r["anchor"]["file"])
        h = r["anchor"]["height"]
        out = os.path.join(inputs, f"{char}-anchor-{sha_file(src)[:10]}-h{h}.png")
        if not os.path.exists(out):
            run_engine(char, "place", src=win(src), out=win(out), height=h)
        return out
    if isinstance(ref, str) and ref in DIRS:
        src = os.path.join(char_dir(char), "keyframes", f"{ref}.png")
        if not os.path.exists(src):
            die(f"picture '{ref}' is the committed {ref} keyframe, which does not exist yet: pick it first")
    elif isinstance(ref, dict) and "file" in ref:
        src = ref["file"] if os.path.isabs(ref["file"]) else os.path.join(REPO, ref["file"])
    else:
        die(f"bad picture reference {ref!r}: use 'anchor', a direction, or {{\"file\": path}}")
    out = os.path.join(inputs, f"{char}-{ref if isinstance(ref, str) else 'file'}-{sha_file(src)[:10]}.png")
    if not os.path.exists(out):
        write_bytes(out, open(src, "rb").read())
    return out


def stage_canvas(char):
    out = os.path.join(stage(char, "inputs"), "canvas-white-1280x720.png")
    if not os.path.exists(out):
        run_engine(char, "canvas", out=win(out))
    return out


def parse_ref(s):
    if s is None or s == "anchor" or s in DIRS:
        return s
    if s.startswith("file:"):
        path = os.path.abspath(s[5:])
        rel = os.path.relpath(path, REPO)
        return {"file": rel if not rel.startswith("..") else path}
    die(f"bad picture reference {s!r}: use anchor, a direction, or file:PATH")


# ------------------------------------------------------------------ init
KF_STYLE = ("He is STANDING UPRIGHT on both feet, not sitting, not crouching, not kneeling, with his weight "
            "on both planted feet and his back straight. Keep the identical painted style, the same colours, "
            "the same outfit, the same chunky proportions, the same height and the same size as in Picture 1, "
            "on a clean pure white background, with wide margins and nothing touching the edges. "
            "No text, no watermark, no grid.")
KF_VIEWS = {
    "s": "Picture 1 shows {who} seen from the front. Picture 2 shows the same character. Draw this exact same "
         "character standing and facing us straight from the front, looking at us, his arms down at his sides "
         "and his feet planted side by side. ",
    "se": "Picture 1 and Picture 2 show the same character, {who}, standing and facing us from the front. Draw "
          "this exact same standing character rotated 45 degrees to a three-quarter view of his front-right: his "
          "body and face turned toward the right side of the image, one eye and the side of his face visible. ",
    "e": "Picture 1 and Picture 2 show the same character, {who}, standing and facing us from the front. Draw "
         "this exact same standing character in a full side profile facing the right side of the image: the "
         "whole outline of his face and one eye, his near arm and near leg in front of the far ones, both feet "
         "on the ground. ",
    "ne": "Picture 1 and Picture 2 show the same character, {who}, standing, seen from directly behind. Draw "
          "this exact same standing character turned 45 degrees to a three-quarter REAR view: we still see his "
          "back, but his body is angled toward the right side of the image so his right shoulder comes forward "
          "and his far side is hidden. His legs and feet are clearly visible. NO eye is visible. NO face is "
          "visible. His head stays turned away from us. ",
    "n": "Picture 1 and Picture 2 show the same character, {who}, standing and facing us from the front. Draw "
         "this exact same standing character seen from DIRECTLY BEHIND: the back of his head, the back of his "
         "body and outfit, and the backs of his arms and legs. His face is completely hidden, no eyes and no "
         "mouth visible. ",
}
KF_INPUTS = {"s": ("anchor", "anchor"), "se": ("s", "s"), "e": ("s", "s"), "ne": ("n", "n"), "n": ("s", "s")}
WALK_BASE = ("Pixel art game sprite animation. {who}, {view}. He walks in place on the spot in a smooth looping "
             "walk cycle: his two legs step one after the other with clear alternating steps and his body bobs "
             "slightly with each step. He does not move across the frame. Static camera, the camera does not "
             "move, plain white background, crisp pixel art, flat colours.")
WALK_VIEWS = {
    "s": "seen from the front, facing the camera, walking straight toward us",
    "se": "seen in a three-quarter front view turned toward the right of the frame, walking diagonally toward "
          "the lower right",
    "e": "in full side profile facing the right side of the frame, walking to the right",
    "ne": "seen in a three-quarter rear view turned toward the right of the frame, walking away from us toward "
          "the upper right",
    "n": "seen from directly behind, walking straight away from us",
}
WALK_EXTRA = {"ne": " He never turns around and never faces the camera: we only ever see him from behind for "
                    "the whole clip. His legs and feet step out one and then the other."}
CUT_ARGS = ["--pixel", "--sprite-height", "96", "--matte", "alpha", "--erode", "1", "--frames", "8",
            "--lens-guard", "0", "--no-canon"]
EXPORT = {"idle": 0, "step": 4, "despeck": {"lo": 225, "spread": 14},
          "packs": [{"pack": "swampspace-hires", "px": 96, "content": 92, "resample": "nearest"},
                    {"pack": "swampspace", "px": 48, "content": 46, "resample": "lanczos"}]}


def cmd_init(a):
    char = a.char
    p = os.path.join(char_dir(char), "recipe.json")
    if os.path.exists(p):
        die(f"{os.path.relpath(p, REPO)} exists; edit it instead")
    anchor = a.anchor or os.path.join("scripts", "assets", "anchors", f"{char}-s-idle.png")
    if not os.path.exists(os.path.join(REPO, anchor)):
        die(f"no anchor at {anchor}: the curated s-idle design every keyframe is drawn from")
    pack.archetypes(char)
    head, stat, untracked = engine_state()
    if stat or untracked:
        die(f"engine checkout is not clean; refusing to pin it:\n{stat}\n{untracked}")
    rt = run_engine(char, "runtime")
    h = run_engine(char, "health")
    who = a.who
    r = {
        "schema": 1,
        "char": char,
        "engine": {"repo": win(ENGINE), "remote": "https://github.com/redaphid/puck-sprites", "commit": head,
                   "comfyui": h["comfyui"], "runtime": {"v2a": rt, "wsl": wsl_runtime()}},
        "anchor": {"file": anchor, "height": 560},
        "keyframes": {"graph": "workflows/qwen/K3-front.json", "height": 540, "dirs": {
            d: {"seed": None, "p1": KF_INPUTS[d][0], "p2": KF_INPUTS[d][1],
                "prompt": "TODO(check every phrase against the anchor) " + KF_VIEWS[d].format(who=who) + KF_STYLE}
            for d in DIRS}},
        "walk": {"graph": "L", "seed": 3, "dirs": {
            d: {"prompt": "TODO(check every phrase against the keyframe) " +
                WALK_BASE.format(who=who[:1].upper() + who[1:], view=WALK_VIEWS[d]) + WALK_EXTRA.get(d, "")}
            for d in DIRS}},
        "cut": {"premat": ["--shrink", "1"], "args": CUT_ARGS,
                "dirs": {d: {"args": ["--min-period", "30"]} for d in DIRS}},
        "export": EXPORT,
    }
    save(r)
    say(f"wrote {os.path.relpath(p, REPO)}: engine {head[:12]}, ComfyUI {h['comfyui']}. "
        "Edit every TODO prompt, then sweep s.")


# ------------------------------------------------------------------ sweep + pick
def cmd_sweep(a):
    r = load(a.char)
    d = a.dir
    kd = r["keyframes"]["dirs"][d]
    no_todo(kd["prompt"], f"keyframes.dirs.{d}.prompt")
    head = engine_ready(r, gpu=True)
    inputs = {"p1": stage_ref(r, kd["p1"]), "p2": stage_ref(r, kd["p2"]), "canvas": stage_canvas(r["char"])}
    key = key_of({"engine": head, "graph": r["keyframes"]["graph"], "prompt": kd["prompt"],
                  "inputs": {k: sha_file(p) for k, p in inputs.items()}})
    out_root = stage(r["char"], "sweep", d)
    todo = [s for s in a.seeds
            if not (os.path.exists(os.path.join(out_root, f"s{s}", "gen.json"))
                    and read_json(os.path.join(out_root, f"s{s}", "gen.json")).get("key") == key)]
    if todo:
        run_engine(r["char"], "keyframes", graph=r["keyframes"]["graph"], prompt=kd["prompt"], seeds=todo,
                   inputs={k: win(p) for k, p in inputs.items()}, refs={"p1": kd["p1"], "p2": kd["p2"]},
                   key=key, out_root=win(out_root), name=f"{r['char']}-{d}", label=f"CAST-{r['char']}-{d}")
    say(f"{len(a.seeds) - len(todo)} seed(s) already done, {len(todo)} generated")
    prov = os.path.join(char_dir(r["char"]), "keyframes", f"{d}.json")
    pinned = read_json(prov).get("raw_pixel_sha256") if os.path.exists(prov) else None
    for s in a.seeds:
        raw = os.path.join(out_root, f"s{s}", "raw.png")
        if pinned and pixel_sha(raw) == pinned:
            say(f"  s{s}: raw.png reproduces the committed {d} pick pixel for pixel")
    sheet = contact_sheet(out_root, a.seeds, f"{r['char']}-{d}")
    say(f"contact sheet: {sheet}\nLook at every candidate at full size ({out_root}/s<seed>/"
        f"{r['char']}-{d}-white.png), then: cast.py pick {r['char']} {d} <seed>")


def contact_sheet(out_root, seeds, name):
    from PIL import Image, ImageDraw
    cells = []
    for s in seeds:
        im = Image.open(os.path.join(out_root, f"s{s}", f"{name}-white.png")).convert("RGB")
        im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
        ImageDraw.Draw(im).text((8, 8), f"seed {s}", fill=(200, 0, 0))
        cells.append(im)
    cols = min(3, len(cells))
    rows = (len(cells) + cols - 1) // cols
    w, h = cells[0].size
    sheet = Image.new("RGB", (cols * w, rows * h), (255, 255, 255))
    for i, c in enumerate(cells):
        sheet.paste(c, ((i % cols) * w, (i // cols) * h))
    out = os.path.join(out_root, "contact.png")
    sheet.save(out)
    return out


def cmd_pick(a):
    r = load(a.char)
    d, seed = a.dir, a.seed
    src = os.path.abspath(a.from_dir) if a.from_dir else os.path.join(STAGE, r["char"], "sweep", d, f"s{seed}")
    gen_path = os.path.join(src, "gen.json")
    if not os.path.exists(gen_path):
        die(f"no candidate at {src} (gen.json missing): sweep it first")
    gen = read_json(gen_path)
    if int(gen["seed"]) != seed:
        die(f"{gen_path} is seed {gen['seed']}, not {seed}")
    alphas = [f for f in os.listdir(src) if f.endswith("-alpha.png")]
    if len(alphas) != 1:
        die(f"expected one *-alpha.png in {src}, found {alphas}")
    refs = gen.get("refs") or {}
    p1 = parse_ref(a.p1) or refs.get("p1")
    p2 = parse_ref(a.p2) or refs.get("p2")
    if p1 is None or p2 is None:
        die("this candidate does not record its pictures; name them with --p1/--p2 (anchor, a direction, "
            "or file:PATH)")
    engine_ready(r)
    height = r["keyframes"]["height"]
    tmp = stage(r["char"], "pick", f"{d}-s{seed}.png")
    res = run_engine(r["char"], "place", src=win(os.path.join(src, alphas[0])), out=win(tmp), height=height)
    data = open(tmp, "rb").read()
    kpath = os.path.join(char_dir(r["char"]), "keyframes", f"{d}.png")
    old = sha_file(kpath) if os.path.exists(kpath) else None
    g = gen["graph"]
    uploaded = {"p1": g["41"]["inputs"]["image"], "p2": g["900"]["inputs"]["image"],
                "canvas": g["902"]["inputs"]["image"]}
    recorded = gen.get("inputs", {})
    prov = {
        "dir": d, "seed": seed, "prompt": gen["prompt"],
        "inputs": {k: {"ref": ref, "uploaded_as": uploaded[k],
                       "pixel_sha256": recorded.get(k, {}).get("pixel_sha256")}
                   for k, ref in (("p1", p1), ("p2", p2), ("canvas", "white 1280x720"))},
        "candidate": src if a.from_dir else os.path.relpath(src, STAGE),
        "raw_pixel_sha256": pixel_sha(os.path.join(src, "raw.png")),
        "normalise": {"from": alphas[0], "height": height, "content_size": res["size"]},
        "png_sha256": sha_bytes(data),
        "graph": g,
    }
    wrote = write_bytes(kpath, data)
    write_json(os.path.join(char_dir(r["char"]), "keyframes", f"{d}.json"), prov)
    r["keyframes"]["dirs"][d].update({"seed": seed, "p1": p1, "p2": p2, "prompt": gen["prompt"],
                                      "sha256": sha_bytes(data)})
    if old and old != sha_bytes(data):
        r["walk"]["dirs"][d].pop("frames_sha256", None)
        r["cut"]["dirs"][d].pop("loop", None)
        say(f"the {d} keyframe changed: its pinned clip digest and loop are cleared; walk + cut --pin it again")
    save(r)
    say(f"{d}: seed {seed} {'committed' if wrote else 'unchanged'} -> {os.path.relpath(kpath, REPO)} "
        f"(content {res['size'][0]}x{res['size'][1]}, W/H {res['wh']})")


# ------------------------------------------------------------------ walk + cut
def walk_key(r, d, head):
    w, kd = r["walk"], r["keyframes"]["dirs"][d]
    return key_of({"engine": head, "graph": w["graph"], "seed": w["seed"], "prompt": w["dirs"][d]["prompt"],
                   "keyframe": kd["sha256"]})


def clip_dir(r, root, d):
    return os.path.join(root, d, f"walk{r['walk']['graph']}-s{r['walk']['seed']}")


def walk_one(r, d, head, clips_root, free_after):
    """Make (or reuse) one Wan clip. Returns (clip dir, seconds or None when reused)."""
    kd, wd = r["keyframes"]["dirs"][d], r["walk"]["dirs"][d]
    no_todo(wd["prompt"], f"walk.dirs.{d}.prompt")
    kf = os.path.join(char_dir(r["char"]), "keyframes", f"{d}.png")
    if not os.path.exists(kf) or sha_file(kf) != kd.get("sha256"):
        die(f"keyframes/{d}.png is missing or differs from the recipe's sha256: pick it again")
    key = walk_key(r, d, head)
    out = clip_dir(r, clips_root, d)
    if fresh(out, key):
        return out, None
    img = stage_ref(r, d)
    res = run_engine(r["char"], "walk", facing=r["walk"]["graph"], seed=r["walk"]["seed"], image=win(img),
                     prompt=wd["prompt"], out_root=win(os.path.join(clips_root, d)), key=key,
                     label=f"CAST-{r['char']}-{d}", free_after=free_after)
    if res["frames"] != FRAMES:
        die(f"{d}: the clip has {res['frames']} frames, expected {FRAMES}")
    return out, res["seconds"]


def cmd_walk(a):
    r = load(a.char)
    ds = dirs_arg(a)
    head = engine_ready(r, gpu=True)
    root = stage(r["char"], "clips")
    for i, d in enumerate(ds):
        t0 = time.time()
        out, secs = walk_one(r, d, head, root, free_after=(i == len(ds) - 1))
        n, dig = frames_digest(os.path.join(out, "frames"))
        pinned = r["walk"]["dirs"][d].get("frames_sha256")
        verdict = ("no pinned clip yet" if not pinned else
                   "MATCHES the pinned clip" if pinned == dig else "DIFFERS from the pinned clip")
        took = f"{secs:.0f}s on the GPU" if secs is not None else "already done"
        say(f"{d}: {n} frames, digest {dig[:16]} ({took}, {time.time() - t0:.0f}s total) - {verdict}")


def cut_one(r, d, frames_dir, work_root, head):
    """premat + video2atlas for one clip. Returns (atlas dir, frame count, frames digest)."""
    n, dig = frames_digest(frames_dir)
    c = r["cut"]
    rgba = os.path.join(work_root, "rgba", d)
    pkey = key_of({"engine": head, "frames": dig, "premat": c["premat"]})
    if not fresh(rgba, pkey):
        part = rgba + ".partial"
        shutil.rmtree(part, ignore_errors=True)
        os.makedirs(part)
        run_script("premat.py", [win(frames_dir), win(part), *c["premat"]], os.path.join(part, "premat.log"))
        mark(part, pkey)
        replace_dir(part, rgba)
    args = c["args"] + c["dirs"][d].get("args", [])
    atlas = os.path.join(work_root, "atlas", d)
    akey = key_of({"rgba": pkey, "args": args})
    if not fresh(atlas, akey):
        part = atlas + ".partial"
        shutil.rmtree(part, ignore_errors=True)
        os.makedirs(part)
        run_script("video2atlas.py", [f"walk{d}={win(rgba)}", "--out-dir", win(part), *args],
                   os.path.join(part, "video2atlas.log"))
        mark(part, akey)
        replace_dir(part, atlas)
    return atlas, n, dig


def loop_of(atlas):
    row = read_json(os.path.join(atlas, "report.json"))["rows"][0]
    lp = row["loop"]
    return {"start": lp["start"], "period": lp["period"], "seam": lp["error_rel"]}, row


def cmd_cut(a):
    r = load(a.char)
    ds = dirs_arg(a)
    head = engine_ready(r)
    work = stage(r["char"])
    for d in ds:
        if a.clips:
            frames = os.path.join(clip_dir(r, os.path.abspath(a.clips), d), "frames")
        else:
            cd = clip_dir(r, stage(r["char"], "clips"), d)
            if not fresh(cd, walk_key(r, d, head)):
                die(f"{d}: no clip for the current recipe in {cd}: run walk first (or pass --clips)")
            frames = os.path.join(cd, "frames")
        atlas, n, dig = cut_one(r, d, frames, work, head)
        loop, row = loop_of(atlas)
        say(f"{d}: loop start {loop['start']} period {loop['period']} seam {loop['seam']} "
            f"(cells from frames {row['source_frames']}) -> {atlas}/contact.png")
        if a.pin:
            pin_row(r, d, atlas, n, dig, loop, row)
    if a.pin:
        save(r)


def pin_row(r, d, atlas, n, dig, loop, row):
    """Commit the row and record the loop and the clip it was cut from."""
    data = open(os.path.join(atlas, "atlas.png"), "rb").read()
    base = os.path.join(char_dir(r["char"]), "atlas", d)
    wrote = write_bytes(base + ".png", data)
    rep = read_json(os.path.join(atlas, "report.json"))
    write_json(base + ".json", {
        "dir": d, "png_sha256": sha_bytes(data), "clip": {"frames": n, "frames_sha256": dig},
        "premat": r["cut"]["premat"], "args": r["cut"]["args"] + r["cut"]["dirs"][d].get("args", []),
        "cell": rep["cell"], "pivot": rep["pivot"], "loop": row["loop"], "source_frames": row["source_frames"],
        "durations_ms": row["durations_ms"], "scale": row["scale"]})
    r["walk"]["dirs"][d].update({"frames": n, "frames_sha256": dig})
    r["cut"]["dirs"][d]["loop"] = loop
    say(f"  pinned {d}: atlas/{d}.png {'written' if wrote else 'unchanged'}")


# ------------------------------------------------------------------ export
def export_files(r, atlas_dir):
    import packs
    targets = [p["pack"] for p in r["export"]["packs"]]
    default = packs.default_pack()
    if default not in targets:
        die(f"the game loads '{default}' (theme.ts DEFAULT_THEME_ID) and the recipe does not export to it")
    files, report = pack.pack_files(r, atlas_dir, DIRS)
    packs.assert_writable(default, [f"char.{a}.s-idle" for a in pack.archetypes(r["char"])])
    return files, report


def compare_packs(files):
    """{pack: (same, [differing or missing rel paths])} against what is on disk."""
    out = {}
    for pk, fs in files.items():
        same, diff = 0, []
        for rel, data in fs.items():
            p = os.path.join(pack.THEMES, pk, rel)
            if os.path.exists(p) and open(p, "rb").read() == data:
                same += 1
            else:
                diff.append(rel)
        out[pk] = (same, diff)
    return out


def cmd_export(a):
    r = load(a.char)
    wsl_drift(r)
    atlas_dir = os.path.join(char_dir(r["char"]), "atlas")
    missing = [d for d in DIRS if not os.path.exists(os.path.join(atlas_dir, f"{d}.png"))]
    if missing:
        die(f"no committed atlas row for {missing}: cut --pin them first")
    files, report = export_files(r, atlas_dir)
    bad = 0
    for pk, fs in files.items():
        if a.check:
            same, diff = compare_packs({pk: fs})[pk]
            bad += len(diff)
            say(f"{pk}: {same}/{len(fs)} PNGs byte-identical" + (f", DIFFER: {diff}" if diff else ""))
        else:
            n = sum(write_bytes(os.path.join(pack.THEMES, pk, rel), data) for rel, data in fs.items())
            say(f"{pk}: {n} PNG(s) written, {len(fs) - n} already identical")
        text, changes = pack.manifest_update(pk, r["char"], set(fs))
        for c in changes:
            say(f"  manifest {c}")
        if a.check:
            bad += len(changes)
        elif text:
            write_bytes(os.path.join(pack.THEMES, pk, "manifest.json"), text.encode())
        say(f"  {pk}/manifest.json: {len(changes)} change(s)" + (" needed" if a.check and changes else ""))
    for k, v in report.items():
        say(f"  {k}: {v['white_px_inpainted']} backdrop-white px inpainted")
    if a.check and bad:
        die(f"export --check: {bad} difference(s)")


# ------------------------------------------------------------------ gate
def cmd_gate(a):
    r = load(a.char)
    char = r["char"]
    say(f"== silhouette consistency (consistency.py {char} --check, swampspace pack)")
    p = subprocess.run([sys.executable, os.path.join(ASSETS, "consistency.py"), char, "--check"],
                       capture_output=True, text=True)
    say((p.stdout + p.stderr).rstrip())
    fails = 0 if p.returncode == 0 else 1
    if not a.no_vlm:
        fails += vlm_gate(char, a.frames.split(","))
    if fails:
        die(f"gate: {fails} failing check group(s) (details above). Do not regenerate art to make a "
            "gate pass; report it.")
    say("gate: all green")


def vlm_gate(char, frames):
    """qwen3-vl facing check per frame and identity against s-idle (verify.py), hi-res pack.
    Identical files (idle is walk-<idle>, step is walk-<step>) are asked once."""
    import verify as VF
    chars = os.path.join(pack.THEMES, "swampspace-hires", "chars")
    say(f"== qwen3-vl facing ({VF.MODEL}, {VF.VOTES} votes each, swampspace-hires)")
    fails, rows, seen = 0, [], {}
    for d in DIRS:
        for fr in frames:
            path = os.path.join(chars, f"{char}-{d}-{fr}.png")
            h = sha_file(path)
            if h not in seen:
                seen[h] = VF.check(path, {"cat": "char", "dir": d, "kind": char, "path": path})
            v, probs = seen[h]
            fails += bool(probs)
            say(f"{'FAIL' if probs else 'ok  '} {d}-{fr:8s} face={v.get('face_visible')} {probs}")
            rows.append({"frame": f"{d}-{fr}", "probs": probs, "face_visible": v.get("face_visible")})
    say("== qwen3-vl identity against s-idle")
    anchor = os.path.join(chars, f"{char}-s-idle.png")
    for d in DIRS[1:]:
        for fr in ("idle", "walk-4"):
            v, probs = VF.check_same(anchor, os.path.join(chars, f"{char}-{d}-{fr}.png"))
            fails += bool(probs)
            say(f"{'FAIL' if probs else 'ok  '} same {d}-{fr:8s} {probs} {str(v.get('reason', ''))[:90]}")
            rows.append({"frame": f"same {d}-{fr}", "probs": probs, "reason": v.get("reason", "")})
    n = len(rows)
    bad = sum(1 for x in rows if x["probs"])
    say(f"\n{bad} FAIL / {n} checked")
    write_json(stage(char, "gate-vlm.json"), {"fails": bad, "checked": n, "rows": rows})
    return 1 if bad else 0


# ------------------------------------------------------------------ rebuild --check
def cmd_rebuild(a):
    if not a.check:
        die("rebuild only runs as --check: it regenerates everything into the stage dir and compares. "
            "To change art, use walk / cut --pin / export.")
    r = load(a.char)
    ds = dirs_arg(a)
    head = engine_ready(r, gpu=True)
    rk = key_of({k: r[k] for k in ("engine", "keyframes", "walk", "cut", "export")})[:12]
    root = stage(r["char"], "rebuild", rk if not a.fresh else f"{rk}-{time.strftime('%Y%m%d-%H%M%S')}")
    say(f"rebuild workspace {root}")
    results, rows_dir = {}, os.path.join(root, "rows")
    for i, d in enumerate(ds):
        t0 = time.time()
        out, secs = walk_one(r, d, head, os.path.join(root, "clips"), free_after=(i == len(ds) - 1))
        atlas, n, dig = cut_one(r, d, os.path.join(out, "frames"), root, head)
        data = open(os.path.join(atlas, "atlas.png"), "rb").read()
        write_bytes(os.path.join(rows_dir, f"{d}.png"), data)
        committed = open(os.path.join(char_dir(r["char"]), "atlas", f"{d}.png"), "rb").read()
        gen = read_json(os.path.join(out, "gen.json"))
        results[d] = {"frames": n, "clip": dig == r["walk"]["dirs"][d].get("frames_sha256"),
                      "atlas": data == committed, "gpu_s": gen.get("seconds"),
                      "reused": secs is None, "wall_s": round(time.time() - t0)}
        say(f"{d}: clip {'MATCH' if results[d]['clip'] else 'MISMATCH'} ({n} frames, {dig[:16]}), "
            f"atlas row {'MATCH' if results[d]['atlas'] else 'MISMATCH'}, "
            f"Wan {gen.get('seconds')}s{' (reused from an earlier run of this check)' if secs is None else ''}")
    if len(ds) == len(DIRS):
        files, _ = export_files(r, rows_dir)
        for pk, (same, diff) in compare_packs(files).items():
            results[f"export:{pk}"] = {"same": same, "differ": diff}
            say(f"export {pk}: {same}/{same + len(diff)} shipped PNGs byte-identical"
                + (f", DIFFER: {diff}" if diff else ""))
    write_json(os.path.join(root, "result.json"), results)
    ok = all(v.get("clip", True) and v.get("atlas", True) and not v.get("differ") for v in results.values())
    if not ok:
        die("rebuild --check: MISMATCH (see above)")
    say("rebuild --check: everything regenerated bit-identically")


# ------------------------------------------------------------------ doctor + status
def cmd_doctor(a):
    ok = True
    head, stat, untracked = engine_state()
    say(f"engine  {ENGINE} HEAD {head}" + ("" if not (stat or untracked) else "  NOT CLEAN"))
    if stat or untracked:
        ok = False
        say(f"        {stat} {untracked[:5]}")
    if a.char:
        r = load(a.char)
        pin = r["engine"]["commit"]
        ok &= head == pin
        say(f"        recipe pins {pin} -> {'ok' if head == pin else 'MISMATCH'}")
        wsl_drift(r)
    try:
        rt = run_engine(a.char or "_doctor", "runtime")
        say(f"v2a     {V}\n        {rt}")
        h = run_engine(a.char or "_doctor", "health")
        say(f"comfyui {h['comfyui']} os={h['os']} queue={h['queue']}")
    except SystemExit:
        ok = False
    say(f"wsl     {wsl_runtime()}")
    try:
        import urllib.request
        with urllib.request.urlopen(os.environ.get("OLLAMA", "http://localhost:11434") + "/api/tags", timeout=5) as f:
            names = [m["name"] for m in json.load(f)["models"]]
        vl = os.environ.get("VLM", "qwen3-vl:8b")
        ok &= vl in names
        say(f"ollama  {vl} {'present' if vl in names else 'MISSING'}")
    except Exception as e:  # noqa: BLE001
        ok = False
        say(f"ollama  not answering: {e}")
    say(f"stage   {STAGE}")
    if not ok:
        die("doctor: not ready (see above)")


def cmd_status(a):
    r = load(a.char)
    say(f"{r['char']}: engine {r['engine']['commit'][:12]}, ComfyUI {r['engine']['comfyui']}")
    say(f"{'dir':3s} {'keyframe':22s} {'clip digest':18s} {'loop':22s} atlas")
    for d in DIRS:
        kd, wd, cd = r["keyframes"]["dirs"][d], r["walk"]["dirs"][d], r["cut"]["dirs"][d]
        kf = f"seed {kd['seed']} {kd['p1']}/{kd['p2']}" if kd.get("sha256") else "-"
        lp = cd.get("loop")
        loop = f"{lp['start']}+{lp['period']} seam {lp['seam']}" if lp else "-"
        atlas = os.path.exists(os.path.join(char_dir(r["char"]), "atlas", f"{d}.png"))
        say(f"{d:3s} {str(kf)[:22]:22s} {(wd.get('frames_sha256') or '-')[:16]:18s} {loop:22s} "
            f"{'yes' if atlas else '-'}")


def cmd_selftest(a):
    import selftest
    raise SystemExit(selftest.main())


# ------------------------------------------------------------------ CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="verb", required=True)

    def verb(name, fn, char=True, dirs=False):
        p = sub.add_parser(name)
        if char:
            p.add_argument("char")
        if dirs:
            p.add_argument("--dirs", nargs="+")
        p.set_defaults(fn=fn)
        return p

    p = verb("doctor", cmd_doctor, char=False)
    p.add_argument("char", nargs="?")
    p = verb("init", cmd_init)
    p.add_argument("--who", required=True, help="one noun phrase for the character, e.g. 'a stocky green frog "
                                                "villager wearing a brown hooded cloak and a scarf'")
    p.add_argument("--anchor", help="repo-relative anchor PNG (default scripts/assets/anchors/<char>-s-idle.png)")
    p = verb("sweep", cmd_sweep)
    p.add_argument("dir", choices=DIRS)
    p.add_argument("--seeds", type=int, nargs="+", required=True)
    p = verb("pick", cmd_pick)
    p.add_argument("dir", choices=DIRS)
    p.add_argument("seed", type=int)
    p.add_argument("--from", dest="from_dir", help="adopt a candidate directory made elsewhere")
    p.add_argument("--p1")
    p.add_argument("--p2")
    verb("walk", cmd_walk, dirs=True)
    p = verb("cut", cmd_cut, dirs=True)
    p.add_argument("--clips", help="cut clips from ROOT/<dir>/walk<G>-s<seed>/frames instead of the stage")
    p.add_argument("--pin", action="store_true", help="commit the rows and record the loops in the recipe")
    p = verb("export", cmd_export)
    p.add_argument("--check", action="store_true", help="compare with what is shipped; write nothing")
    p = verb("gate", cmd_gate)
    p.add_argument("--no-vlm", action="store_true")
    p.add_argument("--frames", default="idle,step," + ",".join(f"walk-{i}" for i in range(8)))
    p = verb("rebuild", cmd_rebuild, dirs=True)
    p.add_argument("--check", action="store_true")
    p.add_argument("--fresh", action="store_true", help="regenerate even if this check already ran")
    verb("status", cmd_status)
    verb("selftest", cmd_selftest, char=False)
    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
