#!/usr/bin/env python3
"""One character image in, one pixel sprite sheet out, through a local ComfyUI.

    pnpm run sprite:sheet -- hero.png                     # 5 directions x idle+step, 48 px
    python3 scripts/assets/spritesheet.py hero.png --frames walk --size 64
    python3 scripts/assets/spritesheet.py hero.png --method sdxl --describe "a frog settler in a green cloak"
    python3 scripts/assets/spritesheet.py hero.png --flow my-tweaked_api.json   # run a flow you edited
    python3 scripts/assets/spritesheet.py doctor          # what the server has, what the CLI will pick
    python3 scripts/assets/spritesheet.py repack sprite-sheets/hero/s1004 --size 32   # re-pixelize, no GPU
    python3 scripts/assets/spritesheet.py flows           # rewrite the importable flows in scripts/assets/flows/
    python3 scripts/assets/spritesheet.py prep hero.png   # square-on-white input for the UI flows

Methods (docs/sprite-sheet-cli.md has the why):

  qwen  (default) Qwen-Image-Edit (2511 by default, auto-detected) + Lightning 4-step.
        Each direction is ONE edit of the input ("same character, side profile facing
        right"); each further pose is an edit OF THAT DIRECTION'S IDLE, with the input
        as image 2 for identity. Derive, don't re-imagine (sprite-generation.md §4.11):
        in cyber-puck's 2026-09-13 prototype, per-frame edits of an on-model frame kept
        sides and identity 8/8, where a whole sheet in one pass drew random poses.
  grid  Qwen, one pass, the whole turnaround in one image. Seconds, not minutes; a
        preview, not a pack (identity holds, poses and spacing wander).
  sdxl  juggernautXL + skormino pixel LoRA + IP-Adapter on the input, the pack's proven
        base. Pixel-native look, weaker identity; wants --describe.

The whole sheet is ONE ComfyUI graph, and it is the same graph as the committed flow
(`flows/sprite-sheet-<method>.json`). Tweak it in the editor, "Export (API)", then
`--flow that_api.json` runs your version through the same post. Frames are found by
the SaveImage titles `frame <dir> <pose>`; keep those and anything else can change.

Post (no GPU): border-connected background key, ONE scale for every frame (so the
character never pumps size between frames), k-centroid downscale, palette snap
(`--palette input` = the input's own colours), feet on the bottom row, each pose
registered to its direction's idle. Output: sheet.png (rows = directions, columns =
poses), per-frame PNGs named `<kind>-<dir>-<pose>.png` (the pack's chars/ naming),
an x4 preview, a GIF per direction, sheet.json with every rect, and the raws.

Drawn side art faces RIGHT (sprite-generation.md §3) and the engine mirrors west.
Models do not reliably obey "facing right": check `e`/`ne`/`se` by eye, and
`--mirror e,ne` flips the raws if a seed came back facing left.
"""
import argparse
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import numpy as np
from PIL import Image, ImageDraw, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import comfy_ui  # noqa: E402
import post as P  # noqa: E402  (kcentroid, corner_bg)
from palette import RGB as SWAMP_RGB  # noqa: E402

HOST = os.environ.get("COMFY", "http://127.0.0.1:8188").rstrip("/")
FLOWS = os.path.join(HERE, "flows")
IN_SIZE = 1024

# ---- what to draw -----------------------------------------------------------
# Viewer-relative wording on purpose: models are far better at "toward the right
# side of the image" than at the character's own left/right (cyber-puck,
# comfyui-pixel-art.md, "Mirroring is a known failure").
DIRS = {
    "s": "front view, facing the viewer",
    "se": "three-quarter front view, body turned 45 degrees toward the right side of the image",
    "e": "full side profile facing the right side of the image, nose pointing right",
    "ne": "three-quarter back view, turned away from the viewer toward the upper right of the image, "
          "back and shoulder visible, face hidden",
    "n": "back view seen from directly behind, back of the head visible, face hidden",
    "sw": "three-quarter front view, body turned 45 degrees toward the left side of the image",
    "w": "full side profile facing the left side of the image, nose pointing left",
    "nw": "three-quarter back view, turned away from the viewer toward the upper left of the image, "
          "back and shoulder visible, face hidden",
}
PACK_DIRS = ["s", "se", "e", "ne", "n"]  # the engine mirrors the west half

POSES = {
    "idle": "standing still in a relaxed idle pose",
    "step": "mid-stride walking pose, one leg forward, arms swinging slightly",
    "walk1": "walk cycle contact pose: the front leg reaching forward with the heel down, the back leg "
             "pushing off behind, arms swinging opposite the legs",
    "walk2": "walk cycle passing pose: weight on the planted leg, the other leg lifted and passing under "
             "the body, body at its highest",
    "walk3": "walk cycle contact pose, the opposite leg now in front: the other leg reaching forward with "
             "the heel down, arms swinging the other way",
    "walk4": "walk cycle passing pose, the opposite leg now lifted and passing under the body",
    "attack": "attacking, lunging forward into a strike",
    "hurt": "recoiling from a hit, flinching backwards",
}
PRESETS = {
    "basic": ["idle", "step"],  # the pack's char contract: <dir>-idle / <dir>-step
    "walk": ["idle", "walk1", "walk2", "walk3", "walk4"],
    "all": list(POSES),
}

STYLE = "Crisp pixel art, thick dark outline, flat cel shading, bold readable shapes."
FRAME = ("One character only, centered, the whole body in frame with empty margin around it, feet visible, "
         "plain flat pure white background, no shadow, no ground, no text, no grid lines.")

