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
import glob
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

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


def cancel(pids) -> None:
    """Drop our still-queued prompts (and stop ours if it is the one running), so a
    run that has died does not leave the GPU busy on work nobody will collect."""
    pids = list(pids)
    try:
        q = http_json("/queue", timeout=10)
        running = {it[1] for it in q.get("queue_running", [])}
        http("/queue", json.dumps({"delete": pids}).encode())
        for pid in running & set(pids):
            http("/interrupt", json.dumps({"prompt_id": pid}).encode())
    except Exception as e:  # best effort: we are already on the way out with the real error
        print(f"  ! could not cancel queued prompts {[p[:8] for p in pids]}: {e}")


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
    # The Edit models use the original Qwen-Image VAE. A server can also hold a newer one
    # (`qwen_image_2.1_vae_bf16`, which sorts first), so keep the default when it's installed.
    qv = [v for v in vaes if "qwen" in v.lower()]
    if qv and cfg["vae"] not in vaes:
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


def _qwen_loaders(g, q, input_name, angles=False):
    """Qwen-Image-Edit model chain + the character input + the (CFG-1-inert) negative."""
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
    src = g.add("LoadImage", {"image": input_name}, "character (square, on white)", col=2)
    neg = g.add("TextEncodeQwenImageEditPlus", {"clip": [clip, 0], "vae": [vae, 0], "image1": [src, 0], "prompt": ""},
                "negative (ignored at CFG 1)", col=3)
    neg = g.add("FluxKontextMultiReferenceLatentMethod",
                {"conditioning": [neg, 0], "reference_latents_method": "index_timestep_zero"}, col=3)
    return m, clip, vae, src, neg


def _idle_prompt(d, describe, style):
    who = f" The character: {describe}." if describe else ""
    return (f"Redraw the character from image 1 as a single full-body video game sprite: {DIRS[d]}, "
            f"{POSES['idle']}. Keep the exact same character design, outfit, colors, markings and "
            f"proportions.{who} {FRAME} {style}")


def qwen_graph(input_name, dirs, poses, seed, q, describe="", style=STYLE, prefix="sprite-sheet/run",
               angles=False, stitch=True) -> Graph:
    g = Graph()
    g.band("models + input", "#335")
    m, clip, vae, src, neg = _qwen_loaders(g, q, input_name, angles)
    lat = g.add("EmptySD3LatentImage", {"width": IN_SIZE, "height": IN_SIZE, "batch_size": 1}, col=1)
    steps, cfg = (4, 1.0) if q.get("lightning") else (20, 2.5)
    who = f" The character: {describe}." if describe else ""
    sheet = []
    for d in dirs:
        g.band(f"direction {d}")
        row, base_decode = [], None
        for c, pose in enumerate(poses):
            if pose == "idle":
                text = _idle_prompt(d, describe, style)
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



# ---- the frog route: Qwen keyframe -> Wan 2.2 I2V walk -> loop cut --------------
# public/themes/swampspace/CURATION.md "frog-settler, 2026-09-25 — the video route": keyframes from
# Qwen-Image-Edit-2511 + Lightning at 1280x720 on white, one per direction; motion from Wan 2.2 I2V A14B
# Q4_K_M high/low + lightx2v 4-step at 848x480, 81 frames @16 fps, seed 3; border-connected white matte
# (--shrink 1); a FULL stride cut to 8 frames; white-speck clean-up; the pack's 34-colour palette at 96 px
# (swampspace-hires is the pack the game loads, docs/sprite-pipeline-wan.md §5). The two-expert graph is
# cyber-puck's tools/video/wan_flf_loop.py (build_a14b_gguf), start frame only.
WAN = {
    "high": "Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf",
    "low": "Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf",
    "lora_high": "wan2.2\\wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    "lora_low": "wan2.2\\wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
    "clip": "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    "vae": "wan_2.1_vae.safetensors",
    "width": 848, "height": 480, "length": 81, "fps": 16, "shift": 5.0, "steps": 4, "split": 2,
}
KEY_W, KEY_H = 1280, 720
WALK = ("walks in place like a video game walk cycle: the legs step forward and back one after another with big, "
        "clear, full strides, the arms swing, the body bobs gently, and it never moves across the frame")
