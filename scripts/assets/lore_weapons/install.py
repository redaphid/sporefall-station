"""Install built weapon frames into both packs: files under <pack>/weapons/,
manifest sprite keys + the `weapons` grip/muzzle section. Idempotent: a
weapon's keys are rewritten from what is on disk in the build dir."""
import json, os, re, shutil, sys
WT = '/home/hypnodroid/Worktrees/sporefall-station/lore-weapons-1106/public/themes'
SRC = '/mnt/d/tmp/cast-walks/weapons/lore/pack'
PACKS = {2: 'swampspace-hires', 1: 'swampspace'}
RX = re.compile(r'^weapon-([A-Za-z]+)-(e|se|s|ne|n)-((?:idle|attack|glow)|mod-[A-Za-z]+)-(\d)\.png$')
def install(ids):
    for grid, pack in PACKS.items():
        d = f'{SRC}/grid{grid}'; man_p = f'{WT}/{pack}/manifest.json'
        man = json.load(open(man_p)); pts = json.load(open(f'{d}/weapons.json'))
        os.makedirs(f'{WT}/{pack}/weapons', exist_ok=True)
        for wid in ids:
            for k in [k for k in man['sprites'] if k.startswith(f'weapon.{wid}.')]: del man['sprites'][k]
            for f in os.listdir(f'{WT}/{pack}/weapons'):
                if f.startswith(f'{wid}-'): os.remove(f'{WT}/{pack}/weapons/{f}')
            n = 0
            for f in sorted(os.listdir(d)):
                m = RX.match(f)
                if not m or m.group(1) != wid: continue
                name = f[len('weapon-'):]
                shutil.copy(f'{d}/{f}', f'{WT}/{pack}/weapons/{name}')
                man['sprites'][f'weapon.{wid}.{m.group(2)}-{m.group(3)}-{m.group(4)}'] = f'weapons/{name}'; n += 1
            man.setdefault('weapons', {})[wid] = pts[wid]
            print(pack, wid, n, 'frames')
        indent = 1 if pack == 'swampspace-hires' else 2
        txt = json.dumps(man, indent=indent, ensure_ascii=False) + '\n'
        open(man_p, 'w').write(txt)
if __name__ == '__main__':
    install(sys.argv[1:])