# ---- model defaults (cyber-puck's proven Qwen recipe, sporefall's SDXL one) -----
QWEN = {
    "unet": "qwen_image_edit_2511_fp8_e4m3fn.safetensors",
    "lightning": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
    "clip": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    "vae": "qwen_image_vae.safetensors",
    "angles": "qwen-image-edit-2511-multiple-angles-lora.safetensors",
    "shift": 3.1,
}
SDXL = {
    "ckpt": "SDXL1.0\\juggernautXL_juggXIByRundiffusion.safetensors",
    "lora": "pixel_art_style_by_skormino_v7.05_test_72img.safetensors",
    "ipadapter": "ip-adapter-plus_sdxl_vit-h.safetensors",
    "clip_vision": "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
    "trigger": "masterpiece, pixpix, 8-bit, pixel_art",
    # sprite-generation.md §4.5: the anchor is a FRONT view; over-weighting it on
    # away-facing poses wins over the pose prompt.
    "ip_weight": {"s": 0.8, "se": 0.75, "sw": 0.75, "e": 0.55, "w": 0.55, "ne": 0.5, "nw": 0.5, "n": 0.5},
    "step_denoise": 0.38,  # §4.6: pose frames are img2img FROM the idle
}
SDXL_NEG = ("photo, photorealistic, 3d render, smooth gradient, soft shading, blurry, text, watermark, signature, "
            "sprite sheet, grid, multiple views, turnaround, duplicate, two characters, cropped, out of frame, "
            "floor shadow, cast shadow, ground, colored background, gradient background, scenery")
BACK_NEG = "face, eyes, front view, looking at the viewer"


# ---- ComfyUI HTTP -----------------------------------------------------------
def http(path, data=None, ctype="application/json", timeout=60):
    req = urllib.request.Request(HOST + path, data=data, headers={"Content-Type": ctype} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def http_json(path, **kw):
    return json.loads(http(path, **kw))


def upload(img: Image.Image, name: str) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + buf.getvalue() + \
        f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n".encode()
    return json.loads(http("/upload/image", body, f"multipart/form-data; boundary={b}"))["name"]


def queue(graph: dict) -> str:
    try:
        return http_json("/prompt", data=json.dumps({"prompt": graph}).encode())["prompt_id"]
    except urllib.error.HTTPError as e:  # 400 = validation: say WHICH node and input
        raise SystemExit(f"ComfyUI rejected the graph:\n{e.read().decode()[:3000]}")


def wait(pid: str, limit_s: int = 3600, poll: float = 2.0) -> dict:
    """Block until the prompt finishes; return {node_id: [image dicts]}."""
    t0, last = time.time(), ""
    while time.time() - t0 < limit_s:
        try:
            h = http_json(f"/history/{pid}", timeout=30)
        except Exception:
            h = {}  # busy mid-batch; keep polling
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                raise SystemExit("ComfyUI execution error:\n" + json.dumps(msgs or st, indent=1)[:3000])
            if st.get("completed", True):
                return {nid: o.get("images", []) for nid, o in h[pid].get("outputs", {}).items()}
        msg = f"  waiting on {pid[:8]} … {int(time.time() - t0)}s"
        if msg[:-3] != last[:-3]:
            print(msg, end="\r", flush=True)
            last = msg
        time.sleep(poll)
    raise TimeoutError(pid)


def fetch(im: dict) -> Image.Image:
    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""),
                                "type": im.get("type", "output")})
    return Image.open(io.BytesIO(http(f"/view?{q}", timeout=120))).convert("RGB")


def listing(folder: str) -> list[str] | None:
    try:
        return http_json(f"/models/{folder}", timeout=10)
    except Exception:
        return None


# ---- model auto-detect ------------------------------------------------------
def _qwen_rank(name: str) -> tuple:
    n = name.lower()
    if re.search(r"edit[_-]?2(?:[_.-]0)?(?![0-9])", n):
        gen = 4  # a "Qwen-Image-Edit-2" release, newer than the dated ones
    elif "2511" in n:
        gen = 3
    elif "2509" in n:
        gen = 2
    else:
        gen = 1
    return (gen, "fp8" in n, n.endswith(".safetensors"))


def detect_qwen(overrides: dict) -> tuple[dict, list[str]]:
    """Pick installed Qwen-Edit files; explicit flags always win. Returns (cfg, notes)."""
    cfg, notes = dict(QWEN), []
    unets = (listing("diffusion_models") or []) + (listing("unet") or [])
    cands = sorted({u for u in unets if "qwen" in u.lower() and "edit" in u.lower()}, key=_qwen_rank, reverse=True)
    if cands:
        cfg["unet"] = cands[0]
        notes.append(f"qwen edit models on server: {', '.join(cands)}")
    elif unets:
        notes.append("no Qwen-Image-Edit model in diffusion_models/ — using the default name; expect a 400")
    tag = next((t for t in ("2511", "2509") if t in cfg["unet"]), None)
    loras = listing("loras")
    if loras is not None:
        light = [lo for lo in loras if "lightning" in lo.lower() and "qwen" in lo.lower() and "edit" in lo.lower()
                 and (tag is None or tag in lo)]
        light.sort(key=lambda lo: ("4step" not in lo.lower().replace("-", ""), lo))
        cfg["lightning"] = light[0] if light else None
        if not light:
            notes.append(f"no Lightning LoRA matching {cfg['unet']} — running 20 steps at CFG 2.5 instead of 4 at 1")
        angles = [lo for lo in loras if "angle" in lo.lower() and "qwen" in lo.lower()]
        cfg["angles"] = angles[0] if angles else None
    encs = (listing("text_encoders") or []) + (listing("clip") or [])
    vl = [e for e in encs if "qwen_2.5_vl" in e.lower() or "qwen2.5-vl" in e.lower()]
    if vl:
        cfg["clip"] = sorted(vl, key=lambda e: ("fp8" not in e, e))[0]
    vaes = listing("vae") or []
    qv = [v for v in vaes if "qwen" in v.lower()]
    if qv:
        cfg["vae"] = qv[0]
    for k, v in overrides.items():
        if v is not None:
            cfg[k] = None if v == "none" else v
    return cfg, notes


