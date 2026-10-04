#!/usr/bin/env python3
"""Indoor kit: tiles, doors and props for the indoor complex floors (3+) of swampspace-hires.

The complex floors drew the first biome's wall, floor, wooden door and prop art.
This kit generates their own set on the local ComfyUI and ships it under the
indoor skin keys that src/render/indoorSkin.ts resolves.

    sweep <job>... [--seeds=N] [--base=S]   candidates -> $SWAMPSPACE_STAGE/indoor-kit/<job>/
    gate <job>...                           post + harness + VLM -> <job>/gate.json
    sheet [job...]                          contact sheet of every candidate, rejects included
    pick <job> <seed>...                    curate: raw -> raws/indoor/, recorded in indoor-kit.json
    ship                                    post every pick into the theme with its flow embedded

Every raw comes back from ComfyUI with its graph embedded (`prompt` + `workflow`).
`ship` writes those two chunks into each shipped PNG, byte for byte the files in
flows/indoor/<job>{,_api}.json, which src/render/themeIndoorFlows.test.ts checks.

Gates, in order (docs/sprite-generation.md 5/5b; metrics first, VLM second):
  harness  tiles: opaque, luminance inside the surface's value band, wrap seam
           energy for seamless surfaces. props/doors: the consistency.py
           silhouette metrics against the first-biome prop the skin replaces
           (feet on the canvas floor, centred, height and mass in its envelope),
           plus the palette_metrics cast floor.
  VLM      verify.check (not a figure; floors read top-down), the subject the
           VLM names must be one of the job's accepted words, and the
           verify.check_style read against the pack's own art.
"""
import json
import os
import shutil
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import comfy  # noqa: E402
import comfy_ui  # noqa: E402
import post as P  # noqa: E402
import tiles_indoor as TI  # noqa: E402
from consistency import metrics  # noqa: E402
from palette_metrics import CAST, band as cast_band, failures as cast_failures, measure  # noqa: E402
from restyle import ink_rim, ramp_grade  # noqa: E402

REPO = HERE.parents[1]
THEME = REPO / "public" / "themes" / "swampspace-hires"
STAGE = Path(os.environ.get("SWAMPSPACE_STAGE", "/tmp/swampspace-stage")) / "indoor-kit"
RAWS = HERE / "raws" / "indoor"
FLOWS = HERE / "flows" / "indoor"
CURATION = HERE / "indoor-kit.json"
OLLAMA = os.environ.setdefault("OLLAMA", "http://127.0.0.1:18436")

PX = 64  # hi-res pack: 32 px logical tile at artScale 2

TILE_CKPT = "SDXL1.0\\juggernautXL_ragnarokBy.safetensors"
PROP_CKPT = "SDXL1.0\\juggernautXL_juggXIByRundiffusion.safetensors"
PROP_LORA = "pixel_art_style_by_skormino_v7.05_test_72img.safetensors"
TRIGGER = "masterpiece, pixpix, 8-bit, pixel_art"

INDOOR_LOOK = ("16-bit era pixel art game texture, crisp chunky pixels, bold dark outlines, "
               "derelict abandoned space station interior, dark gunmetal grey and deep teal riveted metal, "
               "grime and rust stains, faint glowing green spore fungus in the cracks, moody dim lighting")
PROP_LOOK = ("16-bit era palette, bold dark outlines, chunky readable shapes, "
             "worn dark gunmetal and teal painted sci-fi metal, scuffed paint, grimy panel seams, "
             "bioluminescent green indicator lights, moody")
BG_TILE = ("flat texture swatch filling the whole frame edge to edge, no horizon, no sky, "
           "no perspective, no border, no vignette")
BG_OBJ = "single isolated game object centered on plain flat white background"
NEG_BASE = ("photorealistic, 3d render, smooth gradient, soft shading, text, watermark, signature, "
            "blurry, jpeg artifacts, bright cheerful, pastel, sprite sheet, grid of images, multiple views, "
            "duplicate, two copies, several objects side by side")
NEG_FIGURE = ("person, humanoid, figure, character, creature, monster, face, head, arms, legs, hands, "
              "body, portrait")
NEG_OUTDOOR = ("grass, lawn, leaves, jungle, trees, wood planks, wooden floor, dirt, soil, mud, sand, "
               "stone, cobblestone, brick, sky, clouds, horizon")
NEG_TILE = f"{NEG_FIGURE}, {NEG_OUTDOOR}, perspective, isometric, vanishing point, room, furniture, {NEG_BASE}"
NEG_GROUND = ("ground, floor plane, terrain, base, pedestal, plinth, drop shadow, shadow ellipse, "
              "contact shadow, puddle, reflection, standing water")
