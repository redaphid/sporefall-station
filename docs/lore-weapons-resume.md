# Lore weapons: resume note (wind-down 2026-11-06)

Branch `art/lore-weapons-1106`; preview `preview/lore-weapons`
(https://sporefall.hypnodroid.com/betas/lore-weapons/). Roster and rules:
`docs/lore-weapons.md`. Pipeline: `scripts/assets/lore_weapons/` (working
copy and all renders/caches under `D:\tmp\cast-walks\weapons\lore\`).

## Roster (ids renamed in code, numbers pinned by loreWeapons.test.ts)
pistol->rivetDriver, wrench->pressureLance, knife->siphonSpike,
sledgehammer->cageRam, shotgun->scatterFunnel, machinegun->coilRepeater,
flamethrower->phosphorHose, freezeRay->frostCondenser,
tranquilizer->lullDarter, stunGun->sparkCoil. Warden = natural grappleArms;
drones are `bodyArmed`. SAVE_VERSION 5, PROTOCOL_VERSION 15.

## Art state
- **rivetDriver: shipped in both packs.** e/se/s/ne/n x idle 3 + attack 3,
  glow layer (e/se/ne), mod layers frost/incendiary/shock/explosive (all views
  where the zone hit; se shock is empty).
- **The other nine: NOT in the packs.** Profiles, Qwen views (se/s/ne/n,
  picks in `gen/<id>/pick.json`), idle inpaints for se/s/ne/n and loot icons
  are done (icons shipped). Blocker: their `e` view must come from the first
  matte (`gen/<id>/<id>-pick-rgba.png`; re-matting dropped the Coil
  Repeater's barrel and the Cage Ram's shaft), so the `e` idle inpaints need
  regenerating (27 SDXL inpaints, ~4 min).
- Loot icons: all ten, both packs.

## Next command
```sh
cd /mnt/d/tmp/cast-walks/weapons/lore/tools
~/Projects/sporefall-station/scripts/gpu/gpu-run --label "weapons profile idle inpaints" -- \
  python3 prefetch.py pressureLance siphonSpike cageRam scatterFunnel coilRepeater phosphorHose frostCondenser lullDarter sparkCoil
for w in pressureLance siphonSpike cageRam scatterFunnel coilRepeater phosphorHose frostCondenser lullDarter sparkCoil; do python3 build.py $w; done
# look: python3 framesheet.py <id> 2 ; zoom sheet: e2e/weapon-zoom-sheet.mjs --cast loot --weapons ../pack/grid2
python3 install.py pressureLance siphonSpike cageRam scatterFunnel coilRepeater phosphorHose frostCondenser lullDarter sparkCoil
```

## Open issues
- #181: mod attachments for the remaining 14 mods and the other nine weapons.
- Bog-mutant fist anchors (acolyte/mutant) sit at the shoulder: the held
  weapon floats right of the body (handAnchors.ts, plumbing branch).
- Gun grip detection on 3/4 views is heuristic (`frames.gun_points`); check
  every view's grip mark (`framesheet.py`) before installing.
- No beast has a drawn attack clip; hound, stalker, brute, Mireclaw Alpha
  and lurker would read better with bite/rake/ram clips.
- The Coil Repeater profile reads close to a stock rifle; consider a re-roll.
