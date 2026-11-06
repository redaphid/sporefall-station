"""overlays.py RIG_DIR OUT.png: per direction, the aim hold (frame 40) and aimwalk frames 0,6,12,18 over the keyframe."""
import sys, os
from PIL import Image
R, out = sys.argv[1], sys.argv[2]
rows = []
for d in ["s", "se", "e", "ne", "n"]:
    kf = Image.open(f"{R}/kf-{d}-848.png").convert("RGB")
    cells = []
    for ctl, n in [("aim", 40)] + [("walk", i) for i in (0, 6, 12, 18)]:
        p = f"{R}/ctl-{ctl}-{d}/skel-{n:02d}.png"
        sk = Image.open(p).convert("RGB")
        m = sk.convert("L").point(lambda v: 255 if v > 0 else 0)
        c = Image.blend(kf, Image.new("RGB", kf.size, (255, 255, 255)), 0.4)
        c.paste(sk, (0, 0), m)
        cells.append(c.crop((250, 0, 600, 480)))
    rows.append(cells)
W, H = 350, 480
sheet = Image.new("RGB", (W * 5, H * 5), (0, 0, 0))
for r, cells in enumerate(rows):
    for c, im in enumerate(cells):
        sheet.paste(im, (c * W, r * H))
sheet.resize((W * 5 // 2, H * 5 // 2), Image.LANCZOS).save(out)