NEG_WRONG_READ = ("gravestone, tombstone, headstone, monolith, boulder, rock, mossy rock, shrub, bush, "
                  "tree, potted plant, planter, mushroom, organic blob, overgrown, covered in moss")
NEG_PROP = f"{NEG_FIGURE}, {NEG_BASE}, {NEG_GROUND}, {NEG_WRONG_READ}"

# Value plan (mean luminance), slotted between the existing indoor bands in
# tiles_indoor.BAND (hull 22, grate 40, bog 58, hall 62, plating 72, tiled 112)
# and the first biome's wall 30 / floor 82.
BAND = {"deck": 76.0, "bulkhead": 30.0, "pillar": 46.0, "stair_up": 92.0, "stair_down": 44.0,
        "door": 78.0}


@dataclass(frozen=True)
class Job:
    kind: str  # floor | wall | tile | door | prop
    subject: str
    neg: str = ""
    seamless: bool = False
    ref: str | None = None  # "env" or a job whose first pick anchors style (IPAdapter)
    ref_weight: float = 0.5
    init: str | None = None  # a job whose first pick seeds img2img
    denoise: float = 1.0
    accept: tuple[str, ...] = ()
    replaces: str | None = None  # props: first-biome prop whose footprint the skin must keep
    ramp: tuple[str, ...] = ()
    accent: str | None = None
    out: tuple[str, ...] = field(default_factory=tuple)


