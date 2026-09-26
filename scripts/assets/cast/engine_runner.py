"""The Windows half of the cast pipeline. cast.py runs it; do not run it by hand.

    $V engine_runner.py JOB.json          # V = the pinned v2a venv's python.exe

It imports puck-sprites' own modules (comfy, animate, make_keyframe, keyframe_tools),
so the graphs, the upload and the keyframe matte are the engine's. The venv matters:
bit-identical output depends on its pinned numpy and Pillow, which is why the
normaliser below runs here and not under WSL python3. cast.py checks the engine pin
before it starts this.

Every output goes to a `.partial` path and is renamed into place when complete, so
a crash never leaves something that looks finished. The result is written to
job["result"] the same way.
"""
import copy
import hashlib
import json
import os
import shutil
import sys
import time

CANVAS = (1280, 720)


def pixel_sha(path):
    from PIL import Image
    im = Image.open(path)
    h = hashlib.sha256(f"{im.mode}:{im.size[0]}x{im.size[1]}:".encode())
    h.update(im.tobytes())
    return h.hexdigest()


def write_json(path, obj):
    tmp = path + ".partial"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def replace_dir(partial, final):
    if os.path.isdir(final):
        shutil.rmtree(final)
    os.replace(partial, final)


def wait_queue_empty(comfy, timeout=5400):
    """One ComfyUI job at a time: never queue behind someone else's work."""
    t0, last = time.time(), -1e9
    while True:
        q = comfy._req("/queue")
        busy = len(q["queue_running"]) + len(q["queue_pending"])
        if not busy:
            return
        if time.time() - t0 > timeout:
            raise SystemExit(f"ComfyUI queue still busy after {timeout}s ({busy} jobs); not submitting")
        if time.time() - last > 60:
            print(f"ComfyUI queue busy ({busy} jobs); waiting for it to drain", flush=True)
            last = time.time()
        time.sleep(10)


# ------------------------------------------------------------------ commands
def cmd_runtime(job):
    import numpy
    import PIL
    import scipy
    return {"python": sys.version.split()[0], "numpy": numpy.__version__,
            "Pillow": PIL.__version__, "scipy": scipy.__version__}


def cmd_health(job):
    import comfy
    s = comfy.health(verbose=True)
    q = comfy._req("/queue")
    return {"os": s["system"]["os"], "comfyui": s["system"]["comfyui_version"],
            "queue": len(q["queue_running"]) + len(q["queue_pending"])}


