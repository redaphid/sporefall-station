#!/usr/bin/env python3
"""Emit public/themes/swampspace/manifest.json (theme schema v1, docs/themes.md).

Only keys whose asset file actually exists are emitted — a partially generated
pack still ships a valid manifest (the engine falls back per key).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import generate as G
from palette import PALETTE

THEME = G.THEME

NAMES = {
    "player": "Ranger",
    "cop": "Spore Warden",
    "bouncer": "Airlock Warden",
    "thug": "Bog Mutant",
    "boss": "Mireclaw Alpha",
    "gangster": "Rootcult Enforcer",
    "civilian": "Settler",
    "shopkeeper": "Barter Frog",
    "scientist": "Mycologist",
    "robot": "Derelict Unit",
    "crate": "Cargo Pod",
    "barrel": "Spore Barrel",
    "atm": "Cryo Terminal",
    "vending": "Nutrient Dispenser",
    "tv": "Console",
    "toilet": "Hydro Recycler",
    "door": "Bulkhead Hatch",
    "door.open": "Open Hatch",
    "fire": "Phosphor Fire",
    "exit": "Launch Bay",
}

PALETTE_SECTION = {
    # canvas + procedural colors keep the Flashback Titan mood for anything
    # that has no sprite (streets, grass, exit pad, procedural blobs).
    "background": "#0c1416",
    "uiAccent": "#46e078",
    "tiles": {
        "street": "#16282c",     # phosphorescent shallows / flooded deck
        "sidewalk": "#23323a",   # walkway grating
        "floor": "#2a3626",      # (procedural fallback under tile.floor)
        "wall": "#141a16",
        "grass": "#35511a",      # bog overgrowth
        "exit": "#46e078",       # launch-bay pad glows spore-green
    },
    "entities": {
        "boss": "#a05ae0",
        "gangster": "#7b8791",
        "bouncer": "#59636d",
        "shopkeeper": "#b08d50",
        "crate": "#6b4d26",
    },
}

CHAR_FILES = {arch: kind for arch, (kind, *_rest) in G.CHARS.items()}
CHAR_FILES.update({arch: CHAR_FILES[t] for arch, t in G.CHAR_ALIASES.items()
                   if t in CHAR_FILES and arch in ("gangster",)})

ITEM_KEYS = {  # engine item id -> our themed file (items table key)
    "pistol": "spore-pistol", "bat": "root-club", "knife": "shard-knife",
    "medkit": "biogel-kit", "cash": "credit-chits", "shotgun": "scatter-blaster",
    "molotov": "phosphor-flask", "grenade-item": "spore-grenade",
}
PROP_KEYS = {  # engine prop name -> props table key
    "barrel": "spore-barrel", "atm": "cryo-terminal",
    "vending-machine": "nutrient-dispenser", "tv": "console-monitor",
    "toilet": "hydro-recycler",
}


def exists(rel):
    return os.path.exists(os.path.join(THEME, rel))


def build():
    sprites = {}

    def put(key, rel):
        if exists(rel):
            sprites[key] = rel
        else:
            print(f"  (missing, key omitted: {key} -> {rel})", file=sys.stderr)

    put("tile.floor", "tiles/deck-moss.png")
    put("tile.wall", "tiles/root-bulkhead.png")
    for arch, kind in CHAR_FILES.items():
        for d in G.DIRS:
            for frame in ("idle", "step"):
                put(f"char.{arch}.{d}-{frame}", f"chars/{kind}-{d}-{frame}.png")
    put("prop.default", "props/cargo-pod.png")
    for eng, ours in PROP_KEYS.items():
        put(f"prop.{eng}", f"props/{ours}.png")
    put("item.default", "items/biogel-kit.png")
    for eng, ours in ITEM_KEYS.items():
        put(f"item.{eng}", f"items/{ours}.png")
    put("projectile", "fx/spore-bolt.png")
    put("grenade", "fx/spore-pod.png")

    def put_clip(key, rels):
        have = [r for r in rels if exists(r)]
        if have:
            sprites[key] = have

    put_clip("fx.flame", [f"fx/biolume-flame-{i}.png" for i in (1, 2, 3)])
    put_clip("fx.explosion", [f"fx/spore-burst-{i}.png" for i in (1, 2, 3)])
    put_clip("fx.hit", ["fx/hit-spark.png"])
    put_clip("fx.pickup", ["fx/pickup-sparkle.png"])
    put_clip("fx.blood", ["fx/ichor-splat.png"])

    manifest = {
        "name": "Sporefall Station",
        "version": 1,
        "palette": PALETTE_SECTION,
        "names": NAMES,
        "sprites": sprites,
    }
    out = os.path.join(THEME, "manifest.json")
    json.dump(manifest, open(out, "w"), indent=2)
    print(f"{out}: {len(sprites)} sprite keys")

    # register in the theme picker index
    idx_path = os.path.join(os.path.dirname(THEME), "index.json")
    idx = json.load(open(idx_path)) if os.path.exists(idx_path) else []
    if not any(e.get("id") == "swampspace" for e in idx):
        idx.append({"id": "swampspace", "name": "Sporefall Station"})
        json.dump(idx, open(idx_path, "w"), indent=2)
        print(f"registered in {idx_path}")


if __name__ == "__main__":
    build()
