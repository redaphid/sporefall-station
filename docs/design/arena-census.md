# Arena census: do different builds win different fights?

Status: **measured** on `main` at `ccf5a56`, after #92, #99, #101, #132 and #134.
Code: `src/game/arenas.ts` (`ARENAS`, `stageArena`), `src/debug/census.ts` (the
bot, `runFight`, `reachProbe`), `scripts/census.mts` (the CLI). Tests:
`src/game/arenas.test.ts`, `src/debug/census.test.ts`.

Three loadout prototypes (draft PRs #111, #112, #113) failed their playtest for one
shared reason. Floor-1 fights never threatened the tester, so one generic build won
every fight and no build choice mattered. Every one of those designs assumed this
premise:

> Sporefall's enemies can pose genuinely different questions, so different builds
> win different fights.

If no build ever loses, no loadout mechanic can show variety. This census tests the
premise with numbers before anyone builds a fourth loadout mechanic. Every figure
in the verdict comes from the generated tables at the end of this doc.

## Verdict: yes in three of nine arenas, and no build wins them all

- **The enemies can threaten.** Every arena downs a player who does nothing on 8 of
  8 seeds, after a median of 3.8 s (two brutes) to 5.6 s (the Mireclaw Alpha). The
  plain pistol with no mods wins 0/8 against one brute, 0/8 against two, 0/8
  against every boss arena, 3/8 against the gangsters and the swarm, and 4/8
  against the cinders.
- **Three arenas each want a different element.**
  - The brute pair wants fire. Every build with `incendiary` in it wins 8/8, and
    `incendiary` alone takes 0 damage. `shock`, `frost`, `pierce>shock` and
    `pierce>frost` win 0/8. The one build without fire that wins is
    `pierce>frost>shock`, 7/8 on 105 damage.
  - The gangsters want frost first. `pierce>frost` wins 8/8 on 44 damage.
    `incendiary` alone wins 7/8 on 80, and `shock` alone 6/8 on 104.
  - The wet boss that is weak to lightning wants shock. `shock` wins 8/8 on 44
    damage and `pierce>shock` 8/8 on 40. The builds whose only elements are fire
    and frost win 0/8 or 1/8. The weakness is what decides it. Against the stock
    wet boss the same two shock builds win only 3/8 and 4/8.
- **No build is best everywhere.** The best total is `hand frost-lead` with 46 of
  72 fights won, and it wins the wet lightning boss only 4/8. The fire builds that
  sweep the brute pair win that boss 0/8.
- **Three arenas do not separate builds by outcome.** Against one brute, the swarm
  and the cinders, 12 of 13 builds win 8/8. Only `none` loses. The builds differ
  only in damage taken. Against one brute, every build with fire takes 0 damage
  and `shock` takes 82.
- **Fire answers the cinders.** A cinder takes 20% from fire, but a burning body
  panics unless it is the boss or fully fire-immune (`statusFx.ts`, #92). A
  panicking cinder runs away instead of hitting. `incendiary` wins 8/8 on 9 damage.
  The plain pistol wins 4/8 on 115.
- **The dry boss beats every build.** No build wins `arena-boss` more than 1/8.
  `resist.electrified: 2` changes nothing there. All 13 builds have identical hp
  traces on all 8 seeds.

The premise holds where an arena asks a question. Fire answers closers, frost
answers shooters, and shock answers a wet boss that is weak to lightning. A loadout
mechanic has real choices to vary between. There is no answer yet for the dry
boss. Half the arenas reward any element over none and do not care which.

## How the census works

Each arena is one fight staged in the room with the most open floor on the seed's
real floor-1 level. `stageArena` clears the NPCs, loot, fire and projectiles
floor-wide and the room's furniture. It puts the player on the first line in from
one end, at full health with no spawn grace. It fills a band at the far end with
the foes, no further than one tile inside the shortest sight range in the cast, so
every foe can see the player from where it starts. The arenas change only
placement, counts and per-foe overrides. No tile, balance table or AI code
changes. Load any arena with `?seed=303&scenario=arena-brute` (and so on), or with
`npx tsx scripts/playtest.mts s.json new --seed 303 --scenario arena-brute`. The
generated tables list every arena, its foes and its question.

Each foe count is the smallest a calibration sweep tried at which the plain pistol
lost at least half its fights while some element build still won. The brute pair
is one step past that count. The playtest staged one cinder and three sporelings.
In the sweep, three cinders and four sporelings lost to every build tried, the
plain pistol included. The sweep ran before #92 and #134 and was not repeated. The
plain pistol's results are the same on current `main`.

The census bot is fixed and deterministic. Each tick it aims at the nearest living
foe and fires. It walks straight away from that foe while below half health or
while any foe is within 1.5 tiles. It never rolls, chases or picks targets. It
drives the real sim through the `step` verb, one tick per call. A fight ends when
every staged foe is dead (won), the player is downed, or 60 s pass (timed out).
None of the 936 bot fights timed out. `runFight` throws if an arena stages fewer
foes than it names or if the fight leaves the floor.

A gun fires its mods in order, one cast per pull (#134). The builds are no mods,
each element alone, and each element behind `pierce`. Three more hold two elements
behind `pierce`, to show which pair does the work. The four-mod hand
`pierce, shock, incendiary, frost` runs in three orders that lead with shock, fire
or frost. The eight seeds each put the arena in a room of a different shape, from
7x7 to 11x8. A `passive` run per arena and seed holds neutral input to measure how
fast the arena kills a player who does nothing.

## Lightning weakness reaches play only through water

The census compares `arena-boss` with `arena-boss-lightning`, and `arena-boss-wet`
with `arena-boss-lightning-wet`. In the dry pair, all 13 builds have identical hp
traces on all 8 seeds. In the wet pair, every build without `shock` has identical
traces, and six of the seven builds with `shock` fight differently on 6 to 8 of
the 8 seeds. The seventh, `hand fire-lead`, casts `shock` last and has identical
traces on all 8. The census does not explain that one.

The code shows why. A Tesla hit goes through `interactions.shock` (`statusFx.ts`
routes `electrified` there). `shock` deals `ELEC_DAMAGE` scaled by
`resist.electrified` only to a wet body. A dry body is immobilized and takes
nothing, and `ELEMENTS.electrified.dot` is 0, so the damage-over-time path has
nothing to multiply either. Play can now reach the wet case, because #132's flooded
floors apply `wet` (`modifierSystem.ts`).

## Why the loadout playtests saw no threat

**Single floor-1 foes lose the damage race by 3 to 9 times.** Computed from
`NPCS`, `WEAPONS` and the resist tables for a pistol that always hits:

| foe | pistol hits to kill | player's time to kill | foe's time to down 120 hp once in reach |
|---|---|---|---|
| thug | 3 | 1.2 s | 3.5 s (bat) |
| gangster | 3 | 1.2 s | about 6 s (pistol) |
| cinder | 3 | 1.2 s | 5.6 s (fists) |
| sporeling | 2 | 0.6 s | 5.6 s (fists) |
| brute | 19 | 10.8 s | 3.5 s (bat) |
| Mireclaw Alpha | 30 | 17.4 s | 3.3 s (claws) |

The reach probe measures the same ratio for a gangster given 5000 hp. At 4 to 7
tiles, the player dealt 168 to 196 damage while that one gangster downed them. That
is about 5 ordinary 35-hp gangsters. Only the brute and the boss win a one-on-one
race, and the playtest staged mostly one-on-one fights.

**Ranged foes now answer fire from beyond their sight.** #101 makes every player
shot a noise heard out to 12 tiles (`goals.HEAR_RANGE`). A gangster walks toward
the noise and fires once the player is inside its 8-tile sight. In the reach probe,
a gangster shot from 9 tiles fires at 1.1 s, against 1.9 s when left alone. Shot
from 12 tiles it fires at 2.4 s, and left alone it never fires in 10 s. Before #101
the shot gangster fired no sooner than the idle one, which is how a playtester
could snipe at no cost.

**No foe can resist a lock.** A frozen body cannot act, and the next hit shatters
it for 5 times damage (`SHATTER_DAMAGE_MULT`). `resistMult` scales only damage and
never the length of an immobilize. Frost alone no longer answers most fights,
though. It wins the brute pair 0/8 and the gangsters 6/8.

The playtest's open-ground staging and human kiting (the player's 4.5 tiles/s
outruns every arena foe, the sporeling at 4.4 only just) likely widened the gap
further. That is inferred, not measured. The census bot does not kite.

## Proposed changes

The first version of this census proposed five changes. `main` has since made two
of them and replaced a third:

- A Tesla hit takes the `shock` path, with the hit's duration. Done in `statusFx.ts`.
- Play has a source of `wet`. Done by #132's flooded floors.
- A shot foe answers from beyond its sight. Replaced by #101's gunfire noise. The
  reach probe above measures it.

Two remain open. Neither is measured on current `main`.

1. **Give the dry boss an answer.** No build wins `arena-boss` more than 1/8. One
   data-only option in `data/elements.ts` is
   `electrified: { id: 'electrified', dot: 2, interval: 9, durationTicks: 30 }`,
   so `elementSystem` multiplies it by `resist.electrified` on dry targets too. It
   would also change the stock boss and add damage to NPC stun-gun hits on players.
   Its earlier measurement predates #134 and is not repeated here.
2. **Let a resist table shorten an immobilize.** Scale the lock that
   `applyImmobilize` grants by a resist key, so a foe can carry a frost-proof or
   shock-proof table. That lets an arena field a foe that a lock does not answer.
   The `electrified` key already scales shock damage (#97), so reusing it would
   make `electrified: 2` double both the damage and the lock. A separate key, such
   as `frozenLock`, avoids that.

## Limits

- The bot is deliberately simple. It never rolls, kites, chases or picks targets, so
  it understates what a skilled player does and overstates damage taken.
- Many melee fights replay the same way on seeds whose rooms differ only in shape
  beyond the fight. The "distinct fights" column counts how many of the 8 seeds
  gave a different hp trace. It is 3 for the frost builds against one brute, so
  that 8/8 is 3 independent results.
- The boss fights run the whole Mireclaw brain, including summons. Summons count
  toward damage taken but not toward the win.
- Passive regen heals the player during a fight, so damage taken can exceed 120.

## Census tables

Regenerate with `npx tsx scripts/census.mts --write docs/design/arena-census.md`
(about 75 s). Two runs produce byte-identical output. The command replaces only
the block below.

<!-- census:begin -->
Generated by `npx tsx scripts/census.mts --write docs/design/arena-census.md`. Seeds 303, 5, 4, 2, 44, 18, 51, 10; 13 builds; fights capped at 60 s.

| arena | foes | question | control |
|---|---|---|---|
| `arena-brute` | 1 brute | An armoured closer: bullets do 35%, so low damage per second loses the race. |  |
| `arena-brute-pair` | 2 brute | Two armoured closers: more than one element has to land. |  |
| `arena-kiter` | 3 gangster | Shooters that hold range and fire back: stop them shooting or lose the trade. |  |
| `arena-swarm` | 6 sporeling | A fast swarm: one bullet per body is too slow. |  |
| `arena-cinder` | 4 cinder | Ash-dwellers: fire does 20%, bullets do 110%. |  |
| `arena-boss` | 1 boss | Mireclaw Alpha with its stock resists. |  |
| `arena-boss-lightning` | 1 boss {"electrified":2} | Mireclaw Alpha weak to lightning (electrified x2). | `arena-boss` |
| `arena-boss-wet` | 1 boss wet | Mireclaw Alpha with its stock resists, standing wet. |  |
| `arena-boss-lightning-wet` | 1 boss {"electrified":2} wet | Mireclaw Alpha weak to lightning and standing wet, so a shock chain could land. | `arena-boss-wet` |

Arena rooms (the room with the most open floor on each seed): seed 303: warehouse stockroom 9x9; seed 5: office office 8x8; seed 4: clinic ward 7x8; seed 2: apartment living 9x10; seed 44: apartment living 8x6; seed 18: clinic waiting 8x9; seed 51: apartment living 7x7; seed 10: clinic ward 11x8.

### Build x arena

Each cell is fights won out of seeds, then mean damage taken. The player has 120 hp, and passive regen can push damage taken past it. Bold marks the best build in the column.

| build | arena-brute | arena-brute-pair | arena-kiter | arena-swarm | arena-cinder | arena-boss | arena-boss-lightning | arena-boss-wet | arena-boss-lightning-wet |
|---|---|---|---|---|---|---|---|---|---|
| none | 0/8 · 120 | 0/8 · 120 | 3/8 · 115 | 3/8 · 111 | 4/8 · 115 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| shock | 8/8 · 82 | 0/8 · 120 | 6/8 · 104 | 8/8 · 72 | 8/8 · 67 | 0/8 · 120 | 0/8 · 120 | 3/8 · 110 | 8/8 · 44 |
| incendiary | 8/8 · 0 | **8/8 · 0** | 7/8 · 80 | 8/8 · 45 | 8/8 · 9 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| frost | 8/8 · 72 | 0/8 · 120 | 6/8 · 81 | 8/8 · 62 | 8/8 · 10 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 |
| pierce>shock | 8/8 · 82 | 0/8 · 120 | 7/8 · 76 | 8/8 · 51 | 8/8 · 38 | 0/8 · 120 | 0/8 · 120 | **4/8 · 108** | **8/8 · 40** |
| pierce>incendiary | 8/8 · 0 | **8/8 · 0** | 8/8 · 58 | **8/8 · 33** | 8/8 · 9 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| pierce>frost | 8/8 · 72 | 0/8 · 120 | **8/8 · 44** | 8/8 · 39 | 8/8 · 10 | **1/8 · 122** | **1/8 · 122** | 1/8 · 122 | 1/8 · 122 |
| pierce>incendiary>frost | **8/8 · 0** | 8/8 · 38 | 8/8 · 68 | 8/8 · 56 | 8/8 · 10 | 1/8 · 118 | 1/8 · 118 | 0/8 · 120 | 0/8 · 120 |
| pierce>shock>incendiary | 8/8 · 0 | 8/8 · 94 | 7/8 · 71 | 8/8 · 48 | 8/8 · 31 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 |
| pierce>frost>shock | 8/8 · 74 | 7/8 · 105 | 7/8 · 57 | 8/8 · 63 | 8/8 · 28 | 0/8 · 122 | 0/8 · 122 | 1/8 · 118 | 6/8 · 96 |
| hand shock-lead | 8/8 · 0 | 8/8 · 2 | 7/8 · 73 | 8/8 · 56 | **8/8 · 5** | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 2/8 · 104 |
| hand fire-lead | 8/8 · 0 | 8/8 · 42 | 7/8 · 66 | 8/8 · 55 | 8/8 · 29 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| hand frost-lead | 8/8 · 12 | 8/8 · 0 | 8/8 · 74 | 8/8 · 67 | 8/8 · 14 | 1/8 · 119 | 1/8 · 119 | 0/8 · 120 | 4/8 · 105 |

### Best and worst build per arena

Builds joined by `=` tie on every ranking key.

| arena | best | worst | builds that failed to win at least once |
|---|---|---|---|
| arena-brute | pierce>incendiary>frost: 8/8 won, 4.7 s, 0 dmg | none: 0/8 won, n/a s, 120 dmg | 1/13 |
| arena-brute-pair | incendiary = pierce>incendiary: 8/8 won, 7.7 s, 0 dmg | none: 0/8 won, n/a s, 120 dmg | 6/13 |
| arena-kiter | pierce>frost: 8/8 won, 2.4 s, 44 dmg | none: 3/8 won, 6.6 s, 115 dmg | 9/13 |
| arena-swarm | pierce>incendiary: 8/8 won, 3.3 s, 33 dmg | none: 3/8 won, 4.9 s, 111 dmg | 1/13 |
| arena-cinder | hand shock-lead: 8/8 won, 6.4 s, 5 dmg | none: 4/8 won, 6.6 s, 115 dmg | 1/13 |
| arena-boss | pierce>frost: 1/8 won, 18.6 s, 122 dmg | none: 0/8 won, n/a s, 120 dmg | 13/13 |
| arena-boss-lightning | pierce>frost: 1/8 won, 18.6 s, 122 dmg | none: 0/8 won, n/a s, 120 dmg | 13/13 |
| arena-boss-wet | pierce>shock: 4/8 won, 8.2 s, 108 dmg | none: 0/8 won, n/a s, 120 dmg | 13/13 |
| arena-boss-lightning-wet | pierce>shock: 8/8 won, 5.2 s, 40 dmg | none: 0/8 won, n/a s, 120 dmg | 11/13 |

### Builds that fought identically

Builds with the same hp trace on every seed of an arena. The worlds may still differ in ways hp does not show, such as a status that deals no damage.

- arena-brute: shock = pierce>shock; incendiary = pierce>incendiary; frost = pierce>frost.
- arena-brute-pair: shock = pierce>shock; incendiary = pierce>incendiary; frost = pierce>frost.
- arena-kiter: none.
- arena-swarm: none.
- arena-cinder: none.
- arena-boss: none.
- arena-boss-lightning: none.
- arena-boss-wet: none.
- arena-boss-lightning-wet: none.

### arena-brute

An armoured closer: bullets do 35%, so low damage per second loses the race.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.5 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| pierce>incendiary>frost | 8 | 0 | 0 | 7 | 4.7 | 0 |  |
| hand fire-lead | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| incendiary | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| pierce>incendiary | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| hand shock-lead | 8 | 0 | 0 | 7 | 6.1 | 0 |  |
| pierce>shock>incendiary | 8 | 0 | 0 | 6 | 6.2 | 0 |  |
| hand frost-lead | 8 | 0 | 0 | 4 | 5.0 | 12 |  |
| frost | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
| pierce>frost | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
| pierce>frost>shock | 8 | 0 | 0 | 3 | 6.6 | 74 |  |
| shock | 8 | 0 | 0 | 8 | 12.9 | 82 |  |
| pierce>shock | 8 | 0 | 0 | 8 | 12.9 | 82 |  |
| none | 0 | 8 | 0 | 3 | n/a | 120 | 41 |

### arena-brute-pair

Two armoured closers: more than one element has to land.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 3.8 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| incendiary | 8 | 0 | 0 | 8 | 7.7 | 0 |  |
| pierce>incendiary | 8 | 0 | 0 | 8 | 7.7 | 0 |  |
| hand frost-lead | 8 | 0 | 0 | 8 | 9.3 | 0 |  |
| hand shock-lead | 8 | 0 | 0 | 7 | 8.5 | 2 |  |
| pierce>incendiary>frost | 8 | 0 | 0 | 8 | 6.3 | 38 |  |
| hand fire-lead | 8 | 0 | 0 | 7 | 6.9 | 42 |  |
| pierce>shock>incendiary | 8 | 0 | 0 | 6 | 9.9 | 94 |  |
| pierce>frost>shock | 7 | 1 | 0 | 8 | 18.3 | 105 | 50 |
| frost | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| pierce>frost | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| shock | 0 | 8 | 0 | 5 | n/a | 120 | 121 |
| pierce>shock | 0 | 8 | 0 | 5 | n/a | 120 | 121 |
| none | 0 | 8 | 0 | 5 | n/a | 120 | 151 |

### arena-kiter

Shooters that hold range and fire back: stop them shooting or lose the trade.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.3 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| pierce>frost | 8 | 0 | 0 | 8 | 2.4 | 44 |  |
| pierce>incendiary | 8 | 0 | 0 | 8 | 5.5 | 58 |  |
| pierce>incendiary>frost | 8 | 0 | 0 | 8 | 5.3 | 68 |  |
| hand frost-lead | 8 | 0 | 0 | 8 | 4.9 | 74 |  |
| pierce>shock | 7 | 1 | 0 | 8 | 6.0 | 76 | 7 |
| pierce>shock>incendiary | 7 | 1 | 0 | 8 | 4.8 | 71 | 21 |
| hand fire-lead | 7 | 1 | 0 | 8 | 6.3 | 66 | 22 |
| pierce>frost>shock | 7 | 1 | 0 | 8 | 3.0 | 57 | 35 |
| incendiary | 7 | 1 | 0 | 8 | 5.7 | 80 | 35 |
| hand shock-lead | 7 | 1 | 0 | 8 | 4.9 | 73 | 53 |
| shock | 6 | 2 | 0 | 8 | 8.7 | 104 | 25 |
| frost | 6 | 2 | 0 | 8 | 4.1 | 81 | 53 |
| none | 3 | 5 | 0 | 8 | 6.6 | 115 | 28 |

### arena-swarm

A fast swarm: one bullet per body is too slow.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.8 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| pierce>incendiary | 8 | 0 | 0 | 6 | 3.3 | 33 |  |
| pierce>frost | 8 | 0 | 0 | 5 | 5.0 | 39 |  |
| incendiary | 8 | 0 | 0 | 6 | 4.2 | 45 |  |
| pierce>shock>incendiary | 8 | 0 | 0 | 5 | 3.9 | 48 |  |
| pierce>shock | 8 | 0 | 0 | 6 | 4.9 | 51 |  |
| hand fire-lead | 8 | 0 | 0 | 5 | 5.7 | 55 |  |
| pierce>incendiary>frost | 8 | 0 | 0 | 6 | 4.8 | 56 |  |
| hand shock-lead | 8 | 0 | 0 | 5 | 5.2 | 56 |  |
| frost | 8 | 0 | 0 | 7 | 6.7 | 62 |  |
| pierce>frost>shock | 8 | 0 | 0 | 5 | 5.8 | 63 |  |
| hand frost-lead | 8 | 0 | 0 | 5 | 6.3 | 67 |  |
| shock | 8 | 0 | 0 | 6 | 6.1 | 72 |  |
| none | 3 | 5 | 0 | 6 | 4.9 | 111 | 19 |

### arena-cinder

Ash-dwellers: fire does 20%, bullets do 110%.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.7 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| hand shock-lead | 8 | 0 | 0 | 7 | 6.4 | 5 |  |
| pierce>incendiary | 8 | 0 | 0 | 8 | 5.2 | 9 |  |
| incendiary | 8 | 0 | 0 | 8 | 6.8 | 9 |  |
| pierce>frost | 8 | 0 | 0 | 3 | 4.5 | 10 |  |
| frost | 8 | 0 | 0 | 3 | 5.1 | 10 |  |
| pierce>incendiary>frost | 8 | 0 | 0 | 7 | 5.5 | 10 |  |
| hand frost-lead | 8 | 0 | 0 | 8 | 7.0 | 14 |  |
| pierce>frost>shock | 8 | 0 | 0 | 4 | 5.2 | 28 |  |
| hand fire-lead | 8 | 0 | 0 | 8 | 6.6 | 29 |  |
| pierce>shock>incendiary | 8 | 0 | 0 | 7 | 6.8 | 31 |  |
| pierce>shock | 8 | 0 | 0 | 4 | 5.5 | 38 |  |
| shock | 8 | 0 | 0 | 5 | 6.7 | 67 |  |
| none | 4 | 4 | 0 | 5 | 6.6 | 115 | 45 |

### arena-boss

Mireclaw Alpha with its stock resists.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| pierce>frost | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| hand frost-lead | 1 | 7 | 0 | 8 | 14.4 | 119 | 92 |
| pierce>incendiary>frost | 1 | 7 | 0 | 8 | 9.1 | 118 | 135 |
| hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 126 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| hand shock-lead | 0 | 8 | 0 | 8 | n/a | 120 | 167 |
| pierce>frost>shock | 0 | 8 | 0 | 8 | n/a | 122 | 183 |
| pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 199 |
| pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 231 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 245 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-boss-lightning

Mireclaw Alpha weak to lightning (electrified x2).

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| pierce>frost | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| hand frost-lead | 1 | 7 | 0 | 8 | 14.4 | 119 | 92 |
| pierce>incendiary>frost | 1 | 7 | 0 | 8 | 9.1 | 118 | 135 |
| hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 126 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| hand shock-lead | 0 | 8 | 0 | 8 | n/a | 120 | 167 |
| pierce>frost>shock | 0 | 8 | 0 | 8 | n/a | 122 | 183 |
| pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 199 |
| pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 231 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 245 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-boss-wet

Mireclaw Alpha with its stock resists, standing wet.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| pierce>shock | 4 | 4 | 0 | 8 | 8.2 | 108 | 66 |
| shock | 3 | 5 | 0 | 8 | 7.9 | 110 | 70 |
| pierce>frost | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| pierce>frost>shock | 1 | 7 | 0 | 8 | 12.5 | 118 | 92 |
| hand frost-lead | 0 | 8 | 0 | 8 | n/a | 120 | 105 |
| hand shock-lead | 0 | 8 | 0 | 8 | n/a | 120 | 136 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| pierce>incendiary>frost | 0 | 8 | 0 | 8 | n/a | 120 | 147 |
| hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 161 |
| pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 174 |
| pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 205 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 213 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-boss-lightning-wet

Mireclaw Alpha weak to lightning and standing wet, so a shock chain could land.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| pierce>shock | 8 | 0 | 0 | 8 | 5.2 | 40 |  |
| shock | 8 | 0 | 0 | 8 | 7.5 | 44 |  |
| pierce>frost>shock | 6 | 2 | 0 | 8 | 9.2 | 96 | 61 |
| hand frost-lead | 4 | 4 | 0 | 8 | 10.3 | 105 | 143 |
| hand shock-lead | 2 | 6 | 0 | 8 | 9.2 | 104 | 84 |
| pierce>frost | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 115 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| pierce>incendiary>frost | 0 | 8 | 0 | 8 | n/a | 120 | 147 |
| hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 161 |
| pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 205 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 213 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-boss vs arena-boss-lightning

| build | arena-boss | arena-boss-lightning | seeds with an identical hp trace |
|---|---|---|---|
| none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| pierce>shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| pierce>incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| pierce>frost | 1/8 won, 18.6 s, 122 dmg | 1/8 won, 18.6 s, 122 dmg | 8/8 |
| pierce>incendiary>frost | 1/8 won, 9.1 s, 118 dmg | 1/8 won, 9.1 s, 118 dmg | 8/8 |
| pierce>shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 8/8 |
| pierce>frost>shock | 0/8 won, n/a s, 122 dmg | 0/8 won, n/a s, 122 dmg | 8/8 |
| hand shock-lead | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| hand fire-lead | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| hand frost-lead | 1/8 won, 14.4 s, 119 dmg | 1/8 won, 14.4 s, 119 dmg | 8/8 |

### arena-boss-wet vs arena-boss-lightning-wet

| build | arena-boss-wet | arena-boss-lightning-wet | seeds with an identical hp trace |
|---|---|---|---|
| none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock | 3/8 won, 7.9 s, 110 dmg | 8/8 won, 7.5 s, 44 dmg | 0/8 |
| incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| pierce>shock | 4/8 won, 8.2 s, 108 dmg | 8/8 won, 5.2 s, 40 dmg | 0/8 |
| pierce>incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| pierce>frost | 1/8 won, 18.6 s, 122 dmg | 1/8 won, 18.6 s, 122 dmg | 8/8 |
| pierce>incendiary>frost | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| pierce>shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 0/8 |
| pierce>frost>shock | 1/8 won, 12.5 s, 118 dmg | 6/8 won, 9.2 s, 96 dmg | 0/8 |
| hand shock-lead | 0/8 won, n/a s, 120 dmg | 2/8 won, 9.2 s, 104 dmg | 0/8 |
| hand fire-lead | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| hand frost-lead | 0/8 won, n/a s, 120 dmg | 4/8 won, 10.3 s, 105 dmg | 2/8 |

### Reach probe: does a gangster fight back?

The gangster stands on an open street row with 5000 hp. The player holds still for 10.0 s.

| distance (tiles) | player fires | foe first shot (s) | foe shots | closest approach | dmg taken | dmg dealt to foe |
|---|---|---|---|---|---|---|
| 4 | yes | 0.0 | 10 | 4 | 120 | 182 |
| 4 | no | 0.0 | 9 | 4 | 120 | 0 |
| 5 | yes | 0.0 | 11 | 5 | 120 | 196 |
| 5 | no | 0.0 | 9 | 4.8 | 120 | 0 |
| 6 | yes | 0.0 | 10 | 6 | 120 | 168 |
| 6 | no | 0.0 | 9 | 6 | 120 | 0 |
| 7 | yes | 0.0 | 12 | 7 | 120 | 196 |
| 7 | no | 0.0 | 11 | 6.8 | 120 | 0 |
| 8 | yes | 0.0 | 6 | 7.8 | 70 | 70 |
| 8 | no | 0.0 | 10 | 7.7 | 120 | 0 |
| 9 | yes | 1.1 | 8 | 7.5 | 70 | 168 |
| 9 | no | 1.9 | 11 | 7.4 | 84 | 0 |
| 10 | yes | 1.6 | 7 | 7.5 | 70 | 112 |
| 10 | no | 2.4 | 9 | 7.7 | 112 | 0 |
| 11 | yes | 2.1 | 10 | 7.5 | 84 | 210 |
| 11 | no | 2.9 | 9 | 7.5 | 84 | 0 |
| 12 | yes | 2.4 | 9 | 7.8 | 112 | 182 |
| 12 | no | never | 0 | 8.2 | 0 | 0 |

<!-- census:end -->
