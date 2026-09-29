"""Step 0 redesign from a concept image: one paired batch, then a veto sheet for Aaron.

    python3 scripts/assets/step0_concept.py gen   SPEC.json   # needs ComfyUI; hold GPU-WAN.lock
    python3 scripts/assets/step0_concept.py sheet SPEC.json   # CPU only

The graph is the character's own r2 raw (juggernautXL + pixel LoRA + rembg) with its texts and
seed swapped. Each route in SPEC["routes"] runs every seed, so routes compare at a held seed:
  {"ipa": null}                      anchor off: the IPAdapter nodes are removed
  {"ipa": {"weight": w, "end_at": e}} the concept (padded square, so CLIP's centre crop keeps the
                                      whole figure) replaces the r2 cast's shared vine-ranger ref
The sheet shows current | concept | candidates at 96 px on the swamp floor beside SPEC["compare"],
then a large row. Each 96 px label carries the teal share the critic measured (hue 150-200, s > .2).
"""
import colorsys, copy, json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw
import comfy, post

CHARS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../public/themes/swampspace-hires/chars")
SWAMP = (12, 20, 22)
IPA_NODES = ("8", "9", "20")


def teal_share(im):
    rgba = im.convert("RGBA")
    px = [p for p in getattr(rgba, "get_flattened_data", rgba.getdata)() if p[3] > 128]
    teal = 0
    for r, g, b, _ in px:
        h, _, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        teal += 150 <= h * 360 <= 200 and s > 0.2
    return teal / max(1, len(px))


def square_ref(spec):
    im = Image.open(spec["concept"]).convert("RGB")
    if spec.get("concept_crop"):
        im = im.crop(tuple(spec["concept_crop"]))
    side = max(im.size)
    sq = Image.new("RGB", (side, side), tuple(spec.get("concept_pad", (0, 0, 0))))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    path = os.path.join(spec["out"], "concept-ref-square.png")
    sq.save(path)
    return path


def graph_for(g0, spec, route, seed, ref_name):
    g = copy.deepcopy(g0)
    g["3"]["inputs"]["text"] = spec["prompt"]
    g["4"]["inputs"]["text"] = spec["neg"]
    g["6"]["inputs"]["seed"] = seed
    ipa = spec["routes"][route]["ipa"]
    if ipa is None:
        for k in IPA_NODES:
            del g[k]
        g["6"]["inputs"]["model"] = ["2", 0]
    else:
        g["20"]["inputs"]["image"] = ref_name
        g["9"]["inputs"].update(weight=ipa["weight"], end_at=ipa["end_at"])
    g["12"]["inputs"]["filename_prefix"] = f"cast-walks-{spec['kind']}-step0-{route}-s{seed}"
    return g


def generate(spec):
    g0 = json.loads(Image.open(spec["graph"]).info["prompt"])
    assert all(k in g0 for k in IPA_NODES), "r2 graph lost its IPAdapter nodes; graph_for assumes them"
    ref_name = comfy.upload(square_ref(spec))
    raw = os.path.join(spec["out"], "raw")
    for route in spec["routes"]:
        for s in spec["seeds"]:
            print(route, s, "->", comfy.run(graph_for(g0, spec, route, s, ref_name), raw)[-1], flush=True)
    comfy.post("/free", {"unload_models": True, "free_memory": True})


def fit(im, w, h):
    s = min(w / im.width, h / im.height)
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)


def candidates(spec):
    raw = os.path.join(spec["out"], "raw")
    out = []
    for route in spec["routes"]:
        for s in spec["seeds"]:
            f = next(f for f in sorted(os.listdir(raw)) if f.startswith(f"cast-walks-{spec['kind']}-step0-{route}-s{s}_"))
            out.append((f"{route}{s % 100}", Image.open(os.path.join(raw, f)).convert("RGBA")))
    return out


def sheet(spec):
    current = Image.open(f"{CHARS}/{spec['kind']}-s-idle.png").convert("RGBA")
    concept = Image.open(spec["concept"]).convert("RGBA")
    cands = candidates(spec)
    small = [(n, post.sprite(im, 96, 92)) for n, im in cands]
    cell, pad, lab, big = 104, 10, 18, 230
    ink, pale, gold, grey = (20, 24, 24, 255), (230, 230, 210, 255), (255, 210, 120, 255), (150, 170, 170, 255)
    caption = spec.get("caption", "")
    cap_h = lab * (caption.count("\n") + 1) + pad
    row_w = pad + (2 + len(small) + 1 + len(spec["compare"])) * cell
    big_cols = 2 + len(cands)
    per_big = max(1, (row_w - pad) // (big + pad))
    big_rows = -(-big_cols // per_big)
    W = max(row_w, pad + min(big_cols, per_big) * (big + pad))
    top = cap_h
    row96 = top + lab
    grid = row96 + 96 + lab + pad
    H = grid + big_rows * (lab + big + pad)
    sh = Image.new("RGBA", (W, H), (236, 234, 226, 255))
    d = ImageDraw.Draw(sh)
    d.multiline_text((pad, 4), caption, fill=ink, spacing=6)
    d.rectangle((0, top, W, grid - pad // 2), fill=SWAMP + (255,))
    d.text((pad, top + 2), "96 px on the swamp floor (12,20,22).  Label: candidate, teal share of opaque px (critic's measure).  "
           "Right: the humanoids it must not twin.", fill=pale)
    concept96 = fit(concept, 96, 92)
    cols = [("current", current, grey), ("concept", concept96, grey)] + [(n, im, gold) for n, im in small]
    for i, (n, im, c) in enumerate(cols):
        x = pad + i * cell
        sh.alpha_composite(im, (x + (96 - im.width) // 2, row96 + 96 - im.height))
        d.text((x + 2, row96 + 97), f"{n} {teal_share(im):.0%}", fill=c)
    for j, kind in enumerate(spec["compare"]):
        x = pad + (len(cols) + 1 + j) * cell
        im = Image.open(f"{CHARS}/{kind}-s-idle.png").convert("RGBA")
        sh.alpha_composite(im, (x, row96))
        d.text((x + 2, row96 + 97), f"{kind[:10]} {teal_share(im):.0%}", fill=grey)
    bigs = [("current (shipped)", current.resize((big, big), Image.NEAREST)), ("concept", fit(concept, big, big))] + \
           [(n, fit(im, big, big)) for n, im in cands]
    for i, (n, im) in enumerate(bigs):
        x = pad + (i % per_big) * (big + pad)
        y = grid + (i // per_big) * (lab + big + pad)
        d.text((x, y), n, fill=ink)
        sh.alpha_composite(im, (x + (big - im.width) // 2, y + lab))
    path = os.path.join(spec["out"], spec.get("sheet", "redesign.png"))
    sh.convert("RGB").save(path)
    print(path, sh.size)


if __name__ == "__main__":
    spec = json.load(open(sys.argv[2]))
    {"gen": generate, "sheet": sheet}[sys.argv[1]](spec)