def cmd_place(job):
    """Crop to the alpha bbox (alpha > 8), scale to `height` px (LANCZOS) and centre on
    a 1280x720 white canvas. Ported unchanged from the frog run's prep2.py, whose
    outputs it reproduces byte for byte: the keyframe normaliser (height 540, on the
    Qwen pick's -alpha.png) and the anchor input (height 560, on the RGB anchor,
    where the bbox is the whole image)."""
    import numpy as np
    from PIL import Image
    im = Image.open(job["src"]).convert("RGBA")
    a = np.array(im)[:, :, 3]
    ys, xs = np.nonzero(a > 8)
    im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    H = int(job["height"])
    w, h = im.size
    im = im.resize((max(1, round(w * H / h)), H), Image.LANCZOS)
    canvas = Image.new("RGBA", CANVAS, (255, 255, 255, 255))
    canvas.alpha_composite(im, ((CANVAS[0] - im.size[0]) // 2, (CANVAS[1] - H) // 2))
    tmp = job["out"] + ".partial.png"
    canvas.convert("RGB").save(tmp)
    os.replace(tmp, job["out"])
    return {"out": job["out"], "size": list(im.size), "wh": round(im.size[0] / H, 3)}


def cmd_canvas(job):
    from PIL import Image
    tmp = job["out"] + ".partial.png"
    Image.new("RGB", CANVAS, (255, 255, 255)).save(tmp)
    os.replace(tmp, job["out"])
    return {"out": job["out"]}


def cmd_keyframes(job):
    """Qwen-Image-Edit keyframe candidates, one per seed: the frog run's kf.py, with
    the prompt and the two pictures as data. Writes OUT/s<seed>/{raw.png,
    NAME-{white,grey,green,alpha}.png, gen.json}."""
    import comfy
    import keyframe_tools as kt
    import make_keyframe as mk
    wf = json.load(open(os.path.join(job["engine"], job["graph"]), encoding="utf-8"))
    comfy.health()
    nodes = {"p1": mk.N_P1, "p2": mk.N_P2, "canvas": mk.N_CANVAS}
    uploaded = {k: comfy.upload(p) for k, p in job["inputs"].items()}
    done = []
    for s in job["seeds"]:
        g = copy.deepcopy(wf)
        for k, name in uploaded.items():
            g[nodes[k]]["inputs"]["image"] = name
        g[mk.N_KS]["inputs"]["seed"] = int(s)
        g[mk.N_POS]["inputs"]["prompt"] = job["prompt"]
        g[mk.N_SAVE]["inputs"]["filename_prefix"] = f"puck-sprites/{job['label']}-s{s}-{time.strftime('%H%M%S')}"
        wait_queue_empty(comfy)
        pid = comfy.submit(g)
        print(f"queued {job['name']} s{s} {pid}", flush=True)
        rec, secs = comfy.wait(pid, timeout=1800)
        final = os.path.join(job["out_root"], f"s{s}")
        part = final + ".partial"
        shutil.rmtree(part, ignore_errors=True)
        f = next(fi for kind, fi in comfy.outputs(rec) if kind == "images")
        raw = comfy.fetch(f, os.path.join(part, "raw.png"))
        kt.keyout(raw, part, job["name"])
        write_json(os.path.join(part, "gen.json"), {
            "key": job["key"], "refs": job["refs"], "seed": s, "seconds": round(secs, 1),
            "prompt": job["prompt"], "graph_file": job["graph"],
            "inputs": {k: {"file": job["inputs"][k], "uploaded_as": uploaded[k],
                           "pixel_sha256": pixel_sha(job["inputs"][k])} for k in job["inputs"]},
            "graph": g})
        replace_dir(part, final)
        print(f"done {job['name']} s{s} {secs:.0f}s -> {final}", flush=True)
        done.append({"seed": s, "dir": final, "seconds": round(secs, 1)})
    return {"done": done}


def cmd_walk(job):
    """One Wan 2.2 I2V clip through the engine's animate.run (its graph, commit guard
    and Ollama note). Writes OUT_ROOT/walk<facing>-s<seed>/{frames/NNNN.png, raw.mp4,
    gen.json} and returns that directory."""
    import animate
    import comfy
    comfy.health()
    wait_queue_empty(comfy)
    part_root = job["out_root"] + ".partial"
    shutil.rmtree(part_root, ignore_errors=True)
    t0 = time.time()
    res = animate.run(job["facing"], [int(job["seed"])], part_root, image=job["image"],
                      prompt=job["prompt"], free_after=job.get("free_after", True), label=job["label"])
    tag, out, meta = res[0]
    final = os.path.join(job["out_root"], tag)
    os.makedirs(job["out_root"], exist_ok=True)
    write_json(os.path.join(out, "cast-key.json"), {"key": job["key"]})
    replace_dir(out, final)
    shutil.rmtree(part_root, ignore_errors=True)
    return {"dir": final, "tag": tag, "frames": meta["frames"], "seconds": meta["seconds"],
            "wall_seconds": round(time.time() - t0, 1), "s_per_it": meta["s_per_it"],
            "commit_peak_gb": meta["commit_peak_gb"]}


CMDS = {"runtime": cmd_runtime, "health": cmd_health, "place": cmd_place, "canvas": cmd_canvas,
        "keyframes": cmd_keyframes, "walk": cmd_walk}


def main():
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    sys.path.insert(0, os.path.join(job["engine"], "scripts"))
    res = CMDS[job["cmd"]](job)
    write_json(job["result"], res)


if __name__ == "__main__":
    main()
