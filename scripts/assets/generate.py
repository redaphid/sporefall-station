#!/usr/bin/env python3
"""Swampspace theme pack generator — "Sporefall Station".

An alien bog overtaking a derelict space station: mangrove roots through deck
plating, bioluminescent spore drones for cops, phosphorescent water, star-glass
bulkheads. Art direction: Flashback (Amiga 1992) Titan-jungle palette/mood —
teal mist, olive overgrowth swallowing tan/gray tech, sparse hot accents.
(Inspiration only: prompts + a derived color palette; no Flashback art is used
as a generation input or reproduced.)

Recipe (researched + calibrated):
  * SDXL AnythingXL + skormino pixel-art LoRA (Illustrious/SDXL — the LoRA is
    NOT SD1.5; triggers "masterpiece, pixpix, 8-bit, pixel_art", CFG 3.5, euler)
  * IPAdapterAdvanced "style transfer" anchoring: ENVIRONMENT anchors for
    props/items, each character's curated s-idle for its other 9 poses
  * tiles: half-offset + img2img heal pass -> seamless by construction
  * post: k-centroid downscale -> locked 34-color palette (no dither)
  * gate: qwen3-vl verifier (verify.py) + human curation of seed sweeps

Usage:
  python3 generate.py --list
  python3 generate.py sweep <job>... [--seeds N]   # raw sweep into staging
  python3 generate.py curate <job> <file> [--seed N --index I --batch B --note "..."]
                                                   # APPROVE a pick: copy it into
                                                   # the durable raws/ dir + record it
  python3 generate.py final <job>...               # post curated raw -> theme dir
  python3 generate.py final --all                  # rebuild the whole pack
  python3 generate.py final <job> --allow-regen    # re-roll a lost pick (drifts!)
Staging (raw sweeps, NOT committed): $SWAMPSPACE_STAGE or scratchpad/stage.
Curated picks are recorded in curation.json ({job: {seed, index, batch, raw}});
`raw` is a path RELATIVE to scripts/assets (durable) — approve with `curate`.
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

REPO = os.path.dirname(os.path.dirname(HERE))
THEME = os.path.join(REPO, "public", "themes", "swampspace")
STAGE = os.environ.get(
    "SWAMPSPACE_STAGE",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), "swampspace-stage"),
)
CURATION = os.path.join(HERE, "curation.json")
ANCHORS = os.path.join(HERE, "anchors")  # curated RAW picks used as IPAdapter refs
# Durable, COMMITTED home for every curated sweep raw. The original pack recorded
# raws only by their ephemeral $STAGE (/tmp) path; those paths died with the
# session and a same-seed regen no longer reproduces the approved pick (the
# ComfyUI graph/prompts drift over time). Curated raws now live here and are
# committed, so `final` always reproduces the exact approved pixels. Paths in
# curation.json are stored RELATIVE to this file (e.g. "raws/item.spore-pistol.png")
# so they survive machine/user/tmp churn. See docs/sprite-generation.md §2b.
RAWS = os.path.join(HERE, "raws")


def resolve_raw(name, pick):
    """Resolve a curated pick's raw source file, DURABLE-first. Returns an
    existing path or None. Order:
      1. `pick['raw']` — relative paths resolve against this dir (durable);
         absolute paths are honored only if they still exist (legacy /tmp);
      2. `raws/<job>.png` — the durable committed copy;
      3. `anchors/<kind>-<dir>-<frame>.png` — for character jobs, the curated
         s-idle anchor that survived the /tmp loss.
    """
    cands = []
    raw = (pick or {}).get("raw")
    if raw:
        cands.append(raw if os.path.isabs(raw) else os.path.join(HERE, raw))
    cands.append(os.path.join(RAWS, name + ".png"))
    if name.startswith("char."):
        parts = name.split(".")  # char.<kind>.<dir>-<frame>
        if len(parts) == 3:
            cands.append(os.path.join(ANCHORS, f"{parts[1]}-{parts[2]}.png"))
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


def persist_raw(name, srcfile, seed=None, index=0, batch=None, note=None,
                size=None, ckpt=None):
    """Copy a chosen sweep candidate into the durable RAWS dir and record the
    pick in curation.json with a RELATIVE raw path. This is the one true way to
    approve a pick so it reproduces forever — never point curation.json at a
    $STAGE/tmp path again."""
    os.makedirs(RAWS, exist_ok=True)
    dst = os.path.join(RAWS, name + ".png")
    shutil.copyfile(srcfile, dst)
    cur = json.load(open(CURATION)) if os.path.exists(CURATION) else {}
    e = cur.get(name, {})
    if seed is not None:
        e["seed"] = seed
    e["index"] = index
    if batch is not None:
        e["batch"] = batch
    e["raw"] = os.path.relpath(dst, HERE)  # "raws/<job>.png" — portable
    if size is not None:
        e["size"] = size
    if ckpt is not None:
        e["ckpt"] = ckpt
    if note is not None:
        e["note"] = note
    cur[name] = e
    json.dump(cur, open(CURATION, "w"), indent=1)
    print(f"curated {name} -> {os.path.relpath(dst, REPO)}")
    return dst

TRIGGER = "masterpiece, pixpix, 8-bit, pixel_art"
LOOK = ("16-bit era palette, bold dark outlines, chunky readable shapes, "
        "dark teal alien jungle overgrowing tan sci-fi metal, olive moss, "
        "bioluminescent green accents, moody")
NEG_BASE = ("photorealistic, 3d render, smooth gradient, soft shading, text, watermark, "
            "signature, blurry, jpeg artifacts, bright cheerful, pastel, "
            "sprite sheet, grid, multiple views, turnaround, duplicate, two copies, "
            "several objects side by side, faded ghost copy")
NEG_FIGURE = ("person, humanoid, figure, character, creature, monster, face, head, "
              "arms, legs, hands, body, standing figure, portrait, silhouette of a person")
BG_OBJ = "single isolated game object centered on plain flat white background"
BG_CHAR = "single character centered on plain flat white background, full body, feet on the ground"
BG_TILE = ("flat texture swatch filling the whole frame edge to edge, no horizon, no sky, "
           "no perspective, no border, no vignette")
BG_FX = "game vfx sprite centered on plain pure black background"

# ---- characters -------------------------------------------------------------
# 5 render directions (west half is mirrored by the renderer) x idle/step.
DIRS = {
    "s": "standing facing the viewer, front view, symmetrical",
    "se": "three-quarter front view, body turned 45 degrees to the right, facing down-right",
    "e": "side profile view facing right, full profile",
    "ne": "three-quarter back view, body turned away 45 degrees to the right, "
          "back and right shoulder visible, face not visible",
    "n": "back view, seen from directly behind, back of the head visible, no face",
}
STEP = "mid-stride walking pose, one leg forward, arms swinging slightly"

CHARS = {
    # archetype -> (theme kind, description, extra negative)
    # Kinds MUST diverge hard in silhouette + dominant color: a 0.8-weight cast
    # anchor turned every NPC into a ranger clone, so each non-player kind
    # carries the ranger's signature look in its NEGATIVE prompt and the cast
    # anchor weight is only 0.3.
    "player": ("vine-ranger",
               "a heroic swamp ranger explorer in a bright teal-blue spacesuit with tan leather "
               "chest straps and a large glowing orange-amber visor, green vines wrapped around "
               "one arm, sturdy tan boots, vivid saturated colors, high contrast, "
               "chunky proportions, big head, short legs", ""),
    "cop": ("spore-drone",
            "a hovering robotic security drone machine, a rounded gray metal pod body with NO "
            "legs, moss patches on the shell, one large glowing green sensor eye, small thruster "
            "jets underneath, two thin dangling manipulator arms, floating above the ground",
            "human, person, legs, feet, boots, spacesuit, helmet, orange visor, orange cap"),
    "thug": ("bog-mutant",
             "a huge hulking swamp mutant brute, broad shoulders twice as wide as its waist, "
             "moss-crusted olive-green warty skin, bare chest, glowing yellow eyes, massive "
             "heavy fists, hunched forward, chunky proportions, big head, short legs",
             "spacesuit, armor suit, helmet, visor, orange cap, teal suit, slim, thin"),
    "scientist": ("mycologist",
                  "a scientist in a baggy pale white-gray hazmat clean suit with a round hood "
                  "and a square green-glowing faceplate window, satchel of glowing mushroom "
                  "vials on a shoulder strap, chunky proportions, big head, short legs",
                  "teal suit, orange visor, orange cap, muscular, armor"),
    "robot": ("derelict-bot",
              "a squat boxy derelict maintenance robot on wide tank treads, rusty tan-orange "
              "plating with lichen patches, a single dim amber eye lens on a flat rectangular "
              "head, exposed cables and antenna, no legs, chunky blocky silhouette",
              "human, person, legs, boots, spacesuit, helmet, visor, slim figure, face"),
    "civilian": ("frog-settler",
                 "a squat round frog-like alien settler, short and wide, mottled green skin, "
                 "a wide frog mouth and two big round yellow eyes on top of the head, wearing "
                 "a simple brown rope-belted poncho, webbed feet, half as tall as a human, "
                 "chunky proportions, big head",
                 "human face, spacesuit, helmet, visor, orange cap, teal suit, tall, slim"),
    # #67 Mireclaw brood scavenger. Diverges from every other kind on BOTH axes
    # the cast contract cares about: silhouette (the only LOW, HORIZONTAL,
    # wider-than-tall body — everything else is an upright biped/pod/box) and
    # dominant color (near-black chitin; olive/teal/tan/gray are all taken).
    # Violet is a palette ACCENT ("use sparingly"), so it is glow only, not mass.
    "stalker": ("mireclaw-stalker",
                "a low-slung six-legged alien scavenger beast, long lean body held horizontal "
                "close to the ground, dark brown-black chitin plates with pale bone ridges "
                "along the spine, two oversized scythe-shaped front claws, a narrow eyeless "
                "wedge head with mandibles, faint violet bioluminescent glow in the joint "
                "seams, crouched stance, body much wider than it is tall",
                "human, person, upright, standing biped, two legs, spacesuit, helmet, visor, "
                "orange cap, teal suit, green skin, moss, olive, tall, slim, hulking muscular"),
}
CHAR_ALIASES = {"gangster": "thug", "bouncer": "cop", "boss": "thug", "shopkeeper": "civilian"}

# ---- the rest of the pack ---------------------------------------------------
TILES = {
    "deck-moss": ("tiles/deck-moss.png",
                  "seamless top-down texture of sci-fi deck plating, tan-gray metal floor panels "
                  "with rivets, olive moss and thin glowing green spore veins growing in the seams, "
                  "seen from directly above"),
    "root-bulkhead": ("tiles/root-bulkhead.png",
                      "seamless dense macro texture of twisted mangrove roots and vines "
                      "completely covering sci-fi hull plating, tangled dark brown roots and "
                      "olive moss over teal-gray riveted metal panels, every part of the frame "
                      "covered in roots and metal, faint green glow deep between the roots"),
}
PROPS = {
    "cargo-pod": ("props/cargo-pod.png",
                  "a battered sci-fi cargo crate pod, tan metal with teal panel accents, moss on "
                  "the top edges, glowing green status light"),
    "spore-barrel": ("props/spore-barrel.png",
                     "a sealed biotech barrel pod overgrown with green moss, glowing green spore "
                     "sacs clustered on its side, tan metal with warning stripes"),
    "cryo-terminal": ("props/cryo-terminal.png",
                      "an upright cryo-credit terminal kiosk, gray-teal metal cabinet with a "
                      "small glowing amber screen, frost at the base, thin vines climbing one side"),
    "nutrient-dispenser": ("props/nutrient-dispenser.png",
                           "an upright vending machine nutrient dispenser, teal metal cabinet "
                           "with glowing green canisters visible behind a cracked window, moss "
                           "growing from the dispensing slot"),
    "console-monitor": ("props/console-monitor.png",
                        "a derelict computer console monitor on a stubby stand, dark screen with "
                        "flickering green static glyphs, tan-gray casing, moss on top"),
    "hydro-recycler": ("props/hydro-recycler.png",
                       "a squat hydroponic water recycler unit, a bowl-shaped basin of glowing "
                       "teal water on a metal base with pipes, small plants sprouting from it"),
}
ITEMS = {
    "spore-pistol": ("items/spore-pistol.png",
                     "a small sci-fi pistol sidearm with a glowing green spore vial cartridge, "
                     "teal metal, side view"),
    "root-club": ("items/root-club.png",
                  "a gnarled mangrove root club melee weapon, dark brown wood with moss, "
                  "wrapped leather grip, diagonal side view"),
    "shard-knife": ("items/shard-knife.png",
                    "a jagged knife blade made from a torn hull-metal shard, gray metal with "
                    "teal sheen, tape-wrapped grip, diagonal side view"),
    "biogel-kit": ("items/biogel-kit.png",
                   "a small white medical canister kit with a glowing green cross and a vial of "
                   "green bio-gel, side view"),
    "credit-chits": ("items/credit-chits.png",
                     "a small stack of glowing amber hexagonal credit chips, sci-fi currency"),
    "scatter-blaster": ("items/scatter-blaster.png",
                        "a chunky sci-fi scatter blaster shotgun with twin wide barrels and a "
                        "glowing green charge cell, tan and teal metal, side view"),
    "phosphor-flask": ("items/phosphor-flask.png",
                       "a glass flask bottle full of glowing teal phosphorescent liquid with a "
                       "rag stuffed in the neck, side view"),
    "spore-grenade": ("items/spore-grenade.png",
                      "a bulbous organic spore pod grenade, olive-green with glowing green "
                      "cracks and a metal pin cap"),
}
FX = {
    "biolume-flame": ("fx/biolume-flame-{i}.png", 3,
                      "a single teardrop-shaped bioluminescent green-teal flame, bright glowing "
                      "core, pixel art fire sprite"),
    "spore-burst": ("fx/spore-burst-{i}.png", 3,
                    "a round burst explosion of glowing green spores and teal gas, "
                    "pixel art explosion sprite"),
}

TILE_PX, CHAR_PX, PROP_PX, ITEM_PX, FLAME_PX, FX_PX = 32, 48, 32, 32, 48, 64
ENV_ANCHORS = [os.path.join(ANCHORS, f) for f in ("env-a.png", "env-b.png")]


def jobs():
    """Expand the tables into a flat {name: spec} job dict."""
    out = {}
    for name, (path, subj) in TILES.items():
        out[f"tile.{name}"] = dict(cat="tile", path=path, px=TILE_PX,
                                   pos=f"{TRIGGER}, {subj}, {BG_TILE}, {LOOK}",
                                   neg=f"{NEG_FIGURE}, horizon, sky, depth, isometric, {NEG_BASE}",
                                   seamless=True, alpha=False)
    for name, (path, subj) in PROPS.items():
        out[f"prop.{name}"] = dict(cat="prop", path=path, px=PROP_PX,
                                   pos=f"{TRIGGER}, {subj}, {BG_OBJ}, upright, slight high "
                                       f"three-quarter game angle, {LOOK}",
                                   neg=f"{NEG_FIGURE}, {NEG_BASE}", refs="env")
    # Items get NO IPAdapter refs: the environment anchors (mossy barrel + deck
    # tile) turned every weapon into a mushroom. Inventory-icon wording instead;
    # palette lock keeps them cohesive with the pack.
    for name, (path, subj) in ITEMS.items():
        out[f"item.{name}"] = dict(cat="item", path=path, px=ITEM_PX,
                                   pos=f"{TRIGGER}, flat 2D game inventory item icon, {subj}, "
                                       f"{BG_OBJ}, {LOOK}",
                                   neg=f"mushroom, tree, plant, moss ball, {NEG_FIGURE}, {NEG_BASE}")
    # IPAdapter anchoring fights pose words: at 0.8 the anchor's front pose
    # bleeds into back/profile views, so away-facing directions drop the weight.
    DIR_IPW = {"s": 0.8, "se": 0.7, "e": 0.55, "ne": 0.5, "n": 0.5}
    DIR_NEG = {
        "e": "facing the viewer, front view, symmetrical face",
        "ne": "face, eyes, mouth, facing the viewer, front view",
        "n": "face, eyes, mouth, visor on the front, facing the viewer, front view",
    }
    for arch, (kind, desc, kneg) in CHARS.items():
        for d, dprompt in DIRS.items():
            for frame in ("idle", "step"):
                jname = f"char.{kind}.{d}-{frame}"
                is_anchor_pose = d == "s" and frame == "idle"
                neg_parts = [p for p in (DIR_NEG.get(d, ""), kneg) if p]
                spec = dict(
                    cat="char", arch=arch, kind=kind, dir=d, frame=frame,
                    path=f"chars/{kind}-{d}-{frame}.png", px=CHAR_PX,
                    pos=f"{TRIGGER}, full body game character sprite, {desc}, {dprompt}, "
                        f"{BG_CHAR}, {LOOK}",
                    neg=", ".join(neg_parts + [
                        f"two characters, crowd, cropped, close-up, portrait, {NEG_BASE}"]),
                    refs="char-cast" if is_anchor_pose else "char-anchor",
                    ipw=0.3 if is_anchor_pose else DIR_IPW[d],
                )
                if frame == "step":
                    # STEP frames are img2img FROM the direction's curated idle
                    # at low denoise with a minimal prompt delta — posture,
                    # proportions and gear stay identical, only limbs move.
                    # (txt2img steps flickered like a costume change against
                    # their idles when the walk cycle alternated frames.)
                    spec["pos"] = spec["pos"].replace(dprompt, f"{dprompt}, {STEP}")
                    spec["init_from_idle"] = jname.replace("-step", "-idle")
                    spec["denoise"] = 0.38
                    spec["refs"] = None
                out[jname] = spec
    for name, (pattern, frames, subj) in FX.items():
        px = FLAME_PX if "flame" in name else FX_PX
        for i in range(1, frames + 1):
            out[f"fx.{name}.{i}"] = dict(cat="fx", path=pattern.format(i=i), px=px,
                                         pos=f"{TRIGGER}, {subj}, {BG_FX}, {LOOK}",
                                         neg=f"{NEG_FIGURE}, {NEG_BASE}", alpha=False,
                                         luma=True)
    return out


def resolve_refs(spec):
    """Map a spec's symbolic ref group to concrete anchor image paths."""
    kind = spec.get("refs")
    # Escape hatch for a ComfyUI without ComfyUI_IPAdapter_plus installed: the
    # IPAdapter branch in comfy.py is gated on `refs`, so dropping them lets the
    # rest of the recipe (LoRA + locked palette + prompt contract) still run.
    # Style consistency then rests on the palette lock alone -- GATE THE OUTPUT.
    if os.environ.get("NO_IPA"):
        return []
    if kind == "env":
        return [p for p in ENV_ANCHORS if os.path.exists(p)]
    if kind == "char-anchor":  # this character's curated s-idle raw
        p = os.path.join(ANCHORS, f"{spec['kind']}-s-idle.png")
        return [p] if os.path.exists(p) else []
    if kind == "char-cast":  # cast look anchor: the player's curated s-idle
        p = os.path.join(ANCHORS, "vine-ranger-s-idle.png")
        return [p] if os.path.exists(p) and spec["kind"] != "vine-ranger" else []
    return []


