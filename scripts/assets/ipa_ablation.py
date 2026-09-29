#!/usr/bin/env python3
"""Arms of one still experiment on a character's own r2 graph, seeds fixed across arms.

The graph is the one embedded in the character's durable raw (`raws/char.<kind>.s-idle.png`,
juggernautXL + skormino LoRA + IPAdapter PLUS "style transfer" on the ranger + rembg). The shipped
sprite is the baseline; no arm anchors on the old ranger (Aaron 09-29: "not a great image"). Each arm
edits a copy:

  ipa0    IPAdapter removed; the r2 prompt unchanged (shared LOOK suffix and body template kept)
  lore    IPAdapter removed; hook-first lore prompt with its own build and palette line, drawing-medium
          words and photo negatives (sporefall-art roster_lore.MEDIUM / NEG_PHOTO); LOOK and the shared
          body template dropped
  cn      lore, plus a union ControlNet (depth) from a hand-drawn thumbnail of the outline
  concept the critic's concept pick (sporefall-art assets/identity, painterly) as the IPAdapter reference
          (linear 0.5, end 0.8) with that concept's own roster description; no ranger anywhere

    python3 ipa_ablation.py thumbs                 # draw the thumbnails
    python3 ipa_ablation.py gen <kind>             # queue every arm x seed, collect into OUT/<kind>/<arm>/
    python3 ipa_ablation.py sheet <kind>           # original | arms, 96 px on swamp + large
    python3 ipa_ablation.py measure <kind>         # sameness of every candidate vs the cast and the IPA ref
"""
import copy, json, os, sys, time, urllib.parse, urllib.request
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import comfy, post
from cast_sameness import SWAMP, compare, features, load

OUT = os.environ.get("OUT", "/mnt/d/tmp/cast-walks/sameness/exp")
CAST = ["blast-diver", "drowned-diver", "bog-mender", "cinder-husk", "bellwether", "mycologist", "bog-mutant",
        "vine-ranger", "frog-settler"]
IPA_REF_96 = "/mnt/d/tmp/cast-walks/sameness/IPA-ref-july.png"
TEAL = {3, 4, 5, 6, 7, 27}  # palette.PALETTE indices of the teal ramp and the cyan accent

PRE = "masterpiece, pixpix, 8-bit, pixel_art, full body game character sprite, 2d video game character concept art, hand-drawn, "
FRAME = (", standing facing the viewer, front view, single character centered on plain flat white background, "
         "full body, feet on the ground, bold dark outlines, chunky readable shapes, ")
NEG_PHOTO = ("photograph, photorealistic, photoreal, dslr photo, product photo, stock photo, 3d render, octane render, "
             "cgi, ray traced, hyperrealistic skin, studio photography, depth of field, bokeh, ")
NOT_STEAM = "steampunk, gears, cogs, clockwork, victorian, ornate, filigree, goggles, brass, polished copper, rivets, "

