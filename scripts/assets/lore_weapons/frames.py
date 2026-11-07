"""Animate + pixelize one weapon into pack frames.

Every view is a GENERATED large image (profile render; Qwen-Image-Edit views;
diagonals = the profile foreshortened + turned at large scale). Idle frames are
SDXL inpaints of the glow accent; attack frames add a generated FX sprite at the
muzzle (guns) or a thrust + generated burst at the head (melee). Then
k-centroid to the pack grid, palette lock, 1px outline.
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from pixelize import kcentroid, to_palette, outline, levels
import gen, comfy
LORE = '/mnt/d/tmp/cast-walks/weapons/lore'
VIEW_DIR = {'e': 0, 'se': 40, 'ne': -50}  # degrees the muzzle points, screen (+ = down)

def on_white(rgba):
    w = Image.new('RGBA', rgba.size, (255, 255, 255, 255)); w.alpha_composite(rgba); return w.convert('RGB')

def glow_mask(rgba, hue):
    a = np.asarray(rgba).astype(np.int32); r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    if hue == 'green': m = (g > r + 18) & (g > b + 8)
    elif hue in ('teal', 'frost'): m = (g > r + 25) & (b > r + 15)
    elif hue == 'yellow': m = (r > b + 60) & (g > b + 50)
    elif hue == 'orange': m = (r > g + 40) & (r > b + 80)
    elif hue == 'violet': m = (b > g + 30) & (r > g + 10)
    else: m = np.zeros_like(r, bool)
    m &= al > 200
    im = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(3))
    return im

def inpaint_glow(rgba, hue, desc, seeds, tag, denoise=0.55):
    """Idle frames: the glow accent re-generated per seed (pulse/bubbles); alpha kept."""
    os.makedirs(f'{LORE}/gen/tmp', exist_ok=True)
    src = f'{LORE}/gen/tmp/{tag}-src.png'; msk = f'{LORE}/gen/tmp/{tag}-mask.png'
    on_white(rgba).save(src); m = glow_mask(rgba, hue)
    if m.getbbox() is None: return [rgba] * len(seeds)
    m.convert('RGB').save(msk)
    out = []
    for i, (s, level) in enumerate(seeds):
        cache = f'{LORE}/gen/idle-cache/{tag}-s{s}.png'
        if os.path.exists(cache):
            im = Image.open(cache).convert('RGB')
        else:
            prompt = f'{level} {desc}'
            p = comfy.run(gen.inpaint_graph(src, msk, prompt, s, denoise), f'{LORE}/gen/tmp/raw')[0]
            im = Image.open(p).convert('RGB').resize(rgba.size)
            os.makedirs(os.path.dirname(cache), exist_ok=True); im.save(cache)
        o = im.convert('RGBA'); o.putalpha(rgba.getchannel('A')); out.append(o)
    return out

def turn(rgba, pts, deg, squash):
    """Foreshorten along the barrel (x) then turn by deg (screen degrees, + = clockwise/down)."""
    w, h = rgba.size
    im = rgba.resize((max(1, int(w * squash)), h), Image.LANCZOS)
    pts = {k: (x * squash, y) for k, (x, y) in pts.items()}
    pad = int(math.hypot(*im.size)); cv = Image.new('RGBA', (pad * 2, pad * 2)); ox, oy = pad - im.width // 2, pad - im.height // 2
    cv.alpha_composite(im, (ox, oy)); pts = {k: (x + ox, y + oy) for k, (x, y) in pts.items()}
    r = cv.rotate(-deg, resample=Image.BICUBIC, center=(pad, pad))
    t = math.radians(deg)
    pts = {k: (pad + (x - pad) * math.cos(t) - (y - pad) * math.sin(t), pad + (x - pad) * math.sin(t) + (y - pad) * math.cos(t)) for k, (x, y) in pts.items()}
    bb = r.getbbox(); r = r.crop(bb); pts = {k: (x - bb[0], y - bb[1]) for k, (x, y) in pts.items()}
    return r, pts

def fx_sprite(path, deg, size):
    """Luma-keyed generated FX, cropped, scaled to `size` px wide (large coords), turned to deg."""
    im = Image.open(path).convert('RGB'); a = np.asarray(im).astype(np.float32)
    lum = a.max(-1); al = np.clip((lum - 40) * 2.2, 0, 255)
    rgba = Image.fromarray(np.dstack([a, al]).astype(np.uint8), 'RGBA'); rgba = rgba.crop(rgba.getbbox())
    s = size / rgba.width; rgba = rgba.resize((max(1, int(rgba.width * s)), max(1, int(rgba.height * s))), Image.LANCZOS)
    return rgba.rotate(-deg, resample=Image.BICUBIC, expand=True)

def place_fx(frame, pts, fx, anchor='left', fwd=(0.0, 0.0)):
    """Composite fx centred at the muzzle pushed `fwd` (large px) along the shot; expands the canvas."""
    mx, my = pts['muzzle']; mx += fwd[0]; my += fwd[1]
    fx_x = mx - fx.width / 2; fx_y = my - fx.height / 2
    x0 = min(0, fx_x); y0 = min(0, fx_y); x1 = max(frame.width, fx_x + fx.width); y1 = max(frame.height, fx_y + fx.height)
    cv = Image.new('RGBA', (int(x1 - x0) + 1, int(y1 - y0) + 1)); cv.alpha_composite(frame, (int(-x0), int(-y0)))
    cv.alpha_composite(fx, (int(fx_x - x0), int(fx_y - y0)))
    return cv, {k: (x - x0, y - y0) for k, (x, y) in pts.items()}

def pixelize_view(frames, pts, scale, mul=0.85, raw=()):
    """frames: large RGBA, may differ in size; each paired with its own pts. Registers on grip."""
    # bring every frame to a common canvas aligned on the grip
    gx = max(p['grip'][0] for p in pts); gy = max(p['grip'][1] for p in pts)
    W = int(max(f.width - p['grip'][0] for f, p in zip(frames, pts)) + gx) + 1
    H = int(max(f.height - p['grip'][1] for f, p in zip(frames, pts)) + gy) + 1
    al = []
    for f, p in zip(frames, pts):
        cv = Image.new('RGBA', (W, H)); cv.alpha_composite(f if len(al) in raw else levels(f, mul, 1.05), (int(gx - p['grip'][0]), int(gy - p['grip'][1]))); al.append(cv)
    union = Image.new('L', (W, H))
    for c in al: union = Image.fromarray(np.maximum(np.asarray(union), np.asarray(c.getchannel('A'))))
    x0, y0, x1, y1 = union.getbbox()
    # snap the crop so the grip lands on a whole pixel
    step = 1 / scale
    x0 = gx - math.ceil((gx - x0) / step) * step; y0 = gy - math.ceil((gy - y0) / step) * step
    tw = max(1, math.ceil((x1 - x0) * scale)); th = max(1, math.ceil((y1 - y0) * scale))
    x1, y1 = x0 + tw / scale, y0 + th / scale
    out = []
    for j, c in enumerate(al):
        cc = c.crop((int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))))
        if j in raw:
            # a mask layer: area-average coverage, no outline, one flat pale ink
            m = cc.getchannel('A').resize((tw, th), Image.BOX).point(lambda v: 255 if v > 90 else 0)
            lay = Image.new('RGBA', (tw, th), (242, 246, 234, 255)); lay.putalpha(m)
            cv = Image.new('RGBA', (tw + 2, th + 2)); cv.paste(lay, (1, 1)); out.append(cv); continue
        p = to_palette(kcentroid(cc, tw, th)); cv = Image.new('RGBA', (tw + 2, th + 2)); cv.paste(p, (1, 1)); out.append(outline(cv))
    m0 = pts[0]['muzzle']
    grip = [int((gx - x0) * scale) + 1, int((gy - y0) * scale) + 1]
    mx = m0[0] + gx - pts[0]['grip'][0]; my = m0[1] + gy - pts[0]['grip'][1]
    muzzle = [min(tw, max(0, int((mx - x0) * scale))) + 1, min(th, max(0, int((my - y0) * scale))) + 1]
    return out, {'grip': grip, 'muzzle': muzzle}

def _alpha(rgba, work=160):
    s = work / max(rgba.size); small = rgba.resize((max(1, int(rgba.width * s)), max(1, int(rgba.height * s))), Image.BILINEAR)
    return np.asarray(small.getchannel('A')) > 128, 1 / s

def gun_points(rgba, view):
    """Grip = top of the hanging handle (where the fist closes); muzzle by view."""
    a, k = _alpha(rgba); h, w = a.shape
    ys, xs = np.where(a)
    if view in ('e', 'se', 'ne'):
        region = xs < xs.min() + 0.45 * (xs.max() - xs.min())
    else:
        cx = xs.mean(); region = np.abs(xs - cx) < 0.35 * (xs.max() - xs.min())
    by = ys[region].max(); bx = int(np.median(xs[region][ys[region] == by]))
    # climb the handle: follow the run containing bx upward while it stays narrow
    width0 = None; y = by; cx = bx
    cap = by - (0.5 if view == 'e' else 0.4) * (ys.max() - ys.min())
    while y > max(ys.min(), cap):
        row = np.where(a[y])[0]
        if len(row) == 0: break
        # contiguous run around cx
        runs = np.split(row, np.where(np.diff(row) > 1)[0] + 1)
        run = min(runs, key=lambda r: 0 if r[0] <= cx <= r[-1] else min(abs(r[0] - cx), abs(r[-1] - cx)))
        wdt = run[-1] - run[0] + 1
        if width0 is None: width0 = max(wdt, 3)
        if wdt > width0 * 1.9 + 2: break
        cx = int((run[0] + run[-1]) / 2); y -= 1
    grip = (cx * k, (y + 2) * k)
    if view == 'e': i = np.argmax(xs)
    elif view == 'se': i = np.argmax(xs + ys)
    elif view == 'ne': i = np.argmax(xs - ys)
    else: i = None
    if i is not None: muzzle = (xs[i] * k, ys[i] * k)
    else:
        top = ys < ys.min() + 0.45 * (ys.max() - ys.min()); muzzle = (xs[top].mean() * k, ys[top].mean() * k)
    return {'grip': grip, 'muzzle': muzzle}

def melee_points(rgba, view, grip_frac=0.14, head='heavy'):
    """Grip near the light end of the main axis, head = the heavy end."""
    a, k = _alpha(rgba); ys, xs = np.where(a)
    pts = np.stack([xs, ys], 1).astype(np.float32); c = pts.mean(0)
    if view in ('s', 'n'):
        # pointing at/away from the camera: the shaft is foreshortened; grip at the lower part
        return {'grip': (np.median(xs) * k, (ys.max() - 0.2 * (ys.max() - ys.min())) * k), 'muzzle': (c[0] * k, (ys.min() + 0.3 * (ys.max() - ys.min())) * k)}
    u, s_, vt = np.linalg.svd(pts - c, full_matrices=False); ax = vt[0]
    t = (pts - c) @ ax; lo, hi = t.min(), t.max()
    # heavy end: more mass in the outer 25%
    heavier_back = (t > hi - 0.25 * (hi - lo)).sum() < (t < lo + 0.25 * (hi - lo)).sum()
    if heavier_back == (head == 'heavy'): ax, t, lo, hi = -ax, -t, -hi, -lo
    g = c + ax * (lo + grip_frac * (hi - lo)); m = c + ax * (hi - 0.08 * (hi - lo))
    return {'grip': (g[0] * k, g[1] * k), 'muzzle': (m[0] * k, m[1] * k)}

MOD_PROMPTS = {
    'frost': 'frost condenser: a stack of thin pale icy cooling fins clamped around the barrel, white rime and frost crystals, pale icy blue glow',
    'incendiary': 'a small igniter nozzle clamped at the muzzle tip with a hot orange pilot flame',
    'shock': 'a small Tesla coil with tight copper windings and a ball electrode mounted on top, crackling yellow electric spark',
    'explosive': 'a round squat grenade canister drum clamped under the barrel, olive drab with a red hazard stripe',
}

def mod_mask(rgba, pts, view, mod):
    """Where a mod's attachment goes, from the grip->muzzle axis (large px)."""
    from PIL import ImageDraw
    w, h = rgba.size
    gx, gy = pts['grip']; mx, my = pts['muzzle']
    L = math.hypot(mx - gx, my - gy) or 1
    ux, uy = (mx - gx) / L, (my - gy) / L
    nx, ny = uy, -ux  # perpendicular; pick the one pointing up the screen
    if ny > 0: nx, ny = -nx, -ny
    bb = rgba.getbbox(); size = max(bb[2] - bb[0], bb[3] - bb[1])
    m = Image.new('L', (w, h)); d = ImageDraw.Draw(m)
    def blob(t, off, r):
        cx = gx + ux * L * t + nx * off * size; cy = gy + uy * L * t + ny * off * size
        d.ellipse((cx - r * size, cy - r * size, cx + r * size, cy + r * size), fill=255)
    end_on = view in ('s', 'n')
    if end_on:
        cx, cy = mx, my
        R = {'frost': 0.30, 'incendiary': 0.14, 'shock': 0.16, 'explosive': 0.2}[mod]
        oy = {'frost': 0, 'incendiary': 0, 'shock': -0.32, 'explosive': 0.3}[mod]
        d.ellipse((cx - R * size, cy + oy * size - R * size, cx + R * size, cy + oy * size + R * size), fill=255)
    elif mod == 'frost':
        for t in np.linspace(0.55, 0.85, 7): blob(t, 0.04, 0.13)
    elif mod == 'incendiary':
        blob(1.02, 0.0, 0.10)
    elif mod == 'shock':
        blob(0.35, 0.22, 0.14)
    elif mod == 'explosive':
        blob(0.62, -0.20, 0.16)
    return m