WAN_RULES = ("The camera is completely static and locked off: no zoom, no pan, no rotation. The character stays "
             "centred and the same size, keeps facing the same direction the whole time, never turns around, and the "
             "whole body stays in frame. Plain flat white background, no shadow, no ground, crisp pixel art, flat "
             "colours, no motion blur.")
# cfg 1 makes this inert (the 4-step LoRA's setting); it is kept so raising cfg in the editor has one to use
WAN_NEG = ("色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，"
           "多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，杂乱的背景，三条腿，背景人很多，倒着走, "
           "mirrored, flipped, turning around, camera zoom, camera pan, walking out of frame, blurry, smeared")


def detect_wan(overrides: dict) -> tuple[dict, list[str]]:
    w, notes = dict(WAN), []
    unets = (listing("diffusion_models") or []) + (listing("unet") or [])
    i2v = [u for u in unets if "i2v" in u.lower() and ("a14b" in u.lower() or "14b" in u.lower())
           and "2.2" in u.replace("2_2", "2.2").replace("22", "2.2")]
    for part in ("high", "low"):
        c = sorted([u for u in i2v if part in u.lower()], key=lambda u: ("q4_k_m" not in u.lower(), u))
        if c:
            w[part] = c[0]
        elif unets:
            notes.append(f"no Wan 2.2 I2V A14B {part}-noise model found; using {w[part]!r}")
    loras = listing("loras") or []
    for part in ("high", "low"):
        c = [lo for lo in loras if "lightx2v" in lo.lower() and "i2v" in lo.lower() and part in lo.lower()
             and "2.2" in lo.replace("2_2", "2.2").replace("22", "2.2")]
        if c:
            w["lora_" + part] = sorted(c, key=lambda lo: ("4step" not in lo.lower(), lo))[0]
        elif loras:
            notes.append(f"no lightx2v Wan 2.2 I2V {part}-noise LoRA found; using {w['lora_' + part]!r}")
    encs = (listing("text_encoders") or []) + (listing("clip") or [])
    w["clip"] = next((e for e in encs if "umt5" in e.lower()), w["clip"])
    vaes = listing("vae") or []
    w["vae"] = next((v for v in vaes if "wan_2.1_vae" in v.lower() or "wan2.1_vae" in v.lower()), w["vae"])
    w.update({k: v for k, v in overrides.items() if v is not None})
    return w, notes