# ---- graph building -------------------------------------------------------------
class Graph:
    """API graph plus a layout for the editor export. Nodes are placed LOGICALLY: a
    band (a row of the canvas, drawn as a group) and a column inside it. `workflow()`
    stacks each column top to bottom by real node heights, so nothing can overlap."""

    CW, GAP, PAD = 480, 30, 60

    def __init__(self):
        self.nodes, self.place, self.bands, self.notes = {}, {}, [], []

    def band(self, title, color="#353"):
        self.bands.append((title, color))

    def add(self, cls, inputs, title=None, col=0):
        nid = str(len(self.nodes) + 1)
        self.nodes[nid] = {"class_type": cls, "inputs": inputs}
        if title:
            self.nodes[nid]["_meta"] = {"title": title}
        self.place[nid] = (self.bands[-1][0], col)
        return nid

    def layout(self):
        pos, groups, y0 = {}, [], 0
        for title, color in self.bands:
            cols = {}
            for nid, (b, c) in self.place.items():
                if b == title:
                    cols.setdefault(c, []).append(nid)
            if not cols:
                continue
            bottom = y0 + self.PAD
            for c, members in cols.items():
                y = y0 + self.PAD
                for nid in members:
                    pos[nid] = (c * self.CW, y)
                    y += comfy_ui.node_size(self.nodes[nid]["class_type"])[1] + self.GAP
                bottom = max(bottom, y)
            x0, x1 = min(cols) * self.CW, max(cols) * self.CW + self.CW
            groups.append((title, (x0 - 20, y0, x1 - x0, bottom - y0), color))
            y0 = bottom + 80
        notes = [((-self.CW - 40, self.PAD), (self.CW, h), text) for text, h in self.notes]
        return pos, groups, notes

    def workflow(self, specs=None):
        pos, groups, notes = self.layout()
        return comfy_ui.to_workflow(self.nodes, pos, groups, notes, specs)


def _stitch(g, rows: list[list[str]]) -> str | None:
    """ImageStitch every frame into one sheet (rows right, then down)."""
    row_out = []
    for cells in rows:
        cur = cells[0]
        for i, c in enumerate(cells[1:]):
            cur = g.add("ImageStitch", {"image1": [cur, 0], "image2": [c, 0], "direction": "right",
                                        "match_image_size": True, "spacing_width": 0, "spacing_color": "white"},
                        col=i)
        row_out.append(cur)
    cur = row_out[0]
    last = max(len(rows[0]) - 1, 0)
    for r in row_out[1:]:
        cur = g.add("ImageStitch", {"image1": [cur, 0], "image2": [r, 0], "direction": "down",
                                    "match_image_size": True, "spacing_width": 0, "spacing_color": "white"},
                    col=last)
    return cur, last + 1


def qwen_graph(input_name, dirs, poses, seed, q, describe="", style=STYLE, prefix="sprite-sheet/run",
               angles=False, stitch=True) -> Graph:
    g = Graph()
    g.band("models + input", "#335")
    if q["unet"].endswith(".gguf"):
        m = g.add("UnetLoaderGGUF", {"unet_name": q["unet"]}, "Qwen-Image-Edit (GGUF)")
    else:
        m = g.add("UNETLoader", {"unet_name": q["unet"], "weight_dtype": "default"}, "Qwen-Image-Edit")
    if q.get("lightning"):
        m = g.add("LoraLoaderModelOnly", {"model": [m, 0], "lora_name": q["lightning"], "strength_model": 1.0},
                  "Lightning 4-step LoRA (bypass = 20 steps, CFG 2.5)")
    if angles and q.get("angles"):
        m = g.add("LoraLoaderModelOnly", {"model": [m, 0], "lora_name": q["angles"], "strength_model": 1.0},
                  "Multiple-Angles LoRA")
    m = g.add("ModelSamplingAuraFlow", {"model": [m, 0], "shift": q.get("shift", 3.1)})
    m = g.add("CFGNorm", {"model": [m, 0], "strength": 1.0})
    clip = g.add("CLIPLoader", {"clip_name": q["clip"], "type": "qwen_image", "device": "default"}, col=1)
    vae = g.add("VAELoader", {"vae_name": q["vae"]}, col=1)
    lat = g.add("EmptySD3LatentImage", {"width": IN_SIZE, "height": IN_SIZE, "batch_size": 1}, col=1)
    src = g.add("LoadImage", {"image": input_name}, "character (square, on white)", col=2)
    neg = g.add("TextEncodeQwenImageEditPlus", {"clip": [clip, 0], "vae": [vae, 0], "image1": [src, 0], "prompt": ""},
                "negative (ignored at CFG 1)", col=3)
    neg = g.add("FluxKontextMultiReferenceLatentMethod",
                {"conditioning": [neg, 0], "reference_latents_method": "index_timestep_zero"}, col=3)
    steps, cfg = (4, 1.0) if q.get("lightning") else (20, 2.5)
    who = f" The character: {describe}." if describe else ""
    sheet = []
    for d in dirs:
        g.band(f"direction {d}")
        row, base_decode = [], None
        for c, pose in enumerate(poses):
            if pose == "idle":
                text = (f"Redraw the character from image 1 as a single full-body video game sprite: {DIRS[d]}, "
                        f"{POSES['idle']}. Keep the exact same character design, outfit, colors, markings and "
                        f"proportions.{who} {FRAME} {style}")
                if angles and q.get("angles"):
                    text = f"<sks> {DIRS[d]} eye-level shot full shot. " + text
                imgs, latent, denoise = {"image1": [src, 0]}, [lat, 0], 1.0
            else:
                text = (f"Image 1 is a video game sprite of a character; image 2 shows the same character's design. "
                        f"Redraw image 1 with the same character, the same facing direction ({DIRS[d]}), the same "
                        f"size, position and colors, changing only the pose: {POSES[pose]}.{who} {FRAME} {style}")
                imgs = {"image1": [base_decode, 0], "image2": [src, 0]}
                latent = None
                denoise = 1.0  # Lightning is a switch, not a dial (cyber-puck denoise sweep)
            pos = g.add("TextEncodeQwenImageEditPlus", {"clip": [clip, 0], "vae": [vae, 0], "prompt": text, **imgs},
                        f"{d} {pose} prompt", col=2 * c)
            pos = g.add("FluxKontextMultiReferenceLatentMethod",
                        {"conditioning": [pos, 0], "reference_latents_method": "index_timestep_zero"}, col=2 * c)
            if latent is None:  # register the pose to its idle: same framing in, same framing out
                latent = [g.add("VAEEncode", {"pixels": [base_decode, 0], "vae": [vae, 0]}, col=2 * c), 0]
            ks = g.add("KSampler", {"model": [m, 0], "positive": [pos, 0], "negative": [neg, 0], "latent_image": latent,
                                    "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler",
                                    "scheduler": "simple", "denoise": denoise}, f"{d} {pose} sampler", col=2 * c + 1)
            dec = g.add("VAEDecode", {"samples": [ks, 0], "vae": [vae, 0]}, col=2 * c + 1)
            g.add("SaveImage", {"images": [dec, 0], "filename_prefix": f"{prefix}/{d}-{pose}"},
                  f"frame {d} {pose}", col=2 * c + 1)
            if pose == "idle":
                base_decode = dec
            row.append(dec)
        sheet.append(row)
    if stitch and len(dirs) * len(poses) > 1:
        g.band("sheet preview (raw)", "#533")
        out, col = _stitch(g, sheet)
        g.add("SaveImage", {"images": [out, 0], "filename_prefix": f"{prefix}/sheet"}, "sheet preview (raw)", col=col)
    g.notes.append((NOTE_QWEN, 560))
    return g


