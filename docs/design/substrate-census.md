# Substrate census: do #92, #99 and #101 give loadouts real questions?

Status: **measured** on `integration/substrate-census`, which is main 3e6bde6 with
#121, #92, #99 and #101 merged in that order, plus one experiment commit. Nothing
here merges to main. The owner merges the individual PRs, and the conflict notes
below are for those merges.

The arena census (#121, `docs/design/arena-census.md`) found three gaps on main.
Frost answered almost every fight, a lightning weakness changed nothing, and ranged
foes ignored fire from beyond 8 tiles. This doc runs that census again after three
ticket PRs that looked like they close the gaps, and adds the fights and probes
the census could not stage.

## Verdict

- **Lightning prep works in water, and only there.** In a flooded lair, Tesla
  (fold `shock`) beats the lightning-weak Mireclaw 8/8 on 9 damage. The generic
  hand, frost and fire each win 0/8 there. On dry ground the weak boss and the
  stock boss fight identically for all 23 builds on all 8 seeds, and Tesla wins
  0/8.
- **The water does most of the work, not the weakness.** Tesla beats the
  stock-resist boss in the same flooded lair 7/8 on 29 damage. `electrified: 2`
  adds margin, 9 damage instead of 29 and 5.4 s instead of 7.3 s. It matters
  most for mixed sequenced hands, where one shot in three or four is Tesla:
  `seq shock>incendiary` goes from 2/8 to 6/8 and `seq hand fire-lead` from 2/8
  to 5/8.
- **#99 already wets bodies.** The brief said wading only slows movement. It
  does. `modifierSystem.tide` calls `wet()` on every body standing in a
  flooded low tile, each tick, and wet lasts 5 s after the body leaves. The gap
  is that rooms never flood, and the census stages every fight in a room. The
  experiment floods the arena room (see "The flooded lair").
- **#92 plus #99 make an NPC stun gun lethal in the flood.** A wet player who
  stands in front of one stun-gun gangster on a flooded street, with no
  experiment involved, is downed on 5 of 8 seeds, median 4.9 s. On dry ground,
  0 of 8. Each stun hit on a wet body deals 20 hp that skips i-frames, and the
  arc takes the same 20 hp from a wet teammate standing one tile away.
- **The players' own arcs barely hurt them.** Across 8 flooded boss fights the
  Tesla bot took 2 arc hits (40 hp) from its own shots. A two-player Tesla team
  took 2 to 3 hits each.
- **Frost is no longer the universal answer. Fire is.** #92 makes a burning
  foe panic and run. `incendiary+pierce` now wins all 40 non-boss fights (31 on
  main), on 0 damage against one brute and against the pair, and on 9 against
  the cinders that resist fire. `frost+pierce` is unchanged at 32 of 40. The
  measured antidote is a `panic` resist key with the brute at 0 (change B below):
  fire then loses the brute pair 0/8 again.
- **#101 makes out-of-sight gangsters fight back.** Three gangsters staged 12
  tiles away never fired without #101's gunfire noise (0 of 8 seeds). With it,
  they fire on 4 to 6 of 8 seeds, a median 2.1 s into the fight.

## Merge conflicts and resolutions

#121 merged cleanly. #92, #99 and #101 do not merge cleanly into main in that
order. Each has a textual conflict, and two have semantic ones that only a test
run shows. Every re-pinned digest below was proven by reverting only the named
change and recovering the old digest.

| PR | file | kind | resolution |
|---|---|---|---|
| #92 | `systems/interactions.ts` | textual, with main's #97 | Imports keep `resistMult` (#97) and `EntityId` (#92). The `shock` body auto-merged with both #97's resist-scaled damage and #92's leap and `ticks` argument. |
| #92 | `systems/modSequence.flagOff.test.ts` | textual and semantic, with main's #91 and #117 | Keep main's goldens. #92's seed 7 re-pin was for burn panic, but main's rounds freeze now. Seed 7 still moves, `92430cd7` to `d18f1870`, because `applyStatus` now records its source in `fx.frozen.source`. Dropping only that source restores `92430cd7`. |
| #92 | `app/netStatus.test.ts` | semantic, with main's #103 | The test stacked all six statuses on one thug. Under #92, wet douses burning and a panic blocks freeze and shock, so 3 of 6 survive. Rewritten to one body per status. Removing `spore` from `WIRE_STATUSES` fails it. |
| #99 | `systems/goals.ts` `perceives` | textual and semantic, with #92 | Brownout dims sight (`sightMult`), then spore caps what is left at arm's reach. |
| #99 | `debug/verbs.ts` imports | textual, with main's #95 | Keep main's `emptyInput` and `InputCmd` and #99's floor-modifier imports. |
| #99 | `app/inspect.ts` help text | textual, with main's #95 | Keep main's `step` example and add #99's `modifier` verb. |
| #101 | `systems/modSequence.flagOff.test.ts` | textual and semantic | Both seeds move again, to `a13b7b25` and `e92bcf60`. Stubbing out only `hearGunfire` restores `d18f1870` and `3f405983`. |
| #101 | `systems/floorModifiers.test.ts` | semantic, with #99 | #99 pins 300 ticks of clean-floor play "exactly as on main", and that input fires. The two `play:` digests move to `84582f4c` and `e19bf8a5`. Stubbing out only `hearGunfire` restores `1ed48e2d` and `53d35f3b`. |

Things that did not conflict but need attention at merge time:

- **Release notes.** The three PRs add three different files, all dated
  2026-09-26. Rename each to its real merge date, as `CLAUDE.md` asks.
- **Wire.** No PR touches `PROTOCOL_VERSION`, `ARCHETYPES` or `WIRE_STATUSES`.
  #99 and #101 add optional `StateMsg` fields (`modifier`, `lockdown`).
- **#92's verb marks never draw on a co-op client.** `verbMarks` needs `e.ai`,
  which a client mirror built by `applyWireEntity` does not have, and panic lives
  in `lockout.panic`, which is not on the wire. Not fixed here.
- **`scenarios.ts`.** #121 spreads `ARENAS` into the registry and #92 adds
  `element-verbs`. Both auto-merged.

## What each PR changed in the unchanged census

The census ran unchanged (21 builds, 9 arenas, 8 seeds) after each merge. 94 of
189 build x arena cells changed. #92 changed 85 of them, #99 none, and #101 38,
many of them the same cells again. The full per-PR table is in the appendix.

Did #92's Tesla routing change anything with nothing wet? Yes, through the leap,
not through damage. A Tesla hit now also stuns the nearest other NPC within 2.5
tiles:

| build | arena | main | after #92 |
|---|---|---|---|
| shock | arena-swarm | 7/8 · 100 | 8/8 · 72 |
| seq shock | arena-swarm | 7/8 · 107 | 8/8 · 62 |
| seq shock | arena-kiter | 3/8 · 103 | 5/8 · 103 |
| shock | arena-kiter | 6/8 · 91 | 6/8 · 104 |

Against the dry boss, every Tesla-only build stays at 0/8, and `arena-boss-lightning`
still has the same hp trace as `arena-boss` for every build on every seed.
Against the boss the census pre-wets with a scripted status, the routing does
what the census doc's proposal 1 predicted. Fold `shock` goes from 0/8 on 120
damage to 7/8 on 40 against the weak boss after #92 (8/8 on 44 after all three),
and to 3/8 against the stock one.

#92's panic moved the most cells. `incendiary` against the brute pair goes from
0/8 on 120 to 8/8 on 0, and against the cinders from 4/8 on 115 to 8/8 on 9. #92's
shared control lockout, then #101, cut the sequenced lock hands against the dry
boss. `seq hand shock-lead` went 3/8 to 1/8 to 0/8, `seq hand fire-lead` 3/8 to 1/8 to
0/8, `seq hand frost-lead` 3/8 to 2/8 to 1/8.

Did #101's gunfire noise make ranged foes fight back? Yes. The reach probe (one
gangster with 5000 hp, player standing still and firing) now answers from 12
tiles:

| distance (tiles) | main: first shot, damage taken | after #101 |
|---|---|---|
| 9 | 2.4 s, 70 | 1.1 s, 70 |
| 10 | 2.9 s, 84 | 1.6 s, 70 |
| 11 | 3.2 s, 42 | 2.1 s, 84 |
| 12 | never, 0 | 2.4 s, 112 |

`arena-kiter` stages its gangsters inside their sight, so it cannot test this.
The probe "The kiters out of sight" stages the same three gangsters 9 and 12
tiles down an open street row. With #101's `hearGunfire` stubbed out (a
throwaway patch, not kept) and without it:

| distance | build | no gunfire noise: won, damage, seeds where a gangster fired | with #101 |
|---|---|---|---|
| 9 | none | 1/8, 54, 7/8 | 3/8, 70, 8/8 |
| 9 | hand | 6/8, 35, 7/8 | 8/8, 51, 8/8 |
| 12 | none | 2/8, 0, 0/8 | 1/8, 42, 6/8 |
| 12 | hand | 3/8, 0, 0/8 | 6/8, 19, 4/8 |
| 12 | incendiary+pierce | 3/8, 0, 0/8 | 6/8, 14, 4/8 |