CHARS = {
    "drowned-diver": dict(
        seeds=[887200, 887201, 887202, 887203],
        # Family D: "a pressure suit with nobody in it", still walking the patrol nobody rescinded.
        lore=PRE + "an empty waterlogged colony security pressure suit still walking its patrol with nobody inside, "
             "a huge round dull grey helmet lolling to one side on drooping shoulders, its one round porthole half full "
             "of murky green swamp water with small rising bubbles and no face, one small amber status light on the chest, "
             "sagging tan-grey rubberised canvas suit streaked with oxide-orange rust and pale green-white salt crust, "
             "a faded hazard-stripe band on one sleeve, empty hands hanging, heavy weighted boots, water dripping from the cuffs, "
             "heavyset and broad-shouldered, low centre of mass, thick limbs"
             + FRAME + "tan and sand-grey rubberised canvas, oxide orange corrosion, silt brown, corroded green-white, "
             "one weak amber lamp as the only bright colour",
        neg=NEG_PHOTO + "teal suit, teal, cyan suit, blue suit, orange visor, orange cap, face, eyes, mouth, skin, gun, harpoon, rifle, "
            "weapon, vines, leaves, moss, " + NOT_STEAM,
        # front view: an oversized bowl helmet tipped to the viewer's left, one shoulder dropped, arms hanging long
        thumb=[("ellipse", (215, 95, 470, 350), 240),
               ("polygon", [(250, 330), (520, 300), (545, 560), (240, 575)], 205),
               ("polygon", [(250, 340), (205, 360), (185, 600), (245, 610)], 190),
               ("polygon", [(520, 305), (575, 330), (590, 590), (530, 590)], 190),
               ("polygon", [(265, 570), (375, 570), (370, 700), (265, 700)], 215),
               ("polygon", [(405, 565), (520, 560), (525, 700), (410, 700)], 215),
               ("ellipse", (240, 675, 385, 735), 225), ("ellipse", (395, 675, 545, 735), 225)]),
    "bog-mender": dict(
        seeds=[887100, 887101, 887102, 887103],
        # Family A trade (the tool is the outline) in Roster 2's Yellowjack colours: the medic doses the wounded with
        # distilled essence from the still it carries.
        lore=PRE + "a small hunched colony field medic carrying a huge round glass tank of glowing green essence strapped high "
             "on the back, the tank rising far above the head and wider than the shoulders, rubber hoses looping from the tank "
             "to a hand pump held in one gloved hand, a faded hazard-yellow oilcloth smock with black hazard stripes and "
             "hand-stitched patches, a quilted bone-white liner hood, a plain grey rubber breathing mask, teal-stained "
             "fingertips, short bowed legs in black rubber boots, bent forward under the weight, "
             "hunched and top-heavy, curved spine, heavy forward shoulders"
             + FRAME + "hot chemical yellow and acid citron, deep ochre hazard stripes, bone-white and charcoal, "
             "the green glow in the tank is the only bright colour",
        neg=NEG_PHOTO + "plague doctor, beak, beak mask, bird mask, crow, teal suit, teal coat, teal clothing, blue coat, orange visor, "
            "orange cap, syringe, needle, weapon, gun, knife, " + NOT_STEAM,
        # front view: a big round tank behind and above a small lowered head, bell-shaped smock, pump arm out to one side
        thumb=[("ellipse", (230, 70, 540, 380), 165),
               ("ellipse", (335, 265, 435, 365), 250),
               ("polygon", [(300, 350), (470, 350), (540, 640), (235, 640)], 220),
               ("polygon", [(465, 380), (600, 470), (580, 510), (455, 440)], 205),
               ("ellipse", (565, 455, 625, 525), 230),
               ("polygon", [(285, 630), (360, 630), (355, 715), (280, 715)], 200),
               ("polygon", [(415, 630), (490, 630), (495, 715), (420, 715)], 200),
               ("ellipse", (260, 690, 370, 735), 210), ("ellipse", (405, 690, 515, 735), 210)]),
}
ARMS = ["ipa0", "lore", "cn", "concept"]
IDENTITY = "/mnt/d/Projects/sporefall-art/assets/identity"
CONCEPT = {
    # critic picks, /mnt/d/tmp/cast-walks/critique/concept-picks.md; text from sporefall-art sprites/roster_lore2.py
    "bog-mender": (f"{IDENTITY}/lore/gauze-mother.png",
                   PRE + "a tall pale colony caretaker in a floor-length pale linen shift with a wide stiff yoke at the "
                   "shoulders, six long gauze ribbons hanging from the yoke to the floor, both hands folded at the sternum, "
                   "hair bound in white cloth, teal-stained fingertips, one small glass vial of glowing green essence hung "
                   "at the yoke, a narrow bell shape with long vertical streamers" + FRAME +
                   "bleached bone-white and chalk, salt-crusted linen, dry paper-tan, one cold pale-cyan glow",
                   "anime, cute, sexy, bare skin, cleavage, "),
    "drowned-diver": (f"{IDENTITY}/lore/bloat-purser.png",
                      PRE + "a hugely swollen drowned colonist in a burst grey hooded rain uniform coat that no longer "
                      "closes, the torso rounded and taut, the hood pulled low over a hidden face, small hands and small "
                      "head by contrast, short legs sunk into oversized waterlogged black boots, everything sagging, water "
                      "dripping from the hem" + FRAME + "waterlogged grey-green and drowned slate, silt brown, one weak lamp-yellow",
                      "helmet, diving helmet, gun, harpoon, weapon, "),
}


def raw_graph(kind: str) -> dict:
    return json.loads(Image.open(os.path.join(HERE, "raws", f"char.{kind}.s-idle.png")).info["prompt"])


def drop_ipa(g: dict) -> dict:
    for k in ("8", "9", "20"):
        g.pop(k, None)
    g["6"]["inputs"]["model"] = ["2", 0]
    return g


def add_cn(g: dict, image_name: str, strength=0.6, end=0.6) -> dict:
    g["40"] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": "xinsir-controlnet-union-sdxl-1.0-promax.safetensors"}}
    g["41"] = {"class_type": "SetUnionControlNetType", "inputs": {"control_net": ["40", 0], "type": "depth"}}
    g["42"] = {"class_type": "LoadImage", "inputs": {"image": image_name}}
    g["43"] = {"class_type": "ControlNetApplyAdvanced",
               "inputs": {"positive": ["3", 0], "negative": ["4", 0], "control_net": ["41", 0], "image": ["42", 0],
                          "strength": strength, "start_percent": 0.0, "end_percent": end, "vae": ["1", 2]}}
    g["6"]["inputs"]["positive"], g["6"]["inputs"]["negative"] = ["43", 0], ["43", 1]
    return g