def grid_graph(input_name, dirs, seed, q, describe="", style=STYLE, prefix="sprite-sheet/grid") -> Graph:
    """One Qwen pass, the turnaround in one image; the CLI cuts it into len(dirs) cells."""
    g = qwen_graph(input_name, dirs[:1], ["idle"], seed, q, describe, style, prefix, stitch=False)
    g.bands[1] = ("turnaround", "#353")
    g.place = {k: (("turnaround" if b == f"direction {dirs[0]}" else b), c) for k, (b, c) in g.place.items()}
    # Rewire the single frame into a wide one-row turnaround.
    cell_w = max(256, min(512, 2048 // len(dirs)) // 16 * 16)
    lat = next(k for k, n in g.nodes.items() if n["class_type"] == "EmptySD3LatentImage")
    g.nodes[lat]["inputs"].update(width=cell_w * len(dirs), height=cell_w * 2)
    order = ", ".join(f"{i + 1} {DIRS[d]}" for i, d in enumerate(dirs))
    who = f" The character: {describe}." if describe else ""
    enc = next(k for k, n in g.nodes.items() if n.get("_meta", {}).get("title", "").endswith("idle prompt"))
    g.nodes[enc]["_meta"]["title"] = "turnaround prompt"
    g.nodes[enc]["inputs"]["prompt"] = (
        f"Create a character turnaround sprite sheet of this exact character: {len(dirs)} full-body views in one "
        f"row, evenly spaced, the same size, standing on the same baseline. Left to right: {order}.{who} Keep the "
        f"exact same design, outfit, colors and proportions in every view. Plain flat pure white background, no "
        f"shadow, no text, no labels, no grid lines. {style}")
    save = next(k for k, n in g.nodes.items() if n["class_type"] == "SaveImage")
    g.nodes[save]["_meta"]["title"] = f"grid {' '.join(dirs)}"
    g.nodes[save]["inputs"]["filename_prefix"] = f"{prefix}/grid"
    g.notes[:] = [(NOTE_GRID, 300)]
    return g


def sdxl_graph(input_name, dirs, poses, seed, describe="", style="", prefix="sprite-sheet/sdxl", stitch=True) -> Graph:
    g = Graph()
    s = SDXL
    g.band("models + input", "#335")
    ck = g.add("CheckpointLoaderSimple", {"ckpt_name": s["ckpt"]}, "juggernautXL (the pack's proven base)")
    lo = g.add("LoraLoader", {"model": [ck, 0], "clip": [ck, 1], "lora_name": s["lora"], "strength_model": 1.0,
                              "strength_clip": 1.0}, "skormino pixel-art LoRA")
    lat = g.add("EmptyLatentImage", {"width": IN_SIZE, "height": IN_SIZE, "batch_size": 1})
    ipm = g.add("IPAdapterModelLoader", {"ipadapter_file": s["ipadapter"]}, col=1)
    cv = g.add("CLIPVisionLoader", {"clip_name": s["clip_vision"]}, col=1)
    src = g.add("LoadImage", {"image": input_name}, "character (square, on white)", col=2)
    prep = g.add("PrepImageForClipVision", {"image": [src, 0], "interpolation": "LANCZOS", "crop_position": "center",
                                            "sharpening": 0.0}, col=3)
    who = describe or "the character"
    sheet = []
    for d in dirs:
        g.band(f"direction {d}")
        ipa = g.add("IPAdapterAdvanced", {"model": [lo, 0], "ipadapter": [ipm, 0], "image": [prep, 0],
                                          "clip_vision": [cv, 0], "weight": s["ip_weight"].get(d, 0.6),
                                          "weight_type": "style transfer", "combine_embeds": "concat",
                                          "start_at": 0.0, "end_at": 0.9, "embeds_scaling": "V only"},
                    f"{d} identity (IP-Adapter)", col=0)
        neg_text = SDXL_NEG + (", " + BACK_NEG if d in ("n", "ne", "nw") else "")
        neg = g.add("CLIPTextEncode", {"clip": [lo, 1], "text": neg_text}, f"{d} negative", col=0)
        row, base = [], None
        for c, pose in enumerate(poses):
            pos = g.add("CLIPTextEncode", {"clip": [lo, 1], "text": (
                f"{s['trigger']}, {who}, {DIRS[d]}, {POSES[pose]}, single full-body character game sprite centered "
                f"on a plain flat pure white background, whole body in frame, feet visible, bold dark outlines, "
                f"thick black outline, 16-bit era palette, chunky readable shapes{', ' + style if style else ''}")},
                f"{d} {pose} prompt", col=1 + 2 * c)
            if pose == "idle":
                latent, denoise = [lat, 0], 1.0
            else:
                latent = [g.add("VAEEncode", {"pixels": [base, 0], "vae": [ck, 2]}, col=1 + 2 * c), 0]
                denoise = s["step_denoise"]
            ks = g.add("KSampler", {"model": [ipa, 0], "positive": [pos, 0], "negative": [neg, 0],
                                    "latent_image": latent, "seed": seed, "steps": 28, "cfg": 7.0,
                                    "sampler_name": "euler", "scheduler": "normal", "denoise": denoise},
                       f"{d} {pose} sampler", col=2 + 2 * c)
            dec = g.add("VAEDecode", {"samples": [ks, 0], "vae": [ck, 2]}, col=2 + 2 * c)
            g.add("SaveImage", {"images": [dec, 0], "filename_prefix": f"{prefix}/{d}-{pose}"},
                  f"frame {d} {pose}", col=2 + 2 * c)
            if pose == "idle":
                base = dec
            row.append(dec)
        sheet.append(row)
    if stitch and len(dirs) * len(poses) > 1:
        g.band("sheet preview (raw)", "#533")
        out, col = _stitch(g, sheet)
        g.add("SaveImage", {"images": [out, 0], "filename_prefix": f"{prefix}/sheet"}, "sheet preview (raw)", col=col)
    g.notes.append((NOTE_SDXL, 480))
    return g


NOTE_QWEN = """Sprite sheet from ONE character image (Qwen-Image-Edit + Lightning 4-step).

1. Load your character in 'character'. Square, on WHITE: a transparent PNG loads with a black
   background. `python3 scripts/assets/spritesheet.py prep hero.png` makes one.
2. Queue. Each direction's idle is one edit of the input; every other pose is an edit OF THAT
   IDLE with the input as image 2 (identity). Same seed everywhere keeps a sheet coherent.
3. 'sheet preview (raw)' is the stitched raw. The pixel sheet comes from the CLI:
   Export (API) -> spritesheet.py hero.png --flow your_api.json

Keep the SaveImage titles 'frame <dir> <pose>' - the CLI finds frames by them.
No Lightning LoRA? Delete it and set every sampler to 20 steps, CFG 2.5.
Side art must face RIGHT (the engine mirrors west): check e / se / ne by eye."""

NOTE_GRID = """One-pass turnaround (Qwen-Image-Edit). Fast preview, not a pack: identity holds, spacing
and poses wander. Input: square, on white. The CLI cuts the row into cells:
spritesheet.py hero.png --method grid"""

NOTE_SDXL = """Sprite sheet from ONE character image, SDXL route (juggernautXL + skormino pixel LoRA +
IP-Adapter on the input). Pixel-native, weaker identity than the Qwen flow.

Put a short description of the character into every prompt ('a frog settler in a green cloak');
IP-Adapter alone does not carry identity. Pose frames are img2img from the direction's idle at
denoise 0.38 (sprite-generation.md 4.6). Back views carry face negatives (4.5).
Keep the SaveImage titles 'frame <dir> <pose>'."""


# ---- input prep -----------------------------------------------------------------
def prep_input(path: str, size: int = IN_SIZE, fill: float = 0.84) -> Image.Image:
    """Any character image -> square RGB on white, character ~84% of the frame."""
    im = ImageOps.exif_transpose(Image.open(path))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    im = im.convert("RGB")
    k = size * fill / max(im.size)
    small = max(im.size) < 256  # pixel art in: keep hard edges
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))),
                   Image.NEAREST if small else Image.LANCZOS)
    out = Image.new("RGB", (size, size), (255, 255, 255))
    out.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
    return out