def mod_edit(rgba, pts, view, mod, tag, seed=21):
    cache = f'{LORE}/gen/mod-cache/{tag}-{mod}-s{seed}.png'
    mask = mod_mask(rgba, pts, view, mod)
    pad = 0.6
    # canvas with room for attachments outside the silhouette
    bb = rgba.getbbox(); P = int(max(rgba.size) * 0.25)
    cv = Image.new('RGBA', (rgba.width + 2 * P, rgba.height + 2 * P)); cv.alpha_composite(rgba, (P, P))
    mk = Image.new('L', cv.size); mk.paste(mask, (P, P))
    if os.path.exists(cache):
        ed = Image.open(cache).convert('RGB')
    else:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        src = f'{LORE}/gen/tmp/{tag}-{mod}-src.png'; msk = f'{LORE}/gen/tmp/{tag}-{mod}-mask.png'
        on_white(cv).save(src); mk.convert('RGB').save(msk)
        p = comfy.run(gen.inpaint_graph(src, msk, MOD_PROMPTS[mod], seed, 1.0), f'{LORE}/gen/tmp/raw')[0]
        ed = Image.open(p).convert('RGB').resize(cv.size); ed.save(cache)
    # alpha: the weapon's own, plus inside the mask whatever is not paper-white
    a = np.asarray(ed).astype(np.int32)
    notbg = (a.min(-1) < 225) | (np.abs(a - a.mean(-1, keepdims=True)).max(-1) > 18)
    al = np.maximum(np.asarray(cv.getchannel('A')), np.where((np.asarray(mk) > 0) & notbg, 255, 0)).astype(np.uint8)
    # keep the base pixels outside the mask exactly
    base = np.asarray(cv).copy(); inside = np.asarray(mk) > 0
    out = base.copy(); out[..., :3] = np.where(inside[..., None], a, base[..., :3]); out[..., 3] = al
    o = Image.fromarray(out.astype(np.uint8), 'RGBA').crop((P, P, P + rgba.width, P + rgba.height)) if False else Image.fromarray(out.astype(np.uint8), 'RGBA')
    return o, {k: (x + P, y + P) for k, (x, y) in pts.items()}

