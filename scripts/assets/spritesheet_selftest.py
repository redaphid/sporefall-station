#!/usr/bin/env python3
"""Selftest for spritesheet.py + comfy_ui.py, against a FAKE ComfyUI. No GPU, no network.

Exit code = number of failures (same contract as pack_guard_selftest.py: a harness
that aborts prints no failures, so the count and the verdict are printed and returned).

The fake server draws Wren, the deck-9 courier, for every SaveImage it is asked for:
a teal body, a pale chest (the thing a naive colour key punches a hole in), and an
orange satchel that hangs on the image's RIGHT whenever she is drawn facing right.
The satchel is how these tests tell a mirrored frame from a correct one; it is the
only asymmetric thing she owns, and she never puts it down.
"""
import http.server
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import urllib.parse

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

FAILS, RAN = [], 0


def check(name, cond, detail=""):
    global RAN
    RAN += 1
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


# ---- Wren -----------------------------------------------------------------------
TEAL, CHEST, SATCHEL = (36, 86, 92), (242, 246, 234), (255, 144, 50)


def wren(pose="idle", facing="right", size=1024, bg=(255, 255, 255), x_shift=0, stride=None):
    if size != 1024:  # she is drawn on the 1024 grid and scaled, so every size shows the same courier
        return wren(pose, facing, 1024, bg, x_shift, stride).resize((size, size), Image.NEAREST)
    im = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(im)
    cx = size // 2 + x_shift
    if stride is None:
        stride = 70 if pose not in ("idle",) else 0
    d.rectangle((cx - 110, 260, cx + 110, 760), fill=TEAL, outline=(8, 8, 12), width=10)  # body
    d.ellipse((cx - 90, 120, cx + 90, 300), fill=TEAL, outline=(8, 8, 12), width=10)  # head
    d.rectangle((cx - 50, 330, cx + 50, 560), fill=CHEST)  # pale chest, enclosed by teal
    d.rectangle((cx - 90 - stride, 760, cx - 20 - stride, 900), fill=TEAL)  # legs
    d.rectangle((cx + 20 + stride, 760, cx + 90 + stride, 900), fill=TEAL)
    sx = cx + 120 if facing == "right" else cx - 190
    d.rectangle((sx, 480, sx + 70, 600), fill=SATCHEL)
    return im


def satchel_side(frame: Image.Image) -> str:
    a = np.asarray(frame.convert("RGBA")).astype(int)
    o = a[..., 3] > 0
    sat = o & (np.abs(a[..., 0] - SATCHEL[0]) < 60) & (a[..., 1] > 90) & (a[..., 1] < 200) & (a[..., 2] < 110)
    if not sat.any():
        return "?"
    body_x = np.where(o)[1].mean()
    return "R" if np.where(sat)[1].mean() > body_x else "L"


WALK_PERIOD = 40


