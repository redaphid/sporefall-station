import sys, os
from PIL import Image
import gen
G = '/mnt/d/tmp/cast-walks/weapons/lore/gen'
def prep(wid, seed, cn='0.5'):
    src = f'{G}/{wid}/{wid}-cn{cn}-l0.0-s{seed}.png'; rg = f'{G}/{wid}/{wid}-pick-rgba.png'
    gen.rembg(src, rg)
    im = Image.open(rg); im = im.crop(im.getbbox())
    S = 1024; s = 900 / max(im.size); im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    os.makedirs(f'{G}/{wid}/views', exist_ok=True)
    cv = Image.new('RGBA', (S, S), (255, 255, 255, 255)); cv.alpha_composite(im, ((S - im.width) // 2, (S - im.height) // 2))
    cv.convert('RGB').save(f'{G}/{wid}/views/e-white.png'); print(wid, 'ok')
if __name__ == '__main__':
    for a in sys.argv[1:]:
        w, s = a.split(':')[:2]; cn = a.split(':')[2] if a.count(':') > 1 else '0.5'
        prep(w, int(s), cn)
