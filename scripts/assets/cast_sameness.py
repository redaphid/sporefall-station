#!/usr/bin/env python3
"""Measure how alike the cast's sprites are, pair by pair, at game scale.

Each sprite is its 96 px s-idle as the game draws it (a raw still goes through
post.sprite first, so candidates are measured the same way). Four measures per pair:

  iou     silhouette IoU with feet and mask centroid aligned (1 = same outline)
  pal     total-variation distance of the locked-34-colour histograms (0 = same colours)
  hue     total-variation distance of 12 hue bins + 1 neutral bin (0 = same hues)
  struct  correlation of the 24 px luminance maps on the aligned canvas (1 = same light/dark layout)

  same = mean(iou, 1 - pal, 1 - hue, max(struct, 0)); higher is more alike.

    python3 cast_sameness.py lineup OUT_DIR kind|path ...   # lineup.png + table.txt + pairs.json
"""
import itertools, json, os, sys
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import palette, post

CHARS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../public/themes/swampspace-hires/chars")
SWAMP = (12, 20, 22)
PAL = np.array(palette.RGB, np.float32)
CANVAS = 128


def load(ref: str) -> Image.Image:
    """A kind name -> its shipped hires s-idle; a path -> that image, post.sprite'd unless already 96 px."""
    path = ref if os.path.exists(ref) else os.path.join(CHARS, f"{ref}-s-idle.png")
    im = Image.open(path).convert("RGBA")
    return im if im.size == (96, 96) else post.sprite(im, 96, 92)


def features(im: Image.Image) -> dict:
    a = np.asarray(im, np.float32)
    mask = a[..., 3] > 127
    ys, xs = np.nonzero(mask)
    dy, dx = (CANVAS - 8) - ys.max(), round(CANVAS / 2 - xs.mean())
    aligned = np.zeros((CANVAS, CANVAS), bool)
    luma = np.zeros((CANVAS, CANVAS), np.float32)
    aligned[ys + dy, xs + dx] = True
    rgb = a[..., :3][mask]
    luma[ys + dy, xs + dx] = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    idx = np.argmin(((rgb[:, None, :] - PAL[None]) ** 2).sum(-1), 1)
    pal = np.bincount(idx, minlength=len(PAL)) / len(idx)
    hsv = np.asarray(Image.fromarray(a[..., :3].astype(np.uint8)).convert("HSV"), np.float32)[mask]
    chroma = (hsv[:, 1] >= 0.2 * 255) & (hsv[:, 2] >= 0.12 * 255)
    bins = np.where(chroma, (hsv[:, 0] * 12 / 256).astype(int), 12)
    hue = np.bincount(bins, minlength=13) / len(bins)
    small = np.asarray(Image.fromarray(luma).resize((24, 24), Image.BOX), np.float32).ravel()
    h, w = ys.max() - ys.min() + 1, xs.max() - xs.min() + 1
    return {"mask": aligned, "pal": pal, "hue": hue, "luma": small, "aspect": w / h, "fill": mask.sum() / (w * h)}


def compare(f: dict, g: dict) -> dict:
    iou = (f["mask"] & g["mask"]).sum() / (f["mask"] | g["mask"]).sum()
    pal = 0.5 * np.abs(f["pal"] - g["pal"]).sum()
    hue = 0.5 * np.abs(f["hue"] - g["hue"]).sum()
    struct = float(np.corrcoef(f["luma"], g["luma"])[0, 1])
    same = (iou + (1 - pal) + (1 - hue) + max(struct, 0)) / 4
    return {k: round(float(v), 3) for k, v in dict(iou=iou, pal=pal, hue=hue, struct=struct, same=same).items()}


def table(names: list[str], feats: list[dict]) -> tuple[list[dict], str]:
    pairs = [dict(a=names[i], b=names[j], **compare(feats[i], feats[j]))
             for i, j in itertools.combinations(range(len(names)), 2)]
    pairs.sort(key=lambda p: -p["same"])
    lines = ["per sprite: aspect (w/h) and fill (mask / bbox)"]
    lines += [f"  {n:24s} aspect {f['aspect']:.2f}  fill {f['fill']:.2f}" for n, f in zip(names, feats)]
    lines += ["", f"{'pair':52s} {'same':>5s} {'iou':>5s} {'pal':>5s} {'hue':>5s} {'struct':>6s}"]
    lines += [f"{p['a'] + ' ~ ' + p['b']:52s} {p['same']:5.3f} {p['iou']:5.3f} {p['pal']:5.3f} {p['hue']:5.3f} {p['struct']:6.3f}"
              for p in pairs]
    return pairs, "\n".join(lines)


def lineup(ims: list[tuple[str, Image.Image]], scale: int = 3) -> Image.Image:
    cell, lab, pad = 104, 14, 8
    W = pad + len(ims) * cell
    big = 96 * scale
    bcell = big + pad
    W = max(W, pad + len(ims) * bcell)
    H = lab + 96 + pad + lab + big + pad
    sh = Image.new("RGBA", (W, H), SWAMP + (255,))
    d = ImageDraw.Draw(sh)
    d.text((pad, 1), "96 px, game scale", fill=(200, 200, 180, 255))
    for i, (name, im) in enumerate(ims):
        sh.alpha_composite(im, (pad + i * cell, lab))
        d.text((pad + i * cell + 2, lab + 96 - 10), name[:15], fill=(255, 210, 120, 255))
        sh.alpha_composite(im.resize((big, big), Image.NEAREST), (pad + i * bcell, lab + 96 + pad + lab))
        d.text((pad + i * bcell, lab + 96 + pad), name, fill=(255, 210, 120, 255))
    return sh.convert("RGB")


def main():
    cmd, out, refs = sys.argv[1], sys.argv[2], sys.argv[3:]
    assert cmd == "lineup", __doc__
    os.makedirs(out, exist_ok=True)
    names = [os.path.splitext(os.path.basename(r))[0] if os.path.exists(r) else r for r in refs]
    ims = [load(r) for r in refs]
    pairs, text = table(names, [features(im) for im in ims])
    lineup(list(zip(names, ims))).save(os.path.join(out, "lineup.png"))
    json.dump(pairs, open(os.path.join(out, "pairs.json"), "w"), indent=1)
    open(os.path.join(out, "table.txt"), "w").write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
