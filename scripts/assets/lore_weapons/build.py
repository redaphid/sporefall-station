"""Build one weapon's pack frames: python3 build.py WEAPON [--out DIR]"""
import json, math, os, sys
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import frames as F
import gen
LORE = F.LORE
G = f'{LORE}/gen'
GUN_LEN = {2: 26, 1: 13}
CFG = {
    'rivetDriver': dict(kind='gun', hue='green', desc='green charge cylinder', fx='flash-green-s1', len={2: 26, 1: 13}, mods=['frost', 'incendiary', 'shock', 'explosive']),
    'scatterFunnel': dict(kind='gun', hue='teal', desc='teal charge vial', fx='burst-teal-s1', len={2: 34, 1: 17}),
    'coilRepeater': dict(trap_white=196, kind='gun', hue='teal', desc='teal hot coil turns', fx='flash-green-s2', len={2: 34, 1: 17}),
    'phosphorHose': dict(kind='gun', hue='orange', desc='orange phosphor vial', fx='flash-orange-s1', len={2: 32, 1: 16}),
    'frostCondenser': dict(kind='gun', hue='frost', desc='icy pale blue frost vial', fx='flash-frost-s1', len={2: 26, 1: 13}),
    'lullDarter': dict(kind='gun', hue='violet', desc='violet sleep vial', fx='flash-violet-s1', len={2: 26, 1: 13}),
    'sparkCoil': dict(kind='gun', hue='yellow', desc='yellow battery-essence vial', fx='burst-yellow-s1', len={2: 26, 1: 13}),
    'pressureLance': dict(kind='thrust', hue='teal', desc='teal charge vial', fx='burst-teal-s2', len={2: 40, 1: 20}),
    'siphonSpike': dict(kind='thrust', hue='teal', desc='teal glass sample barrel', fx='burst-teal-s1', len={2: 20, 1: 10}, head='light'),
    'cageRam': dict(kind='chop', hue='yellow', desc='yellow charged bulb in the cage', fx=None, len={2: 46, 1: 23}),
}
VIEWS = ['e', 'se', 's', 'ne', 'n']
FX_DEG = {'e': 0, 'se': 40, 'ne': -50}
IDLE = [(11, 'dim softly glowing'), (12, 'glowing'), (13, 'bright glowing')]

def drop_trapped_white(im, min_area=150, level=232):
    """Background the matte left enclosed (between a grip and a magazine): big
    connected patches of near-white become transparent; small highlights stay."""
    from scipy import ndimage
    a = np.asarray(im).copy()
    white = (a[..., :3].min(-1) > level) & (np.ptp(a[..., :3], -1) < 14) & (a[..., 3] > 0)
    lab, n = ndimage.label(white)
    if n:
        sizes = ndimage.sum(white, lab, range(1, n + 1))
        big = np.zeros(n + 1, bool); big[1:] = sizes > min_area
        a[big[lab], 3] = 0
    return Image.fromarray(a, 'RGBA')

def view_images(wid):
    pick = json.load(open(f'{G}/{wid}/pick.json'))
    out = {}
    for v in VIEWS:
        if v not in pick: continue  # the engine borrows a neighbour (n -> ne -> e)
        f, flip = (pick[v], False) if isinstance(pick[v], str) else (pick[v][0], True)
        src = f'{G}/{wid}/{f}'
        rg = src.replace('.png', '-rgba.png')
        # The profile straight from its first matte: re-matting it on the white
        # re-framing dropped thin dark parts (the Coil Repeater's barrel).
        if v == 'e' and os.path.exists(f'{G}/{wid}/{wid}-pick-rgba.png'): rg = f'{G}/{wid}/{wid}-pick-rgba.png'
        if not os.path.exists(rg): gen.rembg(src, rg)
        im = Image.open(rg).convert('RGBA'); im = im.crop(im.getbbox())
        im = drop_trapped_white(im, level=CFG[wid].get('trap_white', 232))
        out[v] = im.transpose(Image.FLIP_LEFT_RIGHT) if flip else im
    return out

