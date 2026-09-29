#!/usr/bin/env python3
"""Drive Wan 2.2 Fun-Control A14B with a periodic proxy depth video and the character keyframe.

The legs follow the proxy's cycle, so the clip repeats every `period` frames by construction; the
video model keeps the frames coherent. One direction per call.

  python3 fun_control.py --depth /mnt/d/tmp/cast-walks/rnd-multileg/proxy/se \
      --ref .../raw/se-keyframe.png --describe-file .../describe-front.txt --dir se --seed 3 \
      --out /mnt/d/tmp/cast-walks/rnd-multileg/fc-se-s3

Writes <out>/raw/walk-<dir>/NNNN.png (the layout loopscan/partscan/cast_walk read), <out>/control.mp4,
<out>/flow_api.json. Take GPU-WAN.lock before running; /free after.
"""
import argparse
import glob
import json
import os
import subprocess
import sys

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import spritesheet as S  # noqa: E402

FUN = {"high": "wanfun\\HighNoise\\Wan2.2-Fun-A14B-Control_HighNoise-Q4_K_M.gguf",
       "low": "wanfun\\LowNoise\\Wan2.2-Fun-A14B-Control_LowNoise-Q4_K_M.gguf"}
FFMPEG = os.path.expanduser("~/.local/bin/ffmpeg")
MOVES = ("walks in place like a video game walk cycle, stepping on all of its legs exactly as the control "
         "motion shows, the carapace level, and it never moves across the frame")


def control_video(depth_dir, length, out_mp4):
    frames = sorted(glob.glob(os.path.join(depth_dir, "depth-*.png")))
    seq = os.path.join(os.path.dirname(out_mp4), "control")
    os.makedirs(seq, exist_ok=True)
    for i in range(length):
        Image.open(frames[i % len(frames)]).convert("RGB").save(os.path.join(seq, f"{i:04d}.png"))
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-framerate", "16", "-i", os.path.join(seq, "%04d.png"),
                    "-c:v", "libx264", "-crf", "4", "-pix_fmt", "yuv420p", out_mp4], check=True)
    return len(frames)


def upload_file(path, name):
    import uuid
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + open(path, "rb").read() + \
        f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n".encode()
    return json.loads(S.http("/upload/image", body, f"multipart/form-data; boundary={b}"))["name"]


def graph(ref_name, video_name, text, seed, prefix, w, h, length, shift, steps, split, lora):
    g = {}

    def add(cls, inputs):
        k = str(len(g) + 1)
        g[k] = {"class_type": cls, "inputs": inputs}
        return [k, 0]

    experts = []
    for part in ("high", "low"):
        u = add("UnetLoaderGGUF", {"unet_name": FUN[part]})
        u = add("ModelComputeDtype", {"model": u, "dtype": "bf16"})
        if lora:
            u = add("LoraLoaderModelOnly", {"model": u, "lora_name": S.WAN["lora_" + part], "strength_model": 1.0})
        experts.append(add("ModelSamplingSD3", {"model": u, "shift": shift}))
    clip = add("CLIPLoader", {"clip_name": S.WAN["clip"], "type": "wan", "device": "default"})
    vae = add("VAELoader", {"vae_name": S.WAN["vae"]})
    pos = add("CLIPTextEncode", {"clip": clip, "text": text})
    neg = add("CLIPTextEncode", {"clip": clip, "text": S.WAN_NEG})
    ref = add("LoadImage", {"image": ref_name})
    vid = add("LoadVideo", {"file": video_name})
    comp = add("GetVideoComponents", {"video": vid})
    fc = add("Wan22FunControlToVideo", {"positive": pos, "negative": neg, "vae": vae, "width": w, "height": h,
                                        "length": length, "batch_size": 1, "ref_image": ref, "control_video": comp})
    cfg = 1.0 if lora else 3.5
    k1 = add("KSamplerAdvanced", {"model": experts[0], "positive": fc, "negative": [fc[0], 1], "latent_image": [fc[0], 2],
                                  "add_noise": "enable", "noise_seed": seed, "steps": steps, "cfg": cfg,
                                  "sampler_name": "euler", "scheduler": "simple", "start_at_step": 0,
                                  "end_at_step": split, "return_with_leftover_noise": "enable"})
    k2 = add("KSamplerAdvanced", {"model": experts[1], "positive": fc, "negative": [fc[0], 1], "latent_image": k1,
                                  "add_noise": "disable", "noise_seed": 0, "steps": steps, "cfg": cfg,
                                  "sampler_name": "euler", "scheduler": "simple", "start_at_step": split,
                                  "end_at_step": 10000, "return_with_leftover_noise": "disable"})
    dec = add("VAEDecode", {"samples": k2, "vae": vae})
    add("SaveImage", {"images": dec, "filename_prefix": f"{prefix}/f"})
    cv = add("CreateVideo", {"images": dec, "fps": 16.0})
    add("SaveVideo", {"video": cv, "filename_prefix": f"{prefix}/clip", "format": "mp4", "codec": "h264"})
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--describe-file", required=True)
    ap.add_argument("--dir", default="se")
    ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--out", required=True)
    ap.add_argument("--length", type=int, default=81)
    ap.add_argument("--shift", type=float, default=8.0)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--split", type=int, default=2)
    ap.add_argument("--no-lora", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    tag = os.path.basename(a.out.rstrip("/"))
    period = control_video(a.depth, a.length, os.path.join(a.out, "control.mp4"))
    vname = upload_file(os.path.join(a.out, "control.mp4"), f"rnd-multileg-{tag}.mp4")
    rname = S.upload(Image.open(a.ref).convert("RGB"), f"rnd-multileg-{tag}-ref.png")
    who = open(a.describe_file).read().strip()
    text = f"Pixel art video game sprite animation. {who[0].upper() + who[1:]}, {S.DIRS[a.dir]}, {MOVES}. {S.WAN_RULES}"
    g = graph(rname, vname, text, a.seed, f"sprite-sheet/rnd-multileg/{tag}", S.WAN["width"], S.WAN["height"],
              a.length, a.shift, a.steps, a.split, not a.no_lora)
    json.dump(g, open(os.path.join(a.out, "flow_api.json"), "w"), indent=1)
    pid = S.queue(g)
    print(f"queued {pid} period {period}", flush=True)
    try:
        outs = S.wait(pid, limit_s=3600)
    except BaseException:
        S.cancel([pid])
        raise
    raw = os.path.join(a.out, "raw", f"walk-{a.dir}")
    os.makedirs(raw, exist_ok=True)
    ims = [im for imgs in outs.values() for im in imgs if im["filename"].startswith("f_")]
    for i, im in enumerate(sorted(ims, key=lambda im: im["filename"])):
        S.fetch(im).save(os.path.join(raw, f"{i:04d}.png"))
    json.dump({"period": period, "seed": a.seed, "shift": a.shift, "steps": a.steps, "lora": not a.no_lora,
               "text": text}, open(os.path.join(a.out, "run.json"), "w"), indent=1)
    print(f"-> {raw} ({len(ims)} frames)")


if __name__ == "__main__":
    main()
