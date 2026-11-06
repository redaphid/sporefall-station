#!/usr/bin/env python3
"""Generated aim keyframes: the gun comes out of the model, never out of hand-placed pixels.

  python3 aim_keyframe.py design --out DIR [--seeds 3,11,23,1004]
      Qwen-Image-Edit turns a crude block sketch of a sidearm (structure input only) into a finished
      on-lore weapon: DIR/design-s<seed>.png. Pick one as the design reference.
  python3 aim_keyframe.py paint KF RIG --dir e --design REF --describe-file F --out DIR [--seeds 3,11]
      KF is the walk run's raw keyframe (1280x720, the clip's framing), RIG a rig_action `aim` control
      dir. The rig's aim pose is painted over the keyframe as crude colour blocks (arms in the
      character's own sleeve and glove colours, a grey block where the gun goes) and Qwen-Image-Edit
      redraws the character from it, holding the design reference's weapon (image 2).
      Writes DIR/<dir>-paint.png (the paint-over), DIR/<dir>-aim-s<seed>.png (1280x720, pasted back
      into the keyframe's framing) and DIR/<dir>-aim-s<seed>-848.png (Fun-Control's ref size).

Lore (docs/art-direction.md, LORE G1-G3): salvaged colony tech, bubble plumbing, one essence-glow
accent; not steampunk, not a modern handgun.
"""
import argparse
import json
import os
import sys

import numpy as np

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import spritesheet as ss  # noqa: E402

WEAPON = ("the Rivet Driver, a chunky salvaged colony rivet gun: a heavy cylindrical grey receiver with a small "
          "carry handle on top, a short barrel held by clamp bands, a thick muzzle collar with a driver nozzle, a pale "
          "green glowing charge cylinder strapped under the barrel, an orange-taped pistol grip")
NOT = "It is not steampunk: no gears, no cogs, no brass filigree, no ornament. It is not a modern handgun."

VIEWS = {"s": "facing the viewer, aiming straight at the viewer so the weapon is seen muzzle-first, held in "
              "front of the chest",
         "se": "in three-quarter front view turned toward the lower right, aiming toward the lower right",
         "e": "in full side profile facing right, aiming straight to the right",
         "ne": "in three-quarter back view turned away toward the upper right, aiming toward the upper right",
         "n": "seen from directly behind, aiming straight ahead away from the viewer, so the weapon and both "
              "hands are hidden in front of the body and only the bent elbows show at the sides"}

CROP = (280, 0, 1000, 720)  # the character's square in the 1280x720 keyframe
Q = 1024