JOBS: dict[str, Job] = {
    # The hero: every other tile and the doors take its pick as their style anchor.
    "deck": Job(
        "floor",
        "seamless top-down texture of a derelict space station corridor floor, large square riveted "
        "steel deck plates with dark recessed seams, scuffed worn gunmetal and teal paint, grime, "
        "small patches of glowing green spore fungus creeping out of the seams, seen from directly above",
        seamless=True, ref="env", ref_weight=0.35,
        accept=("floor", "deck", "plate", "plating", "metal", "panel", "tile", "texture", "grate", "steel")),
    "deck-accent": Job(
        "floor",
        "top-down texture of a cracked station deck plate split open with a cluster of glowing green "
        "spore pods and pale fungus bursting through the crack, riveted steel plates around it, "
        "seen from directly above",
        init="deck", denoise=0.78,
        accept=("floor", "deck", "plate", "metal", "fungus", "spore", "crack", "texture", "panel",
                "mushroom", "mold", "growth", "tile")),
    "bulkhead": Job(
        "wall",
        "seamless texture of the top of a thick dark armored steel bulkhead wall, heavy riveted armor "
        "plates with deep recessed seams, bundled cable conduits and pipes running across, very dark "
        "gunmetal with teal edge highlights, grime, a few faint glowing green spores in the cracks, "
        "seen from directly above",
        seamless=True, ref="deck",
        accept=("wall", "metal", "plate", "panel", "texture", "bulkhead", "pipe", "pipes", "steel",
                "machinery", "floor", "grate", "armor", "hull")),
    "pillar": Job(
        "tile",
        # Round, not square: the first sweep's square capital read as a door 2 of 6 times,
        # and a pillar a player mistakes for a hatch is a gameplay bug.
        "top-down view looking straight down onto the round top of one thick cylindrical steel "
        "support column, a circular capital ring of heavy bolts around a central hub, thick pipes and "
        "conduits hugging its sides, dark gunmetal with teal trim, glowing green spore fungus crusted "
        "on one side, on a dark steel deck, the column fills most of the frame",
        ref="deck",
        accept=("pillar", "column", "plate", "metal", "panel", "hatch", "square", "box", "tile",
                "lid", "block", "steel", "vent", "cover")),
    "stair_up": Job(
        "tile",
        "top-down view of a narrow steel staircase climbing up toward the top of the image, evenly "
        "spaced horizontal metal step treads with yellow and black hazard stripes on each nosing, solid "
        "side rails down the left and right edges, the top step ends at a dark landing, seen from "
        "directly above, fills the whole frame",
        ref="deck",
        accept=("stairs", "staircase", "stair", "steps", "ladder", "escalator", "grate", "vent",
                "metal")),
    "stair_down": Job(
        "tile",
        "top-down view of a narrow steel staircase descending down into a dark shaft, the treads get "
        "darker and fade into shadow toward the top of the image, yellow and black hazard stripes on "
        "each nosing, solid side rails down the left and right edges, seen from directly above",
        init="stair_up", denoise=0.5,
        accept=("stairs", "staircase", "stair", "steps", "ladder", "escalator", "grate", "vent",
                "metal")),
    "door": Job(
        "door",
        "top-down view of a closed square sci-fi blast door hatch, a heavy steel slab split down the "
        "middle into two sliding halves, yellow and black hazard chevron stripes along both edges, "
        "a small glowing green status light, dark gunmetal and teal metal, rivets, grime, the hatch "
        "fills the whole frame, seen from directly above",
        ref="deck",
        accept=("door", "hatch", "blast door", "gate", "panel", "airlock", "vent", "metal")),
    "door-locked": Job(
        "door",
        "top-down view of a sealed square sci-fi blast door hatch, a heavy steel slab split down the "
        "middle, red and black hazard stripes, a glowing red warning light, a thick red locking bar "
        "clamped across the middle seam, dark gunmetal metal, rivets, fills the whole frame",
        init="door", denoise=0.5,
        accept=("door", "hatch", "blast door", "gate", "panel", "airlock", "vent", "metal")),
    # Props: shape from diffusion, colour from the ramp (install_props.py's division of labour).
    "generator": Job(
        "prop",
        "a squat boxy industrial fuel cell generator, a chunky rectangular machine block with deep "
        "cooling fins down both sides, a round glowing green power core window on the front face, "
        "thick cables coiling out of its base, hazard stripes on the lower edge, sitting squarely flat, "
        "slightly wider than tall",
        neg="screen, monitor, television, computer, tv, display, arcade cabinet",
        replaces="cryo-terminal",
        ramp=("#08080c", "#141a16", "#23282e", "#3c444d", "#163a3e", "#24565c", "#3a7a80",
              "#59636d", "#7b8791", "#a2adb4"),
        accent="#46e078",
        accept=("generator", "machine", "engine", "reactor", "power", "device", "battery", "box",
                "console", "unit", "furnace", "pump", "heater", "cell")),
    "coolant-tank": Job(
        "prop",
        "a squat sealed cylindrical coolant tank standing upright on its flat circular end with a "
        "visible elliptical rim, a pressure gauge dial and a valve wheel on the lid, two reinforcing "
        "metal bands around the cylinder, a vertical frosted glass sight strip, roughly as wide as it "
        "is tall",
        neg="barrel of wood, wooden barrel, keg, tree, planter, pot, tall, narrow",
        replaces="spore-barrel",
        ramp=("#08080c", "#141a16", "#163a3e", "#24565c", "#3a7a80", "#59636d", "#5aa4ae",
              "#7ecbd2", "#a2adb4"),
        accent="#46e078",
        accept=("tank", "canister", "barrel", "cylinder", "container", "drum", "keg", "boiler",
                "pressure", "can", "vessel")),
    "cryo-bunk": Job(
        "prop",
        "a sci-fi cryo sleep pod bunk, a low long rectangular capsule bed with a frosted glass canopy "
        "over the mattress, a chunky metal frame, a small control panel at the head end, wider than tall",
        neg="coffin, casket, sarcophagus, wooden bed, blanket, pillow, person sleeping",
        replaces="crew-bunk",
        ramp=("#08080c", "#141a16", "#163a3e", "#24565c", "#3a7a80", "#5aa4ae", "#7ecbd2",
              "#a2adb4", "#bcc5c8"),
        accent="#46e078",
        accept=("pod", "bed", "bunk", "capsule", "cryo", "chamber", "stretcher", "cot", "tank",
                "machine", "bench", "container")),
    "freight-case": Job(
        "prop",
        "a heavy armored freight case, a closed rectangular metal shipping box with thick reinforced "
        "corners, two big latches on the front face, a hazard stripe band across the front, a "
        "stencilled cargo code, a small amber status light, a flat lid, roughly 6 wide by 5 tall",
        neg="dome, rounded top, barrel, cylinder, open lid, wooden crate, planks, tall, narrow",
        replaces="cargo-crate",
        ramp=("#08080c", "#0f1a26", "#16293d", "#1f3c58", "#2b5375", "#3d6f96", "#5b91b5",
              "#7ea6c2", "#b9d2e2"),
        accent="#ffd83e",
        accept=("crate", "case", "box", "container", "chest", "trunk", "toolbox", "cargo", "locker",
                "suitcase")),
    "parts-rack": Job(
        "prop",
        "a sturdy free-standing steel parts rack, an open shelving unit with three thick metal shelves "
        "holding boxed spare parts and coiled cables, four chunky square corner posts, a little glowing "
        "green spore fungus growing on the bottom shelf, taller than wide",
        neg="bookshelf, books, wooden shelf, cabinet doors, closed cabinet, ladder",
        replaces="storage-rack",
        ramp=("#08080c", "#141a16", "#23282e", "#2e343b", "#3c444d", "#59636d", "#7b8791",
              "#a2adb4", "#d8a878"),
        accent="#46e078",
        accept=("shelf", "rack", "shelving", "shelves", "cabinet", "storage", "unit", "cart",
                "trolley", "bookcase")),
}