def build(wid, flat_dir, pack_root=None):
    c = CFG[wid]; ims = view_images(wid)
    prof_len = ims['e'].width
    meta = {1: {}, 2: {}}; files = []
    for v in [v for v in VIEWS if v in ims]:
        im = ims[v]
        pts = F.gun_points(im, v) if c['kind'] == 'gun' else F.melee_points(im, v, head=c.get('head', 'heavy'))
        idle = F.inpaint_glow(im, c['hue'], c['desc'], IDLE, f'{wid}-{v}')
        ip = [dict(pts) for _ in idle]
        att, ap = [], []
        if c['kind'] == 'gun':
            size = prof_len * (0.9 if v in FX_DEG else 0.7)
            t = math.radians(FX_DEG.get(v, 0))
            for fr, sc in ((idle[2], 1.0), (idle[2], 0.7), (idle[1], 0.4)):
                fx = F.fx_sprite(f'{G}/fx/{c["fx"]}.png', FX_DEG.get(v, 0), size * sc)
                fwd = (math.cos(t) * size * sc * 0.28, math.sin(t) * size * sc * 0.28) if v in FX_DEG else (0, 0)
                f2, p2 = F.place_fx(fr, pts, fx, 'center', fwd); att.append(f2); ap.append(p2)
        elif c['kind'] == 'thrust':
            gx, gy = pts['grip']; mx, my = pts['muzzle']; L = math.hypot(mx - gx, my - gy) or 1
            ux, uy = (mx - gx) / L, (my - gy) / L
            for fr, d, sc in ((idle[1], -0.10, 0), (idle[2], 0.22, 0.5), (idle[2], 0.12, 0.3)):
                p2 = {'grip': (gx - ux * d * L, gy - uy * d * L), 'muzzle': pts['muzzle']}
                if sc:
                    fx = F.fx_sprite(f'{G}/fx/{c["fx"]}.png', math.degrees(math.atan2(uy, ux)), prof_len * sc)
                    fr, p2 = F.place_fx(fr, p2, fx, 'center', (ux * prof_len * sc * 0.2, uy * prof_len * sc * 0.2))
                att.append(fr); ap.append(p2)
        gm = F.glow_mask(im, c['hue']).point(lambda x: 255 if x > 0 else 0)
        glow = Image.new('RGBA', im.size, (242, 246, 234, 255)); glow.putalpha(gm)
        medits, mpts = [], []
        for mod in c.get('mods', []):
            ed, ep = F.mod_edit_qwen(im, pts, v, mod, f'{wid}-{v}'); medits.append(ed); mpts.append(ep)
        # Each facing was generated at its own framing, so cap its size against
        # the profile: a diagonal no longer than the profile, an end-on view
        # (at/away from the camera) no bigger than 60% of it.
        cap = {'e': 1.0, 'se': 0.95, 'ne': 0.95, 's': 0.6, 'n': 0.6}[v]
        vmax = max(im.size)
        for grid in (2, 1):
            scale = min(c['len'][grid] / prof_len, cap * c['len'][grid] / vmax)
            px, pp = F.pixelize_view(idle + att + [glow] + medits, ip + ap + [dict(pts)] + mpts, scale, raw=(len(idle) + len(att),))
            base0 = np.asarray(px[0])
            for mod, ed in zip(c.get('mods', []), px[len(idle) + len(att) + 1:]):
                e = np.asarray(ed).copy(); same = (e == base0).all(-1); e[same] = 0
                lay = Image.fromarray(e, 'RGBA')
                if lay.getbbox(): files.append((grid, f'{v}-mod-{mod}-0', lay))
            px = px[:len(idle) + len(att) + 1]
            meta[grid][v] = pp
            for i, f in enumerate(px[:len(idle)]): files.append((grid, f'{v}-idle-{i}', f))
            for i, f in enumerate(px[len(idle):len(idle) + len(att)]): files.append((grid, f'{v}-attack-{i}', f))
            if px[-1].getbbox(): files.append((grid, f'{v}-glow-0', px[-1]))
    os.makedirs(flat_dir, exist_ok=True)
    for grid in (1, 2):
        d = f'{flat_dir}/grid{grid}'; os.makedirs(d, exist_ok=True)
        for g, name, f in files:
            if g == grid: f.save(f'{d}/weapon-{wid}-{name}.png')
        pj = f'{d}/weapons.json'; allm = json.load(open(pj)) if os.path.exists(pj) else {}
        allm[wid] = meta[grid]; json.dump(allm, open(pj, 'w'), indent=1)
    print(wid, {g: meta[g] for g in (2, 1)})

if __name__ == '__main__':
    build(sys.argv[1], f'{LORE}/pack')
