"""GPU half of build.py: rembg every picked view and cache the idle inpaints."""
import sys
import build as B
import frames as F
for wid in sys.argv[1:]:
    c = B.CFG[wid]; ims = B.view_images(wid)
    for v, im in ims.items():
        F.inpaint_glow(im, c['hue'], c['desc'], B.IDLE, f'{wid}-{v}')
    print(wid, 'prefetched', list(ims), flush=True)