# ---- the fake ComfyUI -----------------------------------------------------------
class Fake:
    prompts: list = []
    images: dict = {}
    uploads: dict = {}
    face_left: set = set()  # directions the "model" gets wrong
    fail: set = set()  # prompt ids that end in an execution error
    extra: list = []  # extra_data of each POST /prompt
    deleted: list = []  # ids POSTed to /queue {"delete": [...]}
    models = {
        "diffusion_models": ["Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf", "Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf",
                             "Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf",
                             "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
                             "qwen_image_edit_2511_fp8_e4m3fn.safetensors",
                             "wan2.2_i2v_high_noise_14B_Q4_K_M.gguf"],
        "loras": ["Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
                  "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
                  "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors",
                  "qwen-image-edit-2511-multiple-angles-lora.safetensors",
                  "wan2.2\\wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
                  "wan2.2\\wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
                  "pixel_art_style_by_skormino_v7.05_test_72img.safetensors"],
        "text_encoders": ["qwen_2.5_vl_7b_fp8_scaled.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
        # the real server (0.37) also has the Qwen-Image 2.1 VAE, which sorts before the Edit VAE
        "vae": ["qwen_image_2.1_vae_bf16.safetensors", "qwen_image_vae.safetensors", "wan_2.1_vae.safetensors"],
        "checkpoints": ["SDXL1.0\\juggernautXL_juggXIByRundiffusion.safetensors"],
    }


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype="application/json", code=200):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/models/"):
            return self._send(Fake.models.get(u.path.split("/", 2)[2], []))
        if u.path.startswith("/history/"):
            pid = u.path.rsplit("/", 1)[1]
            if pid in Fake.fail:
                return self._send({pid: {"status": {"status_str": "error", "completed": False, "messages": [
                    ["execution_error", {"node_type": "KSamplerAdvanced",
                                         "exception_message": "cutlass_fp16_linear: K mismatch"}]]}, "outputs": {}}})
            g = Fake.prompts[int(pid)]
            outs = {}
            for nid, n in g.items():
                if n["class_type"] != "SaveImage" or "(mp4)" in n.get("_meta", {}).get("title", ""):
                    continue
                title = n.get("_meta", {}).get("title", "")
                fn = f"p{pid}-n{nid}.png"
                m = re.match(r"frame (\w+) (\S+)", title)
                if m:
                    d, pose = m.groups()
                    facing = "left" if (d in ("w", "nw", "sw") or d in Fake.face_left) else "right"
                    im = wren(pose, facing, bg=(250, 248, 246))  # warm off-white, like SDXL's "white"
                elif title.startswith("keyframe "):
                    im = Image.new("RGB", (1280, 720), (255, 255, 255))
                    im.paste(wren(size=720), (280, 0))
                elif title.startswith("walk ") and "(mp4)" not in title:
                    # her deck-9 shift, walked in place: one full stride every WALK_PERIOD frames. Frame 0
                    # stands still (the keyframe); the stride builds over the first few frames, as Wan's do.
                    d = title.split()[1]
                    facing = "left" if d in Fake.face_left else "right"
                    ims = []
                    for i in range(81):
                        amp = min(1.0, i / 6)
                        st = int(60 * amp * np.sin(2 * np.pi * i / WALK_PERIOD))
                        fr = Image.new("RGB", (848, 480), (253, 253, 251))
                        fr.paste(wren(facing=facing, size=480, stride=st, bg=(253, 253, 251)), (184, 0))
                        buf = io.BytesIO()
                        fr.save(buf, "PNG")
                        Fake.images[f"{fn[:-4]}-{i:04d}.png"] = buf.getvalue()
                        ims.append({"filename": f"{fn[:-4]}-{i:04d}.png", "subfolder": "", "type": "output"})
                    outs[nid] = {"images": ims}
                    continue
                elif title.startswith("grid"):
                    k = len(title.split()) - 1
                    im = Image.new("RGB", (512 * k, 1024), (255, 255, 255))
                    for i in range(k):
                        im.paste(wren(size=1024).resize((512, 512)), (i * 512, 256))
                else:
                    im = Image.new("RGB", (64, 64), (255, 255, 255))
                buf = io.BytesIO()
                im.save(buf, "PNG")
                Fake.images[fn] = buf.getvalue()
                outs[nid] = {"images": [{"filename": fn, "subfolder": "", "type": "output"}]}
            return self._send({pid: {"status": {"status_str": "success", "completed": True}, "outputs": outs}})
        if u.path == "/view":
            fn = urllib.parse.parse_qs(u.query)["filename"][0]
            return self._send(Fake.images[fn], "image/png")
        if u.path == "/object_info":
            return self._send({})
        if u.path == "/queue":
            return self._send({"queue_running": [], "queue_pending": []})
        return self._send({"error": "no"}, code=404)

    def do_POST(self):
        n = int(self.headers["Content-Length"])
        body = self.rfile.read(n)
        if self.path == "/prompt":
            g = json.loads(body)["prompt"]
            Fake.extra.append(json.loads(body).get("extra_data"))
            errs = validate(g)
            if errs:
                return self._send({"error": errs}, code=400)
            Fake.prompts.append(g)
            return self._send({"prompt_id": str(len(Fake.prompts) - 1)})
        if self.path == "/queue":
            Fake.deleted += json.loads(body).get("delete", [])
            return self._send({})
        if self.path == "/interrupt":
            return self._send({})
        if self.path == "/upload/image":
            name = re.search(rb'filename="([^"]+)"', body).group(1).decode()
            Fake.uploads[name] = body
            return self._send({"name": name})
        return self._send({"error": "no"}, code=404)


def validate(g):
    """What the real server would 400 on: dangling links, bad slots, unknown inputs."""
    import comfy_ui
    errs = []
    for nid, n in g.items():
        spec = comfy_ui.BUILTIN.get(n["class_type"])
        if spec is None:
            errs.append(f"{nid}: unknown class {n['class_type']}")
            continue
        links, widgets, _ = spec
        names = {x for x, _ in links} | {w.replace("+control", "") for w in widgets if w != "upload"}
        for k, v in n["inputs"].items():
            if k not in names:
                errs.append(f"{nid} {n['class_type']}: unknown input {k}")
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                src = g.get(v[0])
                if src is None:
                    errs.append(f"{nid}.{k}: dangling link to {v[0]}")
                    continue
                outs = comfy_ui.BUILTIN[src["class_type"]][2]
                want = dict(links).get(k)
                if v[1] >= len(outs):
                    errs.append(f"{nid}.{k}: {src['class_type']} has no output {v[1]}")
                elif want and outs[v[1]][1] != want:
                    errs.append(f"{nid}.{k}: wants {want}, gets {outs[v[1]][1]}")
        for w in widgets:
            w = w.replace("+control", "")
            if w != "upload" and w not in n["inputs"] and n["class_type"] not in ("SaveImage",):
                errs.append(f"{nid} {n['class_type']}: widget {w} unset")
    return errs


def g_class(g, nid):
    return g[nid]["class_type"]


def raises(fn):
    try:
        fn()
    except (SystemExit, Exception):
        return True
    return False