def qwen(images, prompt, seed, prefix):
    q, _ = ss.detect_qwen({"unet": None, "lightning": None, "clip": None, "vae": None})
    names = [ss.upload(im, f"{prefix.replace('/', '-')}-in{i}.png") for i, im in enumerate(images)]
    g = ss.Graph()
    g.band("models + input", "#335")
    m, clip, vae, src, neg = ss._qwen_loaders(g, q, names[0])
    refs = {"image1": [src, 0]}
    for i, n in enumerate(names[1:], start=2):
        refs[f"image{i}"] = [g.add("LoadImage", {"image": n}, f"reference {i}", col=2), 0]
    lat = g.add("EmptySD3LatentImage", {"width": Q, "height": Q, "batch_size": 1}, col=1)
    steps, cfg = (4, 1.0) if q.get("lightning") else (20, 2.5)
    pos = g.add("TextEncodeQwenImageEditPlus", {"clip": [clip, 0], "vae": [vae, 0], "prompt": prompt, **refs}, "edit")
    pos = g.add("FluxKontextMultiReferenceLatentMethod", {"conditioning": [pos, 0], "reference_latents_method": "index_timestep_zero"})
    ks = g.add("KSampler", {"model": [m, 0], "positive": [pos, 0], "negative": [neg, 0], "latent_image": [lat, 0],
                            "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                            "denoise": 1.0}, col=1)
    dec = g.add("VAEDecode", {"samples": [ks, 0], "vae": [vae, 0]}, col=1)
    g.add("SaveImage", {"images": [dec, 0], "filename_prefix": f"sprite-sheet/aim/{prefix}-s{seed}"}, col=2)
    res = ss.wait(ss.queue(g.nodes, g.workflow()))
    ims = [i for v in res.values() for i in v]
    return ss.fetch(ims[0]).convert("RGB"), g


def cmd_design(a):
    os.makedirs(a.out, exist_ok=True)
    if a.sketch:  # a structure sketch from the weapons roster (docs/lore-weapons.md), fitted onto the square
        src = Image.open(a.sketch).convert("RGB")
        src.thumbnail((Q - 120, Q - 120))
        sk = Image.new("RGB", (Q, Q), "white")
        sk.paste(src, ((Q - src.width) // 2, (Q - src.height) // 2))
    else:
        sk = Image.new("RGB", (Q, Q), "white")
        d = ImageDraw.Draw(sk)  # structure only: a block sketch the model replaces
        d.rectangle([300, 430, 760, 520], fill=(200, 196, 170), outline=(20, 20, 24), width=8)
        d.ellipse([360, 330, 480, 440], fill=(70, 200, 190), outline=(20, 20, 24), width=8)
        d.polygon([(300, 500), (420, 500), (390, 700), (270, 690)], fill=(95, 100, 70), outline=(20, 20, 24))
    sk.save(f"{a.out}/sketch.png")
    prompt = (f"Turn the rough block sketch in image 1 into a finished, detailed pixel-art video game weapon item: "
              f"{WEAPON}. Side view, barrel pointing right, the grip below. {NOT} Muted worn colours with the "
              f"teal essence jar as the only glowing accent, thick dark outline, crisp pixel art, plain flat white "
              f"background, nothing else in the image.")
    json.dump({"prompt": prompt}, open(f"{a.out}/design.json", "w"), indent=1)
    for seed in a.seeds:
        im, _ = qwen([sk], prompt, seed, "design")
        im.save(f"{a.out}/design-s{seed}.png")
        print("design", seed, flush=True)


def _sample(kf, xy, r=6):
    """The median colour of the keyframe around an 848-space point (the sleeve, the glove)."""
    x, y = xy[0] * 1280 / 848, xy[1] * 720 / 480
    px = sorted(kf.getpixel((int(x + dx), int(y + dy))) for dx in range(-r, r + 1, 3) for dy in range(-r, r + 1, 3))
    return px[len(px) // 2]


def cmd_paint(a):
    os.makedirs(a.out, exist_ok=True)
    kf = Image.open(a.kf).convert("RGB")
    assert kf.size == (1280, 720), kf.size
    fit = json.load(open(a.fit))
    J = json.load(open(os.path.join(a.rig, f"joints-{a.frame:02d}.json")))
    arms = {k: J["legs"][k] for k in ("arm-near", "arm-far")}
    gun = J.get("props", {}).get("gun")
    sleeve = _sample(kf, fit["elbow_near"])
    glove = _sample(kf, fit["hand_near"])
    k = 1280 / 848
    paint = kf.copy()
    d = ImageDraw.Draw(paint)
    def arm_paint(name):
        ch = [(p[0] * k, p[1] * k) for p in arms[name][1:]]  # shoulder, elbow, hand
        # from behind, only what shows past the body: n the upper arms out to the elbows, ne the far upper arm
        upper = a.dir == "n" or (a.dir == "ne" and name == "arm-far")
        if upper:
            ch = ch[:2]
        d.line(ch, fill=sleeve, width=int(26 * k * a.limb), joint="curve")
        if upper:
            return
        hx, hy = ch[-1]
        r = 15 * k * a.limb
        d.ellipse([hx - r, hy - r, hx + r, hy + r], fill=glove)
    arm_paint("arm-far")
    if gun and a.dir != "n":
        # a block proxy at the weapon's sprite size (`--gun-px` long on the 96 px grid, at the walk run's scale):
        # receiver block over the grip, a slimmer barrel ahead of it, the grip down from the fist
        arm = (np.linalg.norm(np.subtract(fit["shoulder_near"], fit["elbow_near"]))
               + np.linalg.norm(np.subtract(fit["elbow_near"], fit["hand_near"])))
        rear, muz = np.array(gun["rear"]) * k, np.array(gun["muzzle"]) * k
        v = muz - rear
        fs = min(1.0, np.linalg.norm(v) / (0.3 * arm * k))  # the barrel's foreshortening in this view
        L = a.gun_px / a.scale * k  # full length, 1280 px
        hand = rear + 0.15 * v
        u = v / max(1e-6, np.linalg.norm(v))
        w = np.array([u[1], -u[0]]) if u[0] >= 0 else np.array([-u[1], u[0]])  # screen-up side of the barrel
        if w[1] > 0:
            w = -w
        H = 0.30 * L
        body = (150, 158, 150)
        if a.dir == "s":  # muzzle-first: the receiver's face over the hands, the barrel collar on it
            c = hand + np.array([0, -0.55 * H])
            d.rectangle([*(c - [0.42 * H, 0.55 * H]), *(c + [0.42 * H, 0.55 * H])], fill=body, outline=(20, 20, 24), width=4)
            d.ellipse([*(c - 0.26 * H), *(c + 0.26 * H)], fill=(70, 74, 72), outline=(20, 20, 24), width=3)
            d.ellipse([*(c - 0.09 * H), *(c + 0.09 * H)], fill=(10, 10, 12))
        else:
            r0 = hand - 0.20 * L * fs * u
            r1 = hand + 0.30 * L * fs * u
            m1 = hand + 0.80 * L * fs * u
            quad = lambda p0, p1, lo, hi: [tuple(p0 + w * hi), tuple(p1 + w * hi), tuple(p1 + w * lo), tuple(p0 + w * lo)]
            d.polygon(quad(r1, m1, -0.05 * H, 0.45 * H), fill=(95, 100, 98), outline=(20, 20, 24))  # barrel
            d.polygon(quad(r1, m1 - 0.12 * L * fs * u, -0.42 * H, -0.08 * H), fill=(170, 200, 160), outline=(20, 20, 24))
            d.polygon(quad(r0, r1, -0.35 * H, 0.65 * H), fill=body, outline=(20, 20, 24))  # receiver
            g0 = hand - 0.05 * L * fs * u
            d.polygon([tuple(g0 - w * 0.2 * H), tuple(g0 + u * 0.12 * L - w * 0.2 * H),
                       tuple(g0 + u * 0.06 * L - w * 0.85 * H), tuple(g0 - u * 0.06 * L - w * 0.85 * H)],
                      fill=(220, 120, 40), outline=(20, 20, 24))  # taped grip
    arm_paint("arm-near")  # the gun hand's fist over the grip
    paint.save(f"{a.out}/{a.dir}-paint.png")
    who = open(a.describe_file).read().strip()
    prompt = (f"Edit image 1, a pixel-art video game character, so it matches the rough paint-over: {who}, "
              f"{VIEWS[a.dir]}, holding a weapon in a firm two-handed grip with both arms raised and held out "
              f"straight at chest height, exactly where the rough painted arms and grey block are. The weapon is "
              f"{'the one in image 2: ' if a.design else ''}{a.weapon or WEAPON}. {'' if a.weapon else NOT} The arms no longer hang at the sides. Keep everything else "
              f"exactly the same: the same character, face, hair, clothes, colours, proportions, size and position, "
              f"the same thick dark outline and crisp pixel-art style, on the same plain white background.")
    if a.paint_only:
        return
    design = [Image.open(a.design).convert("RGB")] if a.design else []
    sq = paint.crop(CROP).resize((Q, Q), Image.LANCZOS)
    json.dump({"prompt": prompt, "frame": a.frame, "rig": a.rig, "design": a.design}, open(f"{a.out}/{a.dir}-paint.json", "w"), indent=1)
    for seed in a.seeds:
        im, g = qwen([sq] + design, prompt, seed, f"aimkf-{a.dir}")
        back = kf.copy()
        back.paste(im.resize((CROP[2] - CROP[0], CROP[3] - CROP[1]), Image.LANCZOS), CROP[:2])
        back.save(f"{a.out}/{a.dir}-aim-s{seed}.png")
        back.resize((848, 480), Image.LANCZOS).save(f"{a.out}/{a.dir}-aim-s{seed}-848.png")
        json.dump(g.nodes, open(f"{a.out}/{a.dir}-aim-s{seed}_api.json", "w"), indent=1)
        print(a.dir, seed, flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("design")
    p.add_argument("--out", required=True)
    p.add_argument("--sketch", help="a structure sketch to start from (e.g. the roster's control-src.png)")
    p.add_argument("--seeds", type=lambda s: [int(x) for x in s.split(",")], default=[3, 11, 23, 1004])
    p = sub.add_parser("paint")
    p.add_argument("kf")
    p.add_argument("rig", help="a rig_action aim control dir (joints-NN.json)")
    p.add_argument("--fit", required=True, help="the rig's fit.json (sleeve and glove colours are sampled at its rest joints)")
    p.add_argument("--dir", required=True)
    p.add_argument("--frame", type=int, default=40)
    p.add_argument("--limb", type=float, default=1.0, help="painted limb thickness factor")
    p.add_argument("--design", help="the weapon's design reference (image 2); none: the text alone")
    p.add_argument("--gun-px", type=float, default=26.0, help="the weapon's length on the 96 px grid (rivet driver: 26)")
    p.add_argument("--scale", type=float, default=0.2044, help="96 px sprite px per 848 px clip px (the walk run's)")
    p.add_argument("--weapon", help="the weapon's description (default: WEAPON)")
    p.add_argument("--describe-file", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--seeds", type=lambda s: [int(x) for x in s.split(",")], default=[3, 11])
    p.add_argument("--paint-only", action="store_true", help="write the paint-over and stop (no GPU)")
    a = ap.parse_args()
    {"design": cmd_design, "paint": cmd_paint}[a.cmd](a)


if __name__ == "__main__":
    main()
