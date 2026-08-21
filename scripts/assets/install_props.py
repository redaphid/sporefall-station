#!/usr/bin/env python3
"""Take curated prop generations from exp_props.py into the shipping theme packs.

THE DIVISION OF LABOUR, which is the point of this script:

  DIFFUSION SUPPLIES SHAPE. exp_props.py drops the env IPAdapter anchor and adds
  NEG_GROUND plus named anti-tombstone negatives, and that fixed the silhouettes
  outright -- the barrel is a squat cylinder with a rim and a lid, the locker is
  a tall door with a keypad and hinges. No moss caps, no ground plinths.

  THE RAMP SUPPLIES COLOUR. The new raws came out near-WHITE (the previous set
  was near-grey; the pixel LoRA plus a white backdrop pulls hard in that
  direction, and fighting it with prompt words is a seed lottery). It does not
  matter, and that is not luck: `ramp_grade` keeps only VALUE and throws hue
  away by construction. A clean white-and-grey render has an excellent value
  structure -- lit top, shadowed underside, dark seams -- which is precisely
  what the ramp wants as input. So the model is never asked for colour at all.

That composition is why this is one script and not two: post -> ramp -> palette
-> ink, written to both packs at their respective footprints.

Nothing here picks seeds. `CURATED` is a hand-edited list, chosen off a contact
sheet at game size.

    python install_props.py --dry-run
    python install_props.py
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from PIL import Image

import post as P
from palette_metrics import CAST, band, measure
from restyle import ink_rim, ramp_grade

ROOT = Path(__file__).resolve().parents[2]
GEN = Path("D:/tmp/props-gen")

# subject -> (run tag, seed, destination filename, ramp spec)
#
# Ramps follow restyle_props.py's two rules (>=8 entries so `palette_n` can
# clear the cast floor of 9; span from near #08080c to luma 145+ so
# `value_range` can clear 0.487) and are chosen so a furnished room is told
# apart by hue: warm tan desk, teal cabinet, rust barrel, olive locker.
CURATED: dict[str, dict] = {
    # cargo-crate is new on this branch and is the most-seen prop on a floor
    # (23.0 per floor, ~19% of every prop he looks at), so it leads the list.
    # Hue is picked for room-legibility against the other five: desk warm tan,
    # cabinet teal, barrel rust, locker olive, screen neutral -- so the crate
    # takes a cooler steel-blue, with the prompt's green status light as accent.
    # The ramp's top entry is deliberately NOT near-white. At #dce9f2 with
    # accent_q .985 the crate's lit top face blew out to white speckled with
    # green and read, at 32px, as SNOW or moss sitting on the lid -- the exact
    # look the props were being rescued from. Dropping the top two entries and
    # tightening the accent quantile keeps the green as a status light instead
    # of scatter. Tested on the same raws, no regeneration needed.
    "cargo-crate": dict(
        tag="iter/jugg", seed=7006, dst="cargo-crate.png",
        ramp=["#08080c", "#0f1a26", "#16293d", "#1f3c58", "#2b5375",
              "#3d6f96", "#5b91b5", "#7ea6c2", "#b9d2e2"],
        accent="#46e078", accent_q=0.995,
    ),
    "work-desk": dict(
        tag="j1", seed=7007, dst="work-desk.png",
        ramp=["#08080c", "#141a16", "#2e1e10", "#4a3419", "#6b4d26",
              "#8f6c38", "#b08d50", "#cbb277", "#e0d3ae"],
        accent="#46e078", accent_q=0.995,
    ),
    "supply-cabinet": dict(
        tag="j1", seed=7003, dst="supply-cabinet.png",
        ramp=["#08080c", "#141a16", "#163a3e", "#24565c", "#3a7a80",
              "#5aa4ae", "#7ecbd2", "#a2adb4", "#c6d6d4"],
        accent="#46e078", accent_q=0.995,
    ),
    "spore-barrel": dict(
        tag="j1", seed=7000, dst="spore-barrel.png",
        ramp=["#08080c", "#2e1e10", "#4a3419", "#6b4d26", "#8f6c38",
              "#b08d50", "#cbb277", "#a8c46a", "#e8c95a"],
        accent="#ffd83e", accent_q=0.995,
    ),
    "weapons-locker": dict(
        tag="j1", seed=7004, dst="weapons-locker.png",
        ramp=["#08080c", "#141a16", "#22380f", "#35511a", "#4c6b28",
              "#67873c", "#86a750", "#a8c46a", "#c2b184"],
        accent="#ffd83e", accent_q=0.995,
    ),
    "wall-screen": dict(
        tag="j1", seed=7009, dst="wall-screen.png",
        ramp=["#08080c", "#141a16", "#23282e", "#3c444d", "#59636d",
              "#7b8791", "#a2adb4", "#7ecbd2", "#cfe0e2"],
        accent="#46e078", accent_q=0.995,
    ),
    # The mess chair. THE OWNER PICKED THIS ONE, by tapping "Chair 2 -- chunkiest,
    # tall rounded back, teal frame" in the relay picker on 2026-08-20. It
    # REPLACES the p8 seed 1002 this branch shipped first: that was an agent's
    # curation, this is his, and his wins.
    #
    # Provenance matters here because the picker only ever showed him a 512px
    # PREVIEW with the floor baked in -- no alpha, not a usable source. The four
    # previews were built from the chair-jugg sweep (juggernautXL, seeds
    # 1000-1011, rendered 21:28-21:53Z, ranked in chair-gen-report.md). "Chair 2"
    # is that sweep's rank 1, SEED 1006, recovered by matching the preview back
    # against all twelve candidates on silhouette IoU and per-pixel error, then
    # confirmed by eye: a SOLID rounded-top back panel, which is what rules out
    # the slatted-spindle s01004.
    #
    # Hue is SLATE-TEAL, deliberately duller than supply-cabinet's cyan. The
    # recipe asks for "worn dark teal" seat and "dark gunmetal grey" legs, and
    # those are one hue family apart only in saturation -- so the ramp greys the
    # mid entries rather than pushing a second, competing colour into a room that
    # already has warm tan, cyan, rust, olive, steel-blue and neutral.
    #
    # No accent. Every other prop's accent is a status LIGHT (a powered machine);
    # a chair has no light, and a bright speck on the seat is precisely the
    # "white patch on the seat" defect the p8 negatives were written to kill.
    "mess-chair": dict(
        tag="chair-jugg", seed=1006, dst="chair.png",
        # A first, greyer cut of this ramp measured chroma_p90 exactly 70 -- the
        # cast floor, with zero margin, and the weakest in the pack (every other
        # prop scores 84-96). Deepening the mid entries instead of brightening
        # them buys 84 while keeping mean luminance down.
        ramp=["#08080c", "#0e181c", "#153035", "#1c4750", "#245f6b",
              "#2f7d8b", "#4a9dab", "#83b8bf", "#bcd4d8"],
        # Seed 1006 has a slightly narrower value histogram than the p8 render
        # this replaced, so at the 32px footprint one ramp level collapsed into
        # its neighbour and `palette_n` came in at 8 against the cast floor of 9.
        # Spreading the histogram a little further across the SAME ramp buys the
        # 9th level back (measured: 8 -> 9) and leaves chroma, value_range and the
        # hue untouched. Deliberately 0.90, not 1.0: full equalisation also lifts
        # the hi-res value_range to 0.676 and starts washing the seat pad out.
        equalize=0.90,
    ),
    # --- sporeforge "blocky" sweep, 88 renders on juggernautXL -------------
    # Six interior furnishings that until now drew as procedural silhouettes.
    # Each pick is the highest-scoring ACCEPT for its prop in
    # _scratch/sporeforge/props-candidates.json.
    #
    # HUE, and why these reuse families rather than inventing new ones: the
    # locked palette (scripts/assets/palette.py) has exactly four ramp families
    # -- warm tan, teal, olive-green and neutral steel -- plus single-colour
    # accents. There is no violet or indigo RAMP, only the boss's #a05ae0, so a
    # ramp written in a hue the palette does not carry snaps to grey and the
    # sprite lands under the cast's chroma floor. (Measured: an indigo bunk ramp
    # scored sat_frac 0.000, chroma 40.) Reuse across families is already the
    # pack's norm -- crate and screen are both neutral, cabinet and chair both
    # teal, desk and barrel both warm -- and silhouette, not hue, is what tells
    # a furnished room apart. Every ramp below is built from EXACT palette
    # entries in ascending luminance, which is what keeps palette_n >= 9.
    # DELIBERATE DEVIATION from the highest-scoring accept. shelf-s01000 scores
    # 0.991 (vs 0.976 here) and is the only shelf with a 3-vote VLM read, but it
    # is a THIN five-tier rack: at 32px it reads as a faint wireframe, and at the
    # 64px footprint it fails three of the four cast floors under any ramp
    # (sat_frac 0.001-0.048, chroma_p90 12-18, value_range 0.348-0.373 vs a 0.487
    # floor) because there is not enough solid material left to carry a value
    # structure. s01202 is the sweep's "chunkiest shelf, three thick teal slabs
    # on dark posts" and clears all four floors at BOTH footprints. Chunk beats
    # score at 32px.
    "storage-rack": dict(
        tag="blocky", subject="shelf-v3", seed=1202, dst="storage-rack.png",
        ramp=["#08080c", "#141a16", "#1c1420", "#163a3e", "#24565c",
              "#3a7a80", "#5aa4ae", "#d8a878", "#7ecbd2"],
        accent="#46e078", accent_q=0.995,
    ),
    "crew-bunk": dict(
        tag="blocky", subject="bunk", seed=1007, dst="crew-bunk.png",
        # The raw is a tan mattress in a dark teal frame, so the ramp puts teal
        # in the shadows and warm tan in the lit half -- the frame reads cool,
        # the bedding reads warm, off one monotonic value ramp.
        # The two top entries are what carry value_range over the cast floor:
        # ending the ramp at #cbb277 measured 0.474 against a 0.487 floor.
        ramp=["#08080c", "#1c1420", "#2e1e10", "#163a3e", "#24565c",
              "#6b4d26", "#8f6c38", "#b08d50", "#d8a878", "#a6ffbe"],
    ),
    "mess-bench": dict(
        tag="blocky", subject="bench", seed=1009, dst="mess-bench.png",
        # Tan plank on chunky teal end blocks (the raw's own description).
        ramp=["#08080c", "#141a16", "#2e1e10", "#24565c", "#6b4d26",
              "#8f6c38", "#b08d50", "#d8a878", "#cbb277"],
    ),
    # Came out of a SHELF sweep and was relabelled a table on inspection; the
    # 3-vote qwen3-vl read answered "table" unprompted, which is why the
    # relabel is trusted. Deeper than mess-bench so the two read as a mess-hall
    # SET without being the same swatch.
    "mess-table": dict(
        tag="blocky", subject="shelf-v3", seed=1201, dst="mess-table.png",
        ramp=["#08080c", "#141a16", "#1c1420", "#2e1e10", "#4a3419",
              "#6b4d26", "#8f6c38", "#b08d50", "#cbb277"],
    ),
    # DELIBERATE DEVIATION, small: plant-v2-s01105 scores marginally higher
    # (0.943 vs 0.937) but its blades are narrow and its planter face is broken
    # up; s01107 has broad, well-separated blades that survive the downscale, is
    # the sweep note's own "BEST plant", and holds more value_range at 32px
    # (0.662 vs 0.623). Judged at game size, as the brief asks.
    "bio-planter": dict(
        tag="blocky", subject="plant-v2", seed=1107, dst="bio-planter.png",
        # Olive-green foliage over the planter, with the uiAccent green as the
        # blade highlight rather than a machine's status LED.
        ramp=["#08080c", "#141a16", "#22380f", "#35511a", "#4c6b28",
              "#67873c", "#86a750", "#a8c46a", "#cbb277"],
        accent="#46e078", accent_q=0.99,
    ),
    # The raw has a tan shell with teal ribs and twin glowing slit vents; the
    # accent quantile lands on the vents, which is the one accent in the pack
    # that is an organism's glow and not a powered machine's status light.
    "spore-node": dict(
        tag="blocky", subject="sporeNode", seed=1007, dst="spore-node.png",
        # Tan shell rather than teal, so the node does not read as another
        # storage-rack; the glowing vent survives as a green slit.
        ramp=["#08080c", "#141a16", "#1c1420", "#2e1e10", "#163a3e",
              "#6b4d26", "#8f6c38", "#b08d50", "#cbb277", "#a6ffbe"],
        accent="#46e078", accent_q=0.995,
    ),
}

# (theme, canvas px, content px, ink the rim) -- props bake to TILE_PX 32
# logical; the hi-res pack authors at 2x and is the one that carries the cast's
# 1px ink line (see restyle.ink_rim).
TARGETS = [("swampspace", 32, 30, False), ("swampspace-hires", 64, 60, True)]


def build(name: str, spec: dict, px: int, content: int, ink: bool) -> Image.Image:
    """Raw -> keyed -> shadow-stripped -> ramped -> k-centroid -> palette -> ink.

    The ramp goes in BEFORE the downscale, exactly as restyle.build does, so it
    grades a full-resolution value field rather than a handful of surviving
    quantized levels. restyle_props.py had to work the other way round (no raws
    existed) and paid for it with a `palette_n` regression; these have raws.
    """
    # `subject` names the RAW sweep directory when it differs from the CURATED
    # key. The blocky sweep's dirs are sweep names ("shelf-v3", "plant-v2"),
    # not sprite names, and one of them (shelf-v3 seed 1201) produced the
    # curated TABLE. Without this the key would have to be the sweep name and
    # the table entry would read as a shelf.
    src = GEN / spec["tag"] / spec.get("subject", name) / f"seed{spec['seed']:05d}.png"
    if not src.exists():
        raise SystemExit(f"missing raw: {src}")
    im = Image.open(src)

    if not P.has_alpha(im):
        bg_lum = float(P.corner_bg(im) @ [0.299, 0.587, 0.114])
        im = P.flat_key(im) if bg_lum > 128 else P.black_key(im)
    im, _ = P.strip_ground_shadow(im)
    im = P.bbox_crop(im)

    im = ramp_grade(im, spec["ramp"], spec.get("accent"),
                    spec.get("accent_q", 0.98), spec.get("equalize", 0.85))

    w, h = im.size
    if w >= h:
        tw, th = content, max(1, round(content * h / w))
    else:
        tw, th = max(1, round(content * w / h)), content
    im = P.to_palette(P.kcentroid(im, tw, th))

    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(im, ((px - tw) // 2, max(0, px - th - 1)))
    return ink_rim(out) if ink else out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", action="append")
    args = ap.parse_args()

    names = args.only or list(CURATED)
    root = ROOT / "public" / "themes" / "swampspace" / "chars"
    b = band({n: measure(root / f"{n}.png") for n in CAST})
    tmp = ROOT / ".install-props-tmp.png"

    for theme, px, content, ink in TARGETS:
        outdir = ROOT / "public" / "themes" / theme / "props"
        print(f"\n{'(dry) ' if args.dry_run else ''}{theme}")
        print(f"  {'sprite':<20}{'sat_frac':>10}{'chroma_p90':>12}{'value_range':>13}{'palette_n':>11}   vs cast floor")
        for name in names:
            spec = CURATED[name]
            im = build(name, spec, px, content, ink)
            im.save(tmp)
            m = measure(tmp)
            flags = [k for k in ("sat_frac", "chroma_p90", "value_range", "palette_n")
                     if m[k] < b[k]["min"]]
            print(f"  {spec['dst']:<20}{m['sat_frac']:>10.3f}{m['chroma_p90']:>12.0f}"
                  f"{m['value_range']:>13.3f}{m['palette_n']:>11d}   "
                  + (("UNDER: " + ", ".join(flags)) if flags else "all clear"))
            if not args.dry_run:
                im.save(outdir / spec["dst"])
        print(f"  cast floors: sat {b['sat_frac']['min']:.3f}  chroma {b['chroma_p90']['min']:.0f}"
              f"  value {b['value_range']['min']:.3f}  palette_n {b['palette_n']['min']}")

    tmp.unlink(missing_ok=True)
    if not args.dry_run:
        # Keep the chosen raws next to the other curated sources so a future
        # restyle pass has a full-resolution input instead of a shipped PNG.
        raws = Path(__file__).resolve().parent / "raws"
        for name in names:
            spec = CURATED[name]
            src = GEN / spec["tag"] / spec.get("subject", name) / f"seed{spec['seed']:05d}.png"
            shutil.copy2(src, raws / f"prop.{Path(spec['dst']).stem}.png")
        print(f"\n  archived {len(names)} raws into scripts/assets/raws/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