def arm_graph(kind: str, arm: str, seed: int, thumb_name: str | None, concept_name: str | None = None) -> dict:
    spec, g = CHARS[kind], copy.deepcopy(raw_graph(kind))
    r2neg = g["4"]["inputs"]["text"]
    if arm in ("lore", "cn"):
        g["3"]["inputs"]["text"] = spec["lore"]
        g["4"]["inputs"]["text"] = spec["neg"] + r2neg
    if arm == "concept":
        _, pos, neg = CONCEPT[kind]
        ground, tail = r2neg.index("ground, dirt patch"), r2neg.index("two characters")
        body = r2neg[ground:tail].split("elongated,")[0]  # the ground/shadow negatives, not the thin-body ones
        g["3"]["inputs"]["text"] = pos
        g["4"]["inputs"]["text"] = NEG_PHOTO + neg + NOT_STEAM + "teal suit, orange visor, orange cap, " + body + r2neg[tail:]
        g["20"]["inputs"]["image"] = concept_name
        g["9"]["inputs"].update(weight=0.5, weight_type="linear", end_at=0.8)
    else:
        drop_ipa(g)
    if arm == "cn":
        add_cn(g, thumb_name)
    g["6"]["inputs"]["seed"] = seed
    g["12"]["inputs"]["filename_prefix"] = f"sameness-{kind}-{arm}-s{seed}"
    return g


def thumbs():
    for kind, spec in CHARS.items():
        im = Image.new("L", (768, 768), 0)
        d = ImageDraw.Draw(im)
        for shape, xy, v in spec["thumb"]:
            getattr(d, shape)(xy, fill=v)
        path = f"{OUT}/{kind}/thumb.png"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        im.convert("RGB").save(path)
        print(path)


def gen(kind: str):
    thumb = comfy.upload(f"{OUT}/{kind}/thumb.png")
    concept = comfy.upload(CONCEPT[kind][0])
    jobs = []
    for arm in ARMS:
        for s in CHARS[kind]["seeds"]:
            pid = comfy.post("/prompt", {"prompt": arm_graph(kind, arm, s, thumb, concept)})["prompt_id"]
            jobs.append((pid, arm, s))
    json.dump({a: arm_graph(kind, a, CHARS[kind]["seeds"][0], thumb, concept) for a in ARMS}, open(f"{OUT}/{kind}/graphs.json", "w"), indent=1)
    pending = list(jobs)
    t0 = time.time()
    while pending:
        time.sleep(3)
        for job in list(pending):
            pid, arm, s = job
            try:
                h = json.load(urllib.request.urlopen(f"{comfy.HOST}/history/{pid}", timeout=30)).get(pid)
            except Exception:
                continue
            if not h:
                continue
            if h.get("status", {}).get("status_str") == "error":
                raise RuntimeError(json.dumps(h["status"])[:2000])
            ims = [i for o in h["outputs"].values() for i in o.get("images", [])]
            if not ims:
                continue
            q = urllib.parse.urlencode({"filename": ims[-1]["filename"], "subfolder": ims[-1].get("subfolder", ""), "type": ims[-1]["type"]})
            os.makedirs(f"{OUT}/{kind}/{arm}", exist_ok=True)
            with urllib.request.urlopen(f"{comfy.HOST}/view?{q}") as r, open(f"{OUT}/{kind}/{arm}/s{s}.png", "wb") as f:
                f.write(r.read())
            pending.remove(job)
            print(f"{time.time() - t0:5.0f}s {arm} {s}", flush=True)


def candidates(kind: str) -> dict[str, list[tuple[int, Image.Image]]]:
    return {arm: [(s, Image.open(f"{OUT}/{kind}/{arm}/s{s}.png").convert("RGBA")) for s in CHARS[kind]["seeds"]] for arm in ARMS}


def fit(im: Image.Image, w: int, h: int) -> Image.Image:
    im = im.copy()
    im.thumbnail((w, h), Image.LANCZOS)
    return im


