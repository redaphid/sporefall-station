#!/usr/bin/env python3
"""Regenerate the props that a colour ramp provably cannot fix.

THE DIAGNOSIS THIS HARNESS IS BUILT ON (measured, not guessed):

Every shipped prop reads as a grey mossy tombstone, and the props are the only
asset category in generate.py with BOTH of these:

  1. `refs="env"` (generate.py:399). The env anchors are anchors/env-a.png --
     a barrel with a moss cap sitting in a puddle of grass -- and env-b.png, an
     olive deck-plate texture. Look at env-a and then at the six shipped props:
     the moss cap and the ground puddle are env-a's, transferred wholesale by
     IPAdapter onto every prop regardless of what the prompt asked for. The very
     next comment in generate.py (line 400) says items were exempted from these
     anchors because they "turned every weapon into a mushroom". The items were
     rescued; the props never were. **So: refs=None here.**

  2. No `NEG_GROUND`. Props are negatived with `NEG_FIGURE, NEG_BASE` only.
     NEG_GROUND exists (generate.py:121-126) precisely to stop "a painted dirt
     mound / cast shadow" the background key "welds into the alpha as a grey
     SLAB under the sprite", and its own comment says it is applied to every
     ground creature. Never to props. Every prop carries that slab, and the
     slab is what makes an upright box read as a headstone on a grave.
     **So: NEG_GROUND here, plus explicit anti-tombstone negatives.**

THE PROMPT RECIPE is the stalker's, which is the one archetype in the pack that
never drifted: state the silhouette as EXPLICIT GEOMETRY with proportions, then
negative the wrong reading BY NAME. "Grey tombstone" is a nameable wrong
reading, so this fits the problem almost exactly. Each subject below therefore
says how many sides/edges/panels it has and how tall it is relative to its
width, and every subject shares NEG_WRONG_READ.

Deliberately NOT reached for: an IPAdapter reference. art-loop established
tonight that the prompt is the lever and the anchor is not, and here the anchor
is the documented cause of the defect.

Outputs land OUTSIDE the repo (D:/tmp/props-gen/<tag>/). Nothing ships from
here automatically -- curation is manual, via a contact sheet at game size.

  python exp_props.py --list
  python exp_props.py --tag g1 --subjects desk,barrel --seeds 4
  python exp_props.py --tag g1 --post          # post + contact sheet only
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import comfy  # noqa: E402
import post as P  # noqa: E402
from PIL import Image  # noqa: E402

OUT = Path(os.environ.get("EXP_OUT", "D:/tmp/props-gen"))

TRIGGER = "masterpiece, pixpix, 8-bit, pixel_art"
LOOK = ("16-bit era palette, bold dark outlines, chunky readable shapes, "
        "tan and teal sci-fi metal, bioluminescent green accents, moody")
BG_OBJ = ("single isolated game object centered on plain flat white background, "
          "object fills the frame, nothing underneath it")

NEG_BASE = ("photorealistic, 3d render, smooth gradient, soft shading, text, watermark, "
            "signature, blurry, jpeg artifacts, bright cheerful, pastel, "
            "sprite sheet, grid, multiple views, turnaround, duplicate, two copies, "
            "several objects side by side, faded ghost copy")
NEG_FIGURE = ("person, humanoid, figure, character, creature, monster, face, head, "
              "arms, legs, hands, body, standing figure, portrait")
# The slab under the sprite. Same list generate.py applies to every ground
# creature and never applied to a prop.
NEG_GROUND = ("ground, dirt patch, mound, terrain, soil, grass, rocks, base, pedestal, "
              "plinth, cast shadow on the ground, diorama, puddle, sand, gravel")
# The wrong reading, named. This is the half the stalker recipe proved matters:
# it is not enough to describe a locker, you must forbid the tombstone.
NEG_WRONG_READ = ("gravestone, tombstone, headstone, grave marker, monolith, standing stone, "
                  "menhir, cairn, boulder, rock, stone, mossy rock, moss ball, mound of moss, "
                  "shrub, bush, mushroom, organic blob, lump, weathered stone, "
                  "moss cap, overgrown, covered in moss, vines, foliage on top, cemetery")

# subject -> (manifest filename, explicit geometry, extra negatives)
#
# Ranked by measured encounter rate over 1000 generated floors (200 seeds x
# floors 1-5): desk 13.3/floor, cabinet 11.7, barrel 8.2, tv 4.4, locker 3.3.
# Together 41 of the ~51 PNG props a player meets per floor.
SUBJECTS: dict[str, tuple[str, str, str]] = {
    "work-desk": (
        "props/work-desk.png",
        "a low wide sci-fi office work desk, a flat rectangular horizontal desktop surface "
        "supported on two solid side panels, a keyboard and a small dark angled monitor "
        "sitting ON TOP of the desktop, a drawer unit under one end, "
        "WIDE horizontal silhouette twice as wide as it is tall, low to the floor, "
        "roughly 8 wide by 4 tall",
        "tall, upright slab, vertical, narrow, cabinet, tower, obelisk, pillar, column",
    ),
    "supply-cabinet": (
        "props/supply-cabinet.png",
        "a tall narrow sci-fi supply cabinet, a rectangular metal cupboard with TWO hinged "
        "doors meeting at a vertical seam down the middle, a horizontal handle bar on each "
        "door, louvred vent slots near the top, four short feet lifting it off the floor, "
        "flat square top, sharp square corners, roughly 4 wide by 6 tall",
        "rounded top, dome, arch, curved top, screen, window, glass front, "
        "extremely tall, thin, sliver, pole",
    ),
    # Proportion is stated as a ratio and negatived from the other side, because
    # the first pass ("straight vertical sides", no ratio) produced a 1:3 tall
    # canister -- correct geometry, wrong object, and a 10px sliver once posted
    # to the 32px prop footprint.
    "spore-barrel": (
        "props/spore-barrel.png",
        "a SQUAT cylindrical oil drum barrel standing upright on its flat circular end, "
        "clearly a CYLINDER with a visible round elliptical rim at the top, two raised "
        "horizontal ribs banding around the middle, a single yellow hazard warning stripe, "
        "tan and teal metal, flat circular lid with a bung cap, "
        "chunky and stout, only slightly taller than it is wide, roughly 4 wide by 5 tall",
        "dome, hemisphere, egg, sphere, round top, tapered, cone, sack, pot, vase, "
        "tall, narrow, thin, slender, pillar, column, canister, tube, rocket, pipe",
    ),
    "wall-screen": (
        "props/wall-screen.png",
        "a wall-mounted sci-fi flat panel display screen, a thin rectangular monitor in a "
        "slim bezel showing glowing green readout glyphs, mounted flush on a bracket, "
        "a bundle of cables trailing from one bottom corner, "
        "flat and thin, wider than it is tall, no stand, no plinth, roughly 7 wide by 5 tall",
        "stubby stand, pedestal base, on a post, thick body, box, crt, deep cabinet, "
        "tall, narrow, tower",
    ),
    "weapons-locker": (
        "props/weapons-locker.png",
        "a tall rectangular steel weapons locker, one full-height vertical door with a "
        "recessed handle and a small keypad panel, three horizontal louvred vent slits at "
        "eye height, a stencilled yellow number on the door, riveted edges, "
        "flat square top, hard square corners, like a school locker, roughly 4 wide by 7 tall",
        "rounded top, arch, dome, screen, glass, vending machine, shelves, window, "
        "sliver, pole, obelisk",
    ),
}


def spec(name: str) -> dict:
    path, geom, extra = SUBJECTS[name]
    return dict(
        path=path,
        pos=f"{TRIGGER}, {geom}, {BG_OBJ}, upright, slight high three-quarter game angle, {LOOK}",
        neg=f"{NEG_FIGURE}, {NEG_BASE}, {NEG_GROUND}, {NEG_WRONG_READ}, {extra}",
    )


def generate(names: list[str], tag: str, seeds: int, base_seed: int) -> None:
    for name in names:
        s = spec(name)
        dest = OUT / tag / name
        dest.mkdir(parents=True, exist_ok=True)
        for i in range(seeds):
            seed = base_seed + i
            # refs deliberately omitted -- see module docstring.
            g = comfy.build_graph(pos=s["pos"], neg=s["neg"], seed=seed, batch=1,
                                  prefix=f"prop-{name}")
            print(f"  {name} seed {seed} ...", flush=True)
            try:
                got = comfy.run(g, str(dest))
                for p in got:
                    os.replace(p, dest / f"seed{seed:05d}.png")
            except Exception as e:  # keep sweeping; one bad seed is not a run
                print(f"    FAILED seed {seed}: {str(e)[:300]}", flush=True)


def post_all(tag: str, px: int = 64, content: int = 60) -> None:
    """Post every raw to the hi-res prop footprint and write a review sheet."""
    root = OUT / tag
    for sub in sorted(p for p in root.iterdir() if p.is_dir()):
        for raw in sorted(sub.glob("seed*.png")):
            if raw.name.endswith(".post.png"):
                continue
            im = Image.open(raw)
            if not P.has_alpha(im):
                bg = float((P.corner_bg(im) * [0.299, 0.587, 0.114]).sum())
                im = P.flat_key(im) if bg > 128 else P.black_key(im)
            im, _ = P.strip_ground_shadow(im)
            out = P.sprite(im, px, content)
            out.save(raw.with_suffix(".post.png"))
        print(f"  posted {sub.name}")


def sheet(tag: str, raws: bool = False) -> None:
    """Contact sheet for a run.

    Two modes, and the SECOND is the one that decides anything. `--raws` shows
    the 1024px generations, which is only useful for spotting a gross prompt
    failure. The default shows the POSTED sprite on the floor tint at true game
    size beside the cast -- the props are 32 logical px (TILE_PX) against the
    cast's 48 (CHAR_PX), and every previous review of this art was done at a
    size and on a background the player never sees.
    """
    from PIL import ImageDraw, ImageFont

    root = OUT / tag
    subs = sorted(p for p in root.iterdir() if p.is_dir())

    def fnt(s: int):
        try:
            return ImageFont.truetype("C:/Windows/Fonts/consola.ttf", s)
        except OSError:
            return ImageFont.load_default()

    if raws:
        S, pad, ncol = 256, 12, 3
        w = pad * 2 + ncol * (S + 8)
        h = 40 + len(subs) * (S + 24)
        sh = Image.new("RGBA", (w, h), (24, 26, 32, 255))
        d = ImageDraw.Draw(sh)
        d.text((pad, 10), f"exp_props {tag} — RAW generations", font=fnt(17), fill=(230, 233, 240))
        y = 36
        for sub in subs:
            for i, f in enumerate(sorted(p for p in sub.glob("seed*.png")
                                         if not p.name.endswith(".post.png"))[:ncol]):
                sh.paste(Image.open(f).convert("RGB").resize((S, S), Image.LANCZOS),
                         (pad + i * (S + 8), y))
            d.text((pad, y + S + 4), sub.name, font=fnt(13), fill=(160, 166, 178))
            y += S + 24
        dst = root / f"{tag}-raws.png"
    else:
        Z, pad = 5, 12
        S = 32 * Z                      # true prop footprint, zoomed
        C = 48 * Z                      # true cast footprint, same zoom
        cast_dir = ROOT_REPO / "public/themes/swampspace/chars"
        cast = ["vine-ranger-s-idle", "frog-settler-s-idle", "derelict-bot-s-idle"]
        ncol = 4
        w = pad * 2 + max(ncol * (S + 8), len(cast) * (C + 8))
        h = 46 + len(subs) * (S + 22) + C + 26
        sh = Image.new("RGBA", (w, h), (24, 26, 32, 255))
        d = ImageDraw.Draw(sh)
        d.text((pad, 8), f"exp_props {tag} — POSTED, true game size on floor tint",
               font=fnt(17), fill=(230, 233, 240))
        d.text((pad, 28), f"prop 32px vs cast 48px logical, both at {Z}x — real relative scale",
               font=fnt(11), fill=(140, 146, 158))
        y = 46
        for sub in subs:
            for i, f in enumerate(sorted(sub.glob("*.post.png"))[:ncol]):
                x = pad + i * (S + 8)
                d.rectangle([x, y, x + S, y + S], fill=(99, 82, 63))
                sh.alpha_composite(Image.open(f).convert("RGBA").resize((S, S), Image.NEAREST), (x, y))
            d.text((pad + ncol * (S + 8) + 6, y + S // 2 - 6), sub.name, font=fnt(13), fill=(160, 166, 178))
            y += S + 22
        d.text((pad, y), "the cast, same zoom:", font=fnt(12), fill=(140, 146, 158))
        y += 18
        for i, c in enumerate(cast):
            p = cast_dir / f"{c}.png"
            if p.exists():
                sh.alpha_composite(Image.open(p).convert("RGBA").resize((C, C), Image.NEAREST),
                                   (pad + i * (C + 8), y))
        dst = root / f"{tag}-game-size.png"

    sh.convert("RGB").save(dst)
    print(f"  wrote {dst}")


ROOT_REPO = Path(__file__).resolve().parents[2]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="g1")
    ap.add_argument("--subjects", default=",".join(SUBJECTS))
    ap.add_argument("--seeds", type=int, default=4)
    ap.add_argument("--base-seed", type=int, default=1000)
    ap.add_argument("--post", action="store_true", help="post existing raws only")
    ap.add_argument("--sheet", action="store_true", help="contact sheets only")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    if a.sheet:
        sheet(a.tag, raws=True)
        sheet(a.tag)
        return 0

    if a.list:
        for n in SUBJECTS:
            print(f"\n== {n} ==\nPOS: {spec(n)['pos']}\nNEG: {spec(n)['neg']}")
        return 0

    names = [n.strip() for n in a.subjects.split(",") if n.strip()]
    unknown = [n for n in names if n not in SUBJECTS]
    if unknown:
        print(f"unknown subject(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    if not a.post:
        generate(names, a.tag, a.seeds, a.base_seed)
    post_all(a.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
