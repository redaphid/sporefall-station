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


def wren(pose="idle", facing="right", size=1024, bg=(255, 255, 255), x_shift=0):
    im = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(im)
    cx = size // 2 + x_shift
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


# ---- the fake ComfyUI -----------------------------------------------------------
class Fake:
    prompts: list = []
    images: dict = {}
    uploads: dict = {}
    face_left: set = set()  # directions the "model" gets wrong
    models = {
        "diffusion_models": ["qwen_image_edit_2509_fp8_e4m3fn.safetensors",
                             "qwen_image_edit_2511_fp8_e4m3fn.safetensors",
                             "wan2.2_i2v_high_noise_14B_Q4_K_M.gguf"],
        "loras": ["Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
                  "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
                  "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors",
                  "qwen-image-edit-2511-multiple-angles-lora.safetensors",
                  "pixel_art_style_by_skormino_v7.05_test_72img.safetensors"],
        "text_encoders": ["qwen_2.5_vl_7b_fp8_scaled.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
        "vae": ["qwen_image_vae.safetensors", "wan_2.1_vae.safetensors"],
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
            g = Fake.prompts[int(pid)]
            outs = {}
            for nid, n in g.items():
                if n["class_type"] != "SaveImage":
                    continue
                title = n.get("_meta", {}).get("title", "")
                fn = f"p{pid}-n{nid}.png"
                m = re.match(r"frame (\w+) (\S+)", title)
                if m:
                    d, pose = m.groups()
                    facing = "left" if (d in ("w", "nw", "sw") or d in Fake.face_left) else "right"
                    im = wren(pose, facing, bg=(250, 248, 246))  # warm off-white, like SDXL's "white"
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
        return self._send({"error": "no"}, code=404)

    def do_POST(self):
        n = int(self.headers["Content-Length"])
        body = self.rfile.read(n)
        if self.path == "/prompt":
            g = json.loads(body)["prompt"]
            errs = validate(g)
            if errs:
                return self._send({"error": errs}, code=400)
            Fake.prompts.append(g)
            return self._send({"prompt_id": str(len(Fake.prompts) - 1)})
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

        print("model detection")
        q, notes = S.detect_qwen({})
        check("detect: 2511 beats 2509", "2511" in q["unet"], q["unet"])
        check("detect: lightning matches the model version and prefers 4-step",
              q["lightning"] == "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", q["lightning"])
        check("detect: angles LoRA found", q["angles"] and "angles" in q["angles"])
        check("detect: rank puts an 'Edit-2' release above 2511",
              S._qwen_rank("Qwen-Image-Edit-2_fp8.safetensors") > S._qwen_rank("qwen_image_edit_2511_fp8.safetensors"))
        check("detect: 2511 is not mistaken for 'Edit-2'", S._qwen_rank("qwen_image_edit_2511.safetensors")[0] == 3)
        check("detect: --lightning none wins", S.detect_qwen({"lightning": "none"})[0]["lightning"] is None)

        print("graphs")
        dirs, poses = S.PACK_DIRS, ["idle", "step"]
        for label, g in (("qwen", S.qwen_graph("c.png", dirs, poses, 7, q)),
                         ("qwen no-lightning", S.qwen_graph("c.png", dirs, poses, 7, {**q, "lightning": None})),
                         ("qwen gguf+angles", S.qwen_graph("c.png", dirs, poses, 7, {**q, "unet": "x.gguf"}, angles=True)),
                         ("grid", S.grid_graph("c.png", dirs, 7, q)),
                         ("sdxl", S.sdxl_graph("c.png", dirs, poses, 7, "a courier"))):
            errs = validate(g.nodes)
            check(f"{label}: validates", not errs, "; ".join(errs[:3]))
            saves = [n["_meta"]["title"] for n in g.nodes.values() if n["class_type"] == "SaveImage"]
            if label != "grid":
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
        for name in ("sprite-sheet-qwen", "sprite-sheet-sdxl", "sprite-sheet-grid"):
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
