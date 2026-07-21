#!/usr/bin/env python3
"""Single source of truth for the THEME-SPECIFIC knobs of the tileset pipeline.

To make a tile set for a NEW theme, copy this file's THEME dict, change the five
sections below, and point the pipeline at it with `THEME_CONFIG=<module>` (or edit
in place). Everything else in the pipeline (generation, seamless, downscale, gates,
field assembly) is theme-agnostic. See `.claude/skills/themed-tilesets`.

The default THEME is `swampspace-hires` — a dark alien-swamp / abandoned space
outpost sinking into a bog. Import as:  `from theme_config import THEME`.
"""
import importlib
import os

# ---------------------------------------------------------------------------
# swampspace-hires — the worked example. Duplicate + edit for a new theme.
# ---------------------------------------------------------------------------
SWAMP = {
    "id": "swampspace-hires",
    "tiles_dir": "../../public/themes/swampspace-hires/tiles",

    # 1. PALETTE — a small locked list; every tile snaps to it (cohesion lever).
    #    Derive from a dominant-color mood study. (Lives in palette.py; listed here
    #    so a retarget has ONE place to look. Keep palette.py in sync or import it.)
    "palette_module": "palette",   # module exposing RGB / PALETTE

    # 2. VALUE BANDS — mean luminance per surface; touching surfaces ≥1 band apart;
    #    ground dark, structure a step up, goal the one hot value.
    "bands": {"wall": 30.0, "street": 40.0, "grass": 54.0, "floor": 82.0,
              "sidewalk": 118.0, "exit": 150.0},

    # 3. ORGANIC-GROUND terrains (themed_ground.py diverse mode) — one master each,
    #    all in the ONE dark palette so snapping them together reads as varied terrain.
    "diverse": {
        "grass": [
            "dense olive-green moss and low creeping vines carpeting the ground, thick overgrowth, a few dark roots",
            "open pool of dark greeny-blue swamp water and black mud, mossy banks and floating vegetation around the edges, wet",
            "thick tangle of dark brown roots and gnarled vines over mud, sparse moss, twisted overgrowth",
            "rocky boggy mire, wet dark stones and gravel with patches of moss and small murky puddles, scattered debris",
            "half-sunken rusted metal grating and outpost debris swallowed by moss and vines, dark swamp reclaiming the wreck",
        ],
    },

    # 4. STRUCTURED-SURFACE prompts (tiles_genesis_sd.py UNITS) — value + fiction.
    #    (kind, macro/units, subject, denoise). Kept in tiles_genesis_sd for now;
    #    named here as the retarget checklist.
    "structured": ["floor", "street", "sidewalk", "wall", "exit"],

    # 5. THE FICTION — one line, fed into prompts so the whole set feels like one world.
    "fiction": ("abandoned space outpost sinking into a dark alien swamp — tangled "
                "vines and roots over sunken rusted metal, faint glowing green spores "
                "and amber embers, overgrown, wet, moody, low light"),

    # Generation recipe (rarely changes across themes).
    "ckpt": "SDXL1.0/juggernautXL_ragnarokBy.safetensors",
    "lora": "XL/pixel-art-xl.safetensors",
    "lora_w": 0.7,
    "seamless_mode": "circular",
}

THEMES = {"swampspace-hires": SWAMP}


def load():
    """Return the active theme config. `THEME_CONFIG=<module>` overrides with a
    module exposing THEME; else THEME_ID selects from THEMES; else the swamp."""
    mod = os.environ.get("THEME_CONFIG")
    if mod:
        return importlib.import_module(mod).THEME
    return THEMES[os.environ.get("THEME_ID", "swampspace-hires")]


THEME = load()
