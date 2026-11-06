#!/usr/bin/env python3
"""Reference motion for a rotoscoped action, generated on the box (no footage downloaded): a live-action
still of an actor (Z-Image Turbo), a clip of the actor doing the action (Wan 2.2 I2V A14B, 4-step), and
DWPose keypoints per clip frame (comfyui_controlnet_aux's DWPreprocessor). Flashback's route, minus
the film crew: real-looking weight shifts come from a video model trained on filmed people.

  python3 mocap_ref.py still --out DIR [--seeds 3,11,23,42] [--prompt ...]   # DIR/still-sN.png
  python3 mocap_ref.py video --out DIR --still DIR/still-s3.png [--seed 3] [--prompt ...]  # DIR/clip/NNNN.png
  python3 mocap_ref.py pose  --out DIR [--clip DIR/clip]                    # DIR/kps.json, DIR/pose/NNNN.png

kps.json: one entry per clip frame, {"w", "h", "people": [{"pose_keypoints_2d": [x, y, c] * 18 (OpenPose
COCO-18 order, pixels), "hand_left_keypoints_2d": ..., "hand_right_keypoints_2d": ...}]}: what
mocap_rig.py reads. Take GPU-WAN.lock before any subcommand; POST /free after.
"""
import argparse
import glob
import json
import os
import sys
import urllib.parse

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import spritesheet as S  # noqa: E402

W, H = 848, 480
STILL = ("Full-body live-action film still of a lean man in a plain dark jacket, dark trousers and boots, seen "
         "exactly from the side in profile, facing the right side of the image, standing upright and relaxed with "
         "his arms hanging at his sides, a black pistol in a holster on his right hip. His whole body is in frame "
         "from the top of his head to his feet with empty space above and below, centred, small in the frame. "
         "Plain seamless white studio backdrop, even soft light, no shadow on the floor, sharp focus, 35mm photo.")
MOVES = ("Live-action film footage of the man in the image, in full side profile facing the right side of the "
         "image. He stands still for a moment, then in one fast fluid motion he dips slightly, his right hand "
         "drops to the holster on his hip, he whips the pistol out and snaps his right arm straight out forward to "
         "aim at head height, his body leaning into the shot; he holds the aim steadily for a moment, then lowers "
         "the pistol, slides it back into the holster and relaxes back to standing. His feet stay planted and he "
         "never moves across the frame. The camera is completely static and locked off: no zoom, no pan, no "
         "rotation. Plain white studio backdrop, full body in frame the whole time, sharp, natural motion.")
NEG = ("cartoon, illustration, pixel art, blurry, motion blur, camera zoom, camera pan, turning around, walking out of "
       "frame, cropped, extra limbs, extra fingers, two people")


