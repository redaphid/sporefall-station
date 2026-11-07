"""rawstrip.py RUN IDX,IDX,... OUT: raw clip frames side by side (cropped to the figure's column)."""
import sys, glob
from PIL import Image
run, idx, out = sys.argv[1], [int(i) for i in sys.argv[2].split(",")], sys.argv[3]
fs = sorted(glob.glob(f"{run}/raw/walk-*/*.png"))
ims = [Image.open(fs[i]).convert("RGB").crop((260, 0, 600, 480)) for i in idx]
s = Image.new("RGB", (340 * len(ims), 480), "white")
for k, im in enumerate(ims):
    s.paste(im, (k * 340, 0))
s.save(out)
print(len(fs), "frames")
