import sys, json, os
from PIL import Image, ImageDraw
D = '/mnt/d/tmp/cast-walks/weapons/lore/pack'
def sheet(wid, grid, k=6, out=None):
    views = ['e', 'se', 's', 'ne', 'n']; states = [('idle', i) for i in range(3)] + [('attack', i) for i in range(3)]
    cells = {}
    for v in views:
        for s, i in states:
            p = f'{D}/grid{grid}/weapon-{wid}-{v}-{s}-{i}.png'
            if os.path.exists(p): cells[(v, s, i)] = Image.open(p)
    mw = max(c.width for c in cells.values()); mh = max(c.height for c in cells.values())
    S = Image.new('RGBA', (len(states) * (mw + 4) * k, len(views) * (mh + 4) * k), (58, 68, 60, 255))
    for r, v in enumerate(views):
        for c_, (s, i) in enumerate(states):
            im = cells.get((v, s, i))
            if im: S.alpha_composite(im.resize((im.width * k, im.height * k), Image.NEAREST), (c_ * (mw + 4) * k, r * (mh + 4) * k))
    S.save(out or f'/tmp/{wid}-g{grid}.png'); return S.size
if __name__ == '__main__':
    print(sheet(sys.argv[1], int(sys.argv[2])))
