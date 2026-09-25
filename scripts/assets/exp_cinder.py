#!/usr/bin/env python3
"""Controlled silhouette experiments for the cinder-husk sprite (art-loop).

The shipped cinder-husk is an upright humanoid; every other creature in the
threat roster reads as a non-humanoid. This harness varies ONE axis at a time
so the cause is attributable:

  * `ip_type`   -- IPAdapterAdvanced.weight_type. The whole pack has only ever
                   run the build_graph default, "style transfer", which in
                   ComfyUI_IPAdapter_plus DELIBERATELY suppresses composition
                   transfer. The installed node offers exactly:
                     linear, ease in, ease out, ease in-out, reverse in-out,
                     weak input, weak output, weak middle, strong middle,
                     style transfer, composition, strong style transfer
                   (NB: no "*_precise" / "style and composition" -- those are
                   from a newer release than the one installed here.)
  * `ref`       -- which image the anchor is. The pack always anchors characters
                   on the vine-ranger, an UPRIGHT HUMAN. Turning composition
                   transfer up against a humanoid reference can only produce
                   more humanoids, so the reference is a variable of equal
                   standing to the weight_type.
  * `prompt`    -- variants live in PROMPTS below.

Outputs land OUTSIDE the repo (D:/tmp/art-loop/<tag>/) and a review contact
sheet is written per run. Nothing here ships; curation stays manual.

  python3 exp_cinder.py --tag i1 --conds A,B,C,D --seeds 2
  python3 exp_cinder.py --list
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("EXP_OUT", "D:/tmp/art-loop")
REFPREP = os.path.join(OUT, "_refs")


def prep_ref(src, name):
    """Flatten an RGBA sprite raw onto the pale studio backdrop the curated
    anchors use, and size it like them (512). IPAdapter's LoadImage drops alpha,
    which would otherwise leave the subject on pure black and feed the encoder a
    high-contrast vignette that is not part of the subject."""
    from PIL import Image
    os.makedirs(REFPREP, exist_ok=True)
    dst = os.path.join(REFPREP, name)
    im = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", im.size, (236, 236, 236, 255))
    bg.alpha_composite(im)
    bg.convert("RGB").resize((512, 512), Image.LANCZOS).save(dst)
    return dst


# ── prompt variants ──────────────────────────────────────────────────────────
# v2 is what shipped (generate.py CHARS["cinder"]). It negatives "human" while
# POSITIVELY describing arms, shoulders, a chest, a skull head and a spine --
# i.e. it asks for a humanoid and then asks for it not to be one. The stalker,
# the one recipe that never drifted, instead states silhouette as GEOMETRY.
PROMPTS = {
    "v2": (
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
        "crab, frog, big round eyes, campfire, bonfire, torch",
    ),
    # v3 -- the stalker treatment. Lead with GEOMETRY (wider than tall, spine
    # horizontal, head low and forward at shoulder height), never name a part
    # that only humans have, and make the creature a LEAN QUADRUPED: cinder is
    # hp 45 / speed 3.4 / fists (npcs.ts) -- a fast fragile rusher -- so a lean
    # low runner is also the right read for its behaviour. Mass distribution is
    # what separates it from the carapace-brute (massive, humped, pale bone-tan,
    # slow): this one is thin, black and ember-lit.
    "v3": (
        "a burnt-out beast running on ALL FOURS, its whole body carried "
        "HORIZONTALLY low to the ground, longer than it is tall, no upright "
        "torso, a lean starved ribcage slung between four thin cracked black "
        "legs, the narrow wedge-shaped eyeless head held LOW at the FRONT of the "
        "body level with its shoulders, one burning orange slit for an eye, "
        "entire surface a crust of cracked black charcoal like burnt bark with "
        "molten ember-orange light glowing out of the cracks, a short whip tail "
        "of charred vertebrae trailing behind, ash smoke curling off its back, "
        "wide flat crouched silhouette",
        "human, person, humanoid, upright, standing, standing biped, two legs, "
        "bipedal, torso, chest, waist, shoulders, arms, hands, fists, claws for "
        "hands, human proportions, nude, naked, bare skin, human skin, flesh, "
        "skin texture, woman, man, breasts, hair, face, nose, mouth, lips, "
        "hulking muscular, bulky, broad, armor plates, bone plates, carapace, "
        "domed shield head, pale bone tan, spacesuit, helmet, visor, orange cap, "
        "teal suit, green skin, moss, olive, mushroom, hovering, floating, tank "
        "treads, boxy robot, six legs, insect, crab, spider, frog, big round "
        "eyes, campfire, bonfire, torch",
    ),
    # v4 -- v3 fixed the body plan (quadruped, reliably) but not the BUILD.
    # "lean", "starved", "thin ... legs" and "whip tail" drew small spindly
    # CATS across 16 seeds: pretty at 1024 and useless at 48px, where a 1px leg
    # disappears and the sprite loses all coverage. v4 keeps every geometry
    # statement that worked and swaps the build words for mass -- short, thick,
    # dense, barrel-ribbed -- while staying clearly lighter than the brute
    # (which owns "massive/hulking/humped"). Cat/dog/fox are negatived by name;
    # negativing "human" alone never stopped the model reaching for a familiar
    # animal.
    "v4": (
        "a burnt-out beast standing on ALL FOURS, its heavy body carried "
        "HORIZONTALLY low to the ground, the body twice as long as it is tall, "
        "no upright torso, a deep barrel ribcage slung between four SHORT THICK "
        "cracked black legs, the blunt wedge-shaped eyeless head held LOW at the "
        "FRONT of the body level with its shoulders, one burning orange slit for "
        "an eye, entire surface a crust of cracked black charcoal like burnt "
        "bark, molten ember-orange light glowing out of the cracks along its "
        "back and ribs, a short thick stub of a charred tail, ash smoke curling "
        "off its back, wide solid crouched silhouette, chunky readable shape",
        "cat, kitten, feline, dog, puppy, wolf, fox, deer, horse, domestic "
        "animal, pet, cute, thin, slim, slender, spindly, skinny, lanky, "
        "delicate, long thin legs, stick legs, long whip tail, "
        "human, person, humanoid, upright, standing biped, two legs, bipedal, "
        "torso, chest, waist, shoulders, arms, hands, fists, human proportions, "
        "nude, naked, bare skin, human skin, flesh, skin texture, woman, man, "
        "breasts, hair, face, nose, mouth, lips, "
        "massive, hulking, humped back, bone plates, carapace, domed shield "
        "head, pale bone tan, shaggy fur, mane, spacesuit, helmet, visor, "
        "orange cap, teal suit, green skin, moss, olive, mushroom, hovering, "
        "floating, tank treads, boxy robot, six legs, insect, crab, spider, "
        "frog, big round eyes, campfire, bonfire, torch",
    ),
    # v5 -- v4 was a REGRESSION: 9 of 10 seeds came back as upright bipeds.
    # The mass vocabulary did it. "lean/starved" in v3 was doing double duty --
    # it was not just describing build, it was holding the model in ANIMAL
    # territory; swap it for "heavy body / deep barrel ribcage / chunky" and the
    # nearest heavy thing the model knows in this prompt shape is a bulky biped
    # (the bog-mutant). Saying "level with its shoulders" reintroduced shoulders
    # too.
    #
    # So v5 is v3 with the smallest possible delta: only the three words that
    # made the limbs 1px thin are changed (thin legs -> short sturdy legs, whip
    # tail -> short tail), "shoulders" is gone, and v4's one genuinely good
    # contribution -- negativing cat/dog/fox/deer BY NAME -- is kept. No mass
    # vocabulary anywhere.
    "v5": (
        "a burnt-out beast running on ALL FOURS, its whole body carried "
        "HORIZONTALLY low to the ground, longer than it is tall, no upright "
        "torso, a lean starved ribcage slung between four SHORT STURDY cracked "
        "black legs, the narrow wedge-shaped eyeless head held LOW at the FRONT "
        "of the body level with its back, one burning orange slit for an eye, "
        "entire surface a crust of cracked black charcoal like burnt bark with "
        "molten ember-orange light glowing out of the cracks, a short charred "
        "tail, ash smoke curling off its back, wide flat crouched silhouette",
        "cat, kitten, feline, dog, puppy, wolf, fox, deer, horse, domestic "
        "animal, pet, cute, spindly, long thin legs, stick legs, long whip "
        "tail, "
        "human, person, humanoid, upright, standing, standing biped, two legs, "
        "bipedal, torso, chest, waist, shoulders, arms, hands, fists, human "
        "proportions, nude, naked, bare skin, human skin, flesh, skin texture, "
        "woman, man, breasts, hair, face, nose, mouth, lips, "
        "hulking muscular, bulky, broad, armor plates, bone plates, carapace, "
        "domed shield head, pale bone tan, shaggy fur, mane, spacesuit, helmet, "
        "visor, orange cap, teal suit, green skin, moss, olive, mushroom, "
        "hovering, floating, tank treads, boxy robot, six legs, insect, crab, "
        "spider, frog, big round eyes, campfire, bonfire, torch",
    ),
}

# ── conditions: (prompt_key, ip_type, ref_kind, ip_weight) ───────────────────
# ref_kind: "cast" = vine-ranger anchor (what shipped), "brute" = the curated
# carapace-brute raw (a NON-humanoid already in pack style), None = no anchor.
CONDS = {
    # Baseline: exactly what produced the shipped sprite.
    "A": ("v2", "style transfer", "cast", 0.3),
    # Control: does the composition knob measurably do anything? Against a
    # humanoid reference it should make the humanoid read STRONGER. If A and B
    # look the same, the anchor is not the lever at all and the prompt is.
    "B": ("v2", "composition", "cast", 0.8),
    # The lead: composition transfer from a NON-humanoid reference.
    "C": ("v2", "composition", "brute", 0.8),
    # Prompt-only, no anchor: isolates how much of the humanoid is the prompt.
    "D": ("v2", None, None, 0.0),
    # v3 geometry prompt across the same reference axis.
    "E": ("v3", "style transfer", "cast", 0.3),
    "F": ("v3", "composition", "brute", 0.8),
    "G": ("v3", None, None, 0.0),
    "H": ("v3", "style transfer", "brute", 0.3),
    # Production candidate: the SHIPPED configuration (style transfer, cast
    # anchor, ipw 0.3) with ONLY the prompt changed -- iteration 1 showed the
    # reference/mode axis does not move the body plan, so the minimal diff is
    # the right one and the anchor keeps doing its actual job (style).
    # P adds the no-ground background; Q is the same without it, as the control.
    "P": ("v3", "style transfer", "cast", 0.3),
    "Q": ("v3", "style transfer", "cast", 0.3),
    # R is the production candidate: shipped config, v4 prompt.
    "R": ("v4", "style transfer", "cast", 0.3),
    "S": ("v5", "style transfer", "cast", 0.3),
}
# conditions that take the no-ground background. Measured: it does NOT remove
# the diorama base (P and Q both produced them) and it makes the creature
# spindlier and floatier, so it is not used for the production condition.
NOGROUND = {"P"}


# The pack's BG_CHAR ends "...full body, feet on the ground", which for a
# quadruped reliably paints a diorama base under the creature -- a lit ground
# slab that NEG_GROUND does not suppress and strip_ground_shadow() does not
# remove (it keys a *shadow*, not a lit patch). This drops the invitation.
BG_NOGROUND = ("single character centered on plain flat white background, "
               "full body, floating on an empty white background, no ground, "
               "no floor, no base")


def build_pos_neg(pkey, spec_dir="s", bg=None):
    import generate as G
    desc, kneg = PROMPTS[pkey]
    pos = (f"{G.TRIGGER}, full body game character sprite, {desc}, "
           f"{G.DIRS['s']}, {bg or G.BG_CHAR}, {G.LOOK}")
    # NEG_GROUND is not decoration: without it the model paints a cast shadow,
    # which the pre-rembg flat-key welded into the alpha as a grey slab a third
    # of the sprite tall at 48px (art-gen.md). Keep it on every variant.
    neg = ", ".join([kneg, G.NEG_GROUND,
                     f"two characters, crowd, cropped, close-up, portrait, {G.NEG_BASE}"])
    return pos, neg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="exp")
    ap.add_argument("--conds", default="A,B,C,D")
    ap.add_argument("--seeds", type=int, default=2)
    ap.add_argument("--base-seed", type=int, default=770100)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    if a.list:
        for k, v in CONDS.items():
            print(f"{k}: prompt={v[0]:3s} ip_type={str(v[1]):16s} ref={str(v[2]):6s} ipw={v[3]}")
        return

    import comfy
    import generate as G

    refs_cache = {}

    def get_ref(kind):
        if kind is None:
            return None
        if kind not in refs_cache:
            if kind == "cast":
                refs_cache[kind] = [os.path.join(G.ANCHORS, "vine-ranger-s-idle.png")]
            elif kind == "brute":
                refs_cache[kind] = [prep_ref(
                    os.path.join(HERE, "raws", "char.carapace-brute.s-idle.png"),
                    "ref-brute.png")]
            elif kind == "stalker":
                refs_cache[kind] = [prep_ref(
                    os.path.join(HERE, "raws", "char.mireclaw-stalker.s-idle.png"),
                    "ref-stalker.png")]
        return refs_cache[kind]

    for cond in a.conds.split(","):
        cond = cond.strip()
        pkey, ip_type, refkind, ipw = CONDS[cond]
        pos, neg = build_pos_neg(pkey, bg=BG_NOGROUND if cond in NOGROUND else None)
        refs = get_ref(refkind)
        dest = os.path.join(OUT, a.tag, cond)
        for i in range(a.seeds):
            seed = a.base_seed + i
            t0 = time.time()
            kw = dict(pos=pos, neg=neg, seed=seed, batch=1, refs=refs,
                      ip_weight=ipw, alpha=True,
                      prefix=f"exp-{a.tag}-{cond}-s{seed}")
            if ip_type:
                kw["ip_type"] = ip_type
            g = comfy.build_graph(**kw)
            paths = comfy.run(g, dest)
            print(f"[{a.tag}/{cond}] seed={seed} prompt={pkey} "
                  f"ip_type={ip_type} ref={refkind} ipw={ipw} "
                  f"-> {len(paths)} in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