QWEN_MOD = {
    'frost': 'Add a stack of thick pale icy frost-condenser cooling fins clamped around the front half of the barrel, covered in white rime and frost crystals.',
    'incendiary': 'Add a chunky igniter nozzle clamped onto the muzzle with a hot orange pilot flame burning at its tip.',
    'shock': 'Add a small upright Tesla coil with copper windings and a round ball electrode mounted on top of the body, with a crackling yellow spark.',
    'explosive': 'Add a big round squat grenade canister drum, olive drab with a red hazard stripe, clamped underneath the barrel.',
}

def mod_zone(rgba, pts, view, mod):
    from PIL import ImageDraw
    w, h = rgba.size
    gx, gy = pts['grip']; mx, my = pts['muzzle']
    L = math.hypot(mx - gx, my - gy) or 1; ux, uy = (mx - gx) / L, (my - gy) / L
    nx, ny = uy, -ux
    if ny > 0: nx, ny = -nx, -ny
    bb = rgba.getbbox(); size = max(bb[2] - bb[0], bb[3] - bb[1])
    m = Image.new('L', (w, h)); d = ImageDraw.Draw(m)
    if view in ('s', 'n'):
        R = {'frost': 0.42, 'incendiary': 0.3, 'shock': 0.3, 'explosive': 0.35}[mod]
        oy = {'frost': 0, 'incendiary': 0, 'shock': -0.35, 'explosive': 0.35}[mod]
        d.ellipse((mx - R * size, my + oy * size - R * size, mx + R * size, my + oy * size + R * size), fill=255)
        return m
    t0, t1, p0, p1 = {'frost': (0.4, 1.02, -0.22, 0.22), 'incendiary': (0.82, 1.3, -0.22, 0.22),
                      'shock': (0.05, 0.62, 0.0, 0.5), 'explosive': (0.3, 0.98, -0.5, 0.0)}[mod]
    poly = [(gx + ux * L * t + nx * p * size, gy + uy * L * t + ny * p * size) for t, p in ((t0, p0), (t1, p0), (t1, p1), (t0, p1))]
    d.polygon(poly, fill=255)
    return m

