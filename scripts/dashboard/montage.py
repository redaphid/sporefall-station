"""Stitch the newest PNG per workstream into one labelled dashboard image.

Usage: python3 montage.py OUT.png [--max-width 1600]
Writes OUT.png and prints its path, size in bytes and the sources used.
"""
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path("/mnt/d/tmp/cast-walks")
STREAMS = ["bog-mutant", "derelict-bot", "bog-mender", "actions",
           "mireclaw-alpha", "spore-drone", "brood-sac", "hive-spire", "props"]
TILE_W, TILE_H, LABEL_H = 520, 300, 22


def newest_png(stream: str) -> Path | None:
    d = ROOT / stream
    if not d.is_dir():
        return None
    pngs = [p for p in d.rglob("*.png")
            if "raw" not in p.parts and "archive" not in p.parts and p.stat().st_size > 0]
    sheets = [p for p in pngs if any(k in p.name for k in ("contact", "sheet", "strip", "montage"))]
    pool = sheets or pngs
    return max(pool, key=lambda p: p.stat().st_mtime) if pool else None


def tile(src: Path) -> Image.Image:
    im = Image.open(src).convert("RGB")
    scale = min(TILE_W / im.width, TILE_H / im.height)
    resample = Image.NEAREST if scale >= 1 else Image.LANCZOS
    return im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), resample)


def main() -> None:
    out = Path(sys.argv[1])
    picks = [(s, newest_png(s)) for s in STREAMS]
    picks = [(s, p) for s, p in picks if p]
    cols = 3
    rows = (len(picks) + cols - 1) // cols
    canvas = Image.new("RGB", (cols * TILE_W, rows * (TILE_H + LABEL_H) + 30), "white")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((6, 6), f"sporefall dashboard {time.strftime('%Y-%m-%d %H:%M')}", fill="black", font=font)
    for i, (stream, src) in enumerate(picks):
        x, y = (i % cols) * TILE_W, 30 + (i // cols) * (TILE_H + LABEL_H)
        age_min = int((time.time() - src.stat().st_mtime) / 60)
        draw.text((x + 4, y + 4), f"{stream}: {src.name} ({age_min} min old)", fill="black", font=font)
        canvas.paste(tile(src), (x, y + LABEL_H))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, optimize=True)
    small = canvas.resize((canvas.width * 2 // 3, canvas.height * 2 // 3), Image.LANCZOS)
    jpg = out.with_suffix(".jpg")
    small.save(jpg, quality=62, optimize=True)
    print(out, out.stat().st_size)
    print(jpg, jpg.stat().st_size)
    for s, p in picks:
        print(f"  {s}: {p}")


if __name__ == "__main__":
    main()
