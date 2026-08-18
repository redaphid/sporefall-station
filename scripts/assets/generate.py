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
# Props use this instead of LOOK. LOOK positively requests "dark teal alien
# jungle overgrowing tan sci-fi metal, olive moss" -- which is right for tiles
# and creatures, and is a direct contradiction of the props' own negatives
# ("covered in moss, moss cap, overgrown, foliage on top"). Asking for moss and
# forbidding it in the same prompt is how the shipped props became mossy lumps;
# the prop recipe fixed the negatives but left the positive request in place.
#
# Evidence this matters rather than being tidiness: the g2 sweep ran a moss-free
# LOOK and produced zero moss caps across 15 images, against a shipped set where
# all six props have one. Manufactured wear is kept -- these are derelict station
# fittings, not showroom stock -- but as grime and worn paint, not vegetation.
PROP_LOOK = ("16-bit era palette, bold dark outlines, chunky readable shapes, "
             "worn tan and teal painted sci-fi metal, scuffed paint, grimy panel seams, "
             "bioluminescent green indicator lights, moody")
NEG_BASE = ("photorealistic, 3d render, smooth gradient, soft shading, text, watermark, "
            "signature, blurry, jpeg artifacts, bright cheerful, pastel, "
            "sprite sheet, grid, multiple views, turnaround, duplicate, two copies, "
            "several objects side by side, faded ghost copy")
NEG_FIGURE = ("person, humanoid, figure, character, creature, monster, face, head, "
              "arms, legs, hands, body, standing figure, portrait, silhouette of a person")
# The recipe's "feet on the ground" invites a painted dirt mound / cast shadow.
# The background key cannot tell that grey ellipse from the creature, so it welds
# it into the alpha as a grey SLAB under the sprite — invisible at 1024px, but at
# 48px it is a third of the sprite's height. Negatived on every ground creature.
NEG_GROUND = ("ground, dirt patch, mound, terrain, soil, grass, rocks, base, pedestal, "
              "plinth, cast shadow on the ground, diorama, puddle, sand, gravel, "
              # Second pass. The list above still let two things through on the
              # last sweep: a teal ground PUDDLE and a hard elliptical DROP
              # SHADOW. "puddle" and "cast shadow on the ground" were both
              # already present, so the miss was not a gap in coverage — the
              # phrasing was too abstract. Name the pictorial form, not the
              # concept: an "ellipse under the object" is what the model draws.
              # This matters more for props than for creatures: the background
              # key cannot tell a grey ellipse from the sprite, so it welds it
              # into the ALPHA, where no colour pass can ever reach it.
              "drop shadow, shadow ellipse, contact shadow, dark ellipse under the object, "
              "shadow blob, reflection, mirrored reflection, wet floor, standing water, "
              "spilled liquid, water pooling at the base, floor, floor plane, ground plane, "
              "surface beneath the object, stilts, legs propping it up")