def video_graph(input_name, d, seed, q, w, describe="", style=STYLE, prefix="sprite-sheet/video") -> Graph:
    """ONE direction: Qwen keyframe (1280x720 on white) -> Wan 2.2 I2V walk-in-place, 81 frames."""
    g = Graph()
    g.band("models + input", "#335")
    m, clip, vae, src, neg = _qwen_loaders(g, q, input_name)
    lat = g.add("EmptySD3LatentImage", {"width": KEY_W, "height": KEY_H, "batch_size": 1}, col=1)
    steps, cfg = (4, 1.0) if q.get("lightning") else (20, 2.5)
    g.band(f"keyframe {d} (Qwen-Image-Edit)")
    pos = g.add("TextEncodeQwenImageEditPlus", {"clip": [clip, 0], "vae": [vae, 0], "image1": [src, 0],
                                                "prompt": _idle_prompt(d, describe, style)}, f"{d} keyframe prompt", col=0)
    pos = g.add("FluxKontextMultiReferenceLatentMethod",
                {"conditioning": [pos, 0], "reference_latents_method": "index_timestep_zero"}, col=0)
    ks = g.add("KSampler", {"model": [m, 0], "positive": [pos, 0], "negative": [neg, 0], "latent_image": [lat, 0],
                            "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                            "denoise": 1.0}, f"{d} keyframe sampler", col=1)
    key = g.add("VAEDecode", {"samples": [ks, 0], "vae": [vae, 0]}, col=1)
    g.add("SaveImage", {"images": [key, 0], "filename_prefix": f"{prefix}/{d}-keyframe"}, f"keyframe {d}", col=2)
    start = g.add("ImageScale", {"image": [key, 0], "upscale_method": "lanczos", "width": w["width"],
                                 "height": w["height"], "crop": "center"}, "keyframe -> 848x480", col=3)
    g.band(f"walk {d} (Wan 2.2 I2V A14B, 4-step)")
    experts = []
    for i, part in enumerate(("high", "low")):
        if w[part].endswith(".gguf"):
            u = g.add("UnetLoaderGGUF", {"unet_name": w[part]}, f"Wan 2.2 I2V {part} noise", col=0)
        else:
            u = g.add("UNETLoader", {"unet_name": w[part], "weight_dtype": "default"}, f"Wan 2.2 I2V {part} noise", col=0)
        # bf16 compute, as the frog's graph ran. Without it ComfyUI 0.37 takes the fp16 cutlass
        # path for the GGUF experts + LoRA and the first sampler dies: "cutlass_fp16_linear: K mismatch".
        u = g.add("ModelComputeDtype", {"model": [u, 0], "dtype": "bf16"}, col=0)
        u = g.add("LoraLoaderModelOnly", {"model": [u, 0], "lora_name": w["lora_" + part], "strength_model": 1.0},
                  f"lightx2v 4-step {part}", col=0)
        experts.append(g.add("ModelSamplingSD3", {"model": [u, 0], "shift": w["shift"]}, col=0))
    wclip = g.add("CLIPLoader", {"clip_name": w["clip"], "type": "wan", "device": "default"}, col=1)
    wvae = g.add("VAELoader", {"vae_name": w["vae"]}, col=1)
    who = describe or "The character from the start image"
    text = (f"Pixel art video game sprite animation. {who[0].upper() + who[1:]}, {DIRS[d]}, {WALK}. {WAN_RULES}")
    wpos = g.add("CLIPTextEncode", {"clip": [wclip, 0], "text": text}, f"{d} walk prompt", col=2)
    wneg = g.add("CLIPTextEncode", {"clip": [wclip, 0], "text": WAN_NEG}, "walk negative (inert at cfg 1)", col=2)
    i2v = g.add("WanImageToVideo", {"positive": [wpos, 0], "negative": [wneg, 0], "vae": [wvae, 0],
                                    "start_image": [start, 0], "width": w["width"], "height": w["height"],
                                    "length": w["length"], "batch_size": 1}, col=3)
    k1 = g.add("KSamplerAdvanced", {"model": [experts[0], 0], "positive": [i2v, 0], "negative": [i2v, 1],
                                    "latent_image": [i2v, 2], "add_noise": "enable", "noise_seed": seed,
                                    "steps": w["steps"], "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                                    "start_at_step": 0, "end_at_step": w["split"],
                                    "return_with_leftover_noise": "enable"}, "high noise steps", col=4)
    k2 = g.add("KSamplerAdvanced", {"model": [experts[1], 0], "positive": [i2v, 0], "negative": [i2v, 1],
                                    "latent_image": [k1, 0], "add_noise": "disable", "noise_seed": 0,
                                    "steps": w["steps"], "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                                    "start_at_step": w["split"], "end_at_step": 10000,
                                    "return_with_leftover_noise": "disable"}, "low noise steps", col=4)
    dec = g.add("VAEDecode", {"samples": [k2, 0], "vae": [wvae, 0]}, col=5)
    g.add("SaveImage", {"images": [dec, 0], "filename_prefix": f"{prefix}/{d}-walk/f"}, f"walk {d}", col=5)
    vid = g.add("CreateVideo", {"images": [dec, 0], "fps": float(w["fps"])}, col=6)
    g.add("SaveVideo", {"video": [vid, 0], "filename_prefix": f"{prefix}/{d}-walk/clip", "format": "mp4",
                        "codec": "h264"}, f"walk {d} (mp4)", col=6)
    g.notes.append((NOTE_VIDEO, 520))
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

NOTE_VIDEO = """The frog-settler route, one direction per queue (CURATION.md, 2026-09-25):
Qwen-Image-Edit keyframe (1280x720 on white) -> Wan 2.2 I2V A14B Q4_K_M + lightx2v 4-step,
848x480, 81 frames @16 fps -> 'walk <dir>' frames + mp4.

Input: square, on white (spritesheet.py prep hero.png). To do another direction, change the
direction words in BOTH prompts (keyframe and walk) and the SaveImage titles.
The CLI does all five, finds a full-stride loop, cuts 8 frames, mattes, palette-locks at 96 px:
  spritesheet.py hero.png --method video
Side art must face RIGHT: check the e keyframe before paying for its video."""

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


# ---- post for the video route ----------------------------------------------------
def find_loop(frames: list, pmin: int = 12, pmax: int = 64, skip: int = 6, window: int = 4,
              tol: float = 1.5, half: float = 0.6) -> dict:
    """The shortest FULL-stride loop in a walk clip. For each period P, the start s minimising
    the difference between frames s..s+window and s+P..s+P+window. A WINDOW, not one frame:
    a single pose recurs twice per stride (the leg passing forward, then back), so a
    one-frame match finds loops that jump the motion backwards at the seam.

    Every whole number of strides matches, so the best-scoring period is often two or three
    strides (the mycologist: e stride 20 frames, best score at 40; s best at 57). Cut into 8
    cells, that plays two or three strides per loop, at double or triple leg speed. So the
    answer is the SHORTEST period scoring within `tol` of the best, unless it is a half
    stride (legs swapped): a period whose double scores under `half` of its own score is a
    half, and is skipped. `seam` is the loop point's difference relative to an ordinary
    frame-to-frame step: under 1.0, the loop point is smoother than a normal step."""
    small = [np.asarray(f.convert("L").resize((212, 120), Image.BILINEAR), np.float32) for f in frames]
    n = len(small)
    steps = [float(np.abs(small[t + 1] - small[t]).mean()) for t in range(skip, n - 1)]
    step = max(float(np.median(steps)) if steps else 1.0, 1e-6)
    per = {}  # period -> (match / step, start)
    for p in range(pmin, min(pmax, n - skip - window) + 1):
        for s in range(skip, n - p - window + 1):
            e = float(np.mean([np.abs(small[s + k] - small[s + p + k]).mean() for k in range(window)])) / step
            if p not in per or e < per[p][0]:
                per[p] = (e, s)
    if not per:
        raise SystemExit(f"clip of {n} frames is too short for a loop of {pmin}-{pmax} (lower --period)")
    best = min(e for e, _ in per.values())
    limit = tol * best + 0.02

    def is_half(p):
        doubles = [per[q][0] for q in range(2 * p - 2, 2 * p + 3) if q in per]
        return bool(doubles) and min(doubles) < half * per[p][0]

    ps = sorted(per)
    minima = [p for i, p in enumerate(ps)
              if per[p][0] <= limit and all(per[p][0] <= per[q][0] for q in ps[max(0, i - 2):i + 3])]
    p = next((q for q in minima if not is_half(q)), min(per, key=lambda q: per[q][0]))
    e, s = per[p]
    seam = float(np.abs(small[s] - small[s + p]).mean())
    return {"period": p, "start": s, "seam": round(seam / step, 3), "step": round(step, 3),
            "match": round(e, 3), "candidates": {q: round(per[q][0], 2) for q in minima}}


def period_ranges(spec: str, dirs) -> dict:
    """--period '12:64' for every direction, or '12:64,n=14:18,e=16:24' per direction."""
    out, default = {}, (12, 64)
    for part in spec.split(","):
        key, _, rng = part.rpartition("=")
        lo, hi = (int(x) for x in rng.split(":"))
        if key:
            out[key] = (lo, hi)
        else:
            default = (lo, hi)
    return {d: out.get(d, default) for d in dirs}


def cut_loop(frames: list, loop: dict, n: int = 8) -> list:
    return [frames[loop["start"] + round(i * loop["period"] / n)] for i in range(n)]


def shrink_alpha(im: Image.Image, px: int = 1) -> Image.Image:
    """premat.py --shrink 1: pull the matte in so no backdrop-coloured rim survives."""
    if px <= 0:
        return im
    r, g_, b, a = im.split()
    for _ in range(px):
        a = a.filter(ImageFilter.MinFilter(3))
    return Image.merge("RGBA", (r, g_, b, a))


def despeckle(im: Image.Image, lum: int = 225) -> Image.Image:
    """White-speck inpaint: an isolated near-white opaque pixel (matte residue, a highlight
    the palette snapped to white) takes its neighbours' most common colour."""
    a = np.asarray(im.convert("RGBA")).copy()
    h, w_ = a.shape[:2]
    white = (a[..., 3] > 0) & (a[..., :3].min(-1) >= lum)
    for y, x in zip(*np.where(white)):
        nb = [a[j, i] for j, i in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1))
              if 0 <= j < h and 0 <= i < w_ and a[j, i, 3] > 0 and not white[j, i]]
        if len(nb) >= 3:
            vals, counts = np.unique(np.array(nb), axis=0, return_counts=True)
            a[y, x] = vals[counts.argmax()]
    return Image.fromarray(a, "RGBA")