# ---- post: raws -> pixel frames -------------------------------------------------
def key_background(im: Image.Image, thresh: float = 38) -> Image.Image:
    """Alpha from a BORDER-CONNECTED flood of the backdrop colour. A plain colour key
    also punches holes in pale interiors (cream fur, a white chest); only backdrop
    reachable from the frame edge is removed (cyber-puck's premat lesson)."""
    if P.has_alpha(im):
        return im.convert("RGBA")
    rgb = np.asarray(im.convert("RGB"))
    near = np.sqrt(((rgb.astype(np.float32) - P.corner_bg(im)) ** 2).sum(-1)) <= thresh
    mask = Image.new("L", (im.width + 2, im.height + 2), 255)
    mask.paste(Image.fromarray(np.where(near, 255, 0).astype(np.uint8), "L"), (1, 1))
    ImageDraw.floodfill(mask, (0, 0), 128, thresh=0)
    bg = np.asarray(mask)[1:-1, 1:-1] == 128
    return Image.fromarray(np.dstack([rgb, np.where(bg, 0, 255).astype(np.uint8)]), "RGBA")


def bbox(im: Image.Image):
    a = np.asarray(im)[..., 3]
    ys, xs = np.where(a > 128)
    if not len(ys):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def input_palette(im: Image.Image, colors: int) -> list[tuple]:
    """The character's own colours: median-cut over the keyed input's opaque pixels."""
    a = np.asarray(key_background(im))
    px = a[a[..., 3] > 128][:, :3]
    if not len(px):
        return list(SWAMP_RGB)
    strip = Image.fromarray(px.reshape(1, -1, 3).astype(np.uint8), "RGB")
    pal = strip.quantize(colors=colors, method=Image.Quantize.MEDIANCUT).getpalette()[: colors * 3]
    return sorted({tuple(pal[i:i + 3]) for i in range(0, len(pal), 3)})


def snap(im: Image.Image, pal) -> Image.Image:
    a = np.asarray(im.convert("RGBA")).astype(np.float32).copy()
    if pal is not None:
        P_ = np.array(pal, np.float32)
        px = a[..., :3].reshape(-1, 3)
        a[..., :3] = P_[((px[:, None, :] - P_[None]) ** 2).sum(-1).argmin(1)].reshape(a.shape[:2] + (3,))
    a[..., 3] = np.where(a[..., 3] > 128, 255, 0)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def pixelize(raws: dict, dirs, poses, canvas: int, content: int | None, pal) -> dict:
    """{(dir, pose): raw RGB} -> {(dir, pose): canvas px RGBA}, one scale for all frames."""
    keyed = {k: key_background(v) for k, v in raws.items()}
    boxes = {k: bbox(v) for k, v in keyed.items()}
    real = [b for b in boxes.values() if b]
    if not real:
        raise SystemExit("every frame keyed to empty: is the background not plain?")
    content = content or canvas - 2
    span = max(max(b[3] - b[1] for b in real), max(b[2] - b[0] for b in real))
    s = content / span
    out = {}
    for d in dirs:
        idle_b = boxes.get((d, poses[0]))
        cx_ref = (idle_b[0] + idle_b[2]) / 2 if idle_b else None
        for p in poses:
            b, im = boxes.get((d, p)), keyed.get((d, p))
            frame = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
            if b:
                tw, th = max(1, round((b[2] - b[0]) * s)), max(1, round((b[3] - b[1]) * s))
                px = snap(P.kcentroid(im.crop(b), tw, th), pal)
                # registered to the direction's idle centre, so a stride moves the legs, not the body
                cx = cx_ref if cx_ref is not None else (b[0] + b[2]) / 2
                x = round(canvas / 2 + (b[0] - cx) * s)
                frame.paste(px, (x, canvas - 1 - th), px)
            out[(d, p)] = frame
    return out


