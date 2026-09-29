#!/usr/bin/env python3
"""Detached specks per sprite frame: opaque islands not connected (8-way) to the largest body.

  python3 speckscan.py <frames dir> [<kind>]   # e.g. .../best-pal/frames mireclaw-stalker

Prints, per direction and pose, each island's pixel count and where it sits (x, y of its centre,
as a fraction of the body bbox; y > 1 is below the lowest body pixel). On 96 px frames a dark
island under the feet is the "flash near his feet" as the walk plays.
"""
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

d = sys.argv[1]
kind = sys.argv[2] if len(sys.argv) > 2 else ""
total = 0
for f in sorted(glob.glob(os.path.join(d, f"{kind}*-walk-*.png")) + glob.glob(os.path.join(d, f"{kind}*-idle.png"))):
    a = np.asarray(Image.open(f).convert("RGBA"))[..., 3] > 127
    lab, n = ndimage.label(a, structure=np.ones((3, 3)))
    if n < 2:
        continue
    sizes = ndimage.sum(a, lab, range(1, n + 1))
    body = int(np.argmax(sizes)) + 1
    ys, xs = np.where(lab == body)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    isl = []
    for i in range(1, n + 1):
        if i == body:
            continue
        cy, cx = ndimage.center_of_mass(a, lab, i)
        isl.append(f"{int(sizes[i - 1])}px@({(cx - x0) / max(1, x1 - x0):.2f},{(cy - y0) / max(1, y1 - y0):.2f})")
    total += len(isl)
    print(os.path.basename(f), " ".join(isl))
print("islands", total)