def overlaps(wf):
    ns, out = wf["nodes"], []
    for i, a in enumerate(ns):
        for b in ns[i + 1:]:
            (ax, ay), (aw, ah), (bx, by), (bw, bh) = a["pos"], a["size"], b["pos"], b["size"]
            if ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah:
                out.append((a.get("title", a["type"]), b.get("title", b["type"])))
    return out


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    srv = serve()
    os.environ["COMFY"] = f"http://127.0.0.1:{srv.server_port}"
    import comfy_ui
    import spritesheet as S
    S.HOST = os.environ["COMFY"]
    tmp = tempfile.mkdtemp(prefix="spritesheet-selftest-")
    try:
        src = os.path.join(tmp, "wren.png")
        # transparent PNG in: must land on WHITE, not the black LoadImage would give it
        rgba = wren().convert("RGBA")
        a = np.asarray(rgba).copy()
        a[(a[..., :3] == 255).all(-1), 3] = 0
        Image.fromarray(a).save(src)

        print("input prep")
        p = S.prep_input(src)
        check("prep: 1024 square", p.size == (1024, 1024))
        check("prep: transparent -> white, not black", p.getpixel((2, 2)) == (255, 255, 255))
        tiny = os.path.join(tmp, "wren-48.png")
        wren().resize((48, 48), Image.NEAREST).save(tiny)
        pt = np.asarray(S.prep_input(tiny))
        check("prep: pixel-art input upscaled NEAREST (no new colours)",
              len({tuple(c) for c in pt.reshape(-1, 3)}) <= len({tuple(c) for c in np.asarray(Image.open(tiny).convert('RGB')).reshape(-1, 3)}) + 1)

        print("keying")
        k = np.asarray(S.key_background(wren(bg=(250, 248, 246))))
        check("key: backdrop gone", k[5, 5, 3] == 0)
        check("key: pale chest enclosed by the body stays opaque", k[440, 512, 3] == 255)
        ring = Image.new("RGB", (120, 120), (255, 255, 255))
        ImageDraw.Draw(ring).ellipse((20, 20, 100, 100), outline=(30, 60, 64), width=12)  # a claw curled to a leg
        ImageDraw.Draw(ring).rectangle((20, 55, 32, 65), fill=(255, 255, 255))  # 3x3 backdrop speck in the rim
        ImageDraw.Draw(ring).rectangle((20, 55, 32, 65), outline=(30, 60, 64), width=5)
        check("key: an enclosed backdrop pocket stays opaque by default", np.asarray(S.key_background(ring))[60, 60, 3] == 255)
        kp = np.asarray(S.key_background(ring, pockets=S.POCKET_PX))
        check("key: pockets= keys the enclosed backdrop pocket", kp[60, 60, 3] == 0 and kp[5, 5, 3] == 0)
        check("key: pockets= keeps the character and a speck under POCKET_PX (despeckle's job)",
              kp[22, 60, 3] == 255 and kp[60, 26, 3] == 255)
        dark = os.path.join(tmp, "dark-anchor.png")
        da = Image.new("RGBA", (40, 40), (0, 0, 0, 0))  # matted, like the r2 anchors
        ImageDraw.Draw(da).ellipse((5, 5, 35, 35), fill=(30, 60, 64, 255))
        da.save(dark)
        pale = os.path.join(tmp, "wren-anchor.png")
        wren().save(pale)
        check("key: pocket keying on for an anchor with no backdrop-coloured part",
              S.pocket_px(dark, np.array([255.0, 255, 255])) == S.POCKET_PX)
        check("key: pocket keying off for an anchor with a pale chest, and for no anchor",
              S.pocket_px(pale, np.array([255.0, 255, 255])) == 0 and S.pocket_px(None, np.array([255.0, 255, 255])) == 0)

        print("model detection")
        q, notes = S.detect_qwen({})
        check("detect: 2511 beats 2509", "2511" in q["unet"], q["unet"])
        check("detect: lightning matches the model version and prefers 4-step",
              q["lightning"] == "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", q["lightning"])
        check("detect: angles LoRA found", q["angles"] and "angles" in q["angles"])
        check("detect: rank puts an 'Edit-2' release above 2511",
              S._qwen_rank("Qwen-Image-Edit-2_fp8.safetensors") > S._qwen_rank("qwen_image_edit_2511_fp8.safetensors"))
        check("detect: 2511 is not mistaken for 'Edit-2'", S._qwen_rank("qwen_image_edit_2511.safetensors")[0] == 3)
        check("detect: the Edit VAE, not the 2.1 VAE that sorts first", q["vae"] == "qwen_image_vae.safetensors",
              q["vae"])
        check("detect: --lightning none wins", S.detect_qwen({"lightning": "none"})[0]["lightning"] is None)

        print("graphs")
        dirs, poses = S.PACK_DIRS, ["idle", "step"]
        for label, g in (("qwen", S.qwen_graph("c.png", dirs, poses, 7, q)),
                         ("qwen no-lightning", S.qwen_graph("c.png", dirs, poses, 7, {**q, "lightning": None})),
                         ("qwen gguf+angles", S.qwen_graph("c.png", dirs, poses, 7, {**q, "unet": "x.gguf"}, angles=True)),
                         ("grid", S.grid_graph("c.png", dirs, 7, q)),
                         ("sdxl", S.sdxl_graph("c.png", dirs, poses, 7, "a courier")),
                         ("video", S.video_graph("c.png", "e", 3, q, S.WAN, "a courier"))):
            errs = validate(g.nodes)
            check(f"{label}: validates", not errs, "; ".join(errs[:3]))
            saves = [n["_meta"]["title"] for n in g.nodes.values() if n["class_type"] == "SaveImage"]
            if label not in ("grid", "video"):
                want = {f"frame {d} {p}" for d in dirs for p in poses}
                check(f"{label}: one titled save per frame", want <= set(saves), sorted(want - set(saves)))
            wf = g.workflow()
            ids = {n["id"] for n in wf["nodes"]}
            ok = all(l[1] in ids and l[3] in ids for l in wf["links"])
            by = {n["id"]: n for n in wf["nodes"]}
            ok = ok and all(by[l[3]]["inputs"][l[4]]["link"] == l[0] and l[0] in by[l[1]]["outputs"][l[2]]["links"]
                            for l in wf["links"])
            check(f"{label}: editor workflow links are consistent both ways", ok)
            check(f"{label}: no two editor nodes overlap", not overlaps(wf), overlaps(wf)[:3])
            ks = [n for n in wf["nodes"] if n["type"] == "KSampler"]
            check(f"{label}: KSampler widgets = seed, control, steps, cfg, sampler, scheduler, denoise",
                  all(len(n["widgets_values"]) == 7 and n["widgets_values"][1] == "fixed" for n in ks))
        g = S.video_graph("c.png", "e", 3, q, S.WAN)
        adv = [n for n in g.nodes.values() if n["class_type"] == "KSamplerAdvanced"]

        def upstream(nid, cls):  # follow the model input back to the loader
            while True:
                n = g.nodes[nid]
                if n["class_type"] == cls:
                    return n
                if "model" not in n["inputs"]:
                    return None
                nid = n["inputs"]["model"][0]
        check("video: both Wan experts compute in bf16 (the frog's graph; fp16 dies on 0.37)",
              all((upstream(k["inputs"]["model"][0], "ModelComputeDtype") or {}).get("inputs", {}).get("dtype") == "bf16"
                  for k in adv) and len(adv) == 2)
        g = S.qwen_graph("c.png", dirs, poses, 7, {**q, "lightning": None})
        ks = [n["inputs"] for n in g.nodes.values() if n["class_type"] == "KSampler"]
        check("no lightning -> 20 steps, CFG 2.5", all(k["steps"] == 20 and k["cfg"] == 2.5 for k in ks))
        g = S.qwen_graph("c.png", dirs, poses, 7, q)
        step_enc = [n for n in g.nodes.values() if n.get("_meta", {}).get("title") == "e step prompt"][0]
        idle_dec = [n for n in g.nodes.values() if n.get("_meta", {}).get("title") == "frame e idle"][0]
        check("a pose derives from ITS direction's idle (image1), input is image2",
              step_enc["inputs"]["image1"] == idle_dec["inputs"]["images"]
              and g.nodes[step_enc["inputs"]["image2"][0]]["class_type"] == "LoadImage")

        print("editor conversion guards")
        try:
            comfy_ui.to_workflow({"1": {"class_type": "NoSuchNode", "inputs": {}}})
            check("unknown node raises instead of guessing widget order", False)
        except KeyError:
            check("unknown node raises instead of guessing widget order", True)
        info = {"KSampler": {"input": {"required": {
            "model": ["MODEL"], "seed": ["INT", {"control_after_generate": True}], "steps": ["INT"],
            "cfg": ["FLOAT"], "sampler_name": [["euler"]], "scheduler": [["simple"]],
            "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "latent_image": ["LATENT"],
            "denoise": ["FLOAT"]}}, "output": ["LATENT"], "output_name": ["LATENT"]},
            "LoadImage": {"input": {"required": {"image": [["a.png"], {"image_upload": True}]}},
                          "output": ["IMAGE", "MASK"], "output_name": ["IMAGE", "MASK"]}}
        sp = comfy_ui.specs_from_object_info(info)
        check("object_info: seed gets its control widget", sp["KSampler"][1][0] == "seed+control")
        check("object_info: LoadImage gets its upload widget", sp["LoadImage"][1] == ["image", "upload"])
        check("object_info: link inputs keep their order",
              [n for n, _ in sp["KSampler"][0]] == ["model", "positive", "negative", "latent_image"])
        # ComfyUI 0.37: optional widgets the API graph leaves unset, a dynamic combo, an empty combo
        info = {"ModelSamplingAuraFlow": {"input": {"required": {"model": ["MODEL"], "shift": ["FLOAT"]}, "optional": {
            "sampling": [["flow", "img_to_img_velocity"], {"default": "flow", "advanced": True}]}},
            "output": ["MODEL"], "output_name": ["MODEL"]},
            "SaveVideo": {"input": {"required": {"video": ["VIDEO"], "filename_prefix": ["STRING"],
                                                 "format": ["COMFY_DYNAMICCOMBO_V3", {"options": [
                                                     {"key": "auto", "inputs": {}}, {"key": "mp4", "inputs": {}}]}]},
                                    "optional": {"codec": ["COMBO", {"options": ["auto", "h264"]}]}},
                          "output": [], "output_name": []},
            "Pick": {"input": {"required": {"name": [[]]}}, "output": [], "output_name": []}}
        sp = comfy_ui.specs_from_object_info(info)
        wf = comfy_ui.to_workflow({"1": {"class_type": "ModelSamplingAuraFlow", "inputs": {"shift": 3.1}},
                                   "2": {"class_type": "SaveVideo", "inputs": {"filename_prefix": "x", "format": "mp4",
                                                                               "codec": "h264"}}}, specs=sp)
        by = {n["type"]: n for n in wf["nodes"]}
        check("object_info: an unset optional widget gets its default, not null",
              by["ModelSamplingAuraFlow"]["widgets_values"] == [3.1, "flow"], by["ModelSamplingAuraFlow"]["widgets_values"])
        check("object_info: a dynamic combo is a widget, not a link socket",
              by["SaveVideo"]["widgets_values"] == ["x", "mp4", "h264"]
              and [i["name"] for i in by["SaveVideo"]["inputs"]] == ["video"], by["SaveVideo"])
        check("object_info: an empty combo does not crash the spec read", sp["Pick"][1] == ["name"])

        print("end to end: qwen, 5 dirs x idle+step")
        out = os.path.join(tmp, "run")
        S.main([src, "--out", out, "--seeds", "7", "--describe", "a courier with an orange satchel"])
        r = os.path.join(out, "s7")
        sheet = Image.open(f"{r}/sheet.png")
        check("sheet is 2 poses x 5 dirs of 48", sheet.size == (96, 240), sheet.size)
        meta = json.load(open(f"{r}/sheet.json"))
        check("sheet.json has every frame rect", len(meta["frames"]) == 10)
        check("frames named <kind>-<dir>-<pose>", os.path.exists(f"{r}/frames/wren-e-step.png"))
        check("flow_api.json + flow.json written beside the run",
              os.path.exists(f"{r}/flow_api.json") and os.path.exists(f"{r}/flow.json"))
        check("one graph for the whole sheet", len(Fake.prompts) == 1)
        check("input uploaded", "spritesheet-wren.png" in Fake.uploads)
        fr = {k: Image.open(f"{r}/frames/wren-{k}.png") for k in ("s-idle", "s-step", "e-idle", "e-step")}
        al = {k: np.asarray(v)[..., 3] for k, v in fr.items()}
        check("hard alpha only", all(set(np.unique(v)) <= {0, 255} for v in al.values()))
        feet = {k: np.where(v.any(1))[0].max() for k, v in al.items()}
        # post.sprite's convention: 1 px under the feet (y = canvas - th - 1)
        check("feet on the pack's foot row (canvas-2) in every frame", set(feet.values()) == {46}, feet)
        hts = {k: np.where(v.any(1))[0].max() - np.where(v.any(1))[0].min() for k, v in al.items()}
        check("one scale for all frames: same height idle vs step", hts["s-idle"] == hts["s-step"], hts)
        cols = {tuple(c) for c in np.asarray(fr["s-idle"])[al["s-idle"] > 0][:, :3]}
        pal = {tuple(c) for c in json.load(open(f"{r}/post.json"))["palette"]}
        check("every pixel on the input's own palette", cols <= pal)
        check("pale chest survives the key at 48 px", any(min(c) > 200 for c in cols))
        check("satchel on the right when facing right (e)", satchel_side(fr["e-idle"]) == "R")
        check("preview + gifs", os.path.exists(f"{r}/preview.png") and os.path.exists(f"{r}/anim-e.gif"))

        print("mirror: a seed that came back facing left")
        Fake.face_left = {"e"}
        S.main([src, "--out", os.path.join(tmp, "left"), "--seeds", "7", "--dirs", "e"])
        check("unflipped: satchel on the left (the bug the pack shipped once)",
              satchel_side(Image.open(os.path.join(tmp, "left/s7/frames/wren-e-idle.png"))) == "L")
        S.main([src, "--out", os.path.join(tmp, "fixed"), "--seeds", "7", "--dirs", "e", "--mirror", "e"])
        check("--mirror e: satchel back on the right",
              satchel_side(Image.open(os.path.join(tmp, "fixed/s7/frames/wren-e-idle.png"))) == "R")
        Fake.face_left = set()

        print("repack (no GPU)")
        n0 = len(Fake.prompts)
        S.main(["repack", r, "--size", "32", "--palette", "swampspace", "--to", os.path.join(tmp, "r32")])
        s32 = Image.open(os.path.join(tmp, "r32/sheet.png"))
        check("repack: 32 px sheet", s32.size == (64, 160), s32.size)
        check("repack: queued nothing", len(Fake.prompts) == n0)
        import palette
        cols = {tuple(c) for c in np.asarray(s32)[np.asarray(s32)[..., 3] > 0][:, :3]}
        check("repack: swampspace palette honoured", cols <= set(palette.RGB))

        print("walk preset + seeds")
        S.main([src, "--out", os.path.join(tmp, "walk"), "--seeds", "1", "2", "--dirs", "e", "--frames", "walk"])
        check("walk: 5 poses in a row", Image.open(os.path.join(tmp, "walk/s2/sheet.png")).size == (240, 48))
        check("walk: one sheet per seed", os.path.exists(os.path.join(tmp, "walk/s1/sheet.png")))
        seeds = {n["inputs"]["seed"] for n in Fake.prompts[-1].values() if n["class_type"] == "KSampler"}
        check("walk: every sampler in a sheet shares its seed", seeds == {2}, seeds)

        print("grid")
        S.main([src, "--out", os.path.join(tmp, "grid"), "--method", "grid", "--seeds", "3"])
        check("grid: cut into 5 idle cells", Image.open(os.path.join(tmp, "grid/s3/sheet.png")).size == (48, 240))

        print("video route (the frog's)")
        w, _ = S.detect_wan({})
        check("wan: Q4_K_M experts picked over Q8", w["high"].endswith("HighNoise-Q4_K_M.gguf")
              and w["low"].endswith("LowNoise-Q4_K_M.gguf"), (w["high"], w["low"]))
        check("wan: lightx2v high/low LoRAs matched", "high_noise" in w["lora_high"] and "low_noise" in w["lora_low"])
        vg = S.video_graph("c.png", "e", 3, q, w).nodes
        wi = next(n["inputs"] for n in vg.values() if n["class_type"] == "WanImageToVideo")
        check("wan: 848x480, 81 frames (the frog's settings)", (wi["width"], wi["height"], wi["length"]) == (848, 480, 81))
        ka = [n["inputs"] for n in vg.values() if n["class_type"] == "KSamplerAdvanced"]
        check("wan: high 0-2 then low 2-end, 4 steps, cfg 1",
              [(k["start_at_step"], k["end_at_step"]) for k in ka] == [(0, 2), (2, 10000)]
              and all(k["steps"] == 4 and k["cfg"] == 1.0 for k in ka))
        check("wan: the walk starts from the keyframe (scaled), not the raw input",
              g_class(vg, wi["start_image"][0]) == "ImageScale")
        clip = [wren(stride=int(60 * min(1, i / 6) * np.sin(2 * np.pi * i / 40)), size=240) for i in range(81)]
        lp = S.find_loop(clip)
        check("loop: finds the full 40-frame stride, not the half", lp["period"] == 40, lp)
        check("loop: seam smoother than an ordinary step", lp["seam"] < 1.0, lp)
        check("loop: a clip too short says so", raises(lambda: S.find_loop(clip[:20])))
        # a short-legged walker: 20-frame stride, so 40 and 60 match as well; cut one stride, not three
        quick = [wren(stride=int(60 * min(1, i / 6) * np.sin(2 * np.pi * i / 20)), size=240) for i in range(81)]
        lq = S.find_loop(quick)
        check("loop: the shortest full stride (20), not two or three of them", lq["period"] == 20, lq)
        check("loop: per-direction --period ranges", S.period_ranges("12:64,n=14:18", ["s", "n"])
              == {"s": (12, 64), "n": (14, 18)})
        sp = Image.new("RGBA", (5, 5), (36, 86, 92, 255))
        sp.putpixel((2, 2), (250, 250, 250, 255))
        check("despeckle: an isolated white pixel takes its neighbours' colour",
              S.despeckle(sp).getpixel((2, 2)) == (36, 86, 92, 255))
        big = Image.new("RGBA", (5, 5), (250, 250, 250, 255))
        check("despeckle: a white AREA (a real white shirt) is left alone", S.despeckle(big).getpixel((2, 2))[0] == 250)

        n0 = len(Fake.prompts)
        vout = os.path.join(tmp, "video")
        S.main([src, "--out", vout, "--method", "video", "--dirs", "s,e"])
        v = os.path.join(vout, "video-s3")
        check("video: one queue per direction", len(Fake.prompts) - n0 == 2)
        seeds = {n["inputs"].get("noise_seed", n["inputs"].get("seed")) for n in Fake.prompts[-1].values()
                 if n["class_type"] in ("KSampler",) or (n["class_type"] == "KSamplerAdvanced"
                                                          and n["inputs"]["add_noise"] == "enable")}
        check("video: default seed is the frog's (3)", seeds == {3}, seeds)
        vs = Image.open(f"{v}/sheet.png")
        check("video: 96 px (swampspace-hires), idle+step+8 walk per row", vs.size == (960, 192), vs.size)
        vm = json.load(open(f"{v}/sheet.json"))
        check("video: loop recorded per direction", vm["loops"]["e"]["period"] == 40, vm.get("loops"))
        check("video: pack naming chars/<kind>-<dir>-walk-<n>",
              all(os.path.exists(f"{v}/frames/wren-e-walk-{i}.png") for i in range(8)))
        check("video: all 81 clip frames kept for re-cutting", len(os.listdir(f"{v}/raw/walk-e")) == 81)
        check("video: keyframe kept", os.path.exists(f"{v}/raw/e-keyframe.png"))
        import palette
        va = np.asarray(vs)
        cols = {tuple(c) for c in va[va[..., 3] > 0][:, :3]}
        check("video: every pixel on the pack's 34 colours", cols <= set(palette.RGB))
        walk = [np.asarray(Image.open(f"{v}/frames/wren-e-walk-{i}.png"))[..., 3] > 0 for i in range(8)]
        heads = {np.where(f.any(1))[0].min() for f in walk}
        check("video: one fixed window: the head row never pumps", len(heads) == 1, heads)
        check("video: the legs actually move across the cycle",
              len({f.tobytes() for f in walk}) >= 4)
        widths = [np.ptp(np.where(f.any(0))[0]) for f in walk]
        stepw = np.ptp(np.where((np.asarray(Image.open(f"{v}/frames/wren-e-step.png"))[..., 3] > 0).any(0))[0])
        check("video: step = the widest stride of the cycle", stepw == max(widths), (stepw, widths))
        check("video: satchel on the right, facing right", satchel_side(Image.open(f"{v}/frames/wren-e-idle.png")) == "R")
        ex = Fake.extra[n0]
        check("video: the editor workflow rides along as extra_pnginfo (drag-in rebuilds the graph)",
              bool(ex) and "nodes" in ex["extra_pnginfo"]["workflow"])
        check("video: ComfyUI's own keyframe file kept, bytes untouched",
              os.path.exists(f"{v}/raw/e-keyframe-comfy.png"))
        fi = Image.open(f"{v}/frames/wren-e-walk-3.png").info
        check("video: a shipped frame carries its direction's flow (tEXt prompt + workflow)",
              "nodes" in json.loads(fi.get("workflow", "{}")) and json.loads(fi["prompt"]) ==
              json.load(open(f"{v}/flow-e_api.json")))
        check("video: editor + API flow per direction written",
              os.path.exists(f"{v}/flow-e.json") and os.path.exists(f"{v}/flow-s_api.json"))

        def queued_prompts(api):
            by_title = {n.get("_meta", {}).get("title", ""): n["inputs"] for n in api.values()}
            return by_title["e keyframe prompt"]["prompt"], by_title["e walk prompt"]["text"]
        key, wan = queued_prompts(Fake.prompts[-1])
        check("motion: the default is the frog's walk (strides, standing keyframe)",
              "full strides" in wan and "standing still" in key and vm.get("motion") == "walk", (vm.get("motion"), wan))
        S.main([src, "--out", os.path.join(tmp, "hover"), "--method", "video", "--dirs", "e", "--motion", "hover",
                "--describe", "a domed drone with limbs hanging beneath it"])
        key, wan = queued_prompts(Fake.prompts[-1])
        hm = json.load(open(os.path.join(tmp, "hover", "video-s3", "sheet.json")))
        check("motion: hover asks Wan for a rigid bob, still limbs and no steps, after the describe",
              "as one rigid piece" in wan and "stays still" in wan and "strides" not in wan and "step forward" not in wan
              and wan.index("domed drone") < wan.index("hovers in place"), wan)
        check("motion: hover keyframe floats, it does not stand", "floating in the air" in key and "standing" not in key, key)
        check("motion: the run records its motion", hm.get("motion") == "hover", hm.get("motion"))
        hq = Fake.prompts[-1]
        flf = [n["inputs"] for n in hq.values() if n["class_type"] == "WanFirstLastFrameToVideo"]
        check("motion: hover closes the clip: first frame = last frame = the scaled keyframe",
              len(flf) == 1 and flf[0]["start_image"] == flf[0]["end_image"]
              and g_class(hq, flf[0]["start_image"][0]) == "ImageScale"
              and not any(n["class_type"] == "WanImageToVideo" for n in hq.values()))
        he = hm["loops"]["e"]
        check("motion: a closed clip loops whole (81 frames: period 80 from 0)",
              he.get("closed") and (he["period"], he["start"]) == (80, 0), he)
        S.main(["repack", os.path.join(tmp, "hover", "video-s3"), "--period", "12:64", "--to", os.path.join(tmp, "hre")])
        re_e = json.load(open(os.path.join(tmp, "hre", "sheet.json")))["loops"]["e"]
        check("motion: repack --period (assemble) keeps a closed loop whole", re_e.get("closed") and re_e["period"] == 80, re_e)
        home = [wren(stride=int(60 * np.sin(2 * np.pi * i / 80)), size=240) for i in range(81)]
        cl = S.closed_loop(home)
        check("loop: a closed clip that comes home passes the seam", cl["seam"] <= 0.5, cl)
        away = [wren(stride=int(60 * i / 80), size=240) for i in range(81)]
        check("loop: a closed clip that never came home fails the seam", S.closed_loop(away)["seam"] > 1.0,
              S.closed_loop(away))
        n1 = len(Fake.prompts)
        check("motion: an unknown motion is refused before anything is queued",
              raises(lambda: S.main([src, "--out", os.path.join(tmp, "swim"), "--method", "video", "--motion", "swim"]))
              and len(Fake.prompts) == n1)
        n2 = len(Fake.prompts)
        Fake.fail = {str(n2)}  # the first direction dies on the GPU
        died = raises(lambda: S.main([src, "--out", os.path.join(tmp, "vfail"), "--method", "video", "--dirs", "s,se,e"]))
        Fake.fail = set()
        check("video: a GPU error stops the run and drops its other queued directions",
              died and set(Fake.deleted) >= {str(n2 + 1), str(n2 + 2)}, Fake.deleted)
        n1 = len(Fake.prompts)
        cut_e1 = Image.open(f"{v}/raw/e-walk-1.png").tobytes()
        S.main(["repack", v, "--period", "20:30", "--to", os.path.join(tmp, "vr")])
        vr = json.load(open(os.path.join(tmp, "vr/sheet.json")))
        check("repack --period re-cuts the saved clip without the GPU",
              vr["loops"]["e"]["period"] in range(20, 31) and len(Fake.prompts) == n1, vr["loops"]["e"])
        check("repack --to leaves the source run's cut raws alone",
              json.load(open(f"{v}/sheet.json"))["loops"]["e"]["period"] == 40
              and Image.open(f"{v}/raw/e-walk-1.png").tobytes() == cut_e1)
        S.main(["repack", os.path.join(tmp, "vr"), "--size", "48", "--to", os.path.join(tmp, "vr48")])
        check("a repack --to frame still carries its flow",
              "nodes" in json.loads(Image.open(os.path.join(tmp, "vr/frames/wren-e-idle.png")).info.get("workflow", "{}")))
        check("a repack --to output is itself repackable",
              Image.open(os.path.join(tmp, "vr48/sheet.png")).size == (480, 96))
        anchor = os.path.join(tmp, "vr/frames/wren-s-idle.png")
        S.main(["repack", os.path.join(tmp, "vr"), "--palette-from", anchor, "--to", os.path.join(tmp, "vpal")])
        allowed = set(S.anchor_palette(anchor))
        va = np.asarray(Image.open(os.path.join(tmp, "vpal/sheet.png")))
        check("--palette-from: every frame uses only the s-idle's own colours",
              {tuple(int(x) for x in c) for c in va[va[..., 3] > 0][:, :3]} <= allowed)
        S.main(["repack", os.path.join(tmp, "vpal"), "--size", "48", "--to", os.path.join(tmp, "vpal48")])
        va = np.asarray(Image.open(os.path.join(tmp, "vpal48/sheet.png")))
        check("--palette-from sticks to the run: a later repack keeps it",
              {tuple(int(x) for x in c) for c in va[va[..., 3] > 0][:, :3]} <= allowed)
        check("repack keeps the run's 96 px and palette", Image.open(os.path.join(tmp, "vr/sheet.png")).size == (960, 192))

        print("--flow: a flow tweaked in the editor and exported as API")
        wf_api = json.load(open(f"{r}/flow_api.json"))
        for n in wf_api.values():
            if n["class_type"] == "KSampler":
                n["inputs"]["seed"] = 4242
        edited = os.path.join(tmp, "edited_api.json")
        json.dump(wf_api, open(edited, "w"))
        S.main([src, "--out", os.path.join(tmp, "flowrun"), "--flow", edited])
        seeds = {n["inputs"]["seed"] for n in Fake.prompts[-1].values() if n["class_type"] == "KSampler"}
        check("--flow without --seeds keeps the flow's own seed", seeds == {4242}, seeds)
        check("--flow: sheet built from titled saves",
              Image.open(os.path.join(tmp, "flowrun/flow/sheet.png")).size == (96, 240))
        ed = os.path.join(tmp, "editor.json")
        json.dump(json.load(open(f"{r}/flow.json")), open(ed, "w"))
        try:
            S.main([src, "--out", os.path.join(tmp, "x"), "--flow", ed])
            check("--flow with an EDITOR workflow explains Export (API)", False)
        except SystemExit as e:
            check("--flow with an EDITOR workflow explains Export (API)", "Export (API)" in str(e))

        print("committed flows")
        flows = os.path.join(HERE, "flows")
        for name in ("sprite-sheet-qwen", "sprite-sheet-sdxl", "sprite-sheet-grid", "sprite-sheet-video-e"):
            f = os.path.join(flows, f"{name}.json")
            fa = os.path.join(flows, f"{name}_api.json")
            ok = os.path.exists(f) and os.path.exists(fa)
            check(f"{name}: editor + API files exist", ok)
            if ok:
                check(f"{name}: API graph validates", not validate(json.load(open(fa))))
                wf = json.load(open(f))
                check(f"{name}: editor file is the editor format", "nodes" in wf and "links" in wf)
                check(f"{name}: no two nodes overlap", not overlaps(wf), overlaps(wf)[:3])
                inside = all(any(g["bounding"][0] <= n["pos"][0] and n["pos"][0] + n["size"][0] <= g["bounding"][0] + g["bounding"][2]
                                 and g["bounding"][1] <= n["pos"][1] and n["pos"][1] + n["size"][1] <= g["bounding"][1] + g["bounding"][3]
                                 for g in wf["groups"]) for n in wf["nodes"] if n["type"] != "Note")
                check(f"{name}: every node sits inside a group", inside)
                check(f"{name}: input is a LoadImage titled 'character'",
                      any(n["type"] == "LoadImage" and "character" in n.get("title", "") for n in wf["nodes"]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        srv.shutdown()
    print(f"\n{RAN} checks, {len(FAILS)} failed: {'PASS' if not FAILS else 'FAIL'}")
    return len(FAILS)


if __name__ == "__main__":
    sys.exit(main())