# What the VLM calls the shipped indoor surfaces (hall, plating, tiled read 'wall' / 'tile'),
# so a surface that reads the same way is not a wrong read. Measured with the calibration
# run over the shipped tiles; 'container', 'building', 'character' stay rejections.
SURFACE_WORDS = ("tile", "grid", "pattern", "wall", "floor", "panel", "texture", "metal", "plate")

# Style anchor PAIRS. One qwen3-vl style read is noisy: against the Genesis floor/wall
# pair it failed the shipped street tile, and against the flat indoor hall/plating pair
# it fails anything with glow. A candidate passes when it matches the pack's style
# against either pair (calibrated on shipped art outside both pairs).
STYLE_REFS = {"prop": (("chars/vine-ranger-s-idle.png", "props/spore-barrel.png"),
                       ("props/cargo-crate.png", "props/storage-rack.png")),
              "tile": (("tiles/floor-0.png", "tiles/wall-0.png"),
                       ("tiles/hall-0.png", "tiles/plating-0.png"))}


# ---------------------------------------------------------------------------
# Generation


def _layout(api):
    """Editor positions: column per graph depth, so the flow opens readable."""
    depth = {}

    def d(nid):
        if nid not in depth:
            ups = [v[0] for v in api[nid]["inputs"].values() if isinstance(v, list) and len(v) == 2]
            depth[nid] = 1 + max((d(u) for u in ups), default=-1)
        return depth[nid]

    rows = {}
    pos = {}
    for nid in api:
        c = d(nid)
        pos[nid] = (40 + c * 360, 40 + rows.get(c, 0) * 260)
        rows[c] = rows.get(c, 0) + 1
    return pos


_SPECS = None


def to_workflow(api, note):
    global _SPECS
    if _SPECS is None:
        _SPECS = comfy_ui.fetch_specs(comfy.HOST)
    return comfy_ui.to_workflow(api, _layout(api), notes=[((40, -260), (520, 200), note)], specs=_SPECS)


def load_curation():
    return json.loads(CURATION.read_text()) if CURATION.exists() else {}


def first_pick_raw(job):
    picks = load_curation().get(job, {}).get("seeds")
    if not picks:
        raise SystemExit(f"pick {job} first: it anchors or seeds another job")
    return str(RAWS / f"{job}-s{picks[0]}.png")


def graph_for(name, seed):
    j = JOBS[name]
    if j.kind == "prop":
        comfy.LORA, comfy.LORA_W = PROP_LORA, 1.0
        pos = (f"{TRIGGER}, {j.subject}, {BG_OBJ}, nothing underneath it, no shadow and no floor, "
               f"object fills at least 80% of the frame height, tightly cropped, centered, upright, "
               f"slight high three-quarter game angle, {PROP_LOOK}")
        neg = f"{NEG_PROP}, {j.neg}" if j.neg else NEG_PROP
        kw = dict(ckpt=PROP_CKPT, cfg=7.0, size=768, alpha=True)
    else:
        comfy.LORA = ""  # tiles: Ragnarok without the pixel LoRA; k-centroid + palette is the pixel step
        pos = f"{j.subject}, {BG_TILE if j.kind in ('floor', 'wall') else 'top-down game tile'}, {INDOOR_LOOK}"
        neg = f"{NEG_TILE}, {j.neg}" if j.neg else NEG_TILE
        kw = dict(ckpt=TILE_CKPT, cfg=5.0, size=1024, alpha=False)
    refs = None
    if j.ref == "env":
        refs = [str(HERE / "anchors" / "env-b.png")]
    elif j.ref:
        refs = [first_pick_raw(j.ref)]
    init = first_pick_raw(j.init) if j.init else None
    return comfy.build_graph(pos=pos, neg=neg, seed=seed, seamless=j.seamless, refs=refs,
                             ip_weight=j.ref_weight, init=init, denoise=j.denoise,
                             prefix=f"indoor-kit/{name}-s{seed}", **kw)


def sweep(names, seeds=6, base=1000):
    for name in names:
        dest = STAGE / name / "raw"
        for s in range(base, base + seeds):
            if list(dest.glob(f"*-s{s}_*.png")):
                continue
            g = graph_for(name, s)
            wf = to_workflow(g, f"Sporefall Station indoor kit: {name}, seed {s}.\n"
                                f"scripts/assets/indoor_kit.py sweep {name}")
            comfy.run(g, str(dest), workflow=wf)
            print(f"{name}: seed {s} -> {dest}", flush=True)


def raws_of(name):
    out = {}
    for p in sorted((STAGE / name / "raw").glob("*.png")):
        seed = int(p.name.split("-s")[-1].split("_")[0])
        out[seed] = p
    return out


# ---------------------------------------------------------------------------
# Post: raw -> the files it ships as. Returns {theme-relative path: image}.


