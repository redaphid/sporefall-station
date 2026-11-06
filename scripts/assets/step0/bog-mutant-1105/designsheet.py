#!/usr/bin/env python3
"""Design sheet: 3 redesign candidates (concept, 3 seeds at 96 px on the floor, 2x) beside the live cast at 96 px.
usage: designsheet.py OUT.png PICKS.json   (PICKS: [{key,title,concept,dir,seeds,best,lines:[...]}])"""
import json, sys
from PIL import Image, ImageDraw, ImageFont
out, picks = sys.argv[1], json.load(open(sys.argv[2]))
WT = '/home/hypnodroid/Worktrees/sporefall-station/bog-mutant-1105/public/themes/swampspace-hires/chars'
FLOOR = (12, 20, 22); INK = (220, 226, 214); DIM = (150, 160, 150); HOT = (255, 216, 62)
try:
    F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
    FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20)
except OSError:
    F = FB = ImageFont.load_default()
CAST = ['bog-mender', 'drowned-diver', 'blast-diver', 'bellwether', 'mycologist', 'vine-ranger', 'cinder-husk',
        'derelict-bot', 'spore-mortar', 'frog-settler', 'sporeling-mite', 'gloam-hound']
W = 2000; ROW = 300
H = 70 + len(picks) * ROW + 190
m = Image.new('RGB', (W, H), FLOOR); d = ImageDraw.Draw(m)
d.text((16, 12), 'bog-mutant redesign: pick 1 of 3', font=FB, fill=INK)
d.text((16, 40), 'roles: mutant (rootcult brawler, wrench, hp 40, speed 3.4) + acolyte (rootcult pistol hunter in packs, hp 35, 3.6); '
       'the renderer draws the weapon. 96 px, locked 34 colours, game floor.', font=F, fill=DIM)
y = 70
for p in picks:
    d.line((0, y, W, y), fill=(40, 52, 54))
    d.text((16, y + 8), p['title'], font=FB, fill=HOT)
    c = Image.open(p['concept']).convert('RGB'); c.thumbnail((200, 250)); m.paste(c, (16, y + 38))
    x = 230
    for s in p['seeds']:
        im = Image.open(f"{p['dir']}/bog-mutant-s{s}-96.png").convert('RGBA')
        m.paste(im, (x, y + 60), im)
        big = im.resize((192, 192), Image.NEAREST); m.paste(big, (x + 100, y + 38), big)
        d.text((x, y + 236), f"seed {s}" + ("  (pick)" if s == p['best'] else ''), font=F,
               fill=HOT if s == p['best'] else DIM)
        x += 310
    for i, line in enumerate(p['lines']):
        d.text((x + 10, y + 40 + i * 22), line, font=F, fill=INK)
    y += ROW
d.line((0, y, W, y), fill=(40, 52, 54))
d.text((16, y + 8), 'beside the live cast at 96 px (each candidate = its picked seed)', font=F, fill=DIM)
x = 16
for p in picks:
    im = Image.open(f"{p['dir']}/bog-mutant-s{p['best']}-96.png").convert('RGBA'); m.paste(im, (x, y + 36), im)
    d.text((x, y + 136), p['key'], font=F, fill=HOT); x += 104
x += 20
cur = Image.open(f'{WT}/bog-mutant-s-idle.png').convert('RGBA'); m.paste(cur, (x, y + 36), cur)
d.rectangle((x - 3, y + 30, x + 99, y + 134), outline=(220, 60, 60), width=2)
d.text((x, y + 136), 'CURRENT, to be', font=F, fill=(240, 90, 90)); d.text((x, y + 154), 'replaced', font=F, fill=(240, 90, 90))
x += 124
for k in CAST:
    im = Image.open(f'{WT}/{k}-s-idle.png').convert('RGBA'); m.paste(im, (x, y + 36), im)
    d.text((x, y + 136), k[:13], font=F, fill=DIM); x += 104
m.save(out); print(out, m.size)
