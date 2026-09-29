#!/usr/bin/env python3
"""API-format ComfyUI graph -> editor-format workflow (the JSON you drag into the UI).

Every pipeline here queues the API format (`{"<id>": {"class_type", "inputs"}}`),
which the ComfyUI editor can load only as a pile of nodes stacked at 0,0 with no
groups. `to_workflow()` writes the editor format instead: positioned nodes, typed
links, groups and a note, so a flow can be dropped into the browser and tweaked.

The editor format stores widget values POSITIONALLY (`widgets_values`), so the
converter must know each node's widget order. It takes that from the live
server's `/object_info` when it can reach one (`specs_from_object_info`), and
falls back to `BUILTIN`, a hand-written table for exactly the nodes these
pipelines emit. If a node is in neither, conversion raises: a silently
misordered widget list loads as a plausible, wrong flow.
"""
import json
import urllib.request

# class_type -> (link inputs [(name, type)], widget names in order, outputs [(name, type)])
# A widget name ending in "+control" gets the frontend's control_after_generate
# value ("fixed") serialized right after it; "upload" is LoadImage's extra button.
BUILTIN = {
    "LoadImage": ([], ["image", "upload"], [("IMAGE", "IMAGE"), ("MASK", "MASK")]),
    "UNETLoader": ([], ["unet_name", "weight_dtype"], [("MODEL", "MODEL")]),
    "UnetLoaderGGUF": ([], ["unet_name"], [("MODEL", "MODEL")]),
    "LoraLoaderModelOnly": ([("model", "MODEL")], ["lora_name", "strength_model"], [("MODEL", "MODEL")]),
    "ModelSamplingAuraFlow": ([("model", "MODEL")], ["shift"], [("MODEL", "MODEL")]),
    "CFGNorm": ([("model", "MODEL")], ["strength"], [("patched_model", "MODEL")]),
    "CLIPLoader": ([], ["clip_name", "type", "device"], [("CLIP", "CLIP")]),
    "VAELoader": ([], ["vae_name"], [("VAE", "VAE")]),
    "TextEncodeQwenImageEditPlus": (
        [("clip", "CLIP"), ("vae", "VAE"), ("image1", "IMAGE"), ("image2", "IMAGE"), ("image3", "IMAGE")],
        ["prompt"], [("CONDITIONING", "CONDITIONING")]),
    "FluxKontextMultiReferenceLatentMethod": (
        [("conditioning", "CONDITIONING")], ["reference_latents_method"], [("CONDITIONING", "CONDITIONING")]),
    "KSampler": (
        [("model", "MODEL"), ("positive", "CONDITIONING"), ("negative", "CONDITIONING"), ("latent_image", "LATENT")],
        ["seed+control", "steps", "cfg", "sampler_name", "scheduler", "denoise"], [("LATENT", "LATENT")]),
    "VAEEncode": ([("pixels", "IMAGE"), ("vae", "VAE")], [], [("LATENT", "LATENT")]),
    "VAEDecode": ([("samples", "LATENT"), ("vae", "VAE")], [], [("IMAGE", "IMAGE")]),
    "EmptySD3LatentImage": ([], ["width", "height", "batch_size"], [("LATENT", "LATENT")]),
    "EmptyLatentImage": ([], ["width", "height", "batch_size"], [("LATENT", "LATENT")]),
    "SaveImage": ([("images", "IMAGE")], ["filename_prefix"], []),
    "PreviewImage": ([("images", "IMAGE")], [], []),
    "ImageStitch": (
        [("image1", "IMAGE"), ("image2", "IMAGE")],
        ["direction", "match_image_size", "spacing_width", "spacing_color"], [("IMAGE", "IMAGE")]),
    "CheckpointLoaderSimple": ([], ["ckpt_name"], [("MODEL", "MODEL"), ("CLIP", "CLIP"), ("VAE", "VAE")]),
    "LoraLoader": ([("model", "MODEL"), ("clip", "CLIP")], ["lora_name", "strength_model", "strength_clip"],
                   [("MODEL", "MODEL"), ("CLIP", "CLIP")]),
    "CLIPTextEncode": ([("clip", "CLIP")], ["text"], [("CONDITIONING", "CONDITIONING")]),
    "IPAdapterModelLoader": ([], ["ipadapter_file"], [("IPADAPTER", "IPADAPTER")]),
    "CLIPVisionLoader": ([], ["clip_name"], [("CLIP_VISION", "CLIP_VISION")]),
    "PrepImageForClipVision": ([("image", "IMAGE")], ["interpolation", "crop_position", "sharpening"],
                               [("IMAGE", "IMAGE")]),
    # Wan 2.2 I2V (the frog route): two experts, KSamplerAdvanced split, frames out as an IMAGE batch
    "ModelSamplingSD3": ([("model", "MODEL")], ["shift"], [("MODEL", "MODEL")]),
    "ModelComputeDtype": ([("model", "MODEL")], ["dtype"], [("MODEL", "MODEL")]),
    "WanImageToVideo": (
        [("positive", "CONDITIONING"), ("negative", "CONDITIONING"), ("vae", "VAE"),
         ("clip_vision_output", "CLIP_VISION_OUTPUT"), ("start_image", "IMAGE")],
        ["width", "height", "length", "batch_size"],
        [("positive", "CONDITIONING"), ("negative", "CONDITIONING"), ("latent", "LATENT")]),
    "KSamplerAdvanced": (
        [("model", "MODEL"), ("positive", "CONDITIONING"), ("negative", "CONDITIONING"), ("latent_image", "LATENT")],
        ["add_noise", "noise_seed+control", "steps", "cfg", "sampler_name", "scheduler", "start_at_step",
         "end_at_step", "return_with_leftover_noise"], [("LATENT", "LATENT")]),
    "ImageScale": ([("image", "IMAGE")], ["upscale_method", "width", "height", "crop"], [("IMAGE", "IMAGE")]),
    "CreateVideo": ([("images", "IMAGE"), ("audio", "AUDIO")], ["fps"], [("VIDEO", "VIDEO")]),
    "SaveVideo": ([("video", "VIDEO")], ["filename_prefix", "format", "codec"], []),
    "IPAdapterAdvanced": (
        [("model", "MODEL"), ("ipadapter", "IPADAPTER"), ("image", "IMAGE"), ("image_negative", "IMAGE"),
         ("attn_mask", "MASK"), ("clip_vision", "CLIP_VISION")],
        ["weight", "weight_type", "combine_embeds", "start_at", "end_at", "embeds_scaling"], [("MODEL", "MODEL")]),
}

