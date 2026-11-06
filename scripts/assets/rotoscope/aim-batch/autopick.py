"""autopick.py CHARDIR: per direction, the Qwen aim keyframe seed whose figure keeps the keyframe's framing
(top/bottom shift, height ratio) -> kf/<d>-aim-spick-848.png. A provisional pick so Fun-Control can run in
the same GPU batch; every pick is checked by eye afterwards."""
import sys, glob, os, re, shutil
sys.path.insert(0, os.path.expanduser("~/Worktrees/sporefall-station/aim-art-1106/scripts/assets/rotoscope"))
from aim_keyframe import framing
from PIL import Image
C = sys.argv[1]
K = {"player": "vine-ranger", "drowner": "drowned-diver"}[os.path.basename(C.rstrip("/"))]
for d in ["s", "se", "e", "ne", "n"]:
    kf = Image.open(f"/mnt/d/tmp/cast-walks/runs/{K}/best-pal/raw/{d}-keyframe.png")
    best = None
    for f in glob.glob(f"{C}/kf/{d}-aim-s[0-9]*.png"):
        if f.endswith("-848.png"):
            continue
        t, b, r, legs = framing(kf, Image.open(f))
        score = abs(t) + abs(b) + 300 * abs(r - 1) + 3 * legs
        print(d, os.path.basename(f), (t, b, r, legs), round(score, 1))
        if best is None or score < best[0]:
            best = (score, f)
    if best:
        shutil.copyfile(best[1].replace(".png", "-848.png"), f"{C}/kf/{d}-aim-spick-848.png")
        print(d, "pick", os.path.basename(best[1]))