Without the noise, a 12-tile sniper takes no damage and times out most fights.
With it, the gangsters come and the bot pays 14 to 42 hp. The modded builds win
more (the hand 3/8 to 6/8) because the gangsters walk into range. The plain
pistol wins less (2/8 to 1/8).

## The flooded lair (experiment)

The experiment commit is clearly marked and is not a design to merge.
`FloorModifier.floodRooms` lists rooms that flood with the low ground, read by
`inFlood` while `EXPERIMENT_FLOODED_ROOMS` is true. No rolled floor sets it. An
`ArenaSpec` with `tide` starts a bog tide at flood onset (`TIDE_ARENA_AGE`) and
floods its own room. The flood holds 10 s, wet lingers 5 s after it recedes, and
the next flood comes 25 s after the first. The boss and the player are both wet,
and wading slows both to 65% of their walk speed.

- `arena-bog-boss` is the Mireclaw Alpha with `electrified: 2` in the flooded lair.
- `arena-bog-boss-stock` is the stock-resist control.

Solo, 8 seeds, won and mean damage taken:

| build | dry `arena-boss` | flooded, stock resists | flooded, weak to lightning |
|---|---|---|---|
| none | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| hand | 1/8 · 122 | 0/8 · 120 | 0/8 · 120 |
| frost | 0/8 · 123 | 0/8 · 116 | 0/8 · 116 |
| frost+pierce | 1/8 · 122 | 0/8 · 120 | 0/8 · 120 |
| incendiary | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| incendiary+pierce | 0/8 · 120 | 1/8 · 119 | 1/8 · 119 |
| shock | 0/8 · 120 | 7/8 · 29 | 8/8 · 9 |
| shock+pierce | 0/8 · 120 | 8/8 · 28 | 8/8 · 6 |
| seq shock | 0/8 · 120 | 7/8 · 54 | 8/8 · 10 |
| seq shock>frost | 0/8 · 120 | 5/8 · 86 | 5/8 · 73 |
| seq shock>incendiary | 0/8 · 121 | 2/8 · 110 | 6/8 · 81 |
| seq hand shock-lead | 0/8 · 120 | 5/8 · 103 | 7/8 · 78 |
| seq hand fire-lead | 0/8 · 120 | 2/8 · 106 | 5/8 · 80 |
| seq hand frost-lead | 1/8 · 119 | 6/8 · 86 | 7/8 · 81 |

Frost and fire lose the boss dry and flooded alike. In the flood, fire does not
even land. #92 makes a burning hit on a wet body dry it instead of lighting it,
and the tide re-wets the boss on the next tick.

In co-op, two Tesla players win 8/8 on 6 damage each against the weak boss.
Two generic hands win 7/8 on 93 and 84, and two frost players 5/8. Lightning prep
still decides the fight, and the second player narrows the gap.

## Side effects

The probe tables below the census tables hold the full numbers.

- **Own arcs.** The census bot backs off inside 1.5 tiles, so its Tesla arc
  rarely reaches it. Over 8 flooded fights against the weak boss it took 2 arc
  hits, 40 hp, and spent 1.5 s electrified. Two Tesla bots one tile apart took 2
  hits each. The arc floods every wet body within 1.6 tiles of a wet body it
  reaches, players included, so a player in melee range of a wet boss shocks
  themselves and any wet teammate beside them.
- **NPC stun guns.** A gangster armed with a stun gun, 4 tiles from players
  who stand still for 10 s:

  | ground | players | damage (P1 / P2, total over 8 seeds) | arc hits | downed |
  |---|---|---|---|---|
  | dry room | 1 | 174 | 0 | 0/8 |
  | flooded street, no experiment | 1 | 730 | 34 | 5/8, median 4.9 s |
  | flooded street, no experiment | 2 | 622 / 532 | 30 / 24 | 4/8 / 4/8 |
  | flooded lair | 2 | 960 / 960 | 48 / 48 | 8/8 / 8/8, median 5.0 s |

  On main a stun hit only locks a player. After #92 a stun hit on a wet player
  is a `shock`, which deals 20 hp that skip i-frames and physical resist, and
  jumps to wet teammates. NPCs roll the stun gun from `NPC_ARSENAL` (weight 1 of
  23). On a bog-tide floor this reaches real play through #99's flooded streets
  and halls, without the experiment. On 2 of the 8 seeds the street row's first
  tiles are not low ground, so those players stay dry.

## Is frost still the universal answer?

No. Fire replaced it. Non-boss arenas, fold builds with `pierce`, won and mean
damage taken:

| build | brute | brute pair | kiter | swarm | cinder | fights won |
|---|---|---|---|---|---|---|
| incendiary+pierce, main | 8/8 · 52 | 0/8 · 120 | 7/8 · 90 | 8/8 · 53 | 8/8 · 79 | 31/40 |
| incendiary+pierce, integrated | 8/8 · 0 | 8/8 · 0 | 8/8 · 58 | 8/8 · 33 | 8/8 · 9 | 40/40 |
| frost+pierce, both | 8/8 · 72 | 0/8 · 120 | 8/8 · 44 | 8/8 · 39 | 8/8 · 10 | 32/40 |
| shock+pierce, integrated | 8/8 · 82 | 0/8 · 120 | 7/8 · 76 | 8/8 · 51 | 8/8 · 38 | 31/40 |

A panicking foe drops the fight for 2 s and runs from whoever lit it. The census
bot shoots it in the back. Panic ignores the fire resist, so the cinders, which
take 20% from fire, panic like anything else, and the arena that was meant to
punish fire (`arena-cinder`) no longer does.

Three single changes were measured as throwaway patches against this branch,
then reverted. Each ran
`npx tsx scripts/census.mts --arena arena-brute,arena-brute-pair,arena-kiter,arena-swarm,arena-cinder --no-reach`.

- **A. Panic length scales with the fire resist.** In `statusFx.panic`, grant
  `Math.floor(PANIC_TICKS * Math.min(1, resistMult(e, 'burning')))` ticks. Only
  the cinder changes. `incendiary+pierce` against the cinders goes from 8/8 on 9
  to 8/8 on 59, and fold `incendiary` from 8/8 on 9 to 7/8 on 86. Fire still wins
  40 of 40.
- **B. A `panic` resist key, with the brute at 0.** In `statusFx.panic`, return
  early when `resistMult(e, 'panic') <= 0`, and give the brute table `panic: 0`.
  `incendiary+pierce` against the pair goes from 8/8 on 0 to 0/8, and against one
  brute from 0 damage to 52. Fire wins 32 of 40. The builds that fail the pair at
  least once go from 13 of 23 to 19 of 23, and the best answer to the pair
  becomes `seq pierce>incendiary>frost` (8/8 on 20), fire plus a lock, as it was
  on main.
- **C. A freeze-length key, with the gangster at 0.25.** In `applyImmobilize`,
  scale a `frozen` grant by `resistMult(e, 'frozenLock')`, and give the gangster
  `resist: { frozenLock: 0.25 }`. `frost+pierce` against the kiters goes from 8/8
  on 44 to 7/8 on 87, and `incendiary+pierce` becomes the best kiter build. This
  makes fire more universal, not less.

Recommend B. It is the only one of the three that brings back a fight fire
loses. It is the same shape the census doc proposed for frost (a resist key that
shapes a control verb), aimed at the element that now dominates. A is a sensible
follow-up for the cinders, but alone it changes damage, not outcomes.

## Limits

- The census bot never kites, rolls or picks targets. It understates what a
  skilled player does with panic and with wading.
- The flooded lair is staged. In real play, rooms stay dry under the tide, so a
  lightning-weak boss only meets water if the level puts it on a street, a hall,
  a grate or bog seep. Whether that happens is a level-design question this doc
  does not answer.
- `EXPERIMENT_FLOODED_ROOMS` is not predicted by `NetClientSession`, which reads
  low tiles directly, so a co-op client wading in a flooded lair would mispredict
  its speed. The experiment is census-only.
- The stun probe players stand still. A moving player spends less time in
  range, but also wades at 65% speed.

## How to regenerate

```sh
# The census and probe tables in this doc (about 2 min and 30 s). Both are
# byte-identical across runs.
npx tsx scripts/census.mts --write docs/design/substrate-census.md
npx tsx scripts/substrate-probes.mts --write docs/design/substrate-census.md

# The per-PR diff in the appendix. Run the census at each merge commit on this
# branch (c6cd02a is #121, 8a9e1a3 #92, 40307e7 #99, 5763a37 #101), then diff.
git checkout 8a9e1a3 && npx tsx scripts/census.mts > /tmp/after92.md
git checkout 40307e7 && npx tsx scripts/census.mts > /tmp/after99.md
git checkout 5763a37 && npx tsx scripts/census.mts > /tmp/after101.md
git checkout integration/substrate-census
npx tsx scripts/census-diff.mts main=docs/design/arena-census.md +92=/tmp/after92.md +99=/tmp/after99.md +101=/tmp/after101.md
```

