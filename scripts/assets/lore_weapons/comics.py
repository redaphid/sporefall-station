import json, sys
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, '/mnt/d/tmp/cast-walks/weapons/lore/tools')
from sketches import sketch, WEAPONS, GLOW
WT = '/home/hypnodroid/Worktrees/sporefall-station/lore-weapons-1106/public/themes/swampspace-hires/'
M = json.load(open(WT + 'manifest.json'))['sprites']
F = lambda s: ImageFont.truetype('/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf', s)
FB = lambda s: ImageFont.truetype('/usr/share/fonts/Adwaita/AdwaitaMono-Bold.ttf', s)
PAPER, INK = (236, 232, 218, 255), (20, 20, 24)
PW, PH = 440, 470

ALIAS = {'shopkeeper': 'civilian', 'lockkeeper': 'warden'}
def char(arch, view='e-idle', k=2):
    arch = ALIAS.get(arch, arch)
    v = M.get(f'char.{arch}.{view}') or M.get(f'char.{arch}.s-idle')
    v = v[0] if isinstance(v, list) else v
    im = Image.open(WT + v).convert('RGBA')
    return im.resize((im.width * k, im.height * k), Image.NEAREST)

def wrap(d, text, xy, width, font, fill=INK):
    x, y = xy; line = ''
    for w in text.split():
        t = (line + ' ' + w).strip()
        if d.textlength(t, font=font) > width:
            d.text((x, y), line, font=font, fill=fill); y += font.size + 4; line = w
        else: line = t
    d.text((x, y), line, font=font, fill=fill)

def bubbles(d, cx, cy, glow, n=6, spread=40, r=8):
    import math
    for i in range(n):
        a = i * 2.39; rr = spread * ((i + 1) / n) ** .5
        x, y = cx + math.cos(a) * rr, cy + math.sin(a) * rr; q = r - i // 2
        d.ellipse((x - q, y - q, x + q, y + q), fill=glow + (200,), outline=(242, 246, 234), width=2)

def panel(title, arch=None, weapon=None, note='', view='e-idle', fx=None, wscale=.62, wdy=0, wang=0, natural=None, phase=0):
    im = Image.new('RGBA', (PW, PH), PAPER); d = ImageDraw.Draw(im)
    d.rectangle((2, 2, PW - 3, PH - 3), outline=INK, width=4)
    wrap(d, title, (14, 10), PW - 28, FB(20))
    if arch:
        c = char(arch, view); cx, cy = 20, 250 - c.height // 2 + 40
        im.alpha_composite(c, (cx, cy))
        hand = (cx + c.width * .62, cy + c.height * .58)
        if weapon:
            sk = sketch(weapon, phase=phase); sk = sk.resize((int(sk.width * wscale), int(sk.height * wscale)), Image.LANCZOS)
            if wang: sk = sk.rotate(wang, expand=True, resample=Image.BICUBIC)
            wx, wy = int(hand[0] + 10), int(hand[1] - sk.height * .55 + wdy)
            im.alpha_composite(sk, (wx, wy))
            d.line((hand[0], hand[1], wx + sk.width * .2, wy + sk.height * .65), fill=INK, width=2)
            d.text((wx, wy + sk.height + 4), WEAPONS[weapon][0], font=FB(18), fill=INK)
        if natural:
            d.text((cx + c.width + 8, cy + c.height * .45), natural, font=FB(18), fill=(160, 40, 30))
    if fx: fx(d)
    wrap(d, note, (14, PH - 92), PW - 28, F(17))
    return im