def _band(img, surface, ref=None):
    t = BAND[surface]
    m = TI.lum(img if ref is None else ref)
    ratio = (t + 12.75) / (m + 12.75)
    a = np.clip(np.asarray(img, np.float32) * np.clip(ratio, 0.5, 2.2), 0, 255)
    return TI.snap(a)


# Colours per tile. The shipped hi-res surfaces use 7-12 (floor 9, wall 8, grass 12,
# hall 8); the first deck sweep posted at 17-23 and every VLM style read called it
# "high-resolution, smooth shading" against them. Fewer, flatter colours is the pixel look.
MAX_COLOURS = 10


def _limit(a, k=MAX_COLOURS):
    q = Image.fromarray(np.asarray(a, np.uint8), "RGB").quantize(k, Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    return TI.snap(np.asarray(q.convert("RGB"), np.float32))


def _tile(raw, surface, res=PX, seamless=False):
    im = Image.open(raw).convert("RGB")
    small = TI.seamless_kcentroid(im, res) if seamless else np.asarray(P.kcentroid(im, res, res).convert("RGB"))
    return _limit(_band(TI.despeckle(small, passes=2).astype(np.float32), surface))


def bulkhead_caps(body):
    """Cap strip + inner nub derived from a bulkhead body: its top rows lifted
    onto the lit-steel ramp, over the 1 px ink shadow line wallCaps expects."""
    k = 7
    a = np.asarray(body.convert("RGB"), np.float32)[:k - 1]
    lit = np.array([TI.C[c] for c in ("steel2", "steel25", "steel3", "steel35", "teal3")], np.float32)
    luma = a @ np.array([0.299, 0.587, 0.114], np.float32)
    t = np.clip((luma - luma.min()) / (np.ptp(luma) + 1e-3), 0, 1)
    rgb = lit[np.round(t * (len(lit) - 1)).astype(int)]
    cap = np.zeros((PX, PX, 4), np.uint8)
    cap[:k - 1, :, :3] = rgb
    cap[k - 1, :, :3] = TI.C["black"]
    cap[:k, :, 3] = 255
    inner = np.zeros_like(cap)
    inner[:k, :k] = cap[:k, :k]
    return Image.fromarray(cap, "RGBA"), Image.fromarray(inner, "RGBA")


def prop_sprite(raw, j, content=60):
    im = Image.open(raw)
    if not P.has_alpha(im):
        bg = float(P.corner_bg(im) @ [0.299, 0.587, 0.114])
        im = P.flat_key(im) if bg > 128 else P.black_key(im)
    im, _ = P.strip_ground_shadow(im)
    im = P.bbox_crop(im)
    im = ramp_grade(im, list(j.ramp), j.accent, 0.995, 0.85)
    w, h = im.size
    tw, th = (content, max(1, round(content * h / w))) if w >= h else (max(1, round(content * w / h)), content)
    im = P.to_palette(P.kcentroid(im, tw, th))
    out = Image.new("RGBA", (PX, PX), (0, 0, 0, 0))
    out.paste(im, ((PX - tw) // 2, max(0, PX - th - 1)))
    return ink_rim(out)


def post_candidate(name, raw, index=0):
    """One raw -> {relative path: image}. `index` numbers variant files for pools."""
    j = JOBS[name]
    if name == "deck":  # macro-2 master: one 128 px wrap, sliced into four 64 px tiles
        m = _tile(raw, "deck", res=2 * PX, seamless=True)
        return {f"tiles/deck-{4 * index + q}.png": Image.fromarray(
            m[(q // 2) * PX:(q // 2 + 1) * PX, (q % 2) * PX:(q % 2 + 1) * PX], "RGB") for q in range(4)}
    if name == "deck-accent":
        base = _tile(first_pick_raw("deck"), "deck", res=PX)
        a = _tile(raw, "deck", res=PX)
        return {f"tiles/deck-accent-{index}.png": Image.fromarray(
            _limit(TI._seat(a.astype(np.float32), base.astype(np.float32))), "RGB")}
    if name == "bulkhead":
        body = Image.fromarray(_tile(raw, "bulkhead", seamless=True), "RGB")
        out = {f"tiles/bulkhead-{index}.png": body}
        if index == 0:
            cap, inner = bulkhead_caps(body)
            out["tiles/bulkhead-cap.png"] = cap
            out["tiles/bulkhead-cap-inner.png"] = inner
        return out
    if j.kind == "tile":
        return {f"tiles/{name}-{index}.png": Image.fromarray(_tile(raw, name), "RGB")}
    if name == "door":
        closed = Image.fromarray(_tile(raw, "door"), "RGB").convert("RGBA")
        # Open: the slabs have slid into the frame, leaving the hatch's outer ring.
        # A ring reads open on both door axes (doors never rotate; a west-jamb slab
        # lay across half the doorways).
        ring = 6
        slab = np.asarray(closed).copy()
        slab[ring:PX - ring, ring:PX - ring, 3] = 0
        slab[ring - 1, ring - 1:PX - ring + 1, :3] = TI.C["black"]
        slab[PX - ring, ring - 1:PX - ring + 1, :3] = TI.C["black"]
        slab[ring - 1:PX - ring + 1, ring - 1, :3] = TI.C["black"]
        slab[ring - 1:PX - ring + 1, PX - ring, :3] = TI.C["black"]
        return {"props/bulkhead-door.png": closed,
                "props/bulkhead-door-open.png": Image.fromarray(slab, "RGBA")}
    if name == "door-locked":
        return {"props/bulkhead-door-locked.png": Image.fromarray(_tile(raw, "door"), "RGB").convert("RGBA")}
    return {f"props/{name}.png": prop_sprite(raw, j)}


# ---------------------------------------------------------------------------
# Gates


def harness(name, files):
    """Deterministic checks. Returns a list of problems."""
    j = JOBS[name]
    probs = []
    for rel, im in files.items():
        a = np.asarray(im.convert("RGBA"))
        if j.kind in ("floor", "wall", "tile") or rel.endswith(("bulkhead-door.png", "door-locked.png")):
            if rel.endswith(("-cap.png", "-cap-inner.png")):
                continue
            if (a[..., 3] < 255).any():
                probs.append(f"{rel}: not opaque")
            surface = "door" if j.kind == "door" else name.replace("-accent", "")
            m, t = TI.lum(a[..., :3]), BAND[surface]
            if abs(m - t) > 0.25 * t + 6:
                probs.append(f"{rel}: luminance {m:.0f} outside band {t:.0f}")
            n = len(np.unique(a[..., :3].reshape(-1, 3), axis=0))
            if n > MAX_COLOURS + 2:
                probs.append(f"{rel}: {n} colours > {MAX_COLOURS + 2}")
            if TI.detail_energy(a[..., :3]) < 4:
                probs.append(f"{rel}: flat (detail {TI.detail_energy(a[..., :3]):.1f})")
        if j.seamless and name != "deck" and not rel.endswith(("-cap.png", "-cap-inner.png")):
            e = P.seam_energy(im)
            if e > 30:
                probs.append(f"{rel}: wrap seam energy {e:.1f} > 30")
    if name == "deck":  # the master wraps; its slices meet each other by construction
        tiles = [np.asarray(files[k]) for k in sorted(files)]
        master = np.vstack([np.hstack(tiles[:2]), np.hstack(tiles[2:])])
        e = P.seam_energy(Image.fromarray(master))
        if e > 30:
            probs.append(f"deck master wrap seam energy {e:.1f} > 30")
    if j.kind == "prop":
        rel, im = next(iter(files.items()))
        tmp = STAGE / name / "_m.png"
        im.save(tmp)
        got, ref = metrics(str(tmp)), metrics(str(THEME / "props" / f"{j.replaces}.png"))
        if got["foot_y"] < PX - 4:
            probs.append(f"feet at row {got['foot_y']}, not on the canvas floor")
        if abs(got["cx"]) > 4:
            probs.append(f"off-centre cx {got['cx']}")
        if got["height"] < 0.6 * ref["height"]:
            probs.append(f"height {got['height']} < 0.6 x {j.replaces} {ref['height']}")
        if not 0.55 * ref["mass"] <= got["mass"] <= 1.6 * ref["mass"]:
            probs.append(f"mass {got['mass']} outside 0.55-1.6 x {j.replaces} {ref['mass']}")
        fl = cast_failures(measure(tmp), CAST_BAND)
        if fl:
            probs.append(f"under the cast floor: {', '.join(fl)}")
    return probs


CAST_BAND = None


def field(name, files):
    """What the VLM judges: a surface as the floor shows it (its wrap tiled 3x3,
    the deck's 2x2 master included), a single feature tile or sprite as is."""
    j = JOBS[name]
    if name == "deck":
        q = [files[k] for k in sorted(files)]
        unit = Image.new("RGB", (2 * PX, 2 * PX))
        for k, t in enumerate(q):
            unit.paste(t, ((k % 2) * PX, (k // 2) * PX))
    elif j.kind in ("floor", "wall"):
        unit = next(iter(files.values())).convert("RGB")
    else:
        return next(iter(files.values()))
    n = 3 if unit.width == PX else 2
    out = Image.new("RGB", (unit.width * n, unit.height * n))
    for y in range(n):
        for x in range(n):
            out.paste(unit, (x * unit.width, y * unit.height))
    return out


def vlm(name, files):
    import verify as V
    j = JOBS[name]
    probs = []
    cat = "prop" if j.kind in ("prop", "door") else "tile"
    rel, im = next(iter(files.items()))
    tmp = STAGE / name / "_v.png"
    shown = field(name, files).resize((PX * 6, PX * 6), Image.NEAREST)
    shown.save(tmp)
    path = f"tiles/deck-{name}.png" if j.kind == "floor" else rel
    vote, p = V.check(str(tmp), {"cat": cat, "path": path})
    probs += p
    subject = str(vote.get("subject", "?")).lower()
    accept = j.accept + (SURFACE_WORDS if j.kind in ("floor", "wall") else ())
    if not any(w in subject for w in accept):
        probs.append(f"VLM reads it as {subject!r}")
    reasons = []
    for pair in STYLE_REFS[cat]:
        refs = []
        for r in pair:  # anchors shown exactly the way the candidate is
            a = Image.open(THEME / r)
            ref_field = field("bulkhead", {r: a.convert("RGB")}) if cat == "tile" else a
            rp = STAGE / name / f"_ref-{Path(r).stem}.png"
            ref_field.resize((PX * 6, PX * 6), Image.NEAREST).save(rp)
            refs.append(str(rp))
        sv, sp = V.check_style(str(tmp), refs)
        if not sp:
            break
        reasons.append(sv.get("reason", ""))
    else:
        probs.append(f"style (both anchor pairs): {reasons[0]}")
    return subject, probs


def gate(names):
    global CAST_BAND
    CAST_BAND = cast_band({n: measure(REPO / "public/themes/swampspace/chars" / f"{n}.png") for n in CAST})
    for name in names:
        out = {}
        for seed, raw in raws_of(name).items():
            files = post_candidate(name, raw)
            cdir = STAGE / name / "post" / str(seed)
            shutil.rmtree(cdir, ignore_errors=True)
            cdir.mkdir(parents=True)
            for k, (rel, im) in enumerate(files.items()):  # numbered: the sheet shows file 00
                im.save(cdir / f"{k:02d}-{Path(rel).name}")
            probs = harness(name, files)
            subject, vp = vlm(name, files)
            probs += vp
            out[seed] = {"pass": not probs, "subject": subject, "problems": probs}
            print(f"{name} s{seed}: {'PASS' if not probs else 'REJECT'} {subject!r} {probs}", flush=True)
        (STAGE / name / "gate.json").write_text(json.dumps(out, indent=1))


# ---------------------------------------------------------------------------
# Curate + ship


def pick(name, seeds):
    gate_ = json.loads((STAGE / name / "gate.json").read_text())
    RAWS.mkdir(parents=True, exist_ok=True)
    cur = load_curation()
    for s in seeds:
        if not gate_.get(str(s), {}).get("pass"):
            raise SystemExit(f"{name} s{s} did not pass the gate: {gate_.get(str(s))}")
        shutil.copy2(raws_of(name)[s], RAWS / f"{name}-s{s}.png")
    cur[name] = {"seeds": seeds, "raws": [f"raws/indoor/{name}-s{s}.png" for s in seeds]}
    CURATION.write_text(json.dumps(cur, indent=1) + "\n")
    print(f"picked {name}: {seeds}")


def png_text(path):
    b = Path(path).read_bytes()
    out, i = {}, 8
    while i + 8 <= len(b):
        n = int.from_bytes(b[i:i + 4], "big")
        if b[i + 4:i + 8] == b"tEXt":
            k, _, v = b[i + 8:i + 8 + n].partition(b"\0")
            out[k.decode("latin1")] = v
        i += 12 + n
    return out


def _chunk(key, text):
    data = key + b"\0" + text
    return len(data).to_bytes(4, "big") + b"tEXt" + data + zlib.crc32(b"tEXt" + data).to_bytes(4, "big")


def embed(path, prompt, workflow):
    """tEXt prompt + workflow right after IHDR, every other chunk kept (cast_walk.py embed)."""
    png = Path(path).read_bytes()
    chunks, i = [], 8
    while i < len(png):
        end = i + 12 + int.from_bytes(png[i:i + 4], "big")
        if png[i + 4:i + 8] not in (b"tEXt", b"iTXt", b"zTXt"):
            chunks.append(png[i:end])
        i = end
    Path(path).write_bytes(png[:8] + chunks[0] + _chunk(b"prompt", prompt) + _chunk(b"workflow", workflow)
                           + b"".join(chunks[1:]))


def ship():
    cur = load_curation()
    FLOWS.mkdir(parents=True, exist_ok=True)
    shipped = {}
    for name in JOBS:
        if name not in cur:
            print(f"SKIP {name}: no pick")
            continue
        for index, seed in enumerate(cur[name]["seeds"]):
            raw = RAWS / f"{name}-s{seed}.png"
            text = png_text(raw)
            flow = f"{name}-s{seed}"
            prompt = json.dumps(json.loads(text["prompt"]), separators=(",", ":")).encode()
            workflow = json.dumps(json.loads(text["workflow"]), separators=(",", ":")).encode()
            (FLOWS / f"{flow}_api.json").write_bytes(prompt)
            (FLOWS / f"{flow}.json").write_bytes(workflow)
            for rel, im in post_candidate(name, raw, index).items():
                dst = THEME / rel
                im.save(dst, optimize=True)
                embed(dst, prompt, workflow)
                shipped[rel] = flow
    (FLOWS / "shipped.json").write_text(json.dumps(dict(sorted(shipped.items())), indent=1) + "\n")
    print(f"shipped {len(shipped)} files, flows in {FLOWS.relative_to(REPO)}")


# ---------------------------------------------------------------------------
# Contact sheet


def sheet(names, out):
    rows = []
    for name in names:
        g = STAGE / name / "gate.json"
        if not g.exists():
            continue
        verdicts = json.loads(g.read_text())
        picks = set(load_curation().get(name, {}).get("seeds", []))
        cells = []
        for seed, v in sorted(verdicts.items(), key=lambda kv: int(kv[0])):
            files = sorted((STAGE / name / "post" / seed).glob("*.png"))
            im = Image.open(files[0]).convert("RGBA")
            if name == "deck":
                q = [Image.open(f).convert("RGBA") for f in files[:4]]
                im = Image.new("RGBA", (2 * PX, 2 * PX))
                for k, t in enumerate(q):
                    im.paste(t, ((k % 2) * PX, (k // 2) * PX))
            cells.append((int(seed), v, im))
        rows.append((name, cells, picks))
    cw, lab = 2 * PX * 2 // 2 + 2 * PX, 54
    width = 150 + max(len(c) for _, c, _ in rows) * (cw + 8)
    height = sum(cw + lab + 10 for _ in rows) + 40
    sh = Image.new("RGB", (width, height), (24, 26, 30))
    d = ImageDraw.Draw(sh)
    d.text((8, 8), "Indoor kit sweep: every candidate, 4x pixels (deck: its 2x2 master at 2x). GREEN = shipped pick, "
                   "WHITE = passed the gates, RED = rejected (first reason below).", fill=(230, 230, 230))
    y = 40
    for name, cells, picks in rows:
        npass = sum(1 for _, v, _ in cells if v["pass"])
        d.text((8, y + 10), f"{name}\n{npass}/{len(cells)} pass", fill=(230, 230, 230))
        for k, (seed, v, im) in enumerate(cells):
            x = 150 + k * (cw + 8)
            bg = Image.new("RGBA", (cw, cw), (60, 64, 70, 255))
            scale = cw // max(im.size)
            big = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
            bg.alpha_composite(big, ((cw - big.width) // 2, (cw - big.height) // 2))
            sh.paste(bg.convert("RGB"), (x, y))
            col = (70, 220, 110) if seed in picks else (235, 235, 235) if v["pass"] else (230, 80, 70)
            d.rectangle([x - 2, y - 2, x + cw + 1, y + cw + 1], outline=col, width=2)
            why = "PICK" if seed in picks else "pass" if v["pass"] else v["problems"][0]
            d.text((x, y + cw + 4), f"s{seed} {why}"[:30], fill=col)
            d.text((x, y + cw + 18), f"{why[30:60]}", fill=col)
            d.text((x, y + cw + 32), f"vlm: {v['subject']}"[:30], fill=(160, 160, 170))
        y += cw + lab + 10
    sh.save(out)
    print(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opt = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    if not args:
        raise SystemExit(__doc__)
    verb, rest = args[0], args[1:]
    if verb == "sweep":
        sweep(rest, int(opt.get("seeds", 6)), int(opt.get("base", 1000)))
    elif verb == "gate":
        gate(rest)
    elif verb == "sheet":
        sheet(rest or list(JOBS), opt.get("out", str(STAGE / "contact.png")))
    elif verb == "raws":  # the raw renders themselves, 256 px each, for judging the prompt
        for name in rest:
            fs = list(raws_of(name).items())
            im = Image.new("RGB", (len(fs) * 260, 280), (24, 26, 30))
            for i, (seed, f) in enumerate(fs):
                im.paste(Image.open(f).convert("RGB").resize((256, 256)), (i * 260, 0))
                ImageDraw.Draw(im).text((i * 260 + 4, 262), f"s{seed}", fill=(230, 230, 230))
            im.save(STAGE / f"{name}-raws.png")
            print(STAGE / f"{name}-raws.png")
    elif verb == "pick":
        pick(rest[0], [int(s) for s in rest[1:]])
    elif verb == "ship":
        ship()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
