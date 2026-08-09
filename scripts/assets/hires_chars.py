#!/usr/bin/env python3
"""Post curated character raws into the HI-RES theme at 96px and register them.

`generate.py final` only writes the 48px `swampspace` pack, but the game's
DEFAULT theme is `swampspace-hires` (src/app/settings.ts) — so art that stops at
`final` is art the player never sees. This is the second half of shipping a
character.

It is surgical on purpose. The hi-res manifest is NOT a re-render of the low-res
one: it carries its own tile pools, walk-cycle clips and `artScale`, and
regenerating it wholesale from the recipe list would drop all of that. So this
only adds/overwrites the char keys it is asked for and leaves every other key
untouched.

    python hires_chars.py char.mireclaw-stalker.s-idle [...]
    python hires_chars.py --all-curated

96px with 92px of content mirrors what regen_attacks.py already posts, so the
new sprites sit at the same scale as the shipped hi-res cast.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate as G  # noqa: E402
import post as P  # noqa: E402
from PIL import Image  # noqa: E402

HIRES = os.path.join(G.REPO, "public", "themes", "swampspace-hires")
PX, CONTENT = 96, 92
DIRS5 = ("s", "se", "e", "ne", "n")


def post_job(job, manifest):
    spec = G.jobs()[job]
    if spec.get("cat") != "char":
        print(f"  skip {job}: not a character job")
        return 0
    cur = G.load_curation().get(job)
    raw = G.resolve_raw(job, cur)
    if not raw or not os.path.exists(raw):
        print(f"  skip {job}: no durable raw — curate it first")
        return 0
    kind, arch = spec["kind"], spec["arch"]
    rel = f"chars/{kind}-s-idle.png"
    dst = os.path.join(HIRES, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    P.sprite(Image.open(raw), PX, content=CONTENT, anchor="bottom").save(dst)
    # Every direction borrows `s` (theme.ts DIR_FALLBACK), and the engine reads
    # the mapping not the filename, so one drawn pose fills the whole set until
    # real per-direction art exists.
    n = 0
    for d in DIRS5:
        for frame in ("idle", "step"):
            manifest["sprites"][f"char.{arch}.{d}-{frame}"] = rel
            n += 1
    name = __import__("manifest").NAMES.get(arch)
    if name:
        manifest.setdefault("names", {})[arch] = name
    print(f"  {job} -> {rel} ({PX}px, {n} keys)")
    return n


if __name__ == "__main__":
    args = sys.argv[1:]
    jobs = ([j for j, s in G.jobs().items()
             if s.get("cat") == "char" and j in G.load_curation()]
            if "--all-curated" in args else [a for a in args if not a.startswith("--")])
    if not jobs:
        print(__doc__)
        sys.exit(1)
    mpath = os.path.join(HIRES, "manifest.json")
    man = json.load(open(mpath))
    before = len(man["sprites"])
    for j in jobs:
        post_job(j, man)
    json.dump(man, open(mpath, "w"), indent=1)
    print(f"{mpath}: {before} -> {len(man['sprites'])} sprite keys")
