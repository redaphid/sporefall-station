#!/usr/bin/env python3
"""Build throwaway REVIEW theme packs so candidate props can be photographed
IN A ROOM rather than on a contact sheet.

Each pack is a byte-copy of swampspace with exactly one candidate sprite per
new archetype swapped in, so a shot of pack A and a shot of pack B differ in
NOTHING but the sprite under test -- same room, same neighbours, same tint,
same camera. That is the only fair way to compare two picks.

Nothing here ships: packs are written under public/themes/_review-* and are
gitignored. Delete the dirs and the repo is unchanged.

    python build_review_themes.py

REQUIRES A TWO-LINE ENGINE EDIT, DELIBERATELY NOT COMMITTED. For the engine to
render these packs you must add the new names to `PROP_NAMES`
(src/render/theme.ts) and map archetype -> key in `PROP_SPRITE`
(src/render/art.ts). Those edits are NOT on this branch on purpose:
`artResolution.test.ts` asserts that every `PROP_SPRITE` target resolves to a
file in the SHIPPED manifests, and it is right to -- an unbacked mapping is how
a prop silently renders as nothing. The mapping belongs in the commit that
lands the art, not before it. Apply the two edits locally to shoot a review,
and revert them.
"""
from __future__ import annotations
import json, os, shutil, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import post as P
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
THEMES = REPO / "public/themes"
SRC = THEMES / "swampspace"
GEN = Path(os.environ.get("EXP_OUT", "D:/tmp/props-gen"))

# archetype key -> (sweep tag, subject dir, seed)
SETS = {
    "A": {"shelf": ("p2", "storage-rack", 1001), "chair": ("p2", "mess-chair", 1000),
          "bunk": ("p2", "crew-bunk", 1000), "bench": ("p2", "transit-bench", 1000),
          "table": ("p2", "mess-table", 1000)},
    "B": {"shelf": ("p2", "storage-rack", 1005), "chair": ("p2", "mess-chair", 1002),
          "bunk": ("p2", "crew-bunk", 1004), "bench": ("p2", "transit-bench", 1003),
          "table": ("p2", "mess-table", 1001)},
    "C": {"shelf": ("p3", "storage-rack", 1004), "chair": ("p2", "mess-chair", 1005),
          "bunk": ("p2", "crew-bunk", 1006), "bench": ("p2", "transit-bench", 1006),
          "table": ("p2", "mess-table", 1007)},
}
PX = 32


def to_sprite(raw: Path) -> Image.Image:
    """Exactly the shipping prop post: key -> strip ground -> k-centroid ->
    palette -> centered on a 32px canvas (generate.py `final`, cat != char)."""
    return P.sprite(Image.open(raw), PX, content=PX - 2, anchor="center")


def build(tag: str, picks: dict) -> None:
    dst = THEMES / f"_review-{tag}"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(SRC, dst)
    man = json.loads((dst / "manifest.json").read_text(encoding="utf8"))
    man["name"] = f"Swampspace REVIEW {tag}"
    for arch, (sweep, subj, seed) in picks.items():
        raw = GEN / sweep / subj / f"seed{seed:05d}.png"
        if not raw.exists():
            raise SystemExit(f"missing raw {raw}")
        out = dst / "props" / f"{arch}.png"
        to_sprite(raw).save(out)
        man["sprites"][f"prop.{arch}"] = f"props/{arch}.png"
        print(f"  {tag}: prop.{arch} <- {sweep}/{subj}/seed{seed:05d}")
    (dst / "manifest.json").write_text(json.dumps(man, indent=1), encoding="utf8")
    # Register so the loader can find it by id.
    idx_p = THEMES / "index.json"
    idx = json.loads(idx_p.read_text(encoding="utf8"))
    if not any(e.get("id") == f"_review-{tag}" for e in idx):
        idx.append({"id": f"_review-{tag}", "name": man["name"]})
    idx_p.write_text(json.dumps(idx, indent=2), encoding="utf8")

if __name__ == "__main__":
    for tag, picks in SETS.items():
        build(tag, picks)
    print("review packs built")
