#!/usr/bin/env python3
"""Measure mod and round colours against the swamp floors and the locked palette.

Run from the repo root:  python3 docs/design/setting-fit/hue-check.py

The "today" rows are read from the live source, so they re-measure whatever
the branch ships:
  - MOD_PICKUP_COLORS in src/render/modColors.ts (the gem, the held-gun tint,
    and the core hue of every modded round)
  - BASE_BULLET_COLOR in src/render/bulletVisuals.ts (an unmodded round when
    the theme has no projectile sprite, and every NPC round)
  - the floor colours of public/themes/swampspace-hires/manifest.json
  - the locked 34-colour PALETTE in scripts/assets/palette.py
The "proposed" rows are the colours setting-fit.md proposes, so the report's
own proposals are measured by the same rules.

Columns:
  dE pal   CIE76 distance to the nearest palette entry. Under 12 reads as
           "belongs to the pack".
  |dL| min the smallest lightness gap to any floor, and which floor. Under 15
           means the colour is a same-lightness shape on that floor at gameplay
           zoom and needs a rim or halo to read.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / "scripts" / "assets"))
from palette import PALETTE  # noqa: E402

HOT = {"#46e078", "#a6ffbe", "#3ce0d8", "#ffd83e", "#ff9032", "#e04a2a", "#a05ae0"}
FLOOR_KEYS = ("street", "floor", "grass", "bog", "hall", "plating", "grate", "tiled")
PROPOSED = {
    "glass round": "#7ecbd2",
    "bone round": "#f2f6ea",
    "Storm violet": "#a05ae0",
    "Cold pale bio": "#a6ffbe",
    "Flame ember": "#ff9032",
    "Mirror bone": "#f2f6ea",
    "Flight yellow": "#ffd83e",
    "Weight red": "#e04a2a",
    "Moor teal": "#3ce0d8",
    "Root bio green": "#46e078",
    "dark rim": "#08080c",
}


def lab(hexstr):
    h = hexstr.lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047
    y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883
    f = [t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116 for t in (x, y, z)]
    return (116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2]))


def de(a, b):
    return sum((p - q) ** 2 for p, q in zip(lab(a), lab(b))) ** 0.5


mod_src = (ROOT / "src/render/modColors.ts").read_text()
block = mod_src.split("MOD_PICKUP_COLORS", 1)[1].split("}", 1)[0]
today = {m[0]: "#" + m[1].lower() for m in re.findall(r"(\w+):\s*0x([0-9a-fA-F]{6})", block)}
if len(today) < 10:
    sys.exit(f"parsed only {len(today)} mod colours from modColors.ts; the table moved, fix the parser")
n_mods = len(today)
bv = (ROOT / "src/render/bulletVisuals.ts").read_text()
today["(base tracer)"] = "#" + re.search(r"BASE_BULLET_COLOR = 0x([0-9a-fA-F]{6})", bv).group(1).lower()

tiles = json.loads((ROOT / "public/themes/swampspace-hires/manifest.json").read_text())["palette"]["tiles"]
floors = {k: tiles[k].lower() for k in FLOOR_KEYS if k in tiles}
if "tiled" not in floors:
    sys.exit("manifest has no 'tiled' floor colour; update FLOOR_KEYS")


def report(title, colours):
    print(f"\n{title}")
    print(f"{'name':<16}{'colour':<9}{'dE pal':>7}  {'nearest':<8} hot {'|dL| min':>9}  floor")
    off, flat = [], []
    for name, c in colours.items():
        dp, pc = min((de(c, p), p) for p in PALETTE)
        dl, fl = min((abs(lab(c)[0] - lab(v)[0]), k) for k, v in floors.items())
        hot = "yes" if pc in HOT else "   "
        print(f"{name:<16}{c:<9}{dp:>7.1f}  {pc:<8} {hot} {dl:>9.1f}  {fl}")
        if dp >= 12:
            off.append(name)
        if dl < 15:
            flat.append(f"{name} on {fl}")
    print(f"off the palette (dE >= 12): {len(off)} of {len(colours)} {off}")
    print(f"same lightness as some floor (|dL| < 15): {len(flat)} of {len(colours)} {flat}")


print("floors:", ", ".join(f"{k} {v} L*{lab(v)[0]:.0f}" for k, v in floors.items()))
report(f"TODAY: {n_mods} mod colours plus the base tracer", today)
report("PROPOSED: glass round, design-C families and two new elements on palette accents, dark rim", PROPOSED)