The "no gunfire noise" column stubs out the `hearGunfire` call in
`combatSystem` and reruns `scripts/substrate-probes.mts`.

## Census tables

Generated by `scripts/census.mts`. The two `arena-bog-*` arenas and the builds `seq shock>frost` and `seq shock>incendiary` are new. Every other cell matches the unchanged census run after #101.

<!-- census:begin -->
Generated by `npx tsx scripts/census.mts --write docs/design/substrate-census.md`. Seeds 303, 5, 4, 2, 44, 18, 51, 10; 23 builds; fights capped at 60 s.

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
| `arena-bog-boss-stock` | 1 boss | Mireclaw Alpha with its stock resists, in a lair the bog tide floods as the fight starts. |  |
| `arena-bog-boss` | 1 boss {"electrified":2} | Mireclaw Alpha weak to lightning (electrified x2), in a lair the bog tide floods as the fight starts. | `arena-bog-boss-stock` |

Arena rooms (the room with the most open floor on each seed): seed 303: warehouse stockroom 9x9; seed 5: office office 8x8; seed 4: clinic ward 7x8; seed 2: apartment living 9x10; seed 44: apartment living 8x6; seed 18: clinic waiting 8x9; seed 51: apartment living 7x7; seed 10: clinic ward 11x8.

### Build x arena

Each cell is fights won out of seeds, then mean damage taken. The player has 120 hp, and passive regen can push damage taken past it. Bold marks the best build in the column.

| build | arena-brute | arena-brute-pair | arena-kiter | arena-swarm | arena-cinder | arena-boss | arena-boss-lightning | arena-boss-wet | arena-boss-lightning-wet | arena-bog-boss-stock | arena-bog-boss |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0/8 · 120 | 0/8 · 120 | 3/8 · 115 | 3/8 · 111 | 4/8 · 115 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| shock | 8/8 · 82 | 0/8 · 120 | 6/8 · 104 | 8/8 · 72 | 8/8 · 67 | 0/8 · 120 | 0/8 · 120 | 3/8 · 110 | 8/8 · 44 | 7/8 · 29 | 8/8 · 9 |
| incendiary | 8/8 · 0 | **8/8 · 0** | 7/8 · 80 | 8/8 · 45 | 8/8 · 9 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| frost | 8/8 · 72 | 0/8 · 120 | 6/8 · 81 | 8/8 · 62 | 8/8 · 10 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 116 | 0/8 · 116 |
| hand | 8/8 · 72 | 0/8 · 120 | **8/8 · 44** | 8/8 · 39 | 8/8 · 10 | **1/8 · 122** | **1/8 · 122** | 1/8 · 122 | 1/8 · 122 | 0/8 · 120 | 0/8 · 120 |
| shock+pierce | 8/8 · 82 | 0/8 · 120 | 7/8 · 76 | 8/8 · 51 | 8/8 · 38 | 0/8 · 120 | 0/8 · 120 | **4/8 · 108** | **8/8 · 40** | **8/8 · 28** | **8/8 · 6** |
| incendiary+pierce | 8/8 · 0 | **8/8 · 0** | 8/8 · 58 | **8/8 · 33** | 8/8 · 9 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 1/8 · 119 | 1/8 · 119 |
| frost+pierce | 8/8 · 72 | 0/8 · 120 | **8/8 · 44** | 8/8 · 39 | 8/8 · 10 | **1/8 · 122** | **1/8 · 122** | 1/8 · 122 | 1/8 · 122 | 0/8 · 120 | 0/8 · 120 |
| seq none | 0/8 · 120 | 0/8 · 120 | 3/8 · 115 | 3/8 · 111 | 4/8 · 115 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq shock | 4/8 · 110 | 0/8 · 120 | 5/8 · 103 | 8/8 · 62 | 8/8 · 73 | 0/8 · 120 | 0/8 · 120 | 1/8 · 114 | 7/8 · 68 | 7/8 · 54 | 8/8 · 10 |
| seq incendiary | 8/8 · 0 | 8/8 · 0 | 5/8 · 99 | 8/8 · 61 | 8/8 · 17 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq frost | 8/8 · 82 | 0/8 · 120 | 7/8 · 78 | 8/8 · 90 | 8/8 · 13 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 121 | 0/8 · 121 |
| seq pierce>shock | 4/8 · 110 | 0/8 · 120 | 8/8 · 89 | 8/8 · 65 | 8/8 · 67 | 0/8 · 120 | 0/8 · 120 | 1/8 · 114 | 8/8 · 57 | 7/8 · 51 | 8/8 · 10 |
| seq pierce>incendiary | 8/8 · 0 | 8/8 · 0 | 8/8 · 61 | 8/8 · 50 | 8/8 · 13 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq pierce>frost | 8/8 · 82 | 0/8 · 120 | 7/8 · 48 | 8/8 · 50 | 8/8 · 13 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 120 | 0/8 · 120 |
| seq pierce>incendiary>frost | **8/8 · 0** | 8/8 · 38 | 8/8 · 68 | 8/8 · 56 | 8/8 · 10 | 1/8 · 118 | 1/8 · 118 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq pierce>shock>incendiary | 8/8 · 0 | 8/8 · 94 | 7/8 · 71 | 8/8 · 48 | 8/8 · 31 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 | 2/8 · 110 | 6/8 · 81 |
| seq pierce>frost>shock | 8/8 · 74 | 7/8 · 105 | 7/8 · 57 | 8/8 · 63 | 8/8 · 28 | 0/8 · 122 | 0/8 · 122 | 1/8 · 118 | 6/8 · 96 | 7/8 · 59 | 8/8 · 44 |
| seq shock>frost | 8/8 · 10 | 0/8 · 120 | 5/8 · 101 | 8/8 · 65 | 8/8 · 24 | 0/8 · 120 | 0/8 · 120 | 1/8 · 113 | 1/8 · 111 | 5/8 · 86 | 5/8 · 73 |
| seq shock>incendiary | 8/8 · 0 | 8/8 · 94 | 5/8 · 105 | 8/8 · 58 | 8/8 · 40 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 | 2/8 · 110 | 6/8 · 81 |
| seq hand shock-lead | 8/8 · 0 | 8/8 · 2 | 7/8 · 73 | 8/8 · 56 | **8/8 · 5** | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 2/8 · 104 | 5/8 · 103 | 7/8 · 78 |
| seq hand fire-lead | 8/8 · 0 | 8/8 · 42 | 7/8 · 66 | 8/8 · 55 | 8/8 · 29 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 2/8 · 106 | 5/8 · 80 |
| seq hand frost-lead | 8/8 · 12 | 8/8 · 0 | 8/8 · 74 | 8/8 · 67 | 8/8 · 14 | 1/8 · 119 | 1/8 · 119 | 0/8 · 120 | 4/8 · 105 | 6/8 · 86 | 7/8 · 81 |

### Best and worst build per arena

Builds joined by `=` tie on every ranking key.

| arena | best | worst | generic hand (fold) | builds that failed to win at least once |
|---|---|---|---|---|
| arena-brute | seq pierce>incendiary>frost: 8/8 won, 4.7 s, 0 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 8/8 won, 6.1 s, 72 dmg | 4/23 |
| arena-brute-pair | incendiary = incendiary+pierce: 8/8 won, 7.7 s, 0 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 13/23 |
| arena-kiter | hand = frost+pierce: 8/8 won, 2.4 s, 44 dmg | none = seq none: 3/8 won, 6.6 s, 115 dmg | 8/8 won, 2.4 s, 44 dmg | 16/23 |
| arena-swarm | incendiary+pierce: 8/8 won, 3.3 s, 33 dmg | none = seq none: 3/8 won, 4.9 s, 111 dmg | 8/8 won, 5.0 s, 39 dmg | 2/23 |
| arena-cinder | seq hand shock-lead: 8/8 won, 6.4 s, 5 dmg | none = seq none: 4/8 won, 6.6 s, 115 dmg | 8/8 won, 4.5 s, 10 dmg | 2/23 |
| arena-boss | hand = frost+pierce: 1/8 won, 18.6 s, 122 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 1/8 won, 18.6 s, 122 dmg | 23/23 |
| arena-boss-lightning | hand = frost+pierce: 1/8 won, 18.6 s, 122 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 1/8 won, 18.6 s, 122 dmg | 23/23 |
| arena-boss-wet | shock+pierce: 4/8 won, 8.2 s, 108 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 1/8 won, 18.6 s, 122 dmg | 23/23 |
| arena-boss-lightning-wet | shock+pierce: 8/8 won, 5.2 s, 40 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 1/8 won, 18.6 s, 122 dmg | 20/23 |
| arena-bog-boss-stock | shock+pierce: 8/8 won, 7.6 s, 28 dmg | seq incendiary: 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 22/23 |
| arena-bog-boss | shock+pierce: 8/8 won, 5.4 s, 6 dmg | seq incendiary: 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 18/23 |