# COMFY_DYNAMICCOMBO_V3 (ComfyUI 0.37's SaveVideo `format`) is a combo whose options are
# {"key", "inputs"} dicts; it is a widget, not a link socket.
_WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"}


def _default(typ, opts):
    """The value the editor would show for a widget the API graph leaves unset."""
    if "default" in opts:
        return opts["default"]
    options = typ if isinstance(typ, list) else opts.get("options")
    if options:
        return options[0]["key"] if isinstance(options[0], dict) else options[0]
    if isinstance(typ, list):  # a combo with nothing installed for it
        return None
    return {"INT": 0, "FLOAT": 0.0, "STRING": "", "BOOLEAN": False}.get(typ)


def specs_from_object_info(info: dict) -> dict:
    """Derive BUILTIN-shaped specs from a server's /object_info (exact for that server),
    plus a fourth element: each widget's default, for widgets the API graph leaves out
    (an optional `sampling` or `pre_cfg` a newer server added). Without it the editor
    file carries `null` in that widget's slot."""
    out = {}
    for cls, d in info.items():
        links, widgets, defaults = [], [], {}
        for section in ("required", "optional"):
            for name, spec in (d.get("input", {}).get(section) or {}).items():
                typ, opts = spec[0], (spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {})
                if isinstance(typ, list) or typ in _WIDGET_TYPES:
                    if opts.get("forceInput"):
                        links.append((name, typ if isinstance(typ, str) else "COMBO"))
                        continue
                    ctl = opts.get("control_after_generate") or (typ == "INT" and name in ("seed", "noise_seed"))
                    widgets.append(name + ("+control" if ctl else ""))
                    defaults[name] = _default(typ, opts)
                    if opts.get("image_upload"):
                        widgets.append("upload")
                else:
                    links.append((name, typ))
        outs = list(zip(d.get("output_name") or d.get("output", []), d.get("output", [])))
        out[cls] = (links, widgets, outs, defaults)
    return out