def load_curation():
    return json.load(open(CURATION)) if os.path.exists(CURATION) else {}


def sweep(names, seeds=6, base_seed=414500):
    import comfy
    CHUNK = 4  # >4-image batches with the two-pass tile graph can OOM the server
    cur = load_curation()
    for name in names:
        spec = jobs()[name]
        refs = resolve_refs(spec)
        dest = os.path.join(STAGE, name)
        init = spec.get("init")
        if spec.get("init_from_idle"):
            init = resolve_raw(spec["init_from_idle"], cur.get(spec["init_from_idle"]))
            if not init:
                print(f"SKIP {name}: curate {spec['init_from_idle']} first "
                      f"(no durable raw — see `generate.py curate`)")
                continue
        done = 0
        while done < seeds:
            n = min(CHUNK, seeds - done)
            g = comfy.build_graph(
                pos=spec["pos"], neg=spec["neg"], seed=base_seed + done, batch=n,
                seamless=spec.get("seamless", False), refs=refs or None,
                ip_weight=spec.get("ipw", 0.8), init=init,
                denoise=spec.get("denoise", 1.0), alpha=spec.get("alpha", True),
                prefix=name.replace(".", "-") + f"-s{base_seed + done}",
            )
            paths = comfy.run(g, dest)
            done += n
            print(f"{name}: +{len(paths)} candidates (seed {base_seed + done - n}) -> {dest}")