def assemble(frames: dict, dirs, poses, canvas: int, outdir: str, kind: str, meta: dict, raws: dict):
    os.makedirs(f"{outdir}/frames", exist_ok=True)
    sheet = Image.new("RGBA", (canvas * len(poses), canvas * len(dirs)), (0, 0, 0, 0))
    rects = {}
    for r, d in enumerate(dirs):
        for c, p in enumerate(poses):
            f = frames[(d, p)]
            sheet.paste(f, (c * canvas, r * canvas))
            name = f"{kind}-{d}-{p}"
            f.save(f"{outdir}/frames/{name}.png")
            rects[name] = {"x": c * canvas, "y": r * canvas, "w": canvas, "h": canvas, "dir": d, "pose": p}
    sheet.save(f"{outdir}/sheet.png")
    big = sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST)
    bg = Image.new("RGBA", big.size, (38, 44, 40, 255))
    bg.alpha_composite(big)
    bg.convert("RGB").save(f"{outdir}/sheet@4x.png")
    anim = [p for p in poses if p.startswith("walk")] or poses
    for d in dirs:
        seq = []
        for p in anim:
            fr = Image.new("RGBA", (canvas, canvas), (38, 44, 40, 255))
            fr.alpha_composite(frames[(d, p)])
            seq.append(fr.convert("RGB").resize((canvas * 4, canvas * 4), Image.NEAREST))
        seq[0].save(f"{outdir}/anim-{d}.gif", save_all=True, append_images=seq[1:], duration=140, loop=0)
    preview(raws, frames, dirs, poses, canvas).save(f"{outdir}/preview.png")
    json.dump({**meta, "canvas": canvas, "dirs": dirs, "poses": poses, "frames": rects},
              open(f"{outdir}/sheet.json", "w"), indent=1)


