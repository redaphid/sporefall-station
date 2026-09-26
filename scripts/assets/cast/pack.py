"""Atlas rows -> theme-pack character frames, and the manifest keys for them.

CPU only, WSL python3. Ported from the frog run's pack_frog.py, whose 100 shipped PNGs
this reproduces byte for byte: one bbox per row (a shared scale and framing, so the
height does not pump between frames), backdrop-white specks inpainted, the pack's
locked palette (post.to_palette), feet one pixel above the canvas floor.

The manifest update is surgical. A full manifest.py regeneration would drop keys it
does not know about (the stair tiles, the hi-res pack's own pools), so this only sets
the char.<arch>.* keys that manifest.char_keys() derives from the files on disk, keeps
every other key and the file's own formatting, and leaves a manifest that is already
right byte-identical.
"""
import io
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ASSETS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(ASSETS))
THEMES = os.path.join(REPO, "public", "themes")
sys.path.insert(0, ASSETS)
import manifest as M  # noqa: E402
import post as P  # noqa: E402

RESAMPLE = {"nearest": Image.NEAREST, "lanczos": Image.LANCZOS}


def despeck_white(a, lo=225, spread=14):
    """Backdrop white that survived the matte (250,249,248 and friends): neutral, very
    bright, and not a colour a character is expected to have. Inpaint from the nearest
    good pixel rather than punching a hole in the figure. Returns (array, pixels fixed)."""
    rgb = a[:, :, :3].astype(np.int16)
    op = a[:, :, 3] > 0
    bad = op & (rgb.min(axis=2) >= lo) & ((rgb.max(axis=2) - rgb.min(axis=2)) <= spread)
    if not bad.any():
        return a, 0
    good = op & ~bad
    idx = ndimage.distance_transform_edt(~good, return_distances=False, return_indices=True)
    out = a.copy()
    out[:, :, :3][bad] = a[:, :, :3][idx[0][bad], idx[1][bad]]
    return out, int(bad.sum())


def row_frames(atlas_png, px, content, resample, cells=8, despeck=None):
    """The atlas row's cells as px x px pack frames. Returns (frames, white px fixed)."""
    im = Image.open(atlas_png).convert("RGBA")
    w = im.size[0] // cells
    arrs = [np.array(im.crop((i * w, 0, (i + 1) * w, im.size[1]))) for i in range(cells)]
    fixed = [despeck_white(a, **(despeck or {})) for a in arrs]
    killed = sum(k for _, k in fixed)
    arrs = [a for a, _ in fixed]
    # ONE bbox for the whole row: shared scale, shared horizontal framing.
    op = np.zeros(arrs[0].shape[:2], bool)
    for a in arrs:
        op |= a[:, :, 3] > 8
    ys, xs = np.nonzero(op)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    h, w = y1 - y0, x1 - x0
    s = content / max(h, w)
    tw, th = max(1, round(w * s)), max(1, round(h * s))
    out = []
    for a in arrs:
        crop = Image.fromarray(a).crop((int(x0), int(y0), int(x1), int(y1)))
        crop = P.to_palette(crop.resize((tw, th), RESAMPLE[resample]))
        cv = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        cv.paste(crop, ((px - tw) // 2, px - th - 1))
        out.append(cv)
    return out, killed


def encode(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def pack_files(recipe, atlas_dir, dirs):
    """{pack: {chars/<file>.png: bytes}} for every direction, plus a per-row report."""
    char, ex = recipe["char"], recipe["export"]
    files, report = {}, {}
    for spec in ex["packs"]:
        pack = files.setdefault(spec["pack"], {})
        for d in dirs:
            frames, killed = row_frames(os.path.join(atlas_dir, f"{d}.png"), spec["px"], spec["content"],
                                        spec["resample"], despeck=ex.get("despeck"))
            blobs = [encode(f) for f in frames]
            for i, b in enumerate(blobs):
                pack[f"chars/{char}-{d}-walk-{i}.png"] = b
            pack[f"chars/{char}-{d}-idle.png"] = blobs[ex["idle"]]
            pack[f"chars/{char}-{d}-step.png"] = blobs[ex["step"]]
            report[f"{spec['pack']}/{d}"] = {"white_px_inpainted": killed, "files": len(blobs) + 2}
    return files, report


def archetypes(char):
    """The archetypes whose manifest keys point at this character's art (manifest.CHAR_FILES)."""
    arches = [a for a, k in M.CHAR_FILES.items() if k == char]
    if not arches:
        raise SystemExit(f"{char}: no archetype in manifest.CHAR_FILES maps to it. Add it to "
                         "generate.CHARS (and NAMES) first, or the manifests cannot name it.")
    return arches


def merge_keys(sprites, want, prefixes, has):
    """Set `want` inside `sprites` without disturbing anything else.

    Present keys keep their position (value updated if it differs); a missing key goes
    right after the key that precedes it in `want`; a key under one of `prefixes` that
    `want` does not list is dropped only when its file is gone. Returns (new, changes)."""
    items = list(sprites.items())
    pos = {k: i for i, (k, _) in enumerate(items)}
    changes = []
    for k, v in want.items():
        if k in pos and items[pos[k]][1] != v:
            changes.append(f"~ {k}: {items[pos[k]][1]} -> {v}")
            items[pos[k]] = (k, v)
    order = list(want)
    for i, k in enumerate(order):
        if k in pos:
            continue
        prev = next((p for p in reversed(order[:i]) if p in pos), None)
        if prev is None:
            same = [j for j, (kk, _) in enumerate(items) if kk.startswith(prefixes)]
            at = same[-1] + 1 if same else len(items)
        else:
            at = pos[prev] + 1
        items.insert(at, (k, want[k]))
        pos = {kk: j for j, (kk, _) in enumerate(items)}
        changes.append(f"+ {k}: {want[k]}")
    kept = []
    for k, v in items:
        if k.startswith(prefixes) and k not in want and isinstance(v, str) and not has(v):
            changes.append(f"- {k}: {v} (file gone)")
            continue
        kept.append((k, v))
    return dict(kept), changes


def dump_like(text, obj):
    """Serialise obj in the formatting `text` already uses, or refuse: rewriting a
    manifest in another indent would bury a two-key change in a whole-file diff."""
    old = json.loads(text)
    for indent in (1, 2, 4):
        for ascii_ in (True, False):
            s = json.dumps(old, indent=indent, ensure_ascii=ascii_)
            for tail in ("\n", ""):
                if s + tail == text:
                    return json.dumps(obj, indent=indent, ensure_ascii=ascii_) + tail
    raise SystemExit("manifest formatting not recognised (not a plain json.dump); refusing to rewrite it")


def manifest_update(pack, char, new_files):
    """(new manifest text or None if unchanged, changes) for one pack after `new_files`
    (pack-relative paths) exist."""
    pack_dir = os.path.join(THEMES, pack)
    mpath = os.path.join(pack_dir, "manifest.json")
    text = open(mpath, encoding="utf-8").read()
    man = json.loads(text)

    def has(rel):
        return rel in new_files or os.path.exists(os.path.join(pack_dir, rel))

    want = {}
    arches = archetypes(char)
    for arch in arches:
        want.update(M.char_keys(arch, char, has))
    sprites, changes = merge_keys(man["sprites"], want, tuple(f"char.{a}." for a in arches), has)
    man["sprites"] = sprites
    for arch in arches:
        if arch in M.NAMES and arch not in man.setdefault("names", {}):
            man["names"][arch] = M.NAMES[arch]
            changes.append(f"+ names.{arch}: {M.NAMES[arch]}")
    if not changes:
        return None, []
    return dump_like(text, man), changes
