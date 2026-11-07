"""Compose e2e/weapon-mod-fire.mjs stills: one row per mod build, columns across
the shot, each crop centred on the player and reaching the projectiles, 4x
nearest (plus a 1x sheet)."""
import json
import os
import sys

from PIL import Image, ImageDraw

OUT = sys.argv[1]
shots = json.load(open(os.path.join(OUT, 'shots.json')))
W, H = 1100, 240  # crop in screenshot px (dpr 2): player at the left, the lane ahead
labels = list(dict.fromkeys(s['label'] for s in shots))
cols = max(s['k'] for s in shots) + 1
for k, name in ((4, 'mod-fire-4x.png'), (1, 'mod-fire-1x.png')):
    pad = 18
    sheet = Image.new('RGB', (cols * W * k // 2 + 160, len(labels) * (H * k // 2 + pad)), (14, 16, 20))
    d = ImageDraw.Draw(sheet)
    for s in shots:
        r = labels.index(s['label'])
        im = Image.open(s['file']).convert('RGB')
        x0, y0 = int(s['x'] - W * 0.1), int(s['y'] - H * 0.6)
        crop = im.crop((x0, y0, x0 + W, y0 + H)).resize((W * k // 2, H * k // 2), Image.NEAREST)
        sheet.paste(crop, (160 + s['k'] * W * k // 2, r * (H * k // 2 + pad)))
        d.text((6, r * (H * k // 2 + pad) + 6), s['label'], fill=(220, 220, 220))
    sheet.save(os.path.join(OUT, name))
print('composed', len(shots), 'stills ->', OUT)
