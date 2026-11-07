import sys, os
from PIL import Image
D = '/mnt/d/tmp/cast-walks/weapons/lore/pack'
ORDER = ['explosive', 'frost', 'shock', 'incendiary']
TINT = {'frost': (126, 203, 210), 'incendiary': (255, 144, 50), 'shock': (255, 216, 62), 'explosive': (224, 74, 42)}
def tinted(glow, rgb):
    g = glow.copy(); px = g.load()
    for y in range(g.height):
        for x in range(g.width):
            r, gg, b, a = px[x, y]
            if a: px[x, y] = (rgb[0], rgb[1], rgb[2], a)
    return g
def comp(wid, grid, v, mods):
    base = Image.open(f'{D}/grid{grid}/weapon-{wid}-{v}-idle-0.png').convert('RGBA'); out = base.copy()
    for m in ORDER:
        if m in mods:
            p = f'{D}/grid{grid}/weapon-{wid}-{v}-mod-{m}-0.png'
            if os.path.exists(p): out.alpha_composite(Image.open(p))
    gp = f'{D}/grid{grid}/weapon-{wid}-{v}-glow-0.png'
    if mods and os.path.exists(gp): out.alpha_composite(tinted(Image.open(gp), TINT[mods[0]]))
    return out
def sheet(wid, grid, k, out):
    builds = [[], ['frost'], ['incendiary'], ['shock'], ['explosive'], ['explosive', 'frost', 'incendiary']]
    views = ['e', 'se', 's', 'ne', 'n']
    cells = [[comp(wid, grid, v, b) for b in builds] for v in views]
    mw = max(c.width for r in cells for c in r); mh = max(c.height for r in cells for c in r)
    S = Image.new('RGBA', (len(builds) * (mw + 3) * k, len(views) * (mh + 3) * k), (58, 68, 60, 255))
    for j, r in enumerate(cells):
        for i, c in enumerate(r): S.alpha_composite(c.resize((c.width * k, c.height * k), Image.NEAREST), (i * (mw + 3) * k, j * (mh + 3) * k))
    S.save(out); return S.size
if __name__ == '__main__':
    print(sheet(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]))