# The WRONG READING, named. Describing a locker is not enough — you must forbid
# the tombstone, or the model splits the difference and gives you a locker-ish
# headstone. Every shipped prop before this constant existed came out as a mossy
# boulder or a grave marker; see _mycel-results/sprite-inventory.md for the
# contact sheet that made it undeniable.
#
# `tree`/`planter` are in this list because of a measured failure, not a hunch:
# in the g2 sweep two of three spore-barrel seeds grew a TREE out of the barrel
# (one on stilts in a puddle, one a planter tub). The old list named moss, shrub,
# bush and foliage — but never `tree`, so the model had an unblocked route to the
# same silhouette. That single omission is most of the difference between the
# ~1-in-3 hit rate observed and the 4-in-5 that was reported.
NEG_WRONG_READ = ("gravestone, tombstone, headstone, grave marker, monolith, standing stone, "
                  "menhir, cairn, boulder, rock, stone, mossy rock, moss ball, mound of moss, "
                  "shrub, bush, mushroom, organic blob, lump, weathered stone, "
                  "moss cap, overgrown, covered in moss, vines, foliage on top, cemetery, "
                  "tree, potted plant, planter, plant pot, flower pot, tub, trunk, branches, "
                  "leaves, canopy, topiary, bonsai, terrarium, on stilts, on legs")
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
                "a low-slung six-legged alien scavenger beast shaped like a giant crab-mantis, "
                "long lean horizontal body carried close to the ground on six splayed insect "
                "legs, no upright torso, dark brown-black chitin plates with pale bone ridges "
                "along the spine, two oversized scythe-shaped front claws held low, a narrow "
                "eyeless wedge head with mandibles jutting FORWARD from the front of the body, "
                "faint violet bioluminescent glow in the joint seams, "
                "wide flat crouched silhouette twice as wide as it is tall",
                # 3 of the first 4 seeds drifted to an UPRIGHT humanoid, and the recipe's
                # "feet on the ground" invites a painted dirt mound that the background key
                # then welds into the silhouette as a grey slab. Both are negatived hard.
                "human, person, humanoid, upright, standing biped, two legs, bipedal, torso, "
                "wings, spear, weapon in hand, spacesuit, helmet, visor, orange cap, teal suit, "
                "green skin, moss, olive, tall, slim, hulking muscular, "
                "ground, dirt patch, mound, terrain, soil, grass, rocks, base, pedestal, "
                "cast shadow on the ground, diorama"),
    # ── #78 Sporefall threat roster ──────────────────────────────────────────
    # These six archetypes SPAWN IN NORMAL PLAY and every one of them was
    # rendering as the same grey procedural eyeball. Each new kind has to clear
    # the same bar the stalker did: diverge from the whole existing cast on BOTH
    # axes — silhouette AND dominant color — or the pack reads as one creature
    # in six tints. What is already taken:
    #   vine-ranger  upright biped   / teal + orange visor
    #   spore-drone  floating pod    / grey metal
    #   bog-mutant   hulking biped   / olive green
    #   mycologist   biped           / pale white-grey
    #   derelict-bot box on treads   / rust tan-orange
    #   frog-settler squat + round   / mottled green
    #   mireclaw     low horizontal  / near-black chitin
    # v2. v1 said "quadruped ... twice as wide as a person" and drew four upright
    # armoured BIPEDS out of four seeds. What separates this from the stalker —
    # which never drifts — is that the stalker states its silhouette as explicit
    # geometry ("twice as wide as it is tall", "no upright torso") instead of
    # naming a body plan and hoping. Same treatment here.
    "brute": ("carapace-brute",
              "a massive armored beast walking on ALL FOURS, a long heavy body carried "
              "horizontally on four thick pillar legs, no upright torso, the broad domed "
              "bone-plate head shield held low at the FRONT of the body at the same "
              "height as its shoulders like a battering ram, overlapping pale bone-tan "
              "carapace plates across a humped armored back, tiny deep-set eyes beneath "
              "the shield, short thick tail behind, wide flat crouched silhouette twice "
              "as wide as it is tall",
              # Four legs + a bone shield is the whole idea; the bog-mutant is the
              # trap this one falls into (both are "big and strong").
              "human, person, humanoid, upright, standing biped, two legs, bipedal, "
              "torso, chest, waist, shoulders, arms, hands, fists, human proportions, "
              "nude, naked, bare skin, human skin, man, woman, "
              "mech, robot suit, power armor, wings, spacesuit, helmet, visor, orange "
              "cap, teal suit, olive green skin, moss, hovering, floating, tank treads, "
              "boxy robot, mushroom, thin, slim, spindly, six legs, insect, crab, frog, "
              "big round eyes, " + NEG_GROUND),
    # v2. v1 ("a gaunt smouldering ash husk ... lean and starved") drew four pale
    # grey NUDE HUMAN FIGURES — no char, no embers. Describing a humanoid at all
    # lets the cast anchor win, so v2 leads with the material (burnt crust, no
    # skin) rather than the body, and negatives the human read explicitly.
    "cinder": ("cinder-husk",
               "a burnt-out husk monster with NO SKIN anywhere, its entire body a crust "
               "of cracked black charcoal like burnt bark, molten ember-orange light "
               "glowing out of every crack across its chest and shoulders, a featureless "
               "eyeless charcoal skull head with one burning orange slit, long thin "
               "blackened arms ending in three hooked claws, hunched forward over a "
               "jagged broken spine, ash smoke curling off its shoulders, charred pitch "
               "black body with hot orange glowing fissures",
               "nude, naked, bare skin, human skin, flesh, skin texture, smooth skin, "
               "pale grey body, woman, man, person, human, breasts, hair, face, eyes, "
               "nose, mouth, lips, "
               "hulking muscular, broad shoulders, bulky, armor plates, carapace, "
               "spacesuit, helmet, visor, orange cap, teal suit, green skin, moss, olive, "
               "mushroom, hovering, floating, tank treads, boxy robot, six legs, insect, "
               "crab, frog, big round eyes, campfire, bonfire, torch, " + NEG_GROUND),
    "sporeling": ("sporeling-mite",
                  "a tiny scuttling fungal critter, one oversized pale cream mushroom cap "
                  "dome covering almost its whole body, glowing green gills underneath the "
                  "cap rim, four stubby little legs poking out below, no arms at all, two "
                  "pinprick eyes in the shadow under the cap, knee-high, small and round "
                  "and low to the ground",
                  "human, person, humanoid, upright, standing biped, tall, large, huge, "
                  "hulking, muscular, spacesuit, helmet, visor, orange cap, teal suit, "
                  "arms, hands, weapon, robot, treads, hovering, six legs, crab, claws, "
                  "frog face, wide mouth, dark chitin, " + NEG_GROUND),
    # v2. v1 asked for a "tall narrow VERTICAL" body with four folded limbs and
    # got, from four seeds, two humanoids, a tree and a figure in a ball gown:
    # tall + vertical + limbs is a person, and the cast anchor is a person too.
    # v2 gives up the vertical read and describes a closed SHELL — a shape with
    # no limb count to get wrong. It still diverges from the stalker (a long
    # sprawling six-legged body) by being smooth, compact and featureless.
    "lurker": ("gloom-lurker",
               "an ambush creature coiled up tight inside a smooth armored dome shell, a "
               "dark teal chitin carapace clamped shut like a closed clam hugging the "
               "floor, a rim of small glowing violet eyespots around the front edge of the "
               "shell, short hooked grasping claws just barely tucked out of sight beneath "
               "the shell rim, no head, no face, no upright body, squat and rounded and "
               "low to the ground, wider than it is tall",
               "tall, upright, standing, vertical, human, person, humanoid, figure, biped, "
               "two legs, torso, arms, hands, nude, naked, bare skin, woman, man, dress, "
               "gown, robe, tree, trunk, branches, plant, "
               "wide, broad, bulky, hulking, muscular, spacesuit, helmet, visor, "
               "orange cap, teal spacesuit, leather straps, gear, olive green skin, moss, "
               "mushroom cap, hovering, floating, tank treads, boxy robot, six splayed "
               "legs, long legs, crab, frog, big round eyes, face, mouth, "
               + NEG_GROUND),
    # v2. v1 ran through the CHARACTER recipe and drew twig-people: the recipe
    # says "full body, feet on the ground" and the pose word is "standing", which
    # a legless egg sac cannot satisfy, so the model supplied a body. It is a prop
    # that happens to have an archetype — see STATIC_KINDS, which gives it the
    # object framing and the ENVIRONMENT anchor instead of the humanoid cast one.
    "pod": ("brood-sac",
            "a bulbous organic egg sac rooted to the floor, a fat teardrop bulb of taut "
            "sickly olive-yellow membrane webbed with dark veins, a vertical split seam "
            "down the front leaking green bioluminescent light, a knot of short fibrous "
            "roots gripping the floor at its base, no legs, no arms, no head, "
            "a motionless object, not a creature",
            "human, person, humanoid, figure, character, face, eyes, mouth, arms, hands, "
            "legs, feet, walking, standing figure, torso, limbs, twig person, tree, "
            "spacesuit, helmet, visor, teal suit, robot, treads, "
            "metal, barrel, crate, box, canister, mushroom cap, insect, crab, six legs, "
            "hovering, floating, " + NEG_GROUND),
}
# Archetypes that are STATIC OBJECTS wearing an archetype, not figures. The
# character recipe hard-codes "full body, feet on the ground" and a pose word
# ("standing facing the viewer"), and a legless egg sac cannot satisfy either —
# so the model invents a body to hang them on. These kinds get the object
# framing and, per docs §4, the ENVIRONMENT anchor rather than the humanoid cast
# anchor, which is the same rule props already follow.
STATIC_KINDS = {"pod"}
BG_STATIC = ("single isolated game object centered on plain flat white background, "
             "the whole object in frame, resting on the floor")
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
# name -> (manifest path, EXPLICIT GEOMETRY, extra negatives)
#
# Three rules, each earned by a failure:
#
# 1. State the SILHOUETTE as geometry, not as a noun. "a barrel" produced a mossy
#    boulder for the entire life of this pack. "a SQUAT CYLINDER standing on its
#    flat circular end with a visible elliptical rim" produced a barrel.
# 2. State PROPORTION as a ratio AND negative the opposite. The first corrected
#    barrel came out a 1:3 canister — right geometry, wrong object, and a 10px
#    sliver once posted to the 32px prop footprint.
# 3. NEVER ASK FOR MOSS. Every prompt here used to request it ("moss on the top
#    edges", "overgrown with green moss", "moss growing from the dispensing
#    slot", "small plants sprouting from it"). Combined with the env anchor and
#    the missing NEG_GROUND, that is the whole recipe for a mossy grave marker.
#
# And do not ask for COLOUR. Generation supplies shape; `ramp_grade` keeps only
# VALUE and discards hue by construction, so a near-white render with clean value
# structure is the correct input, not a defect.
#
# SEED BUDGET: 8-12 per subject, not 3. The g2 sweep ran 3 and hit roughly 1 in 3
# usable; reporting it as "worked first time" was reading the curated seed as if
# it were the sweep. Expect to curate, and expect to reject.
#
# Ranked by measured encounter rate (200 seeds x floors 1-5, 120,736 objects —
# see _mycel-results/sprite-inventory.md): crate 23.0/floor, desk 13.3,
# cabinet 11.7, barrel 8.2, vending 5.0, tv 4.4, locker 3.3, toilet 3.1, atm 2.4.
PROPS = {
    # #1 object in the game. Nothing has ever been generated for it: it was
    # recorded as an unreachable orphan, so it was never on any queue.
    "cargo-crate": ("props/cargo-crate.png",
                    "a sturdy rectangular sci-fi supply crate, a CLOSED BOX with six flat faces "
                    "and hard square corners, four vertical corner posts and horizontal "
                    "reinforcing bands strapping the sides, recessed latch clamps on the front "
                    "face, a stencilled cargo number and a small green status light, tan metal "
                    "with teal panel accents, a flat square lid, sitting squarely flat on the "
                    "floor, chunky and boxy, slightly wider than it is tall, roughly 6 wide by "
                    "5 tall",
                    "dome, domed top, rounded top, curved, sphere, hemisphere, mound, hill, "
                    "barrel, cylinder, drum, pod, egg, sack, bag, tarpaulin, cloth, open lid, "
                    "spilling contents, tall, narrow, pillar, column"),
    "work-desk": ("props/work-desk.png",
                  # NOTHING ON TOP is load-bearing twice over: the old prompt asked for a
                  # monitor on the desktop, so no reseed could ever fix the monitor tower —
                  # and a desk wearing a monitor is the same object as wall-screen, which
                  # defeats the split that justifies generating both.
                  "a low wide sci-fi office work desk, a bare empty flat rectangular horizontal "
                  "desktop surface with NOTHING ON TOP of it, supported on two solid side "
                  "panels, a drawer unit under one end, WIDE horizontal silhouette, the desktop "
                  "is a wide flat plank twice as wide as the whole object is tall, low to the "
                  "floor, roughly 8 wide by 4 tall",
                  "monitor, screen, computer, keyboard, tower, clutter, objects on the desk, "
                  "tall, upright slab, vertical, narrow, cabinet, obelisk, pillar, column"),
    "supply-cabinet": ("props/supply-cabinet.png",
                       "a tall narrow sci-fi supply cabinet, a rectangular metal cupboard with "
                       "TWO hinged doors meeting at a vertical seam down the middle, a "
                       "horizontal handle bar on each door, louvred vent slots near the top, "
                       "four short feet lifting it off the floor, flat square top, sharp square "
                       "corners, roughly 4 wide by 6 tall",
                       "rounded top, dome, arch, curved top, screen, window, glass front, "
                       "extremely tall, thin, sliver, pole"),
    "spore-barrel": ("props/spore-barrel.png",
                     "a SQUAT cylindrical oil drum barrel standing upright on its flat circular "
                     "end, clearly a CYLINDER with a visible round elliptical rim at the top, "
                     "two raised horizontal ribs banding around the middle, a single yellow "
                     "hazard warning stripe, tan and teal metal, flat circular lid with a bung "
                     "cap, chunky and stout, only slightly taller than it is wide, roughly 4 "
                     "wide by 5 tall",
                     "dome, hemisphere, egg, sphere, round top, tapered, cone, sack, pot, vase, "
                     "tall, narrow, thin, slender, pillar, column, canister, tube, rocket, pipe"),
    "nutrient-dispenser": ("props/nutrient-dispenser.png",
                           # The ONE prop whose silhouette was already right. Regenerate only if
                           # the ramp cannot carry it — shape here is not the problem.
                           "an upright vending machine nutrient dispenser, a tall rectangular "
                           "metal cabinet with a large glass window front, three horizontal "
                           "shelves of canisters visible behind the glass, a dispensing slot at "
                           "the bottom, a keypad beside the window, flat square top, roughly 4 "
                           "wide by 7 tall",
                           "rounded top, dome, arch, solid front, no window, doors, "
                           "sliver, pole, obelisk"),
    "wall-screen": ("props/wall-screen.png",
                    "a wall-mounted sci-fi flat panel display screen, a thin rectangular monitor "
                    "in a slim bezel showing glowing green readout glyphs, mounted flush against "
                    "a vertical wall on a bracket, a bundle of cables trailing from one bottom "
                    "corner, flat and thin, wider than it is tall, no floor contact and nothing "
                    "beneath it, roughly 7 wide by 5 tall",
                    "stand, post, pole, tripod, base plate, pedestal, feet, stubby stand, "
                    "desk monitor, on a table, thick body, box, crt, deep cabinet, tall, "
                    "narrow, tower"),
    "weapons-locker": ("props/weapons-locker.png",
                       "a tall rectangular steel weapons locker, one full-height vertical door "
                       "with a recessed handle and a small keypad panel, three horizontal "
                       "louvred vent slits at eye height, a stencilled yellow number on the "
                       "door, riveted edges, flat square top, hard square corners, like a school "
                       "locker, roughly 4 wide by 7 tall",
                       "rounded top, arch, dome, screen, glass, vending machine, shelves, "
                       "window, sliver, pole, obelisk"),
    "cryo-terminal": ("props/cryo-terminal.png",
                      "an upright cryo-credit terminal kiosk, a narrow rectangular metal cabinet "
                      "with a small glowing screen set into an angled head at the top, a card "
                      "slot and a keypad below it, a flat square top, straight vertical sides, "
                      "standing flat on the floor, roughly 3 wide by 6 tall",
                      "rounded top, dome, arch, tapered, obelisk, pillar, headstone, "
                      "extremely tall, sliver"),
    "hydro-recycler": ("props/hydro-recycler.png",
                       "a squat hydroponic water recycler unit, a wide open circular BASIN with "
                       "a clearly visible elliptical rim holding glowing teal water, sitting on "
                       "a short cylindrical metal pedestal with two pipes running up one side, "
                       "wider than it is tall, roughly 6 wide by 4 tall",
                       "closed top, solid lump, dome, sphere, tall, narrow, pillar, "
                       "plants, sprouts, foliage"),
    # ---- the furnishings that never had art ---------------------------------
    # These six archetypes are placed by the room planner (levelgen/furnish.ts)
    # and have ALWAYS drawn as hand-coded PixiJS vector shapes (render/art.ts
    # FURNITURE_SHAPE) rather than pack art. Together they are 51% of every
    # furnishing the game spawns and 56% of what is inside a house -- `shelf`
    # alone is the single most common object in the game at 20.8 per floor,
    # ahead of the crate. They are listed here in encounter-rate order.
    #
    # Same recipe as the six above: geometry stated with explicit proportions,
    # then the wrong reading negatived BY NAME. The wrong reading for furniture
    # is the neighbouring piece of furniture -- a bench that comes back with a
    # backrest is a chair, and a table with drawers is the desk we already ship.
    # THE SHELF IS THE HARD ONE, AND HERE IS THE MEASUREMENT SO NOBODY REPEATS IT.
    # This wording yields ~2/8 clean single racks on the fixed seed set
    # 1000-1007 (tag p2) -- the weakest subject in the group, and the one that
    # matters most at 20.8/floor.
    #
    # TRIED AND REJECTED (tag p3, SAME eight seeds, one knob): loading the
    # shelves. "every shelf PACKED FULL of stacked crates ... solid back panel",
    # plus anti-duplicate negatives ("two racks, several racks, row of shelving,
    # aisle, warehouse interior"). The theory was that an open frame is mostly
    # HOLES and holes are noise at 32px, so solid loaded bands would survive the
    # downscale better.
    #
    # It measured WORSE: ~1/8. Loading the shelves reads to the model as a
    # WAREHOUSE, and a warehouse is composed as an AISLE -- six of eight seeds
    # came back as two racks facing each other, which is exactly the duplicate
    # the negatives named and did not prevent. Same shape as the NEG_STACK
    # lesson in docs/sprite-generation.md 4.0: naming the defect in the negatives
    # does not move a compositional tendency of the base model.
    #
    # So the next knob to try is NOT more negatives and NOT more loading. It is
    # the object's own proportions -- a wider, shallower, fewer-levelled unit
    # that cannot read as aisle racking in the first place.
    "storage-rack": ("props/storage-rack.png",
                     "a tall open shelving rack, an upright metal frame with FOUR separate "
                     "horizontal shelf boards stacked one above another with clear open gaps "
                     "between them, a vertical corner post at each end, completely OPEN at the "
                     "front with no doors and no glass, a few small crates and canisters resting "
                     "on the shelves, flat square top, roughly 6 wide by 7 tall",
                     "cabinet, cupboard, closed doors, solid front panel, glass front, window, "
                     "one single shelf, table, desk, workbench, wardrobe, dome, rounded top, "
                     "books, bookcase"),
    "mess-chair": ("props/mess-chair.png",
                   "a single simple metal chair, ONE square seat pad on four thin straight legs "
                   "with a low upright backrest rising behind the seat, slim tubular frame, "
                   "seen from a slightly high game angle, roughly 4 wide by 5 tall",
                   "armchair, sofa, couch, loveseat, throne, recliner, cushioned lounge, "
                   "stool, table, desk, bench, long, wide, two chairs, several chairs, "
                   "row of seats, armrests"),
    "crew-bunk": ("props/crew-bunk.png",
                  "a low single crew bed seen from a high angle looking down at it, ONE long "
                  "rectangular mattress lying flat on a low metal frame, a pale pillow at one "
                  "end and a folded blanket across the other end, four short stubby legs, LONG "
                  "horizontal silhouette twice as long as it is wide, low to the floor, "
                  "roughly 8 wide by 4 tall",
                  "bunk beds, stacked beds, two levels, upper bunk, ladder, tall headboard, "
                  "upright, vertical, sofa, couch, chair, table, person, sleeping figure, "
                  "canopy, four poster"),
    "transit-bench": ("props/transit-bench.png",
                      "a long backless waiting bench, ONE single long flat horizontal plank "
                      "seat carried on two solid end supports, completely open underneath, NO "
                      "backrest of any kind, LONG low horizontal silhouette three times as wide "
                      "as it is tall, roughly 9 wide by 3 tall",
                      "backrest, back panel, back rail, chair, armchair, armrests, sofa, "
                      "table, desk, tall, upright, cushions, pillows, several benches"),
    "mess-table": ("props/mess-table.png",
                   "a square mess-hall table, ONE flat square tabletop with NOTHING ON TOP of "
                   "it, held up by four straight legs at the corners, open underneath, seen "
                   "from a slightly high game angle, roughly 7 wide by 5 tall",
                   "desk, drawers, drawer unit, side panels, cabinet, objects on the table, "
                   "plates, cups, food, clutter, chairs, stools, round tabletop, circular, "
                   "tall, narrow"),
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
    # Props take NO IPAdapter refs, for the same reason items don't (see the
    # comment below): `anchors/env-a.png` IS a mossy barrel sitting in a puddle
    # of grass, and IPAdapter stamped that silhouette onto every prop in the
    # pack. The items were rescued from this anchor years ago; the props never
    # were, and every shipped prop is wearing the anchor's shape.
    #
    # They also get NEG_GROUND, which every ground CREATURE already got and no
    # prop ever did. That omission is why each prop has a painted mound welded
    # into its ALPHA — and because it is in the alpha, no colour pass can reach
    # it. That mound is the tombstone plinth.
    for name, (path, subj, extra) in PROPS.items():
        out[f"prop.{name}"] = dict(cat="prop", path=path, px=PROP_PX,
                                   pos=f"{TRIGGER}, {subj}, {BG_OBJ}, nothing underneath it, "
                                       f"no shadow and no floor, object fills at least 80% of the "
                                       f"frame height, tightly cropped, centered, upright, "
                                       f"slight high three-quarter game angle, {PROP_LOOK}",
                                   neg=f"{NEG_FIGURE}, {NEG_BASE}, {NEG_GROUND}, "
                                       f"{NEG_WRONG_READ}, {extra}")
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
                # A static kind has no pose and no facing — it is the same object
                # from every direction — so it drops the "standing/full body" recipe
                # and takes the environment anchor that props use.
                static = arch in STATIC_KINDS
                subject = ("flat 2D game object sprite" if static
                           else "full body game character sprite")
                pose = "seen from the front" if static else dprompt
                spec = dict(
                    cat="char", arch=arch, kind=kind, dir=d, frame=frame,
                    path=f"chars/{kind}-{d}-{frame}.png", px=CHAR_PX,
                    pos=f"{TRIGGER}, {subject}, {desc}, {pose}, "
                        f"{BG_STATIC if static else BG_CHAR}, {LOOK}",
                    neg=", ".join(neg_parts + [
                        f"two characters, crowd, cropped, close-up, portrait, {NEG_BASE}"]),
                    refs=("env" if static
                          else "char-cast" if is_anchor_pose else "char-anchor"),
                    ipw=0.5 if static else (0.3 if is_anchor_pose else DIR_IPW[d]),
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


def spec_alpha(spec):
    """Whether to ask the server to cut the background.

    `NO_REMBG=1` for a ComfyUI without the pack that provides
    `Image Rembg (Remove Background)` — the raw then comes back on its flat
    studio backdrop and `post.sprite` keys it locally (`post.flat_key`)."""
    if os.environ.get("NO_REMBG"):
        return False
    return spec.get("alpha", True)


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
        # The installed rembg node is STRICTLY batch-1: its `tensor2pil` does a
        # bare `.squeeze()`, so a (B,H,W,C) batch reaches PIL as a 4-D array and
        # raises "Cannot handle this data type". Worse than the crash is the
        # near-miss — `pil2tensor` re-`unsqueeze`s to batch 1, so any batch that
        # DID survive would silently return one image and drop the rest. So an
        # alpha job is swept one seed at a time; only the un-cut jobs batch.
        chunk = 1 if spec_alpha(spec) else CHUNK
        done = 0
        while done < seeds:
            n = min(chunk, seeds - done)
            g = comfy.build_graph(
                pos=spec["pos"], neg=spec["neg"], seed=base_seed + done, batch=n,
                seamless=spec.get("seamless", False), refs=refs or None,
                ip_weight=spec.get("ipw", 0.8), init=init,
                denoise=spec.get("denoise", 1.0), alpha=spec_alpha(spec),
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
    # Accept BOTH `--key=value` and `--key value`. The docstring has always shown
    # the space-separated form, but the parser only matched `--key=`, so a
    # documented `curate ... --seed 414501 --ckpt anything-xl` recorded NONE of
    # it — the flag matched nothing and its value fell through into the
    # positional list, where curate ignores anything past the file. Silently
    # losing seed/size/ckpt loses the provenance curation.json exists to keep.
    VALUE_FLAGS = {"--seed", "--index", "--batch", "--size", "--ckpt", "--note", "--seeds"}
    args, flagmap, rest = [], {}, list(sys.argv[1:])
    while rest:
        a = rest.pop(0)
        if not a.startswith("--"):
            args.append(a)
        elif "=" in a:
            k, v = a.split("=", 1)
            flagmap[k] = v
        elif a in VALUE_FLAGS and rest and not rest[0].startswith("--"):
            flagmap[a] = rest.pop(0)
        else:
            flagmap[a] = True
    flags = list(flagmap)
    J = jobs()
    if "--list" in flags:
        print("\n".join(J))
        sys.exit(0)
    cmd, names = (args[0], args[1:]) if args else (None, [])

    def flagval(key, default=None):
        v = flagmap.get(key, default)
        return default if v is True else v

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