def sheet(kind: str, context=("drowned-diver", "mycologist", "bog-mender", "blast-diver")):
    """Top: the picks (PICKS="arm:seed,...") in the shipped lineup at 96 and 192 px on swamp. Below: every arm."""
    seeds = CHARS[kind]["seeds"]
    cands = candidates(kind)
    picks = [p.split(":") for p in os.environ.get("PICKS", "").split(",") if p]
    band = [(k, load(k)) for k in context if k != kind] + [(f"{kind} shipped", load(kind))]
    band += [(f"{arm} {s}", post.sprite(dict(cands[arm])[int(s)], 96, 92)) for arm, s in picks]
    rows = [("shipped", [load(kind)], [Image.open(os.path.join(HERE, "raws", f"char.{kind}.s-idle.png")).convert("RGBA")])]
    rows += [(arm, [post.sprite(im, 96, 92) for _, im in c], [im for _, im in c]) for arm, c in cands.items()]
    big, pad, lab = 200, 8, 16
    W = max(90 + 4 * 100 + pad + 4 * (big + pad), pad + len(band) * 200)
    top = lab + 96 + lab + 192 + pad
    H = top + lab + len(rows) * (big + pad)
    sh = Image.new("RGBA", (W, H), (236, 234, 226, 255))
    d = ImageDraw.Draw(sh)
    ink, gold = (20, 24, 24, 255), (255, 210, 120, 255)
    d.rectangle((0, 0, W, top), fill=SWAMP + (255,))
    d.text((pad, 2), f"{kind}: picks beside the shipped cast, 96 px (game scale) and 2x, swamp ground (12,20,22)", fill=gold)
    for i, (name, im) in enumerate(band):
        d.text((pad + i * 200, lab + 96 + 2), name, fill=gold)
        sh.alpha_composite(im, (pad + i * 200 + 48, lab))
        sh.alpha_composite(im.resize((192, 192), Image.NEAREST), (pad + i * 200, lab + 96 + lab))
    d.text((pad, top + 2), f"every arm, seeds {seeds[0]}-{seeds[-1]} in each. Left: 96 px on swamp. Right: the raw still.", fill=ink)
    for r, (arm, small, larges) in enumerate(rows):
        y = top + lab + r * (big + pad)
        d.text((pad, y + big // 2), arm, fill=ink)
        d.rectangle((90, y, 90 + 4 * 100, y + big), fill=SWAMP + (255,))
        for i, im in enumerate(small):
            sh.alpha_composite(im, (92 + i * 100, y + (big - 96) // 2))
            if arm != "shipped":
                d.text((94 + i * 100, y + big - 14), str(seeds[i]), fill=gold)
        for i, im in enumerate(larges):
            sh.alpha_composite(fit(im, big, big), (90 + 4 * 100 + pad + i * (big + pad), y))
    path = f"{OUT}/{kind}/sheet.png"
    sh.convert("RGB").save(path)
    print(path, sh.size)


def teal_share(im: Image.Image) -> float:
    return float(sum(features(im)["pal"][i] for i in TEAL))


def measure(kind: str):
    others = {k: features(load(k)) for k in CAST if k != kind}
    ref = features(load(IPA_REF_96))
    shipped = load(kind)
    lines = [f"{kind}: mean over 4 seeds. cast = the other {len(others)} shipped humanoids + frog. higher same = more alike.",
             f"{'arm':8s} {'same-cast':>9s} {'nearest':>22s} {'same-ref':>8s} {'iou-ref':>7s} {'teal%':>6s} {'aspect':>6s}"]
    rows = {"shipped": [shipped]} | {a: [post.sprite(im, 96, 92) for _, im in c] for a, c in candidates(kind).items()}
    out = {}
    for arm, ims in rows.items():
        m = []
        for im in ims:
            f = features(im)
            vs = {k: compare(f, g)["same"] for k, g in others.items()}
            near = max(vs, key=vs.get)
            m.append(dict(cast=np.mean(list(vs.values())), near=near, near_v=vs[near], ref=compare(f, ref)["same"],
                          iou_ref=compare(f, ref)["iou"], teal=teal_share(im), aspect=f["aspect"]))
        agg = {k: float(np.mean([x[k] for x in m])) for k in ("cast", "near_v", "ref", "iou_ref", "teal", "aspect")}
        nears = sorted({x["near"] for x in m})
        out[arm] = agg | {"nearest": nears, "per_seed": m}
        lines.append(f"{arm:8s} {agg['cast']:9.3f} {','.join(n[:9] for n in nears)[:16]:>16s} {agg['near_v']:.3f} "
                     f"{agg['ref']:8.3f} {agg['iou_ref']:7.3f} {100 * agg['teal']:5.1f}% {agg['aspect']:6.2f}")
    text = "\n".join(lines)
    open(f"{OUT}/{kind}/measure.txt", "w").write(text + "\n")
    json.dump(out, open(f"{OUT}/{kind}/measure.json", "w"), indent=1, default=str)
    print(text)


if __name__ == "__main__":
    cmd = sys.argv[1]
    {"thumbs": lambda: thumbs(), "gen": lambda: gen(sys.argv[2]), "sheet": lambda: sheet(sys.argv[2]),
     "measure": lambda: measure(sys.argv[2])}[cmd]()