def strip(title, panels, cols, out):
    rows = (len(panels) + cols - 1) // cols
    S = Image.new('RGBA', (cols * (PW + 12) + 12, rows * (PH + 12) + 70), (250, 248, 240, 255))
    ImageDraw.Draw(S).text((14, 16), title, font=FB(30), fill=INK)
    for i, p in enumerate(panels): S.alpha_composite(p, (12 + (i % cols) * (PW + 12), 64 + (i // cols) * (PH + 12)))
    S.convert('RGB').save(out, quality=88); print(out, S.size)

O = '/mnt/d/tmp/cast-walks/weapons/lore/comics/'
T = GLOW['teal']; Y = GLOW['yellow']
A = [
    panel('1. Ranger (player): starts with the Decanter', 'player', 'decanter', 'Old pistol slot. A caged glass bulb is the barrel; the petcock decants one bubble per pull. Same numbers as the pistol.'),
    panel('2. Rootcult Acolyte: Decanter', 'acolyte', 'decanter', 'Hunts at range. Same sidearm, same glow (teal = plain essence).'),
    panel('3. Drowned Diver: Decanter', 'drowner', 'decanter', 'Raid rank-and-file. The old harpoon-gun role keeps the pistol numbers.'),
    panel('4. Tide Bellwether: Decanter', 'bellwether', 'decanter', 'Rings the raid in, shoots from the back.'),
    panel('5. Bog Mutant: Pressure Lance', 'mutant', 'pressureLance', 'Old wrench slot. Still on shift, still carrying a stolen still pipe; the thrust vents its jar out the nozzle.', wscale=.5),
    panel('6. Blast Diver: Pressure Lance', 'breacher', 'pressureLance', 'Wrench slot. Same pipe, used to force hatches.', wscale=.5),
    panel('7. Barter Frog (shopkeeper): Pressure Lance', 'shopkeeper', 'pressureLance', 'Wrench slot. Only swings if robbed.', wscale=.5),
    panel('8. Spore Warden: grapple arms', 'warden', None, 'CHANGE: a drone is machinery, not a tool user. Its claws are its weapon (wrench numbers), no held overlay.', natural='claws:\nno overlay'),
    panel('9. Gloam Hound: fangs', 'gloamhound', None, 'Beasts bite, rake and ram with their bodies. Nothing drawn in a paw or jaw.', natural='fangs:\nno overlay'),
]
strip('A. Who carries what (sidearm = Decanter, melee = Pressure Lance)', A, 3, O + 'strip-A-who.jpg')

def idle_fx(d):
    for i in range(3):
        x0 = 250 + i * 60
        d.text((x0, 330), f'f{i+1}', font=FB(16), fill=INK)
def fire_fx(d):
    bubbles(d, 405, 228, T, n=7, spread=26, r=9)
    d.text((300, 300), 'recoil 1-2px', font=F(16), fill=INK)
def shot_fx(d):
    for i, x in enumerate((300, 350, 405)): d.ellipse((x - 10 + i * 2, 214, x + 10 - i * 2, 234), fill=T + (255,), outline=(242, 246, 234), width=2)
B = [
    panel('1. Idle: low-ready, jar bubbles', 'player', 'decanter', 'Held low at the hip. 3-frame loop: bubbles rise inside the caged bulb, glow breathes.', wdy=40, phase=0, fx=idle_fx),
    panel('2. Aim: level at the fist', 'player', 'decanter', 'Nozzle on the aim line, grip under the fist.', phase=1),
    panel('3. Fire: petcock opens', 'player', 'decanter', 'Use one-shot (3-4 frames): bulb flashes, bubble burst at the nozzle, recoil back, bulb dims.', phase=2, fx=fire_fx),
    panel('4. The shot is a bubble', 'player', 'decanter', 'Projectile reads as an essence bubble; mods tint it (canon tie 2: mixing in the chamber).', phase=0, fx=shot_fx),
]
strip('B. Sidearm in use: Decanter idle -> aim -> fire', B, 4, O + 'strip-B-fire.jpg')

def lunge_fx(d): bubbles(d, 410, 238, T, n=8, spread=30, r=9)
def slam_fx(d):
    d.ellipse((250, 330, 420, 380), outline=Y + (255,), width=5); d.ellipse((290, 342, 380, 368), outline=Y + (255,), width=3)
def jab_fx(d): bubbles(d, 330, 240, T, n=4, spread=12, r=6)
C = [
    panel('1. Lance: low-ready', 'mutant', 'pressureLance', 'Pipe carried low, jar bubbling.', wscale=.5, wdy=30),
    panel('2. Lance: lunge + vent', 'mutant', 'pressureLance', 'Use: thrust forward 3 frames, the nozzle vents a puff of essence (the knockback).', wscale=.5, fx=lunge_fx),
    panel('3. Cage Ram: overhead slam', 'player', 'cageRam', 'Old sledgehammer slot. Two hands; the caged charge bursts on impact = the stun ring.', wscale=.5, wang=-25, fx=slam_fx),
    panel('4. Siphon Spike: quick jab', 'player', 'siphonSpike', 'Old knife slot. A sampling probe: glass barrel, needle tip. Fast, light jab.', wscale=.55, fx=jab_fx),
]
strip('C. Melee in use: Pressure Lance / Cage Ram / Siphon Spike', C, 4, O + 'strip-C-melee.jpg')

D = []
for wid, (name, _, g) in WEAPONS.items():
    im = Image.new('RGBA', (PW, 230), PAPER); d = ImageDraw.Draw(im); d.rectangle((2, 2, PW - 3, 227), outline=INK, width=4)
    im.alpha_composite(sketch(wid), (20, 50)); d.text((14, 10), name, font=FB(20), fill=INK); D.append(im)
