#!/usr/bin/env python3
"""Thin ComfyUI HTTP driver for the swampspace pack (no UI, no saved workflows).

Builds SDXL graphs: checkpoint + pixel-art LoRA (skormino, Illustrious/SDXL —
NB the prior pack paired this LoRA with an SD1.5 checkpoint, which silently
no-ops; it must ride an SDXL-family base) + optional IPAdapter style anchor +
optional seamless-tiling model patch + optional img2img init.

Raw outputs stay in ComfyUI's own output dir (~/sync/comfy-output); callers
download copies into a staging dir for post-processing/curation.
"""
import json
import os
import time
import urllib.parse
import urllib.request
import uuid

HOST = os.environ.get("COMFY", "http://localhost:8188")

# Juggernaut Ragnarok (SDXL) with NO pixel LoRA is the tile recipe: the skormino
# pixel LoRA imposed an ugly halftone-dither "camo blob" look; Juggernaut at high
# denoise draws real detail (grass blades, plate wear) and the k-centroid+palette
# downscale IS the pixel-art step — cleaner, more "attentive" pixel art. Override
# with CKPT=/LORA= for the older character/prop recipes.
CKPT = os.environ.get("CKPT", "SDXL1.0/juggernautXL_ragnarokBy.safetensors")
LORA = os.environ.get("LORA", "")
LORA_W = float(os.environ.get("LORA_W", "1.0"))
SIZE = int(os.environ.get("SIZE", "1024"))
# skormino v7.05 documented recipe: CFG 3-4, 28+ steps, euler
STEPS, CFG, SAMPLER, SCHED = 28, 3.5, "euler", "normal"


def post(path, payload):
    req = urllib.request.Request(
        HOST + path, json.dumps(payload).encode(), {"Content-Type": "application/json"}
    )
    return json.load(urllib.request.urlopen(req))