def still_graph(text, seed, prefix):
    g = {}

    def add(cls, inputs):
        k = str(len(g) + 1)
        g[k] = {"class_type": cls, "inputs": inputs}
        return [k, 0]
    m = add("UNETLoader", {"unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default"})
    m = add("ModelSamplingAuraFlow", {"model": m, "shift": 3.0})
    clip = add("CLIPLoader", {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2", "device": "default"})
    vae = add("VAELoader", {"vae_name": "ae.safetensors"})
    pos = add("CLIPTextEncode", {"clip": clip, "text": text})
    neg = add("CLIPTextEncode", {"clip": clip, "text": NEG})
    lat = add("EmptySD3LatentImage", {"width": W, "height": H, "batch_size": 1})
    ks = add("KSampler", {"model": m, "positive": pos, "negative": neg, "latent_image": lat, "seed": seed,
                          "steps": 8, "cfg": 1.0, "sampler_name": "res_multistep", "scheduler": "simple", "denoise": 1.0})
    dec = add("VAEDecode", {"samples": ks, "vae": vae})
    add("SaveImage", {"images": dec, "filename_prefix": f"{prefix}/still"})
    return g


def video_graph(still_name, text, seed, prefix, length):
    w = dict(S.WAN)
    g = {}

    def add(cls, inputs):
        k = str(len(g) + 1)
        g[k] = {"class_type": cls, "inputs": inputs}
        return [k, 0]
    experts = []
    for part in ("high", "low"):
        u = add("UnetLoaderGGUF", {"unet_name": w[part]})
        u = add("ModelComputeDtype", {"model": u, "dtype": "bf16"})
        u = add("LoraLoaderModelOnly", {"model": u, "lora_name": w["lora_" + part], "strength_model": 1.0})
        experts.append(add("ModelSamplingSD3", {"model": u, "shift": w["shift"]}))
    clip = add("CLIPLoader", {"clip_name": w["clip"], "type": "wan", "device": "default"})
    vae = add("VAELoader", {"vae_name": w["vae"]})
    pos = add("CLIPTextEncode", {"clip": clip, "text": text})
    neg = add("CLIPTextEncode", {"clip": clip, "text": NEG})
    img = add("LoadImage", {"image": still_name})
    i2v = add("WanImageToVideo", {"positive": pos, "negative": neg, "vae": vae, "start_image": img, "width": W,
                                  "height": H, "length": length, "batch_size": 1})
    k1 = add("KSamplerAdvanced", {"model": experts[0], "positive": i2v, "negative": [i2v[0], 1],
                                  "latent_image": [i2v[0], 2], "add_noise": "enable", "noise_seed": seed,
                                  "steps": w["steps"], "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                                  "start_at_step": 0, "end_at_step": w["split"], "return_with_leftover_noise": "enable"})
    k2 = add("KSamplerAdvanced", {"model": experts[1], "positive": i2v, "negative": [i2v[0], 1], "latent_image": k1,
                                  "add_noise": "disable", "noise_seed": 0, "steps": w["steps"], "cfg": 1.0,
                                  "sampler_name": "euler", "scheduler": "simple", "start_at_step": w["split"],
                                  "end_at_step": 10000, "return_with_leftover_noise": "disable"})
    dec = add("VAEDecode", {"samples": k2, "vae": vae})
    add("SaveImage", {"images": dec, "filename_prefix": f"{prefix}/f"})
    cv = add("CreateVideo", {"images": dec, "fps": 16.0})
    add("SaveVideo", {"video": cv, "filename_prefix": f"{prefix}/clip", "format": "mp4", "codec": "h264"})
    return g


def pose_graph(names, prefix):
    """DWPose on each uploaded frame: the drawn pose image and the keypoints as JSON, one pair per frame."""
    g = {}

    def add(cls, inputs):
        k = str(len(g) + 1)
        g[k] = {"class_type": cls, "inputs": inputs}
        return [k, 0]
    for i, n in enumerate(names):
        img = add("LoadImage", {"image": n})
        dw = add("DWPreprocessor", {"image": img, "detect_hand": "enable", "detect_body": "enable",
                                    "detect_face": "disable", "resolution": 768, "bbox_detector": "yolox_l.onnx",
                                    "pose_estimator": "dw-ll_ucoco_384_bs5.torchscript.pt",
                                    "scale_stick_for_xinsr_cn": "disable"})
        add("SaveImage", {"images": dw, "filename_prefix": f"{prefix}/pose-{i:04d}"})
        add("SavePoseKpsAsJsonFile", {"pose_kps": [dw[0], 1], "filename_prefix": f"{prefix}/kps-{i:04d}"})
    return g


def run(g):
    pid = S.queue(g)
    print(f"queued {pid}", flush=True)
    try:
        return S.wait(pid, limit_s=3600)
    except BaseException:
        S.cancel([pid])
        raise


def cmd_still(a):
    os.makedirs(a.out, exist_ok=True)
    for seed in [int(s) for s in a.seeds.split(",")]:
        outs = run(still_graph(a.prompt or STILL, seed, f"mocap/{os.path.basename(a.out)}"))
        im = next(im for ims in outs.values() for im in ims)
        S.fetch(im).save(os.path.join(a.out, f"still-s{seed}.png"))
        print(f"-> {a.out}/still-s{seed}.png", flush=True)
    json.dump({"prompt": a.prompt or STILL, "seeds": a.seeds}, open(os.path.join(a.out, "still.json"), "w"), indent=1)


def cmd_video(a):
    tag = f"{os.path.basename(a.out.rstrip('/'))}-s{a.seed}"
    name = S.upload(Image.open(a.still).convert("RGB").resize((W, H), Image.LANCZOS), f"mocap-{tag}.png")
    g = video_graph(name, a.prompt or MOVES, a.seed, f"mocap/{tag}", a.length)
    json.dump(g, open(os.path.join(a.out, f"video-s{a.seed}_api.json"), "w"), indent=1)
    outs = run(g)
    clip = os.path.join(a.out, f"clip-s{a.seed}")
    os.makedirs(clip, exist_ok=True)
    ims = sorted((im for ims in outs.values() for im in ims if im["filename"].startswith("f_")), key=lambda im: im["filename"])
    for i, im in enumerate(ims):
        S.fetch(im).save(os.path.join(clip, f"{i:04d}.png"))
    json.dump({"still": a.still, "seed": a.seed, "text": a.prompt or MOVES}, open(f"{clip}/run.json", "w"), indent=1)
    print(f"-> {clip} ({len(ims)} frames)")


def cmd_pose(a):
    frames = sorted(glob.glob(os.path.join(a.clip, "*.png")))
    tag = os.path.basename(a.clip.rstrip("/"))
    names = [S.upload(Image.open(f).convert("RGB"), f"mocap-{tag}-{i:04d}.png") for i, f in enumerate(frames)]
    prefix = f"mocap/pose-{tag}"
    outs = run(pose_graph(names, prefix))
    pdir = os.path.join(a.clip + "-pose")
    os.makedirs(pdir, exist_ok=True)
    for ims in outs.values():
        for im in ims:
            if im["filename"].startswith("pose-"):
                S.fetch(im).save(os.path.join(pdir, im["filename"].split("_")[0][5:] + ".png"))
    kps = []
    for i in range(len(frames)):  # SavePoseKpsAsJsonFile reports no outputs: fetch its file by its known name
        q = urllib.parse.urlencode({"filename": f"kps-{i:04d}_00001.json", "subfolder": prefix, "type": "output"})
        kps.append(json.loads(S.http(f"/view?{q}"))[0])
    json.dump(kps, open(os.path.join(a.clip + "-kps.json"), "w"))
    n = sum(1 for k in kps if k.get("people"))
    print(f"-> {a.clip}-kps.json ({n}/{len(kps)} frames with a person), drawn poses in {pdir}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("still")
    p.add_argument("--out", required=True)
    p.add_argument("--seeds", default="3,11,23,42")
    p.add_argument("--prompt")
    p = sub.add_parser("video")
    p.add_argument("--out", required=True)
    p.add_argument("--still", required=True)
    p.add_argument("--seed", type=int, default=3)
    p.add_argument("--length", type=int, default=81)
    p.add_argument("--prompt")
    p = sub.add_parser("pose")
    p.add_argument("--clip", required=True, help="a dir of NNNN.png frames; writes <clip>-kps.json and <clip>-pose/")
    a = ap.parse_args()
    {"still": cmd_still, "video": cmd_video, "pose": cmd_pose}[a.cmd](a)


if __name__ == "__main__":
    main()