def preview(raws, frames, dirs, poses, canvas, cell=192):
    """Raws on top, the pixel frame (x3, nearest) under each: judge at game size."""
    lab = 16
    W, H = cell * len(poses), (cell + canvas * 3 + lab) * len(dirs)
    im = Image.new("RGB", (W, H), (28, 30, 34))
    d_ = ImageDraw.Draw(im)
    for r, d in enumerate(dirs):
        y = r * (cell + canvas * 3 + lab)
        for c, p in enumerate(poses):
            if (d, p) in raws:
                im.paste(raws[(d, p)].convert("RGB").resize((cell, cell), Image.LANCZOS), (c * cell, y + lab))
            px = frames[(d, p)].resize((canvas * 3, canvas * 3), Image.NEAREST)
            im.paste(px, (c * cell + (cell - canvas * 3) // 2, y + lab + cell), px)
            d_.text((c * cell + 4, y + 2), f"{d} {p}", fill=(230, 230, 230))
    return im


# ---- running ----------------------------------------------------------------------
TITLE_RE = re.compile(r"^frame\s+(\w+)\s+(\S+)$")


def harvest(api: dict, outputs: dict) -> tuple[dict, dict]:
    """SaveImage outputs -> ({(dir, pose): image}, {grid title: image})."""
    frames, grids = {}, {}
    for nid, ims in outputs.items():
        if not ims or nid not in api:
            continue
        title = api[nid].get("_meta", {}).get("title", "")
        m = TITLE_RE.match(title)
        if m:
            frames[(m.group(1), m.group(2))] = fetch(ims[0])
        elif title.startswith("grid "):
            grids[title] = fetch(ims[0])
    return frames, grids


def cut_grid(im: Image.Image, dirs) -> dict:
    """Cut a one-row turnaround into len(dirs) square-ish cells (equal widths)."""
    cw = im.width / len(dirs)
    return {(d, "idle"): im.crop((round(i * cw), 0, round((i + 1) * cw), im.height)) for i, d in enumerate(dirs)}


def load_flow(path: str, input_name: str, seed: int | None) -> dict:
    api = json.load(open(path))
    if "nodes" in api and "links" in api:
        raise SystemExit(f"{path} is an editor workflow; in ComfyUI use Workflow > Export (API) and pass that file")
    loads = [k for k, n in api.items() if n.get("class_type") == "LoadImage"]
    tagged = [k for k in loads if "character" in api[k].get("_meta", {}).get("title", "").lower()]
    target = tagged or loads[:1]
    if not target:
        raise SystemExit(f"{path}: no LoadImage node to feed the character into")
    for k in target:
        api[k]["inputs"]["image"] = input_name
    if seed is not None:
        for n in api.values():
            if n.get("class_type") in ("KSampler",) and not isinstance(n["inputs"].get("seed"), list):
                n["inputs"]["seed"] = seed
    return api


def parse_list(v, table, what):
    items = [x.strip() for x in v.split(",") if x.strip()]
    bad = [x for x in items if x not in table]
    if bad:
        raise SystemExit(f"unknown {what}: {', '.join(bad)} (known: {', '.join(table)})")
    return items


def cmd_make(a):
    dirs = parse_list(a.dirs, DIRS, "direction")
    poses = PRESETS.get(a.frames) or parse_list(a.frames, POSES, "pose")
    poses = ["idle"] + [p for p in poses if p != "idle"]  # every pose derives from the idle
    name = a.name or os.path.splitext(os.path.basename(a.image))[0]
    kind = a.kind or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    root = os.path.abspath(a.out or os.path.join("sprite-sheets", name))
    os.makedirs(root, exist_ok=True)
    src = prep_input(a.image)
    src.save(f"{root}/input-{IN_SIZE}.png")
    pal = None if a.palette == "none" else (list(SWAMP_RGB) if a.palette == "swampspace"
                                            else input_palette(src, a.colors))
    if a.method == "grid":
        poses = ["idle"]
    q, notes = (dict(QWEN), [])
    online = not a.dry_run
    if a.method in ("qwen", "grid") and online:
        q, notes = detect_qwen({"unet": a.unet, "lightning": a.lightning, "clip": a.clip, "vae": a.vae})
    elif a.method in ("qwen", "grid"):
        q.update({k: (None if v == "none" else v) for k, v in
                  {"unet": a.unet, "lightning": a.lightning, "clip": a.clip, "vae": a.vae}.items() if v})
    for n in notes:
        print(" ·", n)
    input_name = f"spritesheet-{kind}.png"
    if online:
        input_name = upload(src, input_name)
    runs = []
    for seed in a.seeds or [None if a.flow else 1004]:
        out = os.path.join(root, f"s{seed}" if seed is not None else "flow")
        os.makedirs(f"{out}/raw", exist_ok=True)
        prefix = f"sprite-sheet/{kind}/s{seed}"
        if a.flow:
            api, wf = load_flow(a.flow, input_name, seed), None
        else:
            if a.method == "sdxl":
                g = sdxl_graph(input_name, dirs, poses, seed, a.describe, a.style or "", prefix)
            elif a.method == "grid":
                g = grid_graph(input_name, dirs, seed, q, a.describe, a.style or STYLE, prefix)
            else:
                g = qwen_graph(input_name, dirs, poses, seed, q, a.describe, a.style or STYLE, prefix, a.angles)
            api, wf = g.nodes, g.workflow()
        json.dump(api, open(f"{out}/flow_api.json", "w"), indent=1)
        if wf:
            json.dump(wf, open(f"{out}/flow.json", "w"), indent=1)
        if a.dry_run:
            print(f"dry run: {out}/flow_api.json ({len(api)} nodes), {out}/flow.json")
            continue
        n_samp = sum(1 for n in api.values() if n["class_type"] == "KSampler")
        label = f"seed {seed}" if seed is not None else "flow"
        print(f"{label}: queued {n_samp} sampler(s) on {HOST} ({q.get('unet') if a.method != 'sdxl' else 'sdxl'})")
        t0 = time.time()
        frames, grids = harvest(api, wait(queue(api)))
        print(f"{label}: done in {time.time() - t0:.0f}s" + " " * 20)
        if grids:
            gi = next(iter(grids.values()))
            gi.save(f"{out}/raw/grid.png")
            gdirs = next(iter(grids)).split()[1:] or dirs
            frames.update(cut_grid(gi, gdirs))
            dirs_run, poses_run = gdirs, ["idle"]
        else:
            dirs_run = [d for d in dirs if any((d, p) in frames for p in poses)] if not a.flow else \
                sorted({d for d, _ in frames}, key=lambda d: list(DIRS).index(d) if d in DIRS else 99)
            poses_run = poses if not a.flow else \
                ["idle"] + sorted({p for _, p in frames if p != "idle"}, key=lambda p: list(POSES).index(p)
                                  if p in POSES else 99)
        missing = [(d, p) for d in dirs_run for p in poses_run if (d, p) not in frames]
        if missing:
            print(f"  ! no image for {missing}; those cells stay empty")
        for (d, p), im in frames.items():
            if d in a.mirror:
                im = ImageOps.mirror(im)
                frames[(d, p)] = im
            im.save(f"{out}/raw/{d}-{p}.png")
        runs.append(finish(out, frames, dirs_run, poses_run, a, kind, pal,
                           {"method": "flow" if a.flow else a.method, "seed": seed, "input": a.image, "kind": kind,
                            "models": q if a.method != "sdxl" else SDXL, "mirrored": a.mirror}))
    if runs:
        print("\n".join(runs))


def finish(out, raws, dirs, poses, a, kind, pal, meta) -> str:
    raws = {k: v for k, v in raws.items() if k[0] in dirs and k[1] in poses}
    frames = pixelize(raws, dirs, poses, a.size, a.content, pal)
    json.dump({"palette": pal, "size": a.size, "content": a.content, "kind": kind},
              open(f"{out}/post.json", "w"))
    assemble(frames, dirs, poses, a.size, out, kind, {**meta, "palette": a.palette}, raws)
    return (f"→ {out}/sheet.png  ({len(poses)}x{len(dirs)} of {a.size}px; preview.png, sheet@4x.png, "
            f"anim-*.gif, frames/{kind}-<dir>-<pose>.png)")


def cmd_repack(a):
    """Re-run the pixel post on a finished run's raws: new size/palette, no GPU."""
    meta = json.load(open(f"{a.run}/sheet.json"))
    dirs, poses = meta["dirs"], meta["poses"]
    raws = {}
    for d in dirs:
        for p in poses:
            f = f"{a.run}/raw/{d}-{p}.png"
            if os.path.exists(f):
                raws[(d, p)] = Image.open(f).convert("RGB")
    kind = meta.get("kind") or next(iter(meta["frames"])).rsplit("-", 2)[0]
    if a.palette == "input":
        src = os.path.join(os.path.dirname(os.path.abspath(a.run)), f"input-{IN_SIZE}.png")
        pal = input_palette(Image.open(src), a.colors)
    else:
        pal = None if a.palette == "none" else list(SWAMP_RGB)
    out = a.to or a.run
    os.makedirs(out, exist_ok=True)
    print(finish(out, raws, dirs, poses, a, kind, pal, {k: v for k, v in meta.items()
                                                       if k not in ("frames", "dirs", "poses", "canvas")}))


def cmd_doctor(_a):
    try:
        st = http_json("/system_stats", timeout=10)
    except Exception as e:
        raise SystemExit(f"ComfyUI not reachable at {HOST} ({e}). Set COMFY=http://host:port")
    for dev in st.get("devices", []):
        print(f"server: {st.get('system', {}).get('comfyui_version', '?')}  {dev.get('name')}  "
              f"VRAM free {dev.get('vram_free', 0) / 2**30:.1f}/{dev.get('vram_total', 0) / 2**30:.1f} GB")
    q, notes = detect_qwen({})
    for n in notes:
        print(" ·", n)
    print("qwen route will use:")
    for k in ("unet", "lightning", "clip", "vae", "angles"):
        print(f"  {k:9} {q.get(k)}")
    info = http_json("/object_info", timeout=60)
    need = {"qwen": ["TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "CFGNorm",
                     "ModelSamplingAuraFlow", "EmptySD3LatentImage"],
            "sdxl": ["IPAdapterAdvanced", "IPAdapterModelLoader", "PrepImageForClipVision"],
            "flow sheet preview": ["ImageStitch"], "gguf": ["UnetLoaderGGUF"]}
    for route, nodes in need.items():
        miss = [n for n in nodes if n not in info]
        print(f"  {'ok ' if not miss else 'MISSING'} {route}" + (f": {', '.join(miss)}" if miss else ""))
    ck = listing("checkpoints") or []
    lo = listing("loras") or []
    print(f"  {'ok ' if SDXL['ckpt'] in ck else 'MISSING'} sdxl checkpoint {SDXL['ckpt']}")
    print(f"  {'ok ' if SDXL['lora'] in lo else 'MISSING'} pixel LoRA {SDXL['lora']}")


def cmd_flows(a):
    """(Re)write the committed, importable flows. Exact widget order from the live
    server when reachable; the built-in table otherwise."""
    specs = None
    try:
        specs = comfy_ui.fetch_specs(HOST)
        print(f"widget specs from {HOST}/object_info")
    except Exception:
        print("server not reachable: widget specs from comfy_ui.BUILTIN")
    os.makedirs(a.to, exist_ok=True)
    q = dict(QWEN)
    if specs is not None:
        q, _ = detect_qwen({})
    dirs = parse_list(a.dirs, DIRS, "direction")
    poses = PRESETS.get(a.frames) or parse_list(a.frames, POSES, "pose")
    poses = ["idle"] + [p for p in poses if p != "idle"]
    tag = "" if (a.dirs, a.frames) == (",".join(PACK_DIRS), "basic") else f"-{a.frames}-{'-'.join(dirs)}"
    made = {
        f"sprite-sheet-qwen{tag}": qwen_graph("character.png", dirs, poses, 1004, q, prefix="sprite-sheet/qwen"),
        f"sprite-sheet-sdxl{tag}": sdxl_graph("character.png", dirs, poses, 1004, prefix="sprite-sheet/sdxl"),
        "sprite-sheet-grid": grid_graph("character.png", dirs, 1004, q, prefix="sprite-sheet/grid"),
    }
    for name, g in made.items():
        json.dump(g.workflow(specs), open(f"{a.to}/{name}.json", "w"), indent=1)
        json.dump(g.nodes, open(f"{a.to}/{name}_api.json", "w"), indent=1)
        print(f"  {a.to}/{name}.json  (+ _api.json, {len(g.nodes)} nodes)")


def cmd_prep(a):
    out = a.o or os.path.splitext(a.image)[0] + f"-{IN_SIZE}.png"
    prep_input(a.image).save(out)
    print(out)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--"]:  # `pnpm run sprite:sheet -- hero.png` may pass the separator through
        argv = argv[1:]
    sub = argv[0] if argv and argv[0] in ("doctor", "repack", "flows", "prep") else None
    if sub:
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="spritesheet.py", description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    post = argparse.ArgumentParser(add_help=False)
    post.add_argument("--size", type=int, default=48, help="frame canvas px (the pack's chars are 48)")
    post.add_argument("--content", type=int, help="px the TALLEST frame spans (default size-2)")
    post.add_argument("--palette", choices=["input", "swampspace", "none"], default="input",
                      help="input = the character's own colours; swampspace = the pack's locked 34")
    post.add_argument("--colors", type=int, default=24, help="palette size for --palette input")
    if sub == "doctor":
        return cmd_doctor(ap.parse_args(argv))
    if sub == "prep":
        ap.add_argument("image")
        ap.add_argument("-o")
        return cmd_prep(ap.parse_args(argv))
    if sub == "repack":
        ap = argparse.ArgumentParser(prog="spritesheet.py repack", parents=[post])
        ap.add_argument("run", help="a finished run dir (holds sheet.json and raw/)")
        ap.add_argument("--to", help="write here instead of over the run")
        return cmd_repack(ap.parse_args(argv))
    if sub == "flows":
        ap.add_argument("--to", default=FLOWS)
        ap.add_argument("--dirs", default=",".join(PACK_DIRS))
        ap.add_argument("--frames", default="basic")
        return cmd_flows(ap.parse_args(argv))
    ap = argparse.ArgumentParser(prog="spritesheet.py", parents=[post], description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", help="the character: any size, PNG with alpha or on a plain background")
    ap.add_argument("--method", choices=["qwen", "grid", "sdxl"], default="qwen")
    ap.add_argument("--dirs", default=",".join(PACK_DIRS), help=f"of {','.join(DIRS)}")
    ap.add_argument("--frames", default="basic",
                    help="preset (" + ", ".join(k + "=" + "+".join(v) for k, v in PRESETS.items())
                         + ") or a list of " + ",".join(POSES))
    ap.add_argument("--seeds", type=int, nargs="+", help="one sheet per seed (default 1004; with --flow, "
                                                          "the flow's own seeds)")
    ap.add_argument("--describe", default="", help="one line about the character; helps side/back views, "
                                                   "needed by --method sdxl")
    ap.add_argument("--style", help=f"style sentence (default: {STYLE!r})")
    ap.add_argument("--name", help="run name (default: image file name)")
    ap.add_argument("--kind", help="frame file prefix (default: the name, slugged)")
    ap.add_argument("--out", help="output dir (default ./sprite-sheets/<name>)")
    ap.add_argument("--flow", help="run THIS API-format flow (ComfyUI: Export (API)) instead of building one")
    ap.add_argument("--mirror", default="", help="flip these directions' raws, e.g. e,ne if a seed faced left")
    ap.add_argument("--angles", action="store_true", help="add the Multiple-Angles LoRA if installed")
    ap.add_argument("--unet", help="Qwen-Image-Edit model file (default: auto-detected)")
    ap.add_argument("--lightning", help="Lightning LoRA file, or 'none' (default: auto-detected)")
    ap.add_argument("--clip")
    ap.add_argument("--vae")
    ap.add_argument("--dry-run", action="store_true", help="write flow_api.json / flow.json, queue nothing")
    a = ap.parse_args(argv)
    a.mirror = [d for d in a.mirror.split(",") if d]
    return cmd_make(a)


if __name__ == "__main__":
    main()