### Builds that fought identically

Builds with the same hp trace on every seed of an arena. The worlds may still differ in ways hp does not show, such as a status that deals no damage.

- arena-brute: none = seq none; shock = shock+pierce; incendiary = incendiary+pierce; frost = hand = frost+pierce; seq shock = seq pierce>shock; seq incendiary = seq pierce>incendiary; seq frost = seq pierce>frost; seq pierce>shock>incendiary = seq shock>incendiary.
- arena-brute-pair: none = seq none; shock = shock+pierce; incendiary = incendiary+pierce; frost = hand = frost+pierce; seq shock = seq pierce>shock; seq incendiary = seq pierce>incendiary; seq frost = seq pierce>frost; seq pierce>shock>incendiary = seq shock>incendiary.
- arena-kiter: none = seq none; hand = frost+pierce.
- arena-swarm: none = seq none; hand = frost+pierce.
- arena-cinder: none = seq none; hand = frost+pierce.
- arena-boss: none = seq none; hand = frost+pierce.
- arena-boss-lightning: none = seq none; hand = frost+pierce.
- arena-boss-wet: none = seq none; hand = frost+pierce.
- arena-boss-lightning-wet: none = seq none; hand = frost+pierce.
- arena-bog-boss-stock: none = incendiary = seq none; hand = frost+pierce.
- arena-bog-boss: none = incendiary = seq none; hand = frost+pierce.

### arena-brute

An armoured closer: bullets do 35%, so low damage per second loses the race.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.5 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| seq pierce>incendiary>frost | 8 | 0 | 0 | 7 | 4.7 | 0 |  |
| seq hand fire-lead | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| seq incendiary | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| seq pierce>incendiary | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| incendiary | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| incendiary+pierce | 8 | 0 | 0 | 7 | 5.9 | 0 |  |
| seq hand shock-lead | 8 | 0 | 0 | 7 | 6.1 | 0 |  |
| seq pierce>shock>incendiary | 8 | 0 | 0 | 6 | 6.2 | 0 |  |
| seq shock>incendiary | 8 | 0 | 0 | 6 | 6.2 | 0 |  |
| seq shock>frost | 8 | 0 | 0 | 7 | 10.7 | 10 |  |
| seq hand frost-lead | 8 | 0 | 0 | 4 | 5.0 | 12 |  |
| frost | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
| hand | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
| frost+pierce | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
| seq pierce>frost>shock | 8 | 0 | 0 | 3 | 6.6 | 74 |  |
| seq frost | 8 | 0 | 0 | 3 | 6.9 | 82 |  |
| seq pierce>frost | 8 | 0 | 0 | 3 | 6.9 | 82 |  |
| shock | 8 | 0 | 0 | 8 | 12.9 | 82 |  |
| shock+pierce | 8 | 0 | 0 | 8 | 12.9 | 82 |  |
| seq shock | 4 | 4 | 0 | 6 | 15.9 | 110 | 26 |
| seq pierce>shock | 4 | 4 | 0 | 6 | 15.9 | 110 | 26 |
| none | 0 | 8 | 0 | 3 | n/a | 120 | 41 |
| seq none | 0 | 8 | 0 | 3 | n/a | 120 | 41 |

### arena-brute-pair

Two armoured closers: more than one element has to land.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 3.8 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| incendiary | 8 | 0 | 0 | 8 | 7.7 | 0 |  |
| incendiary+pierce | 8 | 0 | 0 | 8 | 7.7 | 0 |  |
| seq incendiary | 8 | 0 | 0 | 8 | 7.8 | 0 |  |
| seq pierce>incendiary | 8 | 0 | 0 | 8 | 7.8 | 0 |  |
| seq hand frost-lead | 8 | 0 | 0 | 8 | 9.3 | 0 |  |
| seq hand shock-lead | 8 | 0 | 0 | 7 | 8.5 | 2 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 8 | 6.3 | 38 |  |
| seq hand fire-lead | 8 | 0 | 0 | 7 | 6.9 | 42 |  |
| seq pierce>shock>incendiary | 8 | 0 | 0 | 6 | 9.9 | 94 |  |
| seq shock>incendiary | 8 | 0 | 0 | 6 | 9.9 | 94 |  |
| seq pierce>frost>shock | 7 | 1 | 0 | 8 | 18.3 | 105 | 50 |
| frost | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| hand | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| frost+pierce | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| seq frost | 0 | 8 | 0 | 5 | n/a | 120 | 64 |
| seq pierce>frost | 0 | 8 | 0 | 5 | n/a | 120 | 64 |
| seq shock>frost | 0 | 8 | 0 | 4 | n/a | 120 | 115 |
| shock | 0 | 8 | 0 | 5 | n/a | 120 | 121 |
| shock+pierce | 0 | 8 | 0 | 5 | n/a | 120 | 121 |
| seq shock | 0 | 8 | 0 | 5 | n/a | 120 | 125 |
| seq pierce>shock | 0 | 8 | 0 | 5 | n/a | 120 | 125 |
| none | 0 | 8 | 0 | 5 | n/a | 120 | 151 |
| seq none | 0 | 8 | 0 | 5 | n/a | 120 | 151 |

### arena-kiter

Shooters that hold range and fire back: stop them shooting or lose the trade.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.3 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| hand | 8 | 0 | 0 | 8 | 2.4 | 44 |  |
| frost+pierce | 8 | 0 | 0 | 8 | 2.4 | 44 |  |
| incendiary+pierce | 8 | 0 | 0 | 8 | 5.5 | 58 |  |
| seq pierce>incendiary | 8 | 0 | 0 | 8 | 6.0 | 61 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 8 | 5.3 | 68 |  |
| seq hand frost-lead | 8 | 0 | 0 | 8 | 4.9 | 74 |  |
| seq pierce>shock | 8 | 0 | 0 | 8 | 8.3 | 89 |  |
| shock+pierce | 7 | 1 | 0 | 8 | 6.0 | 76 | 7 |
| seq pierce>shock>incendiary | 7 | 1 | 0 | 8 | 4.8 | 71 | 21 |
| seq hand fire-lead | 7 | 1 | 0 | 8 | 6.3 | 66 | 22 |
| seq pierce>frost>shock | 7 | 1 | 0 | 8 | 3.0 | 57 | 35 |
| incendiary | 7 | 1 | 0 | 8 | 5.7 | 80 | 35 |
| seq hand shock-lead | 7 | 1 | 0 | 8 | 4.9 | 73 | 53 |
| seq pierce>frost | 7 | 1 | 0 | 8 | 2.5 | 48 | 56 |
| seq frost | 7 | 1 | 0 | 8 | 4.5 | 78 | 56 |
| shock | 6 | 2 | 0 | 8 | 8.7 | 104 | 25 |
| frost | 6 | 2 | 0 | 8 | 4.1 | 81 | 53 |
| seq shock>frost | 5 | 3 | 0 | 8 | 6.2 | 101 | 30 |
| seq shock | 5 | 3 | 0 | 8 | 9.2 | 103 | 30 |
| seq shock>incendiary | 5 | 3 | 0 | 8 | 7.2 | 105 | 33 |
| seq incendiary | 5 | 3 | 0 | 8 | 6.9 | 99 | 36 |
| none | 3 | 5 | 0 | 8 | 6.6 | 115 | 28 |
| seq none | 3 | 5 | 0 | 8 | 6.6 | 115 | 28 |

### arena-swarm

A fast swarm: one bullet per body is too slow.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.8 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| incendiary+pierce | 8 | 0 | 0 | 6 | 3.3 | 33 |  |
| hand | 8 | 0 | 0 | 5 | 5.0 | 39 |  |
| frost+pierce | 8 | 0 | 0 | 5 | 5.0 | 39 |  |
| incendiary | 8 | 0 | 0 | 6 | 4.2 | 45 |  |
| seq pierce>shock>incendiary | 8 | 0 | 0 | 5 | 3.9 | 48 |  |
| seq pierce>incendiary | 8 | 0 | 0 | 5 | 3.3 | 50 |  |
| seq pierce>frost | 8 | 0 | 0 | 6 | 5.8 | 50 |  |
| shock+pierce | 8 | 0 | 0 | 6 | 4.9 | 51 |  |
| seq hand fire-lead | 8 | 0 | 0 | 5 | 5.7 | 55 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 6 | 4.8 | 56 |  |
| seq hand shock-lead | 8 | 0 | 0 | 5 | 5.2 | 56 |  |
| seq shock>incendiary | 8 | 0 | 0 | 5 | 5.1 | 58 |  |
| seq incendiary | 8 | 0 | 0 | 7 | 4.2 | 61 |  |
| seq shock | 8 | 0 | 0 | 6 | 6.7 | 62 |  |
| frost | 8 | 0 | 0 | 7 | 6.7 | 62 |  |
| seq pierce>frost>shock | 8 | 0 | 0 | 5 | 5.8 | 63 |  |
| seq pierce>shock | 8 | 0 | 0 | 6 | 5.4 | 65 |  |
| seq shock>frost | 8 | 0 | 0 | 6 | 6.4 | 65 |  |
| seq hand frost-lead | 8 | 0 | 0 | 5 | 6.3 | 67 |  |
| shock | 8 | 0 | 0 | 6 | 6.1 | 72 |  |
| seq frost | 8 | 0 | 0 | 7 | 7.1 | 90 |  |
| none | 3 | 5 | 0 | 6 | 4.9 | 111 | 19 |
| seq none | 3 | 5 | 0 | 6 | 4.9 | 111 | 19 |

