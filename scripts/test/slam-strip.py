"""Build 4x nearest frame strips of the wall slam from the stepped e2e frames
(e2e/feature-wall-slam.mjs).

usage: python3 slam-strip.py <steps_dir> <out_dir> [first=0] [count=28] [every=1]
Frames are t%04d.png at zoom 1, camera on the player at (49.5, 9). Each cell is
one sim tick, cropped around the wall the body hits, enlarged 4x nearest."""
import sys, os
from PIL import Image, ImageDraw

steps, out = sys.argv[1], sys.argv[2]
first = int(sys.argv[3]) if len(sys.argv) > 3 else 0
count = int(sys.argv[4]) if len(sys.argv) > 4 else 28
every = int(sys.argv[5]) if len(sys.argv) > 5 else 1
os.makedirs(out, exist_ok=True)
PX, CX, CY = 32, 640, 376  # tile px; the player's tile point on screen
# tag, crop centre (tiles), shot tick
V = [
    ('east', (52.2, 4.9), 20),
    ('west', (47.8, 6.9), 90),
    ('north', (50.5, 3.6), 160),
    ('south', (50.5, 12.7), 230),
    ('corner', (47.6, 12.9), 300),
]
W, H, S, COLS = int(3.5 * PX), int(3.5 * PX), 4, 7
for tag, (x, y), t0 in V:
    cx = CX + (x - 49.5) * PX
    cy = CY + (y - 9) * PX
    box = (int(cx - W / 2), int(cy - H / 2), int(cx + W / 2), int(cy + H / 2))
    ticks = [t for t in range(t0 + first, t0 + first + count * every, every) if os.path.exists(f'{steps}/t{t:04d}.png')]
    rows = (len(ticks) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * W * S, rows * (H * S + 18)), (12, 14, 16))
    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(ticks):
        im = Image.open(f'{steps}/t{t:04d}.png').convert('RGB').crop(box).resize((W * S, H * S), Image.NEAREST)
        ox, oy = (i % COLS) * W * S, (i // COLS) * (H * S + 18)
        sheet.paste(im, (ox, oy + 18))
        d.text((ox + 4, oy + 3), f'{tag} t{t} (+{t - t0})', fill=(230, 230, 230))
    sheet.save(f'{out}/strip-{tag}.png')
    print(f'{out}/strip-{tag}.png', sheet.size, len(ticks))
