#!/usr/bin/env python3
"""Keep a theme manifest's tile pools in sync with the tiles on disk. A stale
manifest silently breaks the game: if a macro pool lists fewer files than
`macro*macro`, the engine falls out of the macro path to per-tile hashing and
the carefully-authored continuity never ships (this exact bug shipped the bog
checkerboard — the manifest listed 8 of 48 grass tiles). Run after any tile
regeneration.

    python3 sync_manifest.py [--theme public/themes/swampspace-hires] [--check]

--check exits non-zero on any mismatch (CI gate) without writing.
"""
import argparse
import glob
import json
import os
import sys

# tile.<name> pools whose file set is discovered from disk (base + accent +
# overlay). Non-tile sprite keys (chars/props/items/fx) are left untouched.
POOLS = [
    ("tile.{n}", "{n}-[0-9]*.png"),
    ("tile.{n}.accent", "{n}-accent-*.png"),
    ("tile.{n}.overlay", "{n}-overlay-*.png"),
]
SURFACES = ["street", "sidewalk", "floor", "wall", "grass", "exit"]


def num(path):
    b = os.path.basename(path)
    return int(b.rsplit("-", 1)[1].split(".")[0])


def discover(tiles_dir, pattern):
    fs = glob.glob(os.path.join(tiles_dir, pattern))
    fs = [f for f in fs if f.split("-")[-1].split(".")[0].isdigit()]
    return [f"tiles/{os.path.basename(f)}" for f in sorted(fs, key=num)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="public/themes/swampspace-hires")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    mpath = os.path.join(args.theme, "manifest.json")
    m = json.load(open(mpath))
    tiles_dir = os.path.join(args.theme, "tiles")
    sprites = m["sprites"]
    macro = m.get("macroTiles", {})
    changed, problems = [], []

    for surf in SURFACES:
        for key_t, pat_t in POOLS:
            key = key_t.format(n=surf)
            if key not in sprites:
                continue
            found = discover(tiles_dir, pat_t.format(n=surf))
            if not found:
                continue
            if list(sprites[key]) != found:
                changed.append(f"{key}: {len(sprites[key])} -> {len(found)}")
                sprites[key] = found
        # macro sanity: base pool must have >= macro^2 tiles
        need = macro.get(surf, 0) ** 2
        have = len(sprites.get(f"tile.{surf}", []))
        if need and have < need:
            problems.append(f"{surf}: macro={macro[surf]} needs>={need} but pool has {have}")

    if args.check:
        for c in changed:
            print(f"OUT OF SYNC: {c}")
        for p in problems:
            print(f"MACRO UNDERFILLED: {p}")
        if changed or problems:
            print(f"{len(changed)+len(problems)} manifest issues")
            return 1
        print("manifest in sync with disk")
        return 0

    if changed:
        json.dump(m, open(mpath, "w"), indent=1)
        for c in changed:
            print(f"synced {c}")
    else:
        print("already in sync")
    for p in problems:
        print(f"WARNING macro underfilled: {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