### arena-cinder

Ash-dwellers: fire does 20%, bullets do 110%.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.7 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| seq hand shock-lead | 8 | 0 | 0 | 7 | 6.4 | 5 |  |
| incendiary+pierce | 8 | 0 | 0 | 8 | 5.2 | 9 |  |
| incendiary | 8 | 0 | 0 | 8 | 6.8 | 9 |  |
| hand | 8 | 0 | 0 | 3 | 4.5 | 10 |  |
| frost+pierce | 8 | 0 | 0 | 3 | 4.5 | 10 |  |
| frost | 8 | 0 | 0 | 3 | 5.1 | 10 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 7 | 5.5 | 10 |  |
| seq pierce>frost | 8 | 0 | 0 | 3 | 4.3 | 13 |  |
| seq pierce>incendiary | 8 | 0 | 0 | 8 | 5.6 | 13 |  |
| seq frost | 8 | 0 | 0 | 3 | 5.7 | 13 |  |
| seq hand frost-lead | 8 | 0 | 0 | 8 | 7.0 | 14 |  |
| seq incendiary | 8 | 0 | 0 | 8 | 7.5 | 17 |  |
| seq shock>frost | 8 | 0 | 0 | 4 | 6.5 | 24 |  |
| seq pierce>frost>shock | 8 | 0 | 0 | 4 | 5.2 | 28 |  |
| seq hand fire-lead | 8 | 0 | 0 | 8 | 6.6 | 29 |  |
| seq pierce>shock>incendiary | 8 | 0 | 0 | 7 | 6.8 | 31 |  |
| shock+pierce | 8 | 0 | 0 | 4 | 5.5 | 38 |  |
| seq shock>incendiary | 8 | 0 | 0 | 8 | 7.2 | 40 |  |
| seq pierce>shock | 8 | 0 | 0 | 6 | 6.1 | 67 |  |
| shock | 8 | 0 | 0 | 5 | 6.7 | 67 |  |
| seq shock | 8 | 0 | 0 | 8 | 9.3 | 73 |  |
| none | 4 | 4 | 0 | 5 | 6.6 | 115 | 45 |
| seq none | 4 | 4 | 0 | 5 | 6.6 | 115 | 45 |

### arena-boss

Mireclaw Alpha with its stock resists.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| hand | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| frost+pierce | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| seq hand frost-lead | 1 | 7 | 0 | 8 | 14.4 | 119 | 92 |
| seq pierce>incendiary>frost | 1 | 7 | 0 | 8 | 9.1 | 118 | 135 |
| seq hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 126 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| seq hand shock-lead | 0 | 8 | 0 | 8 | n/a | 120 | 167 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 178 |
| seq pierce>frost>shock | 0 | 8 | 0 | 8 | n/a | 122 | 183 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| seq shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 198 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 199 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 211 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 214 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 217 |
| shock+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 231 |
| seq shock>frost | 0 | 8 | 0 | 8 | n/a | 120 | 233 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 245 |
| seq pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 258 |
| seq shock | 0 | 8 | 0 | 8 | n/a | 120 | 266 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-boss-lightning

Mireclaw Alpha weak to lightning (electrified x2).

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| hand | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| frost+pierce | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| seq hand frost-lead | 1 | 7 | 0 | 8 | 14.4 | 119 | 92 |
| seq pierce>incendiary>frost | 1 | 7 | 0 | 8 | 9.1 | 118 | 135 |
| seq hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 126 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| seq hand shock-lead | 0 | 8 | 0 | 8 | n/a | 120 | 167 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 178 |
| seq pierce>frost>shock | 0 | 8 | 0 | 8 | n/a | 122 | 183 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| seq shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 198 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 199 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 211 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 214 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 217 |
| shock+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 231 |
| seq shock>frost | 0 | 8 | 0 | 8 | n/a | 120 | 233 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 245 |
| seq pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 258 |
| seq shock | 0 | 8 | 0 | 8 | n/a | 120 | 266 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-boss-wet

Mireclaw Alpha with its stock resists, standing wet.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| shock+pierce | 4 | 4 | 0 | 8 | 8.2 | 108 | 66 |
| shock | 3 | 5 | 0 | 8 | 7.9 | 110 | 70 |
| hand | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| frost+pierce | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| seq pierce>frost>shock | 1 | 7 | 0 | 8 | 12.5 | 118 | 92 |
| seq pierce>shock | 1 | 7 | 0 | 8 | 8.3 | 114 | 102 |
| seq shock | 1 | 7 | 0 | 8 | 12.0 | 114 | 119 |
| seq shock>frost | 1 | 7 | 0 | 8 | 12.1 | 113 | 163 |
| seq hand frost-lead | 0 | 8 | 0 | 8 | n/a | 120 | 105 |
| seq hand shock-lead | 0 | 8 | 0 | 8 | n/a | 120 | 136 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| seq pierce>incendiary>frost | 0 | 8 | 0 | 8 | n/a | 120 | 147 |
| seq hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 161 |
| seq shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 173 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 174 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 178 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 205 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 213 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 217 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 226 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 230 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-boss-lightning-wet

Mireclaw Alpha weak to lightning and standing wet, so a shock chain could land.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| shock+pierce | 8 | 0 | 0 | 8 | 5.2 | 40 |  |
| shock | 8 | 0 | 0 | 8 | 7.5 | 44 |  |
| seq pierce>shock | 8 | 0 | 0 | 8 | 6.4 | 57 |  |
| seq shock | 7 | 1 | 0 | 8 | 7.4 | 68 | 127 |
| seq pierce>frost>shock | 6 | 2 | 0 | 8 | 9.2 | 96 | 61 |
| seq hand frost-lead | 4 | 4 | 0 | 8 | 10.3 | 105 | 143 |
| seq hand shock-lead | 2 | 6 | 0 | 8 | 9.2 | 104 | 84 |
| hand | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| frost+pierce | 1 | 7 | 0 | 8 | 18.6 | 122 | 90 |
| seq shock>frost | 1 | 7 | 0 | 8 | 10.8 | 111 | 90 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 115 |
| seq shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 124 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 139 |
| seq pierce>incendiary>frost | 0 | 8 | 0 | 8 | n/a | 120 | 147 |
| seq hand fire-lead | 0 | 8 | 0 | 8 | n/a | 120 | 161 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 178 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 205 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 213 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 217 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 226 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 230 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 266 |

### arena-bog-boss-stock

Mireclaw Alpha with its stock resists, in a lair the bog tide floods as the fight starts.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 6.2 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| shock+pierce | 8 | 0 | 0 | 7 | 7.6 | 28 |  |
| seq pierce>frost>shock | 7 | 1 | 0 | 8 | 8.6 | 59 | 15 |
| shock | 7 | 1 | 0 | 7 | 7.3 | 29 | 21 |
| seq pierce>shock | 7 | 1 | 0 | 7 | 8.1 | 51 | 134 |
| seq shock | 7 | 1 | 0 | 8 | 8.1 | 54 | 134 |
| seq hand frost-lead | 6 | 2 | 0 | 8 | 11.9 | 86 | 73 |
| seq hand shock-lead | 5 | 3 | 0 | 8 | 10.1 | 103 | 157 |
| seq shock>frost | 5 | 3 | 0 | 8 | 9.6 | 86 | 157 |
| seq pierce>shock>incendiary | 2 | 6 | 0 | 8 | 10.3 | 110 | 125 |
| seq shock>incendiary | 2 | 6 | 0 | 8 | 10.3 | 110 | 134 |
| seq hand fire-lead | 2 | 6 | 0 | 8 | 13.1 | 106 | 147 |
| incendiary+pierce | 1 | 7 | 0 | 8 | 20.4 | 119 | 245 |
| frost | 0 | 7 | 1 | 8 | n/a | 116 | 140 |
| hand | 0 | 8 | 0 | 8 | n/a | 120 | 92 |
| frost+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 92 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 120 | 123 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 121 | 161 |
| seq pierce>incendiary>frost | 0 | 8 | 0 | 8 | n/a | 120 | 228 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 249 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 249 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 249 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 258 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 265 |

### arena-bog-boss