def final(names, allow_regen=False):
    """Post-process each job's curated raw into the theme directory. Prefers the
    DURABLE raw (raws/<job>.png or an anchor) so the shipped pixels reproduce
    byte-for-byte. Same-seed REGEN is off by default: the generation graph drifts
    over time, so regenerating a lost pick produces DIFFERENT art (this is the
    /tmp-loss trap — a spore-pistol regen came back a contaminated blob). Pass
    --allow-regen only to knowingly re-roll a lost pick from its recorded seed."""
    import comfy
    from PIL import Image
    import post as P

    cur = load_curation()
    for name in names:
        spec = jobs()[name]
        pick = cur.get(name)
        if not pick:
            print(f"SKIP {name}: no curated pick in curation.json")
            continue
        raw = resolve_raw(name, pick)  # durable-first
        if not raw:
            if not allow_regen:
                print(f"SKIP {name}: no durable raw (recorded path is gone). "
                      f"Re-curate: `generate.py sweep {name}` then "
                      f"`generate.py curate {name} <picked-file>`. "
                      f"(--allow-regen to re-roll from seed {pick.get('seed')}, "
                      f"but the graph has drifted so it will NOT match the approved pick.)")
                continue
            init = spec.get("init")
            if spec.get("init_from_idle"):
                init = resolve_raw(spec["init_from_idle"], cur.get(spec["init_from_idle"]))
            g = comfy.build_graph(
                pos=spec["pos"], neg=spec["neg"], seed=pick["seed"],
                batch=pick.get("batch", 1),
                seamless=spec.get("seamless", False),
                refs=resolve_refs(spec) or None, ip_weight=spec.get("ipw", 0.8),
                init=init, denoise=spec.get("denoise", 1.0),
                alpha=spec.get("alpha", True), prefix="final-" + name.replace(".", "-"),
            )
            paths = comfy.run(g, os.path.join(STAGE, "final", name))
            raw = paths[pick.get("index", 0)]
        im = Image.open(raw)
        dest = os.path.join(THEME, spec["path"])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if spec["cat"] == "tile":
            out = P.tile(im, spec["px"])
            print(f"  seam energy: {P.seam_energy(out):.1f}")
        elif spec.get("luma"):
            out = P.luma_sprite(im, spec["px"])
        elif spec["cat"] == "char":
            out = P.sprite(im, spec["px"], content=spec["px"] - 2, anchor="bottom")
        else:
            out = P.sprite(im, spec["px"], content=spec["px"] - 2, anchor="center")
        out.save(dest)
        print(f"{name} -> {os.path.relpath(dest, REPO)}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    J = jobs()
    if "--list" in flags:
        print("\n".join(J))
        sys.exit(0)
    cmd, names = (args[0], args[1:]) if args else (None, [])

    def flagval(key, default=None):
        for f in flags:
            if f.startswith(key + "="):
                return f.split("=", 1)[1]
        return default

    if cmd == "curate":
        # curate <job> <file> [--seed N --index I --batch B --size N --ckpt X --note "..."]
        if len(names) < 2 or names[0] not in J:
            print(__doc__)
            print("usage: generate.py curate <job> <picked-file> [--seed N ...]")
            sys.exit(1)
        job, src = names[0], names[1]
        if not os.path.exists(src):
            print(f"no such file: {src}")
            sys.exit(1)
        seed = flagval("--seed")
        batch = flagval("--batch")
        persist_raw(job, src,
                    seed=int(seed) if seed else None,
                    index=int(flagval("--index", "0")),
                    batch=int(batch) if batch else None,
                    size=int(flagval("--size")) if flagval("--size") else None,
                    ckpt=flagval("--ckpt"), note=flagval("--note"))
        sys.exit(0)

    if "--all" in flags:
        names = list(J)
    seeds = int(flagval("--seeds", "6"))
    bad = [n for n in names if n not in J]
    if bad or cmd not in ("sweep", "final"):
        print(__doc__)
        if bad:
            print("unknown jobs:", bad)
        sys.exit(1)
    (sweep(names, seeds=seeds) if cmd == "sweep"
     else final(names, allow_regen="--allow-regen" in flags))