def fetch_specs(host: str, timeout: float = 10) -> dict:
    with urllib.request.urlopen(host + "/object_info", timeout=timeout) as r:
        return specs_from_object_info(json.load(r))


def _is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def to_workflow(api: dict, pos: dict | None = None, groups: list | None = None,
                notes: list | None = None, specs: dict | None = None) -> dict:
    """Convert an API graph. `pos` maps node id -> (x, y); `groups` is
    [(title, (x, y, w, h), color)]; `notes` is [((x, y), (w, h), text)]."""
    specs = {**BUILTIN, **(specs or {})}
    pos = pos or {}
    ids = {nid: i + 1 for i, nid in enumerate(api)}
    nodes, links = [], []
    out_links: dict[tuple, list] = {}
    for nid, node in api.items():
        cls = node["class_type"]
        if cls not in specs:
            raise KeyError(f"no widget spec for {cls!r} (node {nid}); add it to comfy_ui.BUILTIN "
                           f"or convert against a live server")
        link_ins, widgets, outs, *rest = specs[cls]
        defaults = rest[0] if rest else {}
        ins = node["inputs"]
        inputs = []
        for slot, (name, typ) in enumerate(link_ins):
            entry = {"name": name, "type": typ, "link": None}
            v = ins.get(name)
            if _is_link(v):
                lid = len(links) + 1
                links.append([lid, ids[v[0]], v[1], ids[nid], slot, typ])
                out_links.setdefault((v[0], v[1]), []).append(lid)
                entry["link"] = lid
            inputs.append(entry)
        wv = []
        for w in widgets:
            if w == "upload":
                wv.append("image")
            elif w.endswith("+control"):
                wv += [ins.get(w[:-8], defaults.get(w[:-8])), "fixed"]
            else:
                wv.append(ins.get(w, defaults.get(w)))
        # a widget input the API graph drives from another node -> make it a link slot
        for name, v in ins.items():
            if _is_link(v) and name not in [n for n, _ in link_ins]:
                raise ValueError(f"node {nid} ({cls}) links widget input {name!r}; not supported")
        x, y = pos.get(nid, (0, 0))
        n = {"id": ids[nid], "type": cls, "pos": [x, y], "size": node_size(cls, specs),
             "flags": {}, "order": ids[nid] - 1, "mode": 0, "inputs": inputs,
             "outputs": [{"name": on, "type": ot, "links": [], "slot_index": s} for s, (on, ot) in enumerate(outs)],
             "properties": {"Node name for S&R": cls}, "widgets_values": wv}
        if node.get("_meta", {}).get("title"):
            n["title"] = node["_meta"]["title"]
        nodes.append(n)
    by_id = {n["id"]: n for n in nodes}
    for (src, slot), lids in out_links.items():
        by_id[ids[src]]["outputs"][slot]["links"] = lids
    nid = len(nodes)
    for (x, y), (w, h), text in notes or []:
        nid += 1
        nodes.append({"id": nid, "type": "Note", "pos": [x, y], "size": [w, h], "flags": {}, "order": nid - 1,
                      "mode": 0, "inputs": [], "outputs": [], "properties": {}, "widgets_values": [text],
                      "color": "#432", "bgcolor": "#653"})
    return {
        "last_node_id": nid, "last_link_id": len(links), "nodes": nodes, "links": links,
        "groups": [{"title": t, "bounding": list(b), "color": c, "font_size": 24, "flags": {}}
                   for t, b, c in groups or []],
        "config": {}, "extra": {"ds": {"scale": 0.6, "offset": [40, 40]}}, "version": 0.4,
    }


def node_size(cls, specs=None):
    """Editor footprint [w, h] of a node, from its slot and widget counts."""
    # BUILTIN first: the layout was computed from it, so live specs must not resize a node under it
    link_ins, widgets = (BUILTIN.get(cls) or (specs or {}).get(cls) or ([], [], []))[:2]
    n_links, n_widgets = len(link_ins), len(widgets)
    w = 420 if cls.startswith("TextEncode") or cls == "CLIPTextEncode" else 300
    h = 46 + 22 * max(n_links, 1) + 26 * n_widgets
    if cls.startswith("TextEncode") or cls == "CLIPTextEncode":
        h += 120  # room for the prompt box
    if cls in ("SaveImage", "PreviewImage", "LoadImage"):
        w, h = 300, 340
    return [w, h]