def mod_edit_qwen(rgba, pts, view, mod, tag, seed=31):
    """Qwen-Image-Edit adds the attachment; only its zone is taken from the edit."""
    P = int(max(rgba.size) * 0.3)
    cv = Image.new('RGBA', (rgba.width + 2 * P, rgba.height + 2 * P)); cv.alpha_composite(rgba, (P, P))
    p2 = {k: (x + P, y + P) for k, (x, y) in pts.items()}
    zone = mod_zone(cv, p2, view, mod).filter(ImageFilter.GaussianBlur(2))
    cache = f'{LORE}/gen/mod-cache/q-{tag}-{mod}-s{seed}.png'
    if os.path.exists(cache):
        ed = Image.open(cache).convert('RGB')
    else:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        src = f'{LORE}/gen/tmp/{tag}-{mod}-qsrc.png'; on_white(cv).save(src)
        W = (cv.width // 16) * 16; H = (cv.height // 16) * 16
        s = min(1.0, 1024 / max(W, H)); W, H = int(W * s) // 16 * 16, int(H * s) // 16 * 16
        prompt = QWEN_MOD[mod] + ' Keep the object, its angle, size, position and every other detail exactly the same, on a plain white background.'
        pth = comfy.run(gen.qwen_graph(src, prompt, seed, W, H), f'{LORE}/gen/tmp/raw')[0]
        ed = Image.open(pth).convert('RGB').resize(cv.size, Image.LANCZOS); ed.save(cache)
    a = np.asarray(ed).astype(np.int32)
    notbg = (a.min(-1) < 228) | (np.abs(a - a.mean(-1, keepdims=True)).max(-1) > 20)
    z = np.asarray(zone) > 128
    base = np.asarray(cv).copy(); out = base.copy()
    out[..., :3] = np.where(z[..., None], a, base[..., :3])
    out[..., 3] = np.where(z, np.where(notbg, 255, 0), base[..., 3])
    return Image.fromarray(out.astype(np.uint8), 'RGBA'), p2
