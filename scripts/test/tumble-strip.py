"""Build 4x nearest frame sheets of the death tumble from the stepped e2e frames.

usage: python3 tumble-strip.py <steps_dir> <out_dir> [every=1]
Frames are t%04d.png at zoom 1, camera on the player at (34, 9)."""
import sys, os
from PIL import Image, ImageDraw

steps, out = sys.argv[1], sys.argv[2]
every = int(sys.argv[3]) if len(sys.argv) > 3 else 1
os.makedirs(out, exist_ok=True)
PX, CX, CY = 32, 640, 376  # tile px, player feet on screen
# tag, victim tile pos, throw dir (tiles), first tick, last tick
V = [
    ('east-wall', (45.55, 9), (0.5, 0), 20, 84),
    ('pistol-plink', (34, 5), (0, -0.5), 65, 129),
    ('shotgun', (30, 12.5), (-0.5, 0.5), 110, 174),
    ('sporeling', (30, 9), (-0.5, 0), 155, 219),
    ('grenade', (38.4, 13.4), (0, 0), 210, 290),
]
W, H, S, COLS = 4 * PX, 3 * PX, 4, 5
for tag, (x, y), (dx, dy), t0, t1 in V:
    cx = CX + (x - 34 + dx) * PX
    cy = CY + (y - 9 + dy) * PX - PX * 0.7
    box = (int(cx - W / 2), int(cy - H / 2), int(cx + W / 2), int(cy + H / 2))
    ticks = [t for t in range(t0, t1 + 1, every) if os.path.exists(f'{steps}/t{t:04d}.png')]
    rows = (len(ticks) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * W * S, rows * (H * S + 18)), (12, 14, 16))
    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(ticks):
        im = Image.open(f'{steps}/t{t:04d}.png').convert('RGB').crop(box).resize((W * S, H * S), Image.NEAREST)
        ox, oy = (i % COLS) * W * S, (i // COLS) * (H * S + 18)
        sheet.paste(im, (ox, oy + 18))
        d.text((ox + 4, oy + 3), f'{tag} t{t}', fill=(230, 230, 230))
    sheet.save(f'{out}/strip-{tag}.png')
    print(f'{out}/strip-{tag}.png', sheet.size, len(ticks))