def upload(path):
    name = os.path.basename(path)
    boundary = uuid.uuid4().hex
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; '
        f'filename="{name}"\r\nContent-Type: image/png\r\n\r\n'
    ).encode() + open(path, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        HOST + "/upload/image", body,
        {"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    return json.load(urllib.request.urlopen(req))["name"]


def build_graph(
    *,
    pos: str,
    neg: str,
    seed: int,
    batch: int = 1,
    seamless: bool = False,
    refs: list[str] | None = None,
    ip_weight: float = 0.8,
    ip_type: str = "style transfer",
    init: str | None = None,
    denoise: float = 1.0,
    alpha: bool = True,
    prefix: str = "swampspace",
    size: int | None = None,
    control: str | None = None,
    controlnet: str | None = None,
    cn_strength: float = 1.0,
    cn_start: float = 0.0,
    cn_end: float = 1.0,
    cn_preprocess: str | None = None,
    cn_union_type: str | None = None,
):
    """Optional ControlNet branch (orthogonal to IPAdapter): IPAdapter patches
    the MODEL for identity/style; ControlNet patches the CONDITIONING for
    pose/structure, so pose can be pinned DURING diffusion and denoise pushed
    high without the pose or build drifting. `control` is the control image;
    for a ready-made control map (e.g. the rotoscope's Blender depth pass) leave
    `cn_preprocess` None, else pass a preprocessor node class (e.g.
    "DepthAnythingV2Preprocessor"). `cn_union_type` sets the mode on a union
    controlnet (xinsir/promax)."""
    size = size or SIZE
    g = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}}}
    model, clip = ["1", 0], ["1", 1]
    if LORA:
        g["2"] = {
            "class_type": "LoraLoader",
            "inputs": {"model": model, "clip": clip, "lora_name": LORA,
                       "strength_model": LORA_W, "strength_clip": LORA_W},
        }
        model, clip = ["2", 0], ["2", 1]
    g["3"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip, "text": pos}}
    g["4"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip, "text": neg}}
    if init:
        g["30"] = {"class_type": "LoadImage", "inputs": {"image": upload(init)}}
        g["31"] = {"class_type": "ImageScale",
                   "inputs": {"image": ["30", 0], "upscale_method": "lanczos",
                              "width": size, "height": size, "crop": "disabled"}}
        g["32"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["31", 0], "vae": ["1", 2]}}
        if batch > 1:
            g["33"] = {"class_type": "RepeatLatentBatch",
                       "inputs": {"samples": ["32", 0], "amount": batch}}
            latent = ["33", 0]
        else:
            latent = ["32", 0]
    else:
        g["5"] = {"class_type": "EmptyLatentImage",
                  "inputs": {"width": size, "height": size, "batch_size": batch}}
        latent = ["5", 0]
    if refs:
        g["8"] = {"class_type": "IPAdapterUnifiedLoader",
                  "inputs": {"model": ["1", 0], "preset": "PLUS (high strength)"}}
        img = None
        for i, ref in enumerate(refs):
            g[str(20 + i)] = {"class_type": "LoadImage", "inputs": {"image": upload(ref)}}
            if img is None:
                img = [str(20 + i), 0]
            else:
                bid = str(40 + i)
                g[bid] = {"class_type": "ImageBatch",
                          "inputs": {"image1": img, "image2": [str(20 + i), 0]}}
                img = [bid, 0]
        g["9"] = {"class_type": "IPAdapterAdvanced",
                  "inputs": {"model": model, "ipadapter": ["8", 1], "image": img,
                             "weight": ip_weight, "weight_type": ip_type,
                             "combine_embeds": "average", "start_at": 0.0, "end_at": 0.9,
                             "embeds_scaling": "V only"}}
        model = ["9", 0]
    # ControlNet: patches the CONDITIONING (pose/structure), orthogonal to the
    # IPAdapter model patch above. `control` is a control image; if
    # `cn_preprocess` is set it runs that preprocessor first, otherwise the
    # image is used as-is (the rotoscope feeds Blender's ready-made depth pass).
    positive, negative = ["3", 0], ["4", 0]
    if control and controlnet:
        g["60"] = {"class_type": "LoadImage", "inputs": {"image": upload(control)}}
        ctrl_img = ["60", 0]
        if cn_preprocess:
            g["61"] = {"class_type": cn_preprocess, "inputs": {"image": ctrl_img, "resolution": size}}
            ctrl_img = ["61", 0]
        g["62"] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": controlnet}}
        cnet = ["62", 0]
        if cn_union_type:
            g["63"] = {"class_type": "SetUnionControlNetType",
                       "inputs": {"control_net": cnet, "type": cn_union_type}}
            cnet = ["63", 0]
        g["64"] = {"class_type": "ControlNetApplyAdvanced",
                   "inputs": {"positive": positive, "negative": negative,
                              "control_net": cnet, "image": ctrl_img,
                              "strength": cn_strength, "start_percent": cn_start,
                              "end_percent": cn_end}}
        positive, negative = ["64", 0], ["64", 1]
    g["6"] = {"class_type": "KSampler",
              "inputs": {"model": model, "positive": positive, "negative": negative,
                         "latent_image": latent, "seed": seed, "steps": STEPS, "cfg": CFG,
                         "sampler_name": SAMPLER, "scheduler": SCHED, "denoise": denoise}}
    g["7"] = {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}}
    out = ["7", 0]
    if seamless:
        # True-tiling recipe: half-offset the image (wrap edges become adjacent
        # interior columns -> continuous by construction), then a low-denoise
        # img2img pass heals the old seams now sitting at the center cross.
        # (Model Patch Seamless (mtb) deepcopy-crashes on ComfyUI 0.28.)
        g["13"] = {"class_type": "Image Tile Offset (mtb)",
                   "inputs": {"image": out, "tilesX": 2, "tilesY": 2}}
        g["14"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["13", 0], "vae": ["1", 2]}}
        # Heal denoise: too low leaves the offset seam as a visible center cross;
        # SEAMLESS_HEAL raises it to fully blend (default 0.55).
        heal = float(os.environ.get("SEAMLESS_HEAL", "0.55"))
        g["15"] = {"class_type": "KSampler",
                   "inputs": {"model": model, "positive": ["3", 0], "negative": ["4", 0],
                              "latent_image": ["14", 0], "seed": seed + 1, "steps": STEPS,
                              "cfg": CFG, "sampler_name": SAMPLER, "scheduler": SCHED,
                              "denoise": heal}}
        g["16"] = {"class_type": "VAEDecode", "inputs": {"samples": ["15", 0], "vae": ["1", 2]}}
        out = ["16", 0]
    if alpha:
        g["11"] = {"class_type": "Image Rembg (Remove Background)",
                   "inputs": {"images": out, "model": "isnet-general-use",
                              "transparency": True, "alpha_matting": False,
                              "alpha_matting_foreground_threshold": 240,
                              "alpha_matting_background_threshold": 20,
                              "alpha_matting_erode_size": 4, "post_processing": True,
                              "only_mask": False, "background_color": "none"}}
        out = ["11", 0]
    g["12"] = {"class_type": "SaveImage", "inputs": {"images": out, "filename_prefix": prefix}}
    return g


def run(graph, dest_dir, timeout=900):
    """Queue a graph, wait, download every produced image to dest_dir. Returns paths."""
    pid = post("/prompt", {"prompt": graph})["prompt_id"]
    os.makedirs(dest_dir, exist_ok=True)
    for _ in range(timeout):
        time.sleep(1)
        try:
            h = json.load(urllib.request.urlopen(f"{HOST}/history/{pid}", timeout=30))
        except Exception:
            continue  # server busy mid-batch; keep polling
        if pid not in h:
            continue
        entry = h[pid]
        if entry.get("status", {}).get("status_str") == "error":
            raise RuntimeError(json.dumps(entry["status"], indent=1)[:3000])
        outs = [o for o in entry["outputs"].values() if "images" in o]
        if not outs:
            continue
        paths = []
        for im in outs[-1]["images"]:
            q = urllib.parse.urlencode({"filename": im["filename"],
                                        "subfolder": im.get("subfolder", ""),
                                        "type": im["type"]})
            dest = os.path.join(dest_dir, im["filename"])
            with urllib.request.urlopen(f"{HOST}/view?{q}") as r, open(dest, "wb") as f:
                f.write(r.read())
            paths.append(dest)
        return paths
    raise TimeoutError(pid)
