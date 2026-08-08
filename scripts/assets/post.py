#!/usr/bin/env python3
"""Post-processing: diffusion output -> game-ready pixel sprite.

Pipeline per sprite: content bbox crop -> k-centroid downscale (the pixel-art
community's standard content-aware downscaler) -> quantize to the locked
Flashback-derived palette (nearest color, no dither) -> hard alpha.
Tiles skip alpha and get a seam self-check. Effects use luma-keyed alpha.
"""
import numpy as np
from PIL import Image

from palette import RGB

_PAL = np.array(RGB, dtype=np.float32)  # (N,3)


def kcentroid(im: Image.Image, tw: int, th: int, centroids: int = 2) -> Image.Image:
    """K-centroid downscale: for each destination pixel, k-means (k=centroids+)
    the source patch and take the dominant cluster's mean color. Preserves
    outlines and flat fills far better than box/lanczos at sprite scales."""
    im = im.convert("RGBA")
    src = np.asarray(im, dtype=np.float32)
    h, w = src.shape[:2]
    out = np.zeros((th, tw, 4), dtype=np.float32)
    ys = np.linspace(0, h, th + 1).astype(int)
    xs = np.linspace(0, w, tw + 1).astype(int)
    for j in range(th):
        for i in range(tw):
            patch = src[ys[j]:max(ys[j] + 1, ys[j + 1]), xs[i]:max(xs[i] + 1, xs[i + 1])]
            px = patch.reshape(-1, 4)
            opaque = px[px[:, 3] > 128]
            if len(opaque) * 2 <= len(px):  # mostly transparent -> transparent
                out[j, i] = (0, 0, 0, 0)
                continue
            rgbs = opaque[:, :3]
            # tiny k-means (k=2) on the patch, keep dominant cluster mean
            lum = rgbs @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
            c0, c1 = rgbs[lum.argmin()].copy(), rgbs[lum.argmax()].copy()
            for _ in range(4):
                d0 = ((rgbs - c0) ** 2).sum(1)
                d1 = ((rgbs - c1) ** 2).sum(1)
                m = d0 < d1
                if m.any():
                    c0 = rgbs[m].mean(0)
                if (~m).any():
                    c1 = rgbs[~m].mean(0)
            color = c0 if m.sum() * 2 >= len(rgbs) else c1
            out[j, i, :3] = color
            out[j, i, 3] = 255
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def to_palette(im: Image.Image) -> Image.Image:
    """Snap every opaque pixel to the nearest locked-palette color (no dither)."""
    im = im.convert("RGBA")
    a = np.asarray(im, dtype=np.float32).copy()
    px = a[..., :3].reshape(-1, 3)
    d = ((px[:, None, :] - _PAL[None, :, :]) ** 2).sum(-1)
    snapped = _PAL[d.argmin(1)]
    a[..., :3] = snapped.reshape(a.shape[:2] + (3,))
    a[..., 3] = np.where(a[..., 3] > 128, 255, 0)  # hard alpha
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def bbox_crop(im: Image.Image, pad_frac: float = 0.02) -> Image.Image:
    """Crop to non-transparent content (with a small pad), keep square."""
    im = im.convert("RGBA")
    alpha = np.asarray(im)[..., 3]
    ys, xs = np.where(alpha > 24)
    if len(ys) == 0:
        return im
    pad = int(max(im.size) * pad_frac)
    x0, x1 = max(0, xs.min() - pad), min(im.width, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(im.height, ys.max() + 1 + pad)
    return im.crop((x0, y0, x1, y1))


def black_key(im: Image.Image, dist_thresh: float = 30, lum_thresh: float = 22) -> Image.Image:
    """Derive alpha from distance-to-black: a pixel is opaque if it is far enough
    from pure black OR bright enough. Used for raws that ship on a black backdrop
    with NO alpha channel — the durable character anchor raws (512px black-bg RGB)
    and luma FX. Numpy-only (no scipy): a plain threshold, no connected-component
    cleanup, which is all the palette+kcentroid downscale needs to read cleanly."""
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    dist = np.sqrt((a ** 2).sum(-1))
    lum = a @ np.array([0.299, 0.587, 0.114], np.float32)
    mask = (dist > dist_thresh) | (lum > lum_thresh)
    rgba = np.dstack([np.asarray(im.convert("RGB")),
                      np.where(mask, 255, 0).astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")


def corner_bg(im: Image.Image) -> np.ndarray:
    """Median of the four corner pixels — the flat studio backdrop the prompt
    asked for. Sampled rather than assumed: SDXL renders "plain flat white" as a
    slightly warm off-white (~217,215,214), so a hardcoded pure-white key leaves
    a halo."""
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    h, w, _ = a.shape
    return np.median(np.stack([a[3, 3], a[3, w - 4], a[h - 4, 3], a[h - 4, w - 4]]), axis=0)


def flat_key(im: Image.Image, dist_thresh: float = 38) -> Image.Image:
    """Derive alpha from distance to the sampled corner backdrop — the LIGHT-bg
    counterpart to `black_key`.

    Needed whenever the server has no alpha-cut node: the graph's
    `Image Rembg (Remove Background)` lives in a custom pack, so a bare ComfyUI
    returns the raw on its backdrop with no alpha and `bbox_crop` would keep the
    whole frame. On the flat backdrop these prompts produce, a plain distance
    threshold is stable — subject coverage moves <1% between thresh 20 and 60."""
    rgb = np.asarray(im.convert("RGB"))
    dist = np.sqrt(((rgb.astype(np.float32) - corner_bg(im)) ** 2).sum(-1))
    return Image.fromarray(np.dstack([rgb, np.where(dist > dist_thresh, 255, 0).astype(np.uint8)]), "RGBA")


def has_alpha(im: Image.Image) -> bool:
    """True if the image carries a meaningful (non-fully-opaque) alpha channel."""
    if im.mode not in ("RGBA", "LA", "P"):
        return False
    a = np.asarray(im.convert("RGBA"))[..., 3]
    return bool((a < 250).any())


def sprite(src: Image.Image, canvas: int, content: int | None = None,
           anchor: str = "bottom") -> Image.Image:
    """Full sprite post: (background-key if the raw has no alpha) -> bbox ->
    k-centroid to fit `content` px -> palette -> place on a transparent `canvas`
    px square (feet at bottom-center for characters, centered for props/items).

    The durable character anchor raws are 512px RGB on a BLACK backdrop with no
    alpha; without keying, bbox_crop would keep the whole black frame as a box
    (the regression that shipped a black-boxed hero). `has_alpha` routes alpha-cut
    raws (Rembg'd items) straight through and keys only the black-bg ones."""
    content = content or canvas
    if not has_alpha(src):
        # Which backdrop is it on? The durable anchors/FX are black; a raw that
        # skipped the (custom-pack) Rembg node keeps the prompt's light studio
        # backdrop. Keying a light bg with `black_key` would mark the WHOLE
        # frame opaque, so pick by the sampled corner's brightness.
        bg_lum = float(corner_bg(src) @ np.array([0.299, 0.587, 0.114], np.float32))
        src = flat_key(src) if bg_lum > 128 else black_key(src)
    im = bbox_crop(src)
    w, h = im.size
    if w >= h:
        tw, th = content, max(1, round(content * h / w))
    else:
        tw, th = max(1, round(content * w / h)), content
    im = to_palette(kcentroid(im, tw, th))
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    x = (canvas - tw) // 2
    y = canvas - th - 1 if anchor == "bottom" else (canvas - th) // 2
    out.paste(im, (x, max(0, y)))
    return out


def tile(src: Image.Image, px: int = 32) -> Image.Image:
    """Tile post: center-crop square, k-centroid to px, palette. Opaque."""
    im = src.convert("RGB")
    s = min(im.size)
    im = im.crop(((im.width - s) // 2, (im.height - s) // 2,
                  (im.width + s) // 2, (im.height + s) // 2)).convert("RGBA")
    out = to_palette(kcentroid(im, px, px))
    return out.convert("RGB")


def seam_energy(im: Image.Image) -> float:
    """Mean abs RGB difference across the wrap edges — low means it tiles."""
    a = np.asarray(im.convert("RGB"), dtype=np.float32)
    return float(
        np.abs(a[0, :, :] - a[-1, :, :]).mean() + np.abs(a[:, 0, :] - a[:, -1, :]).mean()
    ) / 2


def luma_sprite(src: Image.Image, canvas: int) -> Image.Image:
    """Glow/vfx sprite rendered on black: alpha from brightness, then palette."""
    im = src.convert("RGB")
    arr = np.asarray(im, dtype=np.float32)
    lum = arr @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    # key out any flat non-black backdrop: alpha from distance to the corner
    # color AND brightness (some gens ignore "pure black background")
    corners = np.concatenate([arr[:8, :8].reshape(-1, 3), arr[:8, -8:].reshape(-1, 3),
                              arr[-8:, :8].reshape(-1, 3), arr[-8:, -8:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    dist = np.sqrt(((arr - bg) ** 2).sum(-1))
    a = np.clip(np.minimum(np.clip((lum - 24) * 2.0, 0, 255), dist * 3.0), 0, 255).astype(np.uint8)
    rgba = np.dstack([np.asarray(im), a])
    im = Image.fromarray(rgba, "RGBA")
    im = bbox_crop(im)
    im = kcentroid(im, canvas, canvas)
    # palette-snap but keep soft-ish 4-level alpha for glows
    arr = np.asarray(im, dtype=np.float32).copy()
    px = arr[..., :3].reshape(-1, 3)
    d = ((px[:, None, :] - _PAL[None, :, :]) ** 2).sum(-1)
    arr[..., :3] = _PAL[d.argmin(1)].reshape(arr.shape[:2] + (3,))
    arr[..., 3] = (np.round(arr[..., 3] / 85) * 85).clip(0, 255)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def derive_step(idle: Image.Image) -> Image.Image:
    """Synthesize a mid-stride step frame from a 48px idle sprite: below the
    hip line, shift the left leg-half up/right and the right half down, with a
    1px torso lean. Deterministic, palette-preserving — used for NPCs when GPU
    budget rules out a diffusion sweep per pose (the engine alternates
    idle/step while moving, so a 1-2px gait read is all that's needed)."""
    im = idle.convert("RGBA")
    a = np.asarray(im)
    h, w = a.shape[:2]
    alpha_rows = np.where(a[..., 3].any(axis=1))[0]
    if len(alpha_rows) == 0:
        return im
    top, bottom = alpha_rows[0], alpha_rows[-1]
    hip = top + int((bottom - top) * 0.62)
    out = np.zeros_like(a)
    out[:, :] = a
    legs = a[hip:, :, :]
    out[hip:, :, :] = 0
    mid = w // 2
    # left half: up 1px and 1px inward; right half: down 1px
    out[hip - 1:h - 1, :mid] = np.maximum(out[hip - 1:h - 1, :mid], legs[:h - hip, :mid])
    out[hip + 1:h, mid:] = np.maximum(out[hip + 1:h, mid:], legs[: h - hip - 1, mid:])
    # subtle torso lean: shift rows above hip by 1px toward facing side
    torso = out[top:hip, :, :].copy()
    out[top:hip, 1:, :] = torso[:, : w - 1, :]
    return Image.fromarray(out, "RGBA")


def contact_sheet(images: list[tuple[str, Image.Image]], cols: int = 8,
                  cell: int = 96, scale: int = 1, label: bool = True) -> Image.Image:
    """Grid sheet of (name, image) pairs on a dark checker background."""
    from PIL import ImageDraw
    rows = (len(images) + cols - 1) // cols
    pad, cap = 6, 14 if label else 0
    W, H = cols * (cell + pad) + pad, rows * (cell + cap + pad) + pad
    sheet = Image.new("RGB", (W, H), (24, 26, 30))
    d = ImageDraw.Draw(sheet)
    for idx, (name, im) in enumerate(images):
        cx = pad + (idx % cols) * (cell + pad)
        cy = pad + (idx // cols) * (cell + cap + pad)
        # checkerboard backing so alpha reads
        for j in range(0, cell, 8):
            for i in range(0, cell, 8):
                c = (44, 46, 52) if (i // 8 + j // 8) % 2 else (36, 38, 42)
                d.rectangle((cx + i, cy + j, cx + i + 7, cy + j + 7), fill=c)
        t = im.convert("RGBA")
        f = max(1, min((cell // t.width) * scale if t.width else 1, cell // max(1, t.height)))
        t = t.resize((t.width * f, t.height * f), Image.NEAREST) if f > 1 else t
        if t.width > cell or t.height > cell:
            r = min(cell / t.width, cell / t.height)
            t = t.resize((max(1, int(t.width * r)), max(1, int(t.height * r))), Image.NEAREST)
        sheet.paste(t, (cx + (cell - t.width) // 2, cy + (cell - t.height) // 2), t)
        if label:
            d.text((cx + 2, cy + cell + 1), name[:22], fill=(200, 205, 210))
    return sheet