Mireclaw Alpha weak to lightning (electrified x2), in a lair the bog tide floods as the fight starts.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 6.2 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| shock+pierce | 8 | 0 | 0 | 8 | 5.4 | 6 |  |
| shock | 8 | 0 | 0 | 8 | 5.4 | 9 |  |
| seq pierce>shock | 8 | 0 | 0 | 7 | 5.6 | 10 |  |
| seq shock | 8 | 0 | 0 | 7 | 5.8 | 10 |  |
| seq pierce>frost>shock | 8 | 0 | 0 | 8 | 6.4 | 44 |  |
| seq hand frost-lead | 7 | 1 | 0 | 8 | 8.2 | 81 | 10 |
| seq hand shock-lead | 7 | 1 | 0 | 8 | 8.2 | 78 | 143 |
| seq pierce>shock>incendiary | 6 | 2 | 0 | 8 | 8.4 | 81 | 63 |
| seq shock>incendiary | 6 | 2 | 0 | 8 | 8.4 | 81 | 120 |
| seq shock>frost | 5 | 3 | 0 | 8 | 6.4 | 73 | 42 |
| seq hand fire-lead | 5 | 3 | 0 | 8 | 9.1 | 80 | 175 |
| incendiary+pierce | 1 | 7 | 0 | 8 | 20.4 | 119 | 245 |
| frost | 0 | 7 | 1 | 8 | n/a | 116 | 140 |
| hand | 0 | 8 | 0 | 8 | n/a | 120 | 92 |
| frost+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 92 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 120 | 123 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 121 | 161 |
| seq pierce>incendiary>frost | 0 | 8 | 0 | 8 | n/a | 120 | 228 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 249 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 249 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 249 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 258 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 265 |

### arena-boss vs arena-boss-lightning

| build | arena-boss | arena-boss-lightning | seeds with an identical hp trace |
|---|---|---|---|
| none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| hand | 1/8 won, 18.6 s, 122 dmg | 1/8 won, 18.6 s, 122 dmg | 8/8 |
| shock+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| incendiary+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost+pierce | 1/8 won, 18.6 s, 122 dmg | 1/8 won, 18.6 s, 122 dmg | 8/8 |
| seq none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>incendiary>frost | 1/8 won, 9.1 s, 118 dmg | 1/8 won, 9.1 s, 118 dmg | 8/8 |
| seq pierce>shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 8/8 |
| seq pierce>frost>shock | 0/8 won, n/a s, 122 dmg | 0/8 won, n/a s, 122 dmg | 8/8 |
| seq shock>frost | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 8/8 |
| seq hand shock-lead | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq hand fire-lead | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq hand frost-lead | 1/8 won, 14.4 s, 119 dmg | 1/8 won, 14.4 s, 119 dmg | 8/8 |

### arena-boss-wet vs arena-boss-lightning-wet

| build | arena-boss-wet | arena-boss-lightning-wet | seeds with an identical hp trace |
|---|---|---|---|
| none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock | 3/8 won, 7.9 s, 110 dmg | 8/8 won, 7.5 s, 44 dmg | 0/8 |
| incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| hand | 1/8 won, 18.6 s, 122 dmg | 1/8 won, 18.6 s, 122 dmg | 8/8 |
| shock+pierce | 4/8 won, 8.2 s, 108 dmg | 8/8 won, 5.2 s, 40 dmg | 0/8 |
| incendiary+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost+pierce | 1/8 won, 18.6 s, 122 dmg | 1/8 won, 18.6 s, 122 dmg | 8/8 |
| seq none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq shock | 1/8 won, 12.0 s, 114 dmg | 7/8 won, 7.4 s, 68 dmg | 0/8 |
| seq incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>shock | 1/8 won, 8.3 s, 114 dmg | 8/8 won, 6.4 s, 57 dmg | 0/8 |
| seq pierce>incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>incendiary>frost | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 0/8 |
| seq pierce>frost>shock | 1/8 won, 12.5 s, 118 dmg | 6/8 won, 9.2 s, 96 dmg | 0/8 |
| seq shock>frost | 1/8 won, 12.1 s, 113 dmg | 1/8 won, 10.8 s, 111 dmg | 0/8 |
| seq shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 0/8 |
| seq hand shock-lead | 0/8 won, n/a s, 120 dmg | 2/8 won, 9.2 s, 104 dmg | 0/8 |
| seq hand fire-lead | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq hand frost-lead | 0/8 won, n/a s, 120 dmg | 4/8 won, 10.3 s, 105 dmg | 2/8 |

### arena-bog-boss-stock vs arena-bog-boss

| build | arena-bog-boss-stock | arena-bog-boss | seeds with an identical hp trace |
|---|---|---|---|
| none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock | 7/8 won, 7.3 s, 29 dmg | 8/8 won, 5.4 s, 9 dmg | 0/8 |
| incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost | 0/8 won, n/a s, 116 dmg | 0/8 won, n/a s, 116 dmg | 8/8 |
| hand | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock+pierce | 8/8 won, 7.6 s, 28 dmg | 8/8 won, 5.4 s, 6 dmg | 0/8 |
| incendiary+pierce | 1/8 won, 20.4 s, 119 dmg | 1/8 won, 20.4 s, 119 dmg | 8/8 |
| frost+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq shock | 7/8 won, 8.1 s, 54 dmg | 8/8 won, 5.8 s, 10 dmg | 0/8 |
| seq incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq frost | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 8/8 |
| seq pierce>shock | 7/8 won, 8.1 s, 51 dmg | 8/8 won, 5.6 s, 10 dmg | 0/8 |
| seq pierce>incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>frost | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>incendiary>frost | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>shock>incendiary | 2/8 won, 10.3 s, 110 dmg | 6/8 won, 8.4 s, 81 dmg | 0/8 |
| seq pierce>frost>shock | 7/8 won, 8.6 s, 59 dmg | 8/8 won, 6.4 s, 44 dmg | 0/8 |
| seq shock>frost | 5/8 won, 9.6 s, 86 dmg | 5/8 won, 6.4 s, 73 dmg | 0/8 |
| seq shock>incendiary | 2/8 won, 10.3 s, 110 dmg | 6/8 won, 8.4 s, 81 dmg | 0/8 |
| seq hand shock-lead | 5/8 won, 10.1 s, 103 dmg | 7/8 won, 8.2 s, 78 dmg | 0/8 |
| seq hand fire-lead | 2/8 won, 13.1 s, 106 dmg | 5/8 won, 9.1 s, 80 dmg | 0/8 |
| seq hand frost-lead | 6/8 won, 11.9 s, 86 dmg | 7/8 won, 8.2 s, 81 dmg | 0/8 |

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

## Probe tables

Generated by `scripts/substrate-probes.mts`.

<!-- probes:begin -->
Generated by `npx tsx scripts/substrate-probes.mts --write docs/design/substrate-census.md`.

### Bot teams against the flooded lair

The census bot, alone or with a second bot one tile beside it, on seeds 303, 5, 4, 2, 44, 18, 51, 10. Both players carry the build. Per-player columns read player 1 / player 2. Arc hits count electrocution damage events a player took; each is 20 hp. Shocked time is time spent electrified, summed over the seeds.

