"""4x nearest sheets of each walk8 leg's stop, from the stepped skid frames.
usage: python3 skid-strip.py <steps_dir> <out_dir>"""
import sys, os
from PIL import Image, ImageDraw
steps, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
PX, CX, CY = 32, 640, 376
LEGS = [('e', 34), ('se', 118), ('s', 202), ('sw', 286), ('w', 370), ('nw', 454), ('n', 538), ('ne', 622)]
W, H, S, COLS = 3 * PX, 3 * PX, 4, 7
for tag, stop in LEGS:
    ticks = [t for t in range(stop - 6, stop + 15) if os.path.exists(f'{steps}/t{t:04d}.png')]
    if not ticks: continue
    box = (CX - W // 2, int(CY - PX * 0.7 - H / 2), CX + W // 2, int(CY - PX * 0.7 + H / 2))
    rows = (len(ticks) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * W * S, rows * (H * S + 18)), (12, 14, 16))
    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(ticks):
        im = Image.open(f'{steps}/t{t:04d}.png').convert('RGB').crop(box).resize((W * S, H * S), Image.NEAREST)
        ox, oy = (i % COLS) * W * S, (i // COLS) * (H * S + 18)
        sheet.paste(im, (ox, oy + 18))
        d.text((ox + 4, oy + 3), f'{tag} t{t} ({t - stop:+d})', fill=(230, 230, 230))
    sheet.save(f'{out}/skid-{tag}.png')
    print(f'{out}/skid-{tag}.png', sheet.size, len(ticks))
