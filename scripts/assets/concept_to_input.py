"""Concept art -> 96 px input anchor for the video route (spritesheet.py --method video).

Qwen-Image-Edit redraws the concept as ONE full-body three-quarter-front pixel-art sprite on
white, one image per seed. Each edit is keyed (border flood), cropped, k-centroid reduced to the
hires pack's content box (92 px, feet on canvas-2, the frames' own numbers) and snapped to the
locked 34 colours (palette.py). The strip shows the concept, every edit, and every 96 px result
on the pale backdrop and on the game floor (manifest background), where dark limbs vanish.
`thin` is the share of the 96 px silhouette narrower than 3 px; shipped humanoids measure 0-.014,
the stalker .061 and the crab alpha .054 (the critic: "the legs vanish").

  python3 concept_to_input.py CONCEPT --kind K --out DIR [--seeds 3 11 23 1004] [--describe "..."]
  -> DIR/edit-s<seed>.png (ComfyUI's PNG, flow embedded), DIR/<K>-s<seed>-96.png, DIR/strip.png,
     DIR/summary.json
Edits already in DIR are reused (no GPU), so a re-run only re-reduces; --force redraws.
Pick one: cp DIR/<K>-s<seed>-96.png /mnt/d/tmp/cast-walks/runs/<K>/input-anchor.png
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, PngImagePlugin

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.environ.get("SPOREFALL_ASSETS") or (
    HERE if os.path.exists(os.path.join(HERE, "spritesheet.py"))
    else os.path.expanduser("~/Worktrees/sporefall-station/cast-walks/scripts/assets"))
sys.path.insert(0, ASSETS)
import spritesheet as ss  # noqa: E402
import post as P  # noqa: E402
from palette import RGB as LOCKED  # noqa: E402

CANVAS, CONTENT = 96, 92
FLOOR = (12, 20, 22)  # manifest palette.background
PALE = (242, 246, 234)
VIEW = ("three-quarter front view, body turned 45 degrees toward the right side of the image, "
        "standing still in a relaxed idle pose")
MEDIUM = ("A clean 2D game sprite drawing, never a photo or a 3D render: convert the painting into crisp "
          "pixel art with thick dark outlines, flat cel shading and a limited palette. Every limb stays fully "
          "drawn and outlined, including the thin ones.")


def prompt(describe: str) -> str:
    who = f" The character: {describe}." if describe else ""
    return (f"Redraw the character from image 1 as a single full-body video game sprite: {VIEW}. Keep the exact "
            f"same character design: the same body shapes, proportions, materials, colors and markings.{who} "
            f"{ss.FRAME} {MEDIUM}")


def edit(src_name: str, seed: int, text: str, kind: str, q: dict) -> bytes:
    g = ss.Graph()
    g.band("models + concept", "#335")
    m, clip, vae, s, neg = ss._qwen_loaders(g, q, src_name)
    lat = g.add("EmptySD3LatentImage", {"width": 1024, "height": 1024, "batch_size": 1}, col=1)
    steps, cfg = (4, 1.0) if q.get("lightning") else (20, 2.5)
    g.band("concept -> 3/4 front pixel sprite on white")
    pos = g.add("TextEncodeQwenImageEditPlus", {"clip": [clip, 0], "vae": [vae, 0], "image1": [s, 0], "prompt": text},
                "edit prompt")
    pos = g.add("FluxKontextMultiReferenceLatentMethod",
                {"conditioning": [pos, 0], "reference_latents_method": "index_timestep_zero"})
    ks = g.add("KSampler", {"model": [m, 0], "positive": [pos, 0], "negative": [neg, 0], "latent_image": [lat, 0],
                            "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                            "denoise": 1.0}, "sampler", col=1)
    dec = g.add("VAEDecode", {"samples": [ks, 0], "vae": [vae, 0]}, col=1)
    g.add("SaveImage", {"images": [dec, 0], "filename_prefix": f"sprite-sheet/{kind}/concept/s{seed}"}, "edit", col=2)
    res = ss.wait(ss.queue(g.nodes, g.workflow()))
    return ss.fetch_bytes([i for v in res.values() for i in v][0])


def reduce96(im: Image.Image, pockets: int) -> Image.Image:
    """Edit -> 96 px RGBA on the frames' grid, every pixel one of the locked 34. `pockets` keys backdrop
    a limb or an arch encloses (the border flood cannot reach it and it stays white)."""
    keyed = ss.key_background(im.convert("RGB"), pockets=pockets)
    b = ss.bbox(keyed)
    if not b:
        raise SystemExit("edit keyed to empty: the backdrop is not plain")
    w, h = b[2] - b[0], b[3] - b[1]
    s = CONTENT / max(w, h)
    tw, th = max(1, round(w * s)), max(1, round(h * s))
    px = ss.despeckle(ss.snap(P.kcentroid(keyed.crop(b), tw, th), LOCKED))
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.paste(px, ((CANVAS - tw) // 2, CANVAS - 1 - th), px)
    return out


def thin(op: np.ndarray) -> float:
    """Share of the silhouette narrower than 3 px (gone after a 3x3 opening): stick limbs, antennae,
    hair-line claws. They shimmer or vanish in motion at 96 px (Aaron, 09-29: "how thin some of those
    would be")."""
    from scipy import ndimage
    kept = ndimage.binary_opening(op, structure=np.ones((3, 3), bool))
    return round(float((op & ~kept).sum() / max(1, op.sum())), 3)


def stats(im: Image.Image) -> dict:
    a = np.asarray(im)
    op = a[..., 3] > 128
    px = a[op][:, :3].astype(int)
    lost = np.sqrt(((px - FLOOR) ** 2).sum(-1)) <= 30  # reads as floor on the game's dark ground
    ys, xs = np.where(op)
    cols = {tuple(c) for c in px.tolist()}
    return {"opaque": int(op.sum()), "w": int(xs.max() - xs.min() + 1), "h": int(ys.max() - ys.min() + 1),
            "colours": len(cols), "off_locked": len(cols - set(LOCKED)),
            "floor_like": round(float(lost.mean()), 3), "thin": thin(op)}


def on(bg, im: Image.Image, k: int) -> Image.Image:
    c = Image.new("RGBA", im.size, bg + (255,))
    c.alpha_composite(im)
    return c.convert("RGB").resize((im.width * k, im.height * k), Image.NEAREST)


def with_text(src_png: str, im: Image.Image, dst: str) -> None:
    """The 96 px anchor keeps the edit's ComfyUI prompt + workflow, so a drag-in rebuilds it."""
    info = PngImagePlugin.PngInfo()
    for key, val in Image.open(src_png).info.items():
        if key in ("prompt", "workflow") and isinstance(val, str):
            info.add_text(key, val)
    im.save(dst, pnginfo=info)


def lineup(a, cands: list) -> None:
    """Candidates at the kind's in-game scale on the floor beside shipped cast members at theirs, feet level."""
    chars = os.path.join(os.path.dirname(os.path.dirname(ASSETS)), "public/themes/swampspace-hires/chars")
    row = [(f"{a.kind} s{seed}", im, a.scale) for seed, im in zip(a.seeds, cands)]
    for item in a.lineup.split(","):
        kind, _, sc = item.partition(":")
        im = Image.open(f"{chars}/{kind}-s-idle.png").convert("RGBA")
        print(kind, "thin", thin(np.asarray(im)[..., 3] > 128))
        row.append((kind, im, float(sc or 1)))
    k = 2
    ims = [(t, im.resize((round(im.width * sc), round(im.height * sc)), Image.NEAREST)) for t, im, sc in row]
    hmax = max(im.height for _, im in ims)
    canvas = Image.new("RGBA", (sum(im.width + 8 for _, im in ims) + 8, hmax + 24), FLOOR + (255,))
    d = ImageDraw.Draw(canvas)
    x = 8
    for t, im in ims:
        canvas.alpha_composite(im, (x, hmax + 8 - im.height))
        d.text((x, hmax + 10), t[:20], fill=(200, 200, 200))
        x += im.width + 8
    canvas = canvas.convert("RGB")
    canvas.resize((canvas.width * k, canvas.height * k), Image.NEAREST).save(f"{a.out}/lineup.png")
    print("lineup", f"{a.out}/lineup.png")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("concept")
    ap.add_argument("--kind", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seeds", type=int, nargs="+", default=[3, 11, 23, 1004])
    ap.add_argument("--describe", default="", help="shapes, materials, colours that must survive the redraw")
    ap.add_argument("--force", action="store_true", help="redraw edits already in --out")
    ap.add_argument("--pockets", type=int, default=ss.POCKET_PX,
                    help="min enclosed-backdrop piece to key, raw px; 0 for a character with white parts of its own")
    ap.add_argument("--scale", type=float, default=1.0, help="the kind's in-game ARCHETYPE_SCALE (boss 1.5)")
    ap.add_argument("--lineup", default="", help="kind[:scale],... shipped hires s-idles drawn beside the candidates")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    text = prompt(a.describe)
    src = ss.prep_input(a.concept)
    src.save(f"{a.out}/concept-1024.png")
    need = [s for s in a.seeds if a.force or not os.path.exists(f"{a.out}/edit-s{s}.png")]
    if need:
        q, _ = ss.detect_qwen({"unet": None, "lightning": None, "clip": None, "vae": None})
        name = ss.upload(src, f"{a.kind}-concept.png")
        for seed in need:
            open(f"{a.out}/edit-s{seed}.png", "wb").write(edit(name, seed, text, a.kind, q))
            print("edit", seed, flush=True)
    summary = {"concept": os.path.abspath(a.concept), "prompt": text, "seeds": {}}
    k, cell = 4, 384
    strip = Image.new("RGB", (cell * (1 + len(a.seeds)), cell * 3), (40, 44, 48))
    strip.paste(src.resize((cell, cell), Image.LANCZOS), (0, 0))
    d = ImageDraw.Draw(strip)
    d.text((6, cell + 6), f"{a.kind}\nconcept -> Qwen edit\n-> 96 px, locked 34\nrow 2: pale, row 3: floor",
           fill=(230, 230, 230))
    for i, seed in enumerate(a.seeds):
        ep = f"{a.out}/edit-s{seed}.png"
        px = reduce96(Image.open(ep), a.pockets)
        dst = f"{a.out}/{a.kind}-s{seed}-96.png"
        with_text(ep, px, dst)
        summary["seeds"][seed] = st = stats(px)
        x = cell * (i + 1)
        strip.paste(Image.open(ep).convert("RGB").resize((cell, cell), Image.LANCZOS), (x, 0))
        strip.paste(on(PALE, px, k), (x, cell))
        strip.paste(on(FLOOR, px, k), (x, cell * 2))
        d.text((x + 6, 6), f"s{seed}", fill=(200, 30, 30))
        d.text((x + 6, cell * 2 + 6), f"s{seed} floor-like {st['floor_like']:.0%} thin {st['thin']:.0%}",
               fill=(230, 230, 230))
        print(seed, json.dumps(st), dst)
    strip.save(f"{a.out}/strip.png")
    if a.lineup:
        lineup(a, [Image.open(f"{a.out}/{a.kind}-s{seed}-96.png") for seed in a.seeds])
    json.dump(summary, open(f"{a.out}/summary.json", "w"), indent=1)
    print("strip", f"{a.out}/strip.png")


if __name__ == "__main__":
    main()