| arena | build | players | won | mean dmg taken | arc hits | shocked (s) |
|---|---|---|---|---|---|---|
| arena-bog-boss | none | 1 | 0/8 | 120 | 0 | 0.0 |
| arena-bog-boss | none | 2 | 1/8 | 137 / 142 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss | shock | 1 | 8/8 | 9 | 2 | 1.5 |
| arena-bog-boss | shock | 2 | 8/8 | 6 / 6 | 2 / 2 | 1.5 / 1.5 |
| arena-bog-boss | shock+pierce | 1 | 8/8 | 6 | 2 | 1.5 |
| arena-bog-boss | shock+pierce | 2 | 8/8 | 6 / 6 | 2 / 2 | 1.5 / 1.5 |
| arena-bog-boss | seq shock | 1 | 8/8 | 10 | 1 | 1.5 |
| arena-bog-boss | seq shock | 2 | 8/8 | 12 / 7 | 2 / 2 | 1.5 / 1.5 |
| arena-bog-boss | seq shock>frost | 1 | 5/8 | 73 | 3 | 3.7 |
| arena-bog-boss | seq shock>frost | 2 | 8/8 | 37 / 31 | 1 / 1 | 1.5 / 1.5 |
| arena-bog-boss | seq hand shock-lead | 1 | 7/8 | 78 | 1 | 1.4 |
| arena-bog-boss | seq hand shock-lead | 2 | 8/8 | 45 / 19 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss | frost | 1 | 0/8 | 116 | 0 | 0.0 |
| arena-bog-boss | frost | 2 | 5/8 | 105 / 88 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss | incendiary | 1 | 0/8 | 120 | 0 | 0.0 |
| arena-bog-boss | incendiary | 2 | 2/8 | 150 / 141 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss | incendiary+pierce | 1 | 1/8 | 119 | 0 | 0.0 |
| arena-bog-boss | incendiary+pierce | 2 | 6/8 | 133 / 96 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss | hand | 1 | 0/8 | 120 | 0 | 0.0 |
| arena-bog-boss | hand | 2 | 7/8 | 93 / 84 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss-stock | none | 1 | 0/8 | 120 | 0 | 0.0 |
| arena-bog-boss-stock | none | 2 | 1/8 | 137 / 142 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss-stock | shock | 1 | 7/8 | 29 | 2 | 1.5 |
| arena-bog-boss-stock | shock | 2 | 8/8 | 28 / 17 | 3 / 3 | 2.2 / 2.2 |
| arena-bog-boss-stock | shock+pierce | 1 | 8/8 | 28 | 2 | 1.5 |
| arena-bog-boss-stock | shock+pierce | 2 | 8/8 | 28 / 14 | 3 / 3 | 2.2 / 2.2 |
| arena-bog-boss-stock | seq shock | 1 | 7/8 | 54 | 1 | 1.5 |
| arena-bog-boss-stock | seq shock | 2 | 8/8 | 32 / 24 | 2 / 2 | 1.5 / 1.5 |
| arena-bog-boss-stock | seq shock>frost | 1 | 5/8 | 86 | 4 | 4.1 |
| arena-bog-boss-stock | seq shock>frost | 2 | 7/8 | 57 / 60 | 3 / 3 | 3.7 / 3.7 |
| arena-bog-boss-stock | seq hand shock-lead | 1 | 5/8 | 103 | 1 | 1.4 |
| arena-bog-boss-stock | seq hand shock-lead | 2 | 8/8 | 60 / 53 | 3 / 4 | 1.7 / 3.0 |
| arena-bog-boss-stock | frost | 1 | 0/8 | 116 | 0 | 0.0 |
| arena-bog-boss-stock | frost | 2 | 5/8 | 105 / 88 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss-stock | incendiary | 1 | 0/8 | 120 | 0 | 0.0 |
| arena-bog-boss-stock | incendiary | 2 | 2/8 | 150 / 141 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss-stock | incendiary+pierce | 1 | 1/8 | 119 | 0 | 0.0 |
| arena-bog-boss-stock | incendiary+pierce | 2 | 6/8 | 133 / 96 | 0 / 0 | 0.0 / 0.0 |
| arena-bog-boss-stock | hand | 1 | 0/8 | 120 | 0 | 0.0 |
| arena-bog-boss-stock | hand | 2 | 7/8 | 93 / 84 | 0 / 0 | 0.0 / 0.0 |

### An NPC stun gun against wet players

A gangster armed with a stun gun starts 4 tiles from the players. The players hold still for 10 s. A flooded room is the arena room under the bog tide (the experiment); a flooded street is an open street row under the tide, which floods in real bog-tide play. On flooded ground the players and the gunner are wet. Totals over seeds 303, 5, 4, 2, 44, 18, 51, 10; per-player columns read player 1 / player 2.

| ground | players | stun shots | dmg taken | arc hits | shocked (s) | downed | median time to down (s) |
|---|---|---|---|---|---|---|---|
| dry room | 1 | 91 | 174 | 0 | 22.9 | 0/8 | n/a |
| dry room | 2 | 88 | 68 / 108 | 0 / 0 | 14.7 / 17.0 | 0/8 / 0/8 | n/a / n/a |
| flooded room | 1 | 88 | 960 | 48 | 20.8 | 8/8 | 5.0 |
| flooded room | 2 | 89 | 960 / 960 | 48 / 48 | 20.8 / 20.8 | 8/8 / 8/8 | 5.0 / 5.0 |
| flooded street | 1 | 82 | 730 | 34 | 21.0 | 5/8 | 4.9 |
| flooded street | 2 | 82 | 622 / 532 | 30 / 24 | 16.4 / 20.4 | 4/8 / 4/8 | 5.2 / 5.2 |

### The kiters out of sight

arena-kiter's three gangsters stand abreast on an open street row, 9 or 12 tiles from the census bot, beyond their 8-tile sight. Seeds 303, 5, 4, 2, 44, 18, 51, 10; fights capped at 60 s.

| distance (tiles) | build | won | mean dmg taken | seeds where a gangster fired | median first reply (s) |
|---|---|---|---|---|---|
| 9 | none | 3/8 | 70 | 8/8 | 0.7 |
| 9 | hand | 8/8 | 51 | 8/8 | 0.7 |
| 9 | incendiary+pierce | 8/8 | 58 | 8/8 | 0.7 |
| 12 | none | 1/8 | 42 | 6/8 | 2.1 |
| 12 | hand | 6/8 | 19 | 4/8 | 2.1 |
| 12 | incendiary+pierce | 6/8 | 14 | 4/8 | 2.1 |
<!-- probes:end -->

## Appendix: the unchanged census after each merge

Each cell is fights won out of 8, then mean damage taken, from the census with 21 builds run at each merge commit. Only rows that differ between any two columns appear. `main` is the block in `docs/design/arena-census.md`.

