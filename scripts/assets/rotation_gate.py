#!/usr/bin/env python3
"""Photograph every rotating furnishing TURNED the four ways the game turns it.

WHY THIS EXISTS. `src/render/sprites.ts` sets

    view.sprite.rotation = upright ? 0 : e.facing

and an interactable is `upright` unless its archetype is listed in
`ROTATES_WITH_FACING` (`src/render/art.ts`). So for those archetypes the
SHIPPED PNG is turned to an arbitrary angle by the layout planner, and a sprite
drawn as a standing three-quarter object stands on its head at `facing = pi`.

That is not hypothetical. `work-desk.png` shipped upside down on `main` for six
days (#42 section 3a): the three-quarter desk art landed at 14:54 in #29 and
`desk` was added to `ROTATES_WITH_FACING` at 14:57 in #28. The set's own doc
comment says "Add to this set only after LOOKING at the sprite turned" — this
script is that look, made cheap and re-runnable so it actually happens.

NEITHER EXISTING GATE CATCHES IT. `consistency.py` measures the silhouette
(alpha) only, and a turned sprite has a perfectly good silhouette. The VLM check
passes a well-formed chair. Reading correctly when turned is a judgement about
PROJECTION, so the output here is a contact sheet for a human eye, not a
pass/fail number that would only invent false confidence.

    python scripts/assets/rotation_gate.py
    python scripts/assets/rotation_gate.py --theme swampspace-hires --out sheet.png

The rotate list is PARSED OUT OF art.ts rather than duplicated here, so this
cannot quietly drift from the code it is checking — if someone adds `shelf` to
the set, the next run photographs `shelf`.
"""
import argparse
import os
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ART_TS = ROOT / "src" / "render" / "art.ts"
FLOOR = (58, 62, 54, 255)  # the dark slate a real interior floor actually is
ANGLES = (0, 90, 180, 270)


def parse_set(name: str) -> list[str]:
    """Pull a `new Set([...])` literal out of art.ts. Fails loudly: a silently
    empty list would render an empty sheet and read as 'nothing wrong'."""
    src = ART_TS.read_text(encoding="utf-8")
    m = re.search(rf"{name}\s*:\s*ReadonlySet<string>\s*=\s*new Set\(\[(.*?)\]\)", src, re.S)
    if not m:
        raise SystemExit(f"could not find {name} in {ART_TS}")
    return re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))


def parse_record(name: str) -> dict[str, str]:
    """Pull a `Record<string, string>` object literal out of art.ts."""
    src = ART_TS.read_text(encoding="utf-8")
    m = re.search(rf"{name}\s*:\s*Record<string, string>\s*=\s*\{{(.*?)\n\}}", src, re.S)
    if not m:
        raise SystemExit(f"could not find {name} in {ART_TS}")
    body = re.sub(r"//[^\n]*", "", m.group(1))
    return dict(re.findall(r"(\w+)\s*:\s*['\"]([^'\"]+)['\"]", body))


def font(size: int, bold: bool = True):
    path = "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"
    return ImageFont.truetype(path, size) if os.path.exists(path) else ImageFont.load_default()


def sprite_path(theme: str, art_name: str) -> Path | None:
    """PROP_SPRITE values are manifest keys; the pack file is `<key>.png` under
    props/, with a couple of historical name differences to bridge."""
    base = ROOT / "public" / "themes" / theme / "props"
    for candidate in (art_name, f"{art_name}-machine", f"work-{art_name}"):
        p = base / f"{candidate}.png"
        if p.exists():
            return p
    hits = sorted(base.glob(f"*{art_name}*.png"))
    return hits[0] if hits else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="swampspace-hires")
    ap.add_argument("--out", default="rotation-gate.png")
    args = ap.parse_args()

    rotates = parse_set("ROTATES_WITH_FACING")
    prop_sprite = parse_record("PROP_SPRITE")

    rows, missing = [], []
    for arch in rotates:
        art_name = prop_sprite.get(arch)
        if not art_name:
            # No texture yet -> drawn as a procedural vector today, so it cannot
            # be upside down YET. It acquires the defect the moment art lands,
            # which is exactly why it is reported rather than skipped silently.
            missing.append(arch)
            continue
        p = sprite_path(args.theme, art_name)
        if p is None:
            missing.append(f"{arch} (mapped to '{art_name}', no file)")
            continue
        rows.append((f"{arch}  ({p.name})", Image.open(p).convert("RGBA")))

    print(f"rotating archetypes in art.ts: {', '.join(rotates)}")
    for m in missing:
        print(f"  no texture yet, not photographed: {m}")
    if not rows:
        print("nothing to photograph — every rotating archetype is still a vector placeholder")
        return 0

    S, GAP, LEFT = 150, 16, 300
    W = LEFT + len(ANGLES) * (S + GAP) + GAP
    H = 130 + len(rows) * (S + GAP) + 60
    sheet = Image.new("RGBA", (W, H), (26, 28, 34, 255))
    d = ImageDraw.Draw(sheet)
    d.text((24, 18), "Rotating furnishings, turned the way the game turns them",
           font=font(28), fill=(238, 240, 245))
    d.text((24, 56), f"theme: {args.theme}   —   every row below is rotated by e.facing at runtime",
           font=font(18, False), fill=(168, 174, 186))
    for i, r in enumerate(ANGLES):
        d.text((LEFT + i * (S + GAP), 100), f"facing {r}", font=font(17), fill=(150, 155, 168))

    y = 122
    for label, im in rows:
        d.text((24, y + S // 2 - 12), label, font=font(18), fill=(219, 222, 230))
        big = im.resize((S, S), Image.NEAREST)
        for i, r in enumerate(ANGLES):
            cell = Image.new("RGBA", (S, S), FLOOR)
            cell.alpha_composite(big.rotate(r, resample=Image.NEAREST, expand=False))
            sheet.alpha_composite(cell, (LEFT + i * (S + GAP), y))
        y += S + GAP

    d.text((24, y + 12),
           "A sprite PASSES only if all four columns still read as the object.",
           font=font(20), fill=(235, 200, 120))
    sheet.convert("RGB").save(args.out)
    print(f"saved {args.out}  ({sheet.size[0]}x{sheet.size[1]}, {len(rows)} photographed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
