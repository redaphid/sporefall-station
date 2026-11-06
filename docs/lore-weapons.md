# Lore weapons

Canon tie 2 (`docs/LORE.md`): weapons are bubble-burst plumbing, not guns.
`LORE_CHARACTERS.md` G2: "a weapon is a stolen section of an essence still".
Owner (2026-11-06): no clubs, wrenches, knives or plain pistols; generated art
only, animated. Each mundane weapon became a colony still-section with the
SAME numbers (`src/game/data/loreWeapons.test.ts` pins them), so balance did
not move. Comics that settled the roster: https://draw.hypnodroid.com/b/sporefall-weapons

| old id | new id | name | glow (G3: one hue) | carried by |
|---|---|---|---|---|
| pistol | rivetDriver | Rivet Driver | green | Ranger (start), Rootcult Acolyte, Drowned Diver, Tide Bellwether, loot |
| wrench | pressureLance | Pressure Lance | teal | Bog Mutant, Blast Diver, Barter Frog, loot |
| knife | siphonSpike | Siphon Spike | teal | loot |
| sledgehammer | cageRam | Cage Ram | yellow | loot |
| shotgun | scatterFunnel | Scatter Funnel | teal | loot |
| machinegun | coilRepeater | Coil Repeater | teal | loot |
| flamethrower | phosphorHose | Phosphor Hose | orange | loot |
| freezeRay | frostCondenser | Frost Condenser | pale frost | loot |
| tranquilizer | lullDarter | Lull Darter | violet | (scenarios) |
| stunGun | sparkCoil | Spark Coil | yellow | loot |

- **Rivet Driver** (sidearm): a salvaged pneumatic rivet driver: heavy receiver, thick clamp-banded barrel, muzzle collar, air cylinder, one small green charge vial. It fires the game's fast hard tracer, so it must look punchy and kinetic. (The first design, a caged-bulb "Decanter", was dropped the same day: owner, "a 'bubble gun' would be very unsatisfying to use, with characteristics different than the existing projectiles".)
- **Pressure Lance**: a stolen still pipe with a heavy pneumatic piston head; the thrust slams the piston (the knockback).
- **Siphon Spike**: a sampling probe: glass barrel, needle tip. Quick jab.
- **Cage Ram**: two-handed pole, a wire cage holding a charged bulb; it bursts on impact (the stun).
- **Scatter Funnel / Coil Repeater / Phosphor Hose / Frost Condenser / Lull Darter / Spark Coil**: funnel mouth, coil-wrapped tube, hose-fed wand, finned condenser, slim dart tube, forked coil prongs.

**Look promises behaviour** (owner, 2026-11-06): each weapon must read as what its existing projectile, hit and numbers deliver; essence glow is one small accent, never the barrel.

**Look promises behaviour** (owner, 2026-11-06): each weapon must read as what its existing projectile, hit and numbers deliver; essence glow is one small accent, never the barrel.

Not steampunk: worn grey steel, rubber, canvas tape; no gears, brass filigree or goggles.

## Bodies are their own weapons

Only tool-using humanoids carry a weapon (`TOOL_USERS` in the test). Beasts
keep natural armament (fangs, mandibles, horns, claws) and draw no overlay.
The Spore Warden and Airlock Warden draw the spore-drone, a machine: the warden
fights with `grappleArms` (the old wrench numbers), and both are `bodyArmed`,
so populate's arsenal roll no longer hands a drone a carried weapon (the roll
is still drawn, so every other spawn's weapon is unchanged).

## Merging other branches

The ids changed everywhere (134 files). After merging this branch into one that
still says `'pistol'`, run `python3 scripts/rename-weapon-ids.py`; the scan in
`loreWeapons.test.ts` fails while any old id survives. SAVE_VERSION 5 and
PROTOCOL_VERSION 15 discard pre-rename saves and refuse pre-rename peers.