| build | arena | main | +92 | +99 | +101 |
|---|---|---|---|---|---|
| shock | arena-kiter | 6/8 · 91 | 6/8 · 104 | 6/8 · 104 | 6/8 · 104 |
| shock | arena-swarm | 7/8 · 100 | 8/8 · 72 | 8/8 · 72 | 8/8 · 72 |
| shock | arena-cinder | 8/8 · 69 | 8/8 · 67 | 8/8 · 67 | 8/8 · 67 |
| shock | arena-boss-wet | 0/8 · 120 | 3/8 · 99 | 3/8 · 99 | 3/8 · 110 |
| shock | arena-boss-lightning-wet | 0/8 · 120 | 7/8 · 40 | 7/8 · 40 | 8/8 · 44 |
| incendiary | arena-brute | 8/8 · 52 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| incendiary | arena-brute-pair | 0/8 · 120 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| incendiary | arena-kiter | 4/8 · 104 | 7/8 · 80 | 7/8 · 80 | 7/8 · 80 |
| incendiary | arena-swarm | 8/8 · 69 | 8/8 · 45 | 8/8 · 45 | 8/8 · 45 |
| incendiary | arena-cinder | 4/8 · 115 | 8/8 · 9 | 8/8 · 9 | 8/8 · 9 |
| hand | arena-boss | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| hand | arena-boss-lightning | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| hand | arena-boss-wet | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| hand | arena-boss-lightning-wet | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| shock+pierce | arena-kiter | 7/8 · 90 | 7/8 · 76 | 7/8 · 76 | 7/8 · 76 |
| shock+pierce | arena-swarm | 8/8 · 77 | 8/8 · 51 | 8/8 · 51 | 8/8 · 51 |
| shock+pierce | arena-cinder | 8/8 · 55 | 8/8 · 38 | 8/8 · 38 | 8/8 · 38 |
| shock+pierce | arena-boss-wet | 0/8 · 120 | 4/8 · 99 | 4/8 · 99 | 4/8 · 108 |
| shock+pierce | arena-boss-lightning-wet | 0/8 · 120 | 7/8 · 36 | 7/8 · 36 | 8/8 · 40 |
| incendiary+pierce | arena-brute | 8/8 · 52 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| incendiary+pierce | arena-brute-pair | 0/8 · 120 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| incendiary+pierce | arena-kiter | 7/8 · 90 | 8/8 · 58 | 8/8 · 58 | 8/8 · 58 |
| incendiary+pierce | arena-swarm | 8/8 · 53 | 8/8 · 33 | 8/8 · 33 | 8/8 · 33 |
| incendiary+pierce | arena-cinder | 8/8 · 79 | 8/8 · 9 | 8/8 · 9 | 8/8 · 9 |
| frost+pierce | arena-boss | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| frost+pierce | arena-boss-lightning | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| frost+pierce | arena-boss-wet | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| frost+pierce | arena-boss-lightning-wet | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 122 |
| seq shock | arena-kiter | 3/8 · 103 | 5/8 · 103 | 5/8 · 103 | 5/8 · 103 |
| seq shock | arena-swarm | 7/8 · 107 | 8/8 · 62 | 8/8 · 62 | 8/8 · 62 |
| seq shock | arena-cinder | 8/8 · 102 | 8/8 · 73 | 8/8 · 73 | 8/8 · 73 |
| seq shock | arena-boss-wet | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 1/8 · 114 |
| seq shock | arena-boss-lightning-wet | 0/8 · 120 | 7/8 · 63 | 7/8 · 63 | 7/8 · 68 |
| seq incendiary | arena-brute | 8/8 · 66 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| seq incendiary | arena-brute-pair | 4/8 · 108 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| seq incendiary | arena-kiter | 6/8 · 98 | 6/8 · 91 | 6/8 · 91 | 5/8 · 99 |
| seq incendiary | arena-swarm | 8/8 · 65 | 8/8 · 61 | 8/8 · 61 | 8/8 · 61 |
| seq incendiary | arena-cinder | 1/8 · 117 | 8/8 · 16 | 8/8 · 16 | 8/8 · 17 |
| seq pierce>shock | arena-kiter | 7/8 · 87 | 8/8 · 89 | 8/8 · 89 | 8/8 · 89 |
| seq pierce>shock | arena-swarm | 8/8 · 86 | 8/8 · 65 | 8/8 · 65 | 8/8 · 65 |
| seq pierce>shock | arena-cinder | 8/8 · 79 | 8/8 · 67 | 8/8 · 67 | 8/8 · 67 |
| seq pierce>shock | arena-boss-wet | 0/8 · 120 | 1/8 · 114 | 1/8 · 114 | 1/8 · 114 |
| seq pierce>shock | arena-boss-lightning-wet | 0/8 · 120 | 8/8 · 49 | 8/8 · 49 | 8/8 · 57 |
| seq pierce>incendiary | arena-brute | 8/8 · 66 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| seq pierce>incendiary | arena-brute-pair | 4/8 · 108 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| seq pierce>incendiary | arena-kiter | 6/8 · 90 | 8/8 · 61 | 8/8 · 61 | 8/8 · 61 |
| seq pierce>incendiary | arena-swarm | 8/8 · 45 | 8/8 · 50 | 8/8 · 50 | 8/8 · 50 |
| seq pierce>incendiary | arena-cinder | 7/8 · 86 | 7/8 · 13 | 7/8 · 13 | 8/8 · 13 |
| seq pierce>incendiary>frost | arena-brute | 8/8 · 2 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| seq pierce>incendiary>frost | arena-brute-pair | 8/8 · 20 | 8/8 · 38 | 8/8 · 38 | 8/8 · 38 |
| seq pierce>incendiary>frost | arena-kiter | 6/8 · 95 | 8/8 · 68 | 8/8 · 68 | 8/8 · 68 |
| seq pierce>incendiary>frost | arena-swarm | 8/8 · 53 | 8/8 · 56 | 8/8 · 56 | 8/8 · 56 |
| seq pierce>incendiary>frost | arena-cinder | 8/8 · 85 | 8/8 · 10 | 8/8 · 10 | 8/8 · 10 |
| seq pierce>incendiary>frost | arena-boss | 2/8 · 110 | 2/8 · 112 | 2/8 · 112 | 1/8 · 118 |
| seq pierce>incendiary>frost | arena-boss-lightning | 2/8 · 110 | 2/8 · 112 | 2/8 · 112 | 1/8 · 118 |
| seq pierce>incendiary>frost | arena-boss-wet | 2/8 · 110 | 1/8 · 118 | 1/8 · 118 | 0/8 · 120 |
| seq pierce>incendiary>frost | arena-boss-lightning-wet | 2/8 · 110 | 1/8 · 118 | 1/8 · 118 | 0/8 · 120 |
| seq pierce>shock>incendiary | arena-brute-pair | 8/8 · 84 | 8/8 · 94 | 8/8 · 94 | 8/8 · 94 |
| seq pierce>shock>incendiary | arena-kiter | 5/8 · 87 | 7/8 · 69 | 7/8 · 69 | 7/8 · 71 |
| seq pierce>shock>incendiary | arena-swarm | 8/8 · 73 | 8/8 · 48 | 8/8 · 48 | 8/8 · 48 |
| seq pierce>shock>incendiary | arena-cinder | 3/8 · 116 | 8/8 · 31 | 8/8 · 31 | 8/8 · 31 |
| seq pierce>frost>shock | arena-brute | 8/8 · 2 | 8/8 · 74 | 8/8 · 74 | 8/8 · 74 |
| seq pierce>frost>shock | arena-brute-pair | 5/8 · 89 | 7/8 · 105 | 7/8 · 105 | 7/8 · 105 |
| seq pierce>frost>shock | arena-swarm | 8/8 · 79 | 8/8 · 63 | 8/8 · 63 | 8/8 · 63 |
| seq pierce>frost>shock | arena-cinder | 8/8 · 21 | 8/8 · 28 | 8/8 · 28 | 8/8 · 28 |
| seq pierce>frost>shock | arena-boss | 1/8 · 122 | 0/8 · 122 | 0/8 · 122 | 0/8 · 122 |
| seq pierce>frost>shock | arena-boss-lightning | 1/8 · 122 | 0/8 · 122 | 0/8 · 122 | 0/8 · 122 |
| seq pierce>frost>shock | arena-boss-wet | 1/8 · 122 | 3/8 · 114 | 3/8 · 114 | 1/8 · 118 |
| seq pierce>frost>shock | arena-boss-lightning-wet | 1/8 · 122 | 6/8 · 82 | 6/8 · 82 | 6/8 · 96 |
| seq hand shock-lead | arena-brute-pair | 8/8 · 30 | 8/8 · 2 | 8/8 · 2 | 8/8 · 2 |
| seq hand shock-lead | arena-kiter | 5/8 · 92 | 7/8 · 73 | 7/8 · 73 | 7/8 · 73 |
| seq hand shock-lead | arena-swarm | 8/8 · 59 | 8/8 · 56 | 8/8 · 56 | 8/8 · 56 |
| seq hand shock-lead | arena-cinder | 8/8 · 51 | 8/8 · 5 | 8/8 · 5 | 8/8 · 5 |
| seq hand shock-lead | arena-boss | 3/8 · 116 | 1/8 · 117 | 1/8 · 117 | 0/8 · 120 |
| seq hand shock-lead | arena-boss-lightning | 3/8 · 116 | 1/8 · 117 | 1/8 · 117 | 0/8 · 120 |
| seq hand shock-lead | arena-boss-wet | 3/8 · 116 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq hand shock-lead | arena-boss-lightning-wet | 3/8 · 116 | 4/8 · 89 | 4/8 · 89 | 2/8 · 104 |
| seq hand fire-lead | arena-brute-pair | 8/8 · 2 | 8/8 · 42 | 8/8 · 42 | 8/8 · 42 |
| seq hand fire-lead | arena-kiter | 7/8 · 82 | 8/8 · 65 | 8/8 · 65 | 7/8 · 66 |
| seq hand fire-lead | arena-swarm | 8/8 · 58 | 8/8 · 55 | 8/8 · 55 | 8/8 · 55 |
| seq hand fire-lead | arena-cinder | 8/8 · 47 | 8/8 · 28 | 8/8 · 28 | 8/8 · 29 |
| seq hand fire-lead | arena-boss | 3/8 · 102 | 1/8 · 120 | 1/8 · 120 | 0/8 · 120 |
| seq hand fire-lead | arena-boss-lightning | 3/8 · 102 | 1/8 · 120 | 1/8 · 120 | 0/8 · 120 |
| seq hand fire-lead | arena-boss-wet | 3/8 · 102 | 2/8 · 118 | 2/8 · 118 | 0/8 · 120 |
| seq hand fire-lead | arena-boss-lightning-wet | 3/8 · 102 | 2/8 · 118 | 2/8 · 118 | 0/8 · 120 |
| seq hand frost-lead | arena-brute | 8/8 · 0 | 8/8 · 12 | 8/8 · 12 | 8/8 · 12 |
| seq hand frost-lead | arena-brute-pair | 8/8 · 2 | 8/8 · 0 | 8/8 · 0 | 8/8 · 0 |
| seq hand frost-lead | arena-kiter | 6/8 · 77 | 8/8 · 74 | 8/8 · 74 | 8/8 · 74 |
| seq hand frost-lead | arena-swarm | 8/8 · 72 | 8/8 · 67 | 8/8 · 67 | 8/8 · 67 |
| seq hand frost-lead | arena-cinder | 8/8 · 37 | 8/8 · 14 | 8/8 · 14 | 8/8 · 14 |
| seq hand frost-lead | arena-boss | 3/8 · 119 | 2/8 · 116 | 2/8 · 116 | 1/8 · 119 |
| seq hand frost-lead | arena-boss-lightning | 3/8 · 119 | 2/8 · 116 | 2/8 · 116 | 1/8 · 119 |
| seq hand frost-lead | arena-boss-wet | 3/8 · 119 | 1/8 · 118 | 1/8 · 118 | 0/8 · 120 |
| seq hand frost-lead | arena-boss-lightning-wet | 3/8 · 119 | 4/8 · 106 | 4/8 · 106 | 4/8 · 105 |

94 of 189 cells differ.

| distance (tiles) | player fires | main | +92 | +99 | +101 |
|---|---|---|---|---|---|
| 9 | yes | 2.4 s, 6 shots, 70 dmg | 2.4 s, 6 shots, 70 dmg | 2.4 s, 6 shots, 70 dmg | 1.1 s, 8 shots, 70 dmg |
| 10 | yes | 2.9 s, 9 shots, 84 dmg | 2.9 s, 9 shots, 84 dmg | 2.9 s, 9 shots, 84 dmg | 1.6 s, 7 shots, 70 dmg |
| 11 | yes | 3.2 s, 5 shots, 42 dmg | 3.2 s, 5 shots, 42 dmg | 3.2 s, 5 shots, 42 dmg | 2.1 s, 10 shots, 84 dmg |
| 12 | yes | never, 0 shots, 0 dmg | never, 0 shots, 0 dmg | never, 0 shots, 0 dmg | 2.4 s, 9 shots, 112 dmg |