def pixelize_fixed(raws: dict, dirs, poses, canvas: int, content: int | None, pal, shrink: int = 1) -> dict:
    """Video frames share a locked camera, so each direction goes through ONE crop window
    (the union of its frames) at ONE scale for the whole sheet: nothing pumps, feet stay
    where the video put them (trace.py's fixed-window rule)."""
    keyed = {k: shrink_alpha(key_background(v), shrink) for k, v in raws.items()}
    boxes = {k: bbox(v) for k, v in keyed.items()}
    union = {}
    for d in dirs:
        bs = [boxes[(d, p)] for p in poses if boxes.get((d, p))]
        if bs:
            union[d] = (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))
    if not union:
        raise SystemExit("every frame keyed to empty: is the background not plain?")
    content = content or canvas - 2
    s = content / max(max(u[3] - u[1], u[2] - u[0]) for u in union.values())
    out = {}
    for d in dirs:
        u = union.get(d)
        for p in poses:
            frame = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
            if u and (d, p) in keyed:
                tw, th = max(1, round((u[2] - u[0]) * s)), max(1, round((u[3] - u[1]) * s))
                px = despeckle(snap(P.kcentroid(keyed[(d, p)].crop(u), tw, th), pal))
                frame.paste(px, ((canvas - tw) // 2, canvas - 1 - th), px)
            out[(d, p)] = frame
    return out


def widest(frames: list) -> int:
    """Index of the widest silhouette: the full-stride contact pose, used as the pack's `step`."""
    widths = []
    for f in frames:
        b = bbox(key_background(f.resize((f.width // 4, f.height // 4))))
        widths.append(b[2] - b[0] if b else 0)
    return int(np.argmax(widths))


# ---- running ----------------------------------------------------------------------
TITLE_RE = re.compile(r"^frame\s+(\w+)\s+(\S+)$")


def harvest(api: dict, outputs: dict, walks: dict | None = None) -> tuple[dict, dict]:
    """SaveImage outputs -> ({(dir, pose): image}, {grid title: image}); `walk <dir>` saves
    (a whole clip) land in `walks[dir]` as a frame list."""
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
        elif title.startswith("keyframe "):
            frames[(title.split()[1], "keyframe")] = fetch(ims[0])
        elif re.match(r"^walk \w+$", title) and walks is not None:
            walks[title.split()[1]] = [fetch(im) for im in sorted(ims, key=lambda i: i["filename"])]
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
    if a.method == "video":
        return cmd_video(a, dirs, kind, root, src, pal)
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


WALK_POSES = ["idle", "step"] + [f"walk-{i}" for i in range(8)]


def cmd_video(a, dirs, kind, root, src, pal):
    """The frog route for every direction: one queue per direction (keyframe + walk clip),
    then loop-find, cut 8 frames, and post them through one fixed window at 96 px."""
    online = not a.dry_run
    qo = {"unet": a.unet, "lightning": a.lightning, "clip": a.clip, "vae": a.vae}
    if online:
        q, notes = detect_qwen(qo)
        w, wnotes = detect_wan({})
        notes += wnotes
    else:
        q = {**QWEN, **{k: (None if v == "none" else v) for k, v in qo.items() if v}}
        w, notes = dict(WAN), []
    for n in notes:
        print(" ·", n)
    ranges = period_ranges(a.period, dirs)
    input_name = upload(src, f"spritesheet-{kind}.png") if online else f"spritesheet-{kind}.png"
    runs = []
    for seed in a.seeds or [3]:  # the frog's seed
        out = os.path.join(root, f"video-s{seed}")
        os.makedirs(f"{out}/raw", exist_ok=True)
        graphs = {d: video_graph(input_name, d, seed, q, w, a.describe, a.style or STYLE,
                                 f"sprite-sheet/{kind}/video-s{seed}") for d in dirs}
        for d, g in graphs.items():
            json.dump(g.nodes, open(f"{out}/flow-{d}_api.json", "w"), indent=1)
            json.dump(g.workflow(), open(f"{out}/flow-{d}.json", "w"), indent=1)
        if a.dry_run:
            print(f"dry run: {out}/flow-<dir>_api.json for {', '.join(dirs)}")
            continue
        pids = {d: queue(g.nodes) for d, g in graphs.items()}  # ComfyUI runs them in order
        print(f"seed {seed}: queued {len(pids)} direction(s) — a keyframe and an {w['length']}-frame walk each; "
              f"minutes per direction")
        raws, loops, t0 = {}, {}, time.time()
        for i, d in enumerate(dirs):
            walks = {}
            try:
                outputs = wait(pids[d], limit_s=7200, poll=5)
            except (SystemExit, TimeoutError, KeyboardInterrupt):
                cancel(pids[x] for x in dirs[i:])
                raise
            frames, _ = harvest(graphs[d].nodes, outputs, walks)
            clip = walks.get(d) or []
            if d in a.mirror:
                clip = [ImageOps.mirror(f) for f in clip]
                frames = {k: ImageOps.mirror(v) for k, v in frames.items()}
            if (d, "keyframe") in frames:
                frames[(d, "keyframe")].save(f"{out}/raw/{d}-keyframe.png")
            pmin, pmax = ranges[d]
            if len(clip) < pmin + 8:
                print(f"  ! {d}: {len(clip)} frames, too few for a {pmin}+ frame loop; row stays empty")
                continue
            os.makedirs(f"{out}/raw/walk-{d}", exist_ok=True)
            for i, f in enumerate(clip):
                f.save(f"{out}/raw/walk-{d}/{i:04d}.png")
            loop = find_loop(clip, pmin, pmax)
            cyc = cut_loop(clip, loop)
            loops[d] = loop
            raws[(d, "idle")] = clip[0]  # the start frame: the keyframe, re-rendered by Wan in its own look
            raws[(d, "step")] = cyc[widest(cyc)]
            for i, f in enumerate(cyc):
                raws[(d, f"walk-{i}")] = f
            for p in ("idle", "step"):
                raws[(d, p)].save(f"{out}/raw/{d}-{p}.png")
            for i, f in enumerate(cyc):
                f.save(f"{out}/raw/{d}-walk-{i}.png")
            print(f"  {d}: loop of {loop['period']} frames from {loop['start']}, seam {loop['seam']} "
                  f"(under 1.0 = smoother than a normal step; candidates {loop['candidates']})  "
                  f"[{time.time() - t0:.0f}s]")
        dirs_run = [d for d in dirs if d in loops]
        if not dirs_run:
            continue
        runs.append(finish(out, raws, dirs_run, WALK_POSES, a, kind, pal,
                           {"method": "video", "seed": seed, "input": a.image, "kind": kind, "loops": loops,
                            "models": {"qwen": q, "wan": w}, "mirrored": a.mirror}))
    if runs:
        print("\n".join(runs))


def finish(out, raws, dirs, poses, a, kind, pal, meta) -> str:
    raws = {k: v for k, v in raws.items() if k[0] in dirs and k[1] in poses}
    if meta.get("method") == "video":
        frames = pixelize_fixed(raws, dirs, poses, a.size, a.content, pal)
    else:
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
    a.size = a.size or meta.get("canvas", 48)
    a.palette = a.palette or meta.get("palette", "input")
    out = os.path.abspath(a.to or a.run)
    raw = f"{out}/raw"
    if out != os.path.abspath(a.run):
        # --to never touches the source run, and its output is itself a run `repack` can take:
        # the cut raws are copied, the 81-frame clips linked
        os.makedirs(raw, exist_ok=True)
        for f in glob.glob(f"{a.run}/raw/*"):
            dst = os.path.join(raw, os.path.basename(f))
            if os.path.isdir(f):
                if not os.path.lexists(dst):
                    os.symlink(os.path.abspath(f), dst)
            else:
                shutil.copyfile(f, dst)
        for f in ("input-%d.png" % IN_SIZE,):
            src_in = os.path.join(os.path.dirname(os.path.abspath(a.run)), f)
            if os.path.exists(src_in) and not os.path.exists(os.path.join(os.path.dirname(out), f)):
                shutil.copyfile(src_in, os.path.join(os.path.dirname(out), f))
    if a.period and meta.get("method") == "video":  # re-find the loop in the saved clips, then re-cut
        ranges = period_ranges(a.period, dirs)
        for d in dirs:
            clip = [Image.open(f).convert("RGB") for f in sorted(glob.glob(f"{raw}/walk-{d}/*.png"))]
            loop = find_loop(clip, *ranges[d])
            cyc = cut_loop(clip, loop)
            meta.setdefault("loops", {})[d] = loop
            cyc[widest(cyc)].save(f"{raw}/{d}-step.png")
            for i, f in enumerate(cyc):
                f.save(f"{raw}/{d}-walk-{i}.png")
            print(f"  {d}: loop of {loop['period']} from {loop['start']}, seam {loop['seam']}  "
                  f"(candidates {loop['candidates']})")
    raws = {}
    for d in dirs:
        for p in poses:
            f = f"{raw}/{d}-{p}.png"
            if os.path.exists(f):
                raws[(d, p)] = Image.open(f).convert("RGB")
    kind = meta.get("kind") or next(iter(meta["frames"])).rsplit("-", 2)[0]
    if a.palette == "input":
        src = os.path.join(os.path.dirname(os.path.abspath(a.run)), f"input-{IN_SIZE}.png")
        pal = input_palette(Image.open(src), a.colors)
    else:
        pal = None if a.palette == "none" else list(SWAMP_RGB)
    if not raws:
        raise SystemExit(f"{raw}: no raw frames to repack")
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
    w, wnotes = detect_wan({})
    for n in wnotes:
        print(" ·", n)
    print("video route will use:")
    for k in ("high", "low", "lora_high", "lora_low", "clip", "vae"):
        print(f"  {k:9} {w[k]}")
    info = http_json("/object_info", timeout=60)
    need = {"qwen": ["TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "CFGNorm",
                     "ModelSamplingAuraFlow", "EmptySD3LatentImage"],
            "sdxl": ["IPAdapterAdvanced", "IPAdapterModelLoader", "PrepImageForClipVision"],
            "video": ["WanImageToVideo", "KSamplerAdvanced", "ModelSamplingSD3", "ModelComputeDtype", "UnetLoaderGGUF",
                      "ImageScale",
                      "CreateVideo", "SaveVideo"],
            "flow sheet preview": ["ImageStitch"]}
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
    except (urllib.error.URLError, OSError) as e:  # unreachable only; a parse bug must not pass as offline
        print(f"server not reachable ({e}): widget specs from comfy_ui.BUILTIN")
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
        "sprite-sheet-video-e": video_graph("character.png", "e", 3, q, detect_wan({})[0] if specs else dict(WAN),
                                            prefix="sprite-sheet/video"),
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
    post.add_argument("--size", type=int, help="frame canvas px (default 48; 96 for --method video, the "
                                                   "swampspace-hires size the game loads)")
    post.add_argument("--content", type=int, help="px the TALLEST frame spans (default size-2)")
    post.add_argument("--palette", choices=["input", "swampspace", "none"],
                      help="input = the character's own colours (default); swampspace = the pack's locked 34 "
                           "(default for --method video, as the frog shipped)")
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
        ap.add_argument("--period", help="video runs: re-find the loop in this frame range, e.g. 12:64, "
                                             "or per direction: 12:64,n=14:18")
        return cmd_repack(ap.parse_args(argv))
    if sub == "flows":
        ap.add_argument("--to", default=FLOWS)
        ap.add_argument("--dirs", default=",".join(PACK_DIRS))
        ap.add_argument("--frames", default="basic")
        return cmd_flows(ap.parse_args(argv))
    ap = argparse.ArgumentParser(prog="spritesheet.py", parents=[post], description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", help="the character: any size, PNG with alpha or on a plain background")
    ap.add_argument("--method", choices=["qwen", "video", "grid", "sdxl"], default="qwen",
                    help="video = the frog-settler route (Qwen keyframe + Wan 2.2 walk), 96 px")
    ap.add_argument("--period", default="12:64", help="video: loop length range in frames, all directions "
                                                        "(12:64) or per direction (12:64,e=16:24); the "
                                                        "shortest full stride in range wins")
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
    a.size = a.size or (96 if a.method == "video" else 48)
    a.palette = a.palette or ("swampspace" if a.method == "video" else "input")
    return cmd_make(a)


if __name__ == "__main__":
    main()
