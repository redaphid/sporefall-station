# Arena census: do different builds win different fights?

Status: **measured** on `feat/arena-census`. Code: `src/game/arenas.ts` (`ARENAS`,
`stageArena`), `src/debug/census.ts` (the bot, `runFight`, `reachProbe`),
`scripts/census.mts` (the CLI). Tests: `src/game/arenas.test.ts`,
`src/debug/census.test.ts`.

Three loadout prototypes (draft PRs #111, #112, #113) failed their playtest for one
shared reason. Floor-1 fights never threatened the tester, so one generic build won
every fight and no build choice mattered. Every one of those designs assumed this
premise:

> Sporefall's enemies can pose genuinely different questions, so different builds
> win different fights.

If no build ever loses, no loadout mechanic can show variety. This census tests the
premise with numbers before anyone builds a fourth loadout mechanic. Every figure
in the verdict comes from the generated tables at the end of this doc.

## Verdict: the premise partly holds

- **The enemies can threaten.** Every arena downs a player who does nothing on 8 of
  8 seeds, after a median of 3.8 s (two brutes) to 5.6 s (the Mireclaw Alpha). The
  plain pistol with no mods wins 0/8 against one brute, 0/8 against two, 0/8
  against every boss arena, 3/8 against the gangsters and the swarm, and 4/8
  against the cinders.
- **A wrong element costs nothing, it just does nothing.** Against the cinders,
  incendiary has the same hp trace as no mods on every seed (4/8 won, 115 damage),
  because `burning` does `round(2 × 0.2) = 0` per tick. Frost wins the same fight
  8/8 on 10 damage.
- **Fold mode has two answers, and one of them is nearly universal.** The generic
  hand `[shock, incendiary, frost, pierce]` is not a mix. Fold keeps only the
  newest element (#106), so the hand has the same hp trace as `frost+pierce` in
  every arena. That frost build is the best fold build against the gangsters (8/8,
  44 damage), the swarm (8/8, 39) and the cinders (8/8, 10). Against one brute every
  fold element build wins 8/8, and fire takes the least damage (52 against the
  hand's 72). No fold build wins the brute pair, and the best fold build beats the
  boss 1/8.
- **Sequencing adds a third answer for closers: fire plus a lock.** A sequenced
  list lands its elements on alternate shots, so burning and an immobilize can both
  be on a brute, which fold's newest-element rule forbids. `seq
  pierce>incendiary>frost` beats one brute 8/8 on 2 damage and the pair 8/8 on 20.
  `seq pierce>shock>incendiary` beats the pair 8/8 on 84. Without fire, `seq
  pierce>frost>shock` beats the pair only 5/8, and no single-element build beats it
  more than 4/8. Against the gangsters and the cinders the sequenced hands do worse than fold
  frost: 5/8 to 7/8 won on 77 to 92 damage against the gangsters, and 37 to 51
  damage against the cinders.
- **The lightning question cannot be asked.** `resist.electrified: 2` changes
  nothing for any of the 21 builds on any of the 8 seeds, dry or wet. The hp traces
  are identical.

The generic hand loses the brute pair 0/8 and the boss 7/8, and it takes 72 of 120
hp against one brute. So a loadout mechanic has fights to vary against. The problem
is that today's elements give it three answers (frost, fire, and fire plus a lock),
frost covers three of the six distinct fights, and the owner's showcase answer,
lightning, does nothing.

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
is one step past that count, kept because no fold build wins it. The playtest
staged one cinder and three sporelings. In the sweep, three cinders and four
sporelings lost to every build tried, the plain pistol included.

The census bot is fixed and deterministic. Each tick it aims at the nearest living
foe and fires. It walks straight away from that foe while below half health or
while any foe is within 1.5 tiles. It never rolls, chases or picks targets. It
drives the real sim through the `step` verb, one tick per call. A fight ends when
every staged foe is dead (won), the player is downed, or 60 s pass (timed out).
None of the 1,512 bot fights timed out. `runFight` throws if an arena stages fewer
foes than it names or if the fight leaves the floor.

The builds are no mods, each element alone, the hand, and each element with
`pierce`, all in fold mode. The same builds run in sequenced mode, with the hand in
three orders that lead with shock, fire or frost. Three more sequenced builds hold
two elements each, to show which pair does the work. The eight seeds each put the
arena in a room of a different shape, from 7x7 to 11x8. A `passive` run per arena
and seed holds neutral input to measure how fast the arena kills a player who does
nothing.

## Lightning weakness does not reach play

The census compares `arena-boss` with `arena-boss-lightning`, and `arena-boss-wet`
with `arena-boss-lightning-wet`. All 21 builds have identical hp traces on all 8
seeds in both comparisons.

The code shows why. `resistMult` has three readers:

- `combat.ts` `applyDamage` reads `'physical'` for every bullet.
- `fire.ts` `elementSystem` reads the status id for damage over time, but
  `ELEMENTS.electrified.dot` is 0, so there is nothing to multiply.
- `interactions.ts` `shock` reads `'electrified'` (the #97 fix), but only for wet
  bodies, and no sim system calls `shock`. Its only caller is the `?e2e` debug API
  in `src/game/debug.ts`.

A Tesla hit goes through `applyStatus`, which only immobilizes. Nothing in play
applies `wet` either. The only callers of `wet()` are the `wet-electric` scenario
and the same debug API, and the `Bog` tile (`levelgen/level.ts`) sets no status. So
the Tesla card's blurb, "arcs through anything wet", describes a rule no player can
trigger.

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

**Ranged foes do not answer fire from beyond 8 tiles.** A gangster perceives out to
its `sightRange` of 8 and fires inside `range × 0.8 = 8`. A landed hit does not put
it in aggro. `applyDamage` does that only for `retaliates` archetypes such as the
bouncer. In the reach probe, a gangster shot from 9 to 11 tiles fired no sooner
than one left alone (2.4 s against 1.9 s at 9 tiles), when its idle wander carried
it into range. From 12 tiles it never fired in 10 s. An earlier version of this
census staged foes against the far wall of 10-tile rooms, and those foes never
engaged, which is how a playtester can win at no cost.

**Frost answers almost everything.** A frozen body cannot act, and the next hit
shatters it for 5 times damage (`SHATTER_DAMAGE_MULT`). No archetype can resist a
freeze, because `resistMult` scales only damage and never the length of an
immobilize.

The playtest's open-ground staging and human kiting (the player's 4.5 tiles/s
outruns every arena foe, the sporeling at 4.4 only just) likely widened the gap
further. That is inferred, not measured. The census bot does not kite.

## Proposed minimal changes

None of these are applied. Each measured one was run as a throwaway patch against
this branch, then reverted. To reproduce one, apply its diff and run the census
command it lists.

1. **Let `shock` be the one path a Tesla hit takes.** Give `interactions.shock` a
   duration argument and call it in place of `applyStatus` for an electrified hit
   in `projectiles.ts`:

   ```ts
   if (landed && p.onHit) {
   	if (p.onHit.status === 'electrified') shock(w, other, p.onHit.ticks)
   	else applyStatus(w, other, p.onHit.status, p.onHit.ticks)
   }
   ```

   Measured with `npx tsx scripts/census.mts --arena arena-boss,arena-boss-lightning,arena-boss-wet,arena-boss-lightning-wet,arena-brute,arena-kiter --no-reach`.
   Every dry arena's table is unchanged. Against the wet boss, fold `shock` goes
   from 2/8 won on 109 damage (stock) to 8/8 on 56 (weak to lightning), and
   `shock+pierce` from 2/8 on 105 to 8/8 on 60. The generic hand stays at 1/8 on
   121. That is the prepare-for-the-boss delta the owner asked for, but only on a
   wet boss, so it needs change 2. Calling `shock` after `applyStatus` instead, as
   an earlier draft of this doc proposed, re-applies the lock and shortens the
   anti-chain-lock window, which changed 10 of 108 dry boss fights in a reviewer's
   run.
2. **Give play a source of `wet`.** Make the `Bog` tile, or a flooded boss room,
   apply `wet` to whoever stands in it. Not measured. With change 1, a wet player
   hit by an NPC's `stunGun` (NPCs roll it, `populate.ts`) takes 20 damage that
   skips i-frames and physical resist, and the arc jumps to wet teammates within
   1.6 tiles.
3. **Or give `electrified` damage over time.** The one-line data alternative in
   `data/elements.ts` is `electrified: { id: 'electrified', dot: 2, interval: 9, durationTicks: 30 }`,
   so `elementSystem` multiplies it by `resist.electrified` on dry targets too.
   Measured with `npx tsx scripts/census.mts --arena arena-boss,arena-boss-lightning --no-reach`.
   The shock-led sequenced hand goes from 2/8 won (stock) to 6/8 (weak), and the
   fire-led hand from 3/8 to 6/8. Fold `shock` still loses 0/8 on both. This also
   changes the stock boss, and it adds damage to NPC stun-gun hits on players.
4. **Put a foe in aggro when a target it is hostile to lands a hit.** In
   `combat.ts` `applyDamage`, extend the `retaliates` branch to any foe for which
   `behaviors.isHostileTarget(w, target, attacker)` is true, with that function
   exported. Measured with `npx tsx scripts/census.mts --arena arena-kiter --build none --seeds 303`,
   which includes the reach probe. A gangster shot from 9 tiles fires back at 1.0 s
   (was 2.4 s), from 10 tiles at 1.4 s (was 2.9 s), and from 12 tiles at 3.0 s,
   dealing 84 damage (was never, 0 damage). In the arenas, where foes start in
   sight, the plain pistol's wins against the gangsters drop from 3/8 to 1/8.
   `NpcDef.hostility` is the wrong key for this: its own comment says the inspect
   card is its only reader.
5. **Let a resist table shorten an immobilize.** Scale the lock that
   `applyImmobilize` grants by a resist key, so a foe can carry a frost-proof or
   shock-proof table. That is the only way an arena can field a foe that frost does
   not answer, and a lock is half of the sequenced answer too. Not measured. The
   `electrified` key already scales shock damage (#97), so reusing it would make
   `electrified: 2` double both the damage and the lock. A separate key, such as
   `frozenLock`, avoids that.

Changes 1 and 2 serve the lightning boss. Change 5 is what would let a loadout
mechanic have more than three answers to vary between. Change 4 closes the free
sniping gap. Changes 1 and 3 add damage, change 2 widens where change 1 lands, and
none touch hp or speed.

## Limits

- The bot is deliberately simple. It never rolls, kites, chases or picks targets, so
  it understates what a skilled player does and overstates damage taken.
- Many melee fights replay the same way on seeds whose rooms differ only in shape
  beyond the fight. The "distinct fights" column counts how many of the 8 seeds
  gave a different hp trace. It is 3 for the fold frost builds against one brute,
  so that 8/8 is 3 independent results.
- The boss fights run the whole Mireclaw brain, including summons. Summons count
  toward damage taken but not toward the win.
- Passive regen heals the player during a fight, so damage taken can exceed 120.

## Census tables

Regenerate with `npx tsx scripts/census.mts --write docs/design/arena-census.md`
(about 75 s). Two runs produce byte-identical output. The command replaces only
the block below.

<!-- census:begin -->
Generated by `npx tsx scripts/census.mts --write docs/design/arena-census.md`. Seeds 303, 5, 4, 2, 44, 18, 51, 10; 21 builds; fights capped at 60 s.

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
| shock | 8/8 · 82 | 0/8 · 120 | 6/8 · 91 | 7/8 · 100 | 8/8 · 69 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| incendiary | 8/8 · 52 | 0/8 · 120 | 4/8 · 104 | 8/8 · 69 | 4/8 · 115 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| frost | 8/8 · 72 | 0/8 · 120 | 6/8 · 81 | 8/8 · 62 | 8/8 · 10 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 |
| hand | 8/8 · 72 | 0/8 · 120 | **8/8 · 44** | **8/8 · 39** | **8/8 · 10** | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 |
| shock+pierce | 8/8 · 82 | 0/8 · 120 | 7/8 · 90 | 8/8 · 77 | 8/8 · 55 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| incendiary+pierce | 8/8 · 52 | 0/8 · 120 | 7/8 · 90 | 8/8 · 53 | 8/8 · 79 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| frost+pierce | 8/8 · 72 | 0/8 · 120 | **8/8 · 44** | **8/8 · 39** | **8/8 · 10** | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 | 1/8 · 121 |
| seq none | 0/8 · 120 | 0/8 · 120 | 3/8 · 115 | 3/8 · 111 | 4/8 · 115 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq shock | 4/8 · 110 | 0/8 · 120 | 3/8 · 103 | 7/8 · 107 | 8/8 · 102 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq incendiary | 8/8 · 66 | 4/8 · 108 | 6/8 · 98 | 8/8 · 65 | 1/8 · 117 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq frost | 8/8 · 82 | 0/8 · 120 | 7/8 · 78 | 8/8 · 90 | 8/8 · 13 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 |
| seq pierce>shock | 4/8 · 110 | 0/8 · 120 | 7/8 · 87 | 8/8 · 86 | 8/8 · 79 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq pierce>incendiary | 8/8 · 66 | 4/8 · 108 | 6/8 · 90 | 8/8 · 45 | 7/8 · 86 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 | 0/8 · 120 |
| seq pierce>frost | 8/8 · 82 | 0/8 · 120 | 7/8 · 48 | 8/8 · 50 | 8/8 · 13 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 | 0/8 · 123 |
| seq pierce>incendiary>frost | 8/8 · 2 | 8/8 · 20 | 6/8 · 95 | 8/8 · 53 | 8/8 · 85 | 2/8 · 110 | 2/8 · 110 | 2/8 · 110 | 2/8 · 110 |
| seq pierce>shock>incendiary | 8/8 · 0 | 8/8 · 84 | 5/8 · 87 | 8/8 · 73 | 3/8 · 116 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 | 0/8 · 121 |
| seq pierce>frost>shock | 8/8 · 2 | 5/8 · 89 | 7/8 · 57 | 8/8 · 79 | 8/8 · 21 | 1/8 · 122 | 1/8 · 122 | 1/8 · 122 | 1/8 · 122 |
| seq hand shock-lead | **8/8 · 0** | 8/8 · 30 | 5/8 · 92 | 8/8 · 59 | 8/8 · 51 | 3/8 · 116 | 3/8 · 116 | 3/8 · 116 | 3/8 · 116 |
| seq hand fire-lead | 8/8 · 0 | **8/8 · 2** | 7/8 · 82 | 8/8 · 58 | 8/8 · 47 | 3/8 · 102 | 3/8 · 102 | 3/8 · 102 | 3/8 · 102 |
| seq hand frost-lead | 8/8 · 0 | 8/8 · 2 | 6/8 · 77 | 8/8 · 72 | 8/8 · 37 | **3/8 · 119** | **3/8 · 119** | **3/8 · 119** | **3/8 · 119** |

### Best and worst build per arena

Builds joined by `=` tie on every ranking key.

| arena | best | worst | generic hand (fold) | builds that failed to win at least once |
|---|---|---|---|---|
| arena-brute | seq hand shock-lead: 8/8 won, 4.8 s, 0 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 8/8 won, 6.1 s, 72 dmg | 4/21 |
| arena-brute-pair | seq hand fire-lead: 8/8 won, 7.0 s, 2 dmg | none = seq none: 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 16/21 |
| arena-kiter | hand = frost+pierce: 8/8 won, 2.4 s, 44 dmg | seq shock: 3/8 won, 5.9 s, 103 dmg | 8/8 won, 2.4 s, 44 dmg | 19/21 |
| arena-swarm | hand = frost+pierce: 8/8 won, 5.0 s, 39 dmg | none = seq none: 3/8 won, 4.9 s, 111 dmg | 8/8 won, 5.0 s, 39 dmg | 4/21 |
| arena-cinder | hand = frost+pierce: 8/8 won, 4.5 s, 10 dmg | seq incendiary: 1/8 won, 9.3 s, 117 dmg | 8/8 won, 4.5 s, 10 dmg | 6/21 |
| arena-boss | seq hand frost-lead: 3/8 won, 11.7 s, 119 dmg | none = seq none = seq shock: 0/8 won, n/a s, 120 dmg | 1/8 won, 13.8 s, 121 dmg | 21/21 |
| arena-boss-lightning | seq hand frost-lead: 3/8 won, 11.7 s, 119 dmg | none = seq none = seq shock: 0/8 won, n/a s, 120 dmg | 1/8 won, 13.8 s, 121 dmg | 21/21 |
| arena-boss-wet | seq hand frost-lead: 3/8 won, 11.7 s, 119 dmg | none = seq none = seq shock: 0/8 won, n/a s, 120 dmg | 1/8 won, 13.8 s, 121 dmg | 21/21 |
| arena-boss-lightning-wet | seq hand frost-lead: 3/8 won, 11.7 s, 119 dmg | none = seq none = seq shock: 0/8 won, n/a s, 120 dmg | 1/8 won, 13.8 s, 121 dmg | 21/21 |

### Builds that fought identically

Builds with the same hp trace on every seed of an arena. The worlds may still differ in ways hp does not show, such as a status that deals no damage.

- arena-brute: none = seq none; shock = shock+pierce; incendiary = incendiary+pierce; frost = hand = frost+pierce; seq shock = seq pierce>shock; seq incendiary = seq pierce>incendiary; seq frost = seq pierce>frost.
- arena-brute-pair: none = seq none; incendiary = incendiary+pierce; frost = hand = frost+pierce; seq incendiary = seq pierce>incendiary; seq frost = seq pierce>frost.
- arena-kiter: none = seq none; hand = frost+pierce.
- arena-swarm: none = seq none; hand = frost+pierce.
- arena-cinder: none = incendiary = seq none; hand = frost+pierce.
- arena-boss: none = seq none; hand = frost+pierce.
- arena-boss-lightning: none = seq none; hand = frost+pierce.
- arena-boss-wet: none = seq none; hand = frost+pierce.
- arena-boss-lightning-wet: none = seq none; hand = frost+pierce.

### arena-brute

An armoured closer: bullets do 35%, so low damage per second loses the race.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.5 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| seq hand shock-lead | 8 | 0 | 0 | 5 | 4.8 | 0 |  |
| seq hand fire-lead | 8 | 0 | 0 | 6 | 4.8 | 0 |  |
| seq hand frost-lead | 8 | 0 | 0 | 6 | 5.7 | 0 |  |
| seq pierce>shock>incendiary | 8 | 0 | 0 | 6 | 6.2 | 0 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 4 | 4.5 | 2 |  |
| seq pierce>frost>shock | 8 | 0 | 0 | 3 | 6.6 | 2 |  |
| incendiary | 8 | 0 | 0 | 4 | 5.3 | 52 |  |
| incendiary+pierce | 8 | 0 | 0 | 4 | 5.3 | 52 |  |
| seq incendiary | 8 | 0 | 0 | 4 | 5.7 | 66 |  |
| seq pierce>incendiary | 8 | 0 | 0 | 4 | 5.7 | 66 |  |
| frost | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
| hand | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
| frost+pierce | 8 | 0 | 0 | 3 | 6.1 | 72 |  |
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
| seq hand fire-lead | 8 | 0 | 0 | 3 | 7.0 | 2 |  |
| seq hand frost-lead | 8 | 0 | 0 | 5 | 9.3 | 2 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 5 | 7.8 | 20 |  |
| seq hand shock-lead | 8 | 0 | 0 | 5 | 7.8 | 30 |  |
| seq pierce>shock>incendiary | 8 | 0 | 0 | 5 | 8.6 | 84 |  |
| seq pierce>frost>shock | 5 | 3 | 0 | 6 | 13.2 | 89 | 57 |
| seq incendiary | 4 | 4 | 0 | 4 | 7.5 | 108 | 77 |
| seq pierce>incendiary | 4 | 4 | 0 | 4 | 7.5 | 108 | 77 |
| frost | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| hand | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| frost+pierce | 0 | 8 | 0 | 5 | n/a | 120 | 59 |
| seq frost | 0 | 8 | 0 | 5 | n/a | 120 | 64 |
| seq pierce>frost | 0 | 8 | 0 | 5 | n/a | 120 | 64 |
| incendiary | 0 | 8 | 0 | 6 | n/a | 120 | 73 |
| incendiary+pierce | 0 | 8 | 0 | 6 | n/a | 120 | 73 |
| shock+pierce | 0 | 8 | 0 | 5 | n/a | 120 | 119 |
| shock | 0 | 8 | 0 | 5 | n/a | 120 | 121 |
| seq pierce>shock | 0 | 8 | 0 | 5 | n/a | 120 | 125 |
| seq shock | 0 | 8 | 0 | 5 | n/a | 120 | 133 |
| none | 0 | 8 | 0 | 5 | n/a | 120 | 151 |
| seq none | 0 | 8 | 0 | 5 | n/a | 120 | 151 |

### arena-kiter

Shooters that hold range and fire back: stop them shooting or lose the trade.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.3 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| hand | 8 | 0 | 0 | 8 | 2.4 | 44 |  |
| frost+pierce | 8 | 0 | 0 | 8 | 2.4 | 44 |  |
| shock+pierce | 7 | 1 | 0 | 8 | 7.2 | 90 | 14 |
| incendiary+pierce | 7 | 1 | 0 | 8 | 4.8 | 90 | 35 |
| seq pierce>frost>shock | 7 | 1 | 0 | 8 | 3.0 | 57 | 42 |
| seq pierce>frost | 7 | 1 | 0 | 8 | 2.5 | 48 | 56 |
| seq frost | 7 | 1 | 0 | 8 | 4.5 | 78 | 56 |
| seq hand fire-lead | 7 | 1 | 0 | 8 | 5.5 | 82 | 61 |
| seq pierce>shock | 7 | 1 | 0 | 8 | 5.9 | 87 | 63 |
| seq pierce>incendiary | 6 | 2 | 0 | 8 | 5.0 | 90 | 23 |
| seq pierce>incendiary>frost | 6 | 2 | 0 | 8 | 5.3 | 95 | 38 |
| seq incendiary | 6 | 2 | 0 | 8 | 5.3 | 98 | 40 |
| shock | 6 | 2 | 0 | 8 | 5.7 | 91 | 46 |
| frost | 6 | 2 | 0 | 8 | 4.1 | 81 | 53 |
| seq hand frost-lead | 6 | 2 | 0 | 8 | 3.6 | 77 | 64 |
| seq pierce>shock>incendiary | 5 | 3 | 0 | 8 | 3.7 | 87 | 25 |
| seq hand shock-lead | 5 | 3 | 0 | 8 | 6.3 | 92 | 39 |
| incendiary | 4 | 4 | 0 | 8 | 4.5 | 104 | 39 |
| none | 3 | 5 | 0 | 8 | 6.6 | 115 | 28 |
| seq none | 3 | 5 | 0 | 8 | 6.6 | 115 | 28 |
| seq shock | 3 | 5 | 0 | 8 | 5.9 | 103 | 43 |

### arena-swarm

A fast swarm: one bullet per body is too slow.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.8 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| hand | 8 | 0 | 0 | 5 | 5.0 | 39 |  |
| frost+pierce | 8 | 0 | 0 | 5 | 5.0 | 39 |  |
| seq pierce>incendiary | 8 | 0 | 0 | 7 | 3.3 | 45 |  |
| seq pierce>frost | 8 | 0 | 0 | 6 | 5.8 | 50 |  |
| incendiary+pierce | 8 | 0 | 0 | 7 | 3.8 | 53 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 7 | 4.9 | 53 |  |
| seq hand fire-lead | 8 | 0 | 0 | 7 | 5.2 | 58 |  |
| seq hand shock-lead | 8 | 0 | 0 | 7 | 4.9 | 59 |  |
| frost | 8 | 0 | 0 | 7 | 6.7 | 62 |  |
| seq incendiary | 8 | 0 | 0 | 7 | 4.2 | 65 |  |
| incendiary | 8 | 0 | 0 | 7 | 4.4 | 69 |  |
| seq hand frost-lead | 8 | 0 | 0 | 7 | 5.7 | 72 |  |
| seq pierce>shock>incendiary | 8 | 0 | 0 | 7 | 4.5 | 73 |  |
| shock+pierce | 8 | 0 | 0 | 6 | 4.9 | 77 |  |
| seq pierce>frost>shock | 8 | 0 | 0 | 7 | 5.8 | 79 |  |
| seq pierce>shock | 8 | 0 | 0 | 7 | 5.4 | 86 |  |
| seq frost | 8 | 0 | 0 | 7 | 7.1 | 90 |  |
| seq shock | 7 | 1 | 0 | 7 | 5.4 | 107 | 8 |
| shock | 7 | 1 | 0 | 7 | 5.5 | 100 | 30 |
| none | 3 | 5 | 0 | 6 | 4.9 | 111 | 19 |
| seq none | 3 | 5 | 0 | 6 | 4.9 | 111 | 19 |

### arena-cinder

Ash-dwellers: fire does 20%, bullets do 110%.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 4.7 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| hand | 8 | 0 | 0 | 3 | 4.5 | 10 |  |
| frost+pierce | 8 | 0 | 0 | 3 | 4.5 | 10 |  |
| frost | 8 | 0 | 0 | 3 | 5.1 | 10 |  |
| seq pierce>frost | 8 | 0 | 0 | 3 | 4.3 | 13 |  |
| seq frost | 8 | 0 | 0 | 3 | 5.7 | 13 |  |
| seq pierce>frost>shock | 8 | 0 | 0 | 3 | 5.9 | 21 |  |
| seq hand frost-lead | 8 | 0 | 0 | 4 | 6.4 | 37 |  |
| seq hand fire-lead | 8 | 0 | 0 | 4 | 5.1 | 47 |  |
| seq hand shock-lead | 8 | 0 | 0 | 5 | 5.8 | 51 |  |
| shock+pierce | 8 | 0 | 0 | 5 | 5.5 | 55 |  |
| shock | 8 | 0 | 0 | 6 | 6.9 | 69 |  |
| incendiary+pierce | 8 | 0 | 0 | 7 | 5.6 | 79 |  |
| seq pierce>shock | 8 | 0 | 0 | 5 | 5.8 | 79 |  |
| seq pierce>incendiary>frost | 8 | 0 | 0 | 4 | 5.9 | 85 |  |
| seq shock | 8 | 0 | 0 | 6 | 7.4 | 102 |  |
| seq pierce>incendiary | 7 | 1 | 0 | 8 | 6.6 | 86 | 21 |
| none | 4 | 4 | 0 | 5 | 6.6 | 115 | 45 |
| incendiary | 4 | 4 | 0 | 5 | 6.6 | 115 | 45 |
| seq none | 4 | 4 | 0 | 5 | 6.6 | 115 | 45 |
| seq pierce>shock>incendiary | 3 | 5 | 0 | 6 | 9.4 | 116 | 33 |
| seq incendiary | 1 | 7 | 0 | 6 | 9.3 | 117 | 27 |

### arena-boss

Mireclaw Alpha with its stock resists.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| seq hand frost-lead | 3 | 5 | 0 | 8 | 11.7 | 119 | 88 |
| seq hand shock-lead | 3 | 5 | 0 | 8 | 12.9 | 116 | 94 |
| seq hand fire-lead | 3 | 5 | 0 | 8 | 10.0 | 102 | 135 |
| seq pierce>incendiary>frost | 2 | 6 | 0 | 8 | 9.2 | 110 | 161 |
| hand | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| frost+pierce | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| seq pierce>frost>shock | 1 | 7 | 0 | 8 | 16.2 | 122 | 142 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 120 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 168 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 200 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 201 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 207 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 217 |
| shock+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 239 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 246 |
| seq pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 260 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq shock | 0 | 8 | 0 | 8 | n/a | 120 | 261 |

### arena-boss-lightning

Mireclaw Alpha weak to lightning (electrified x2).

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| seq hand frost-lead | 3 | 5 | 0 | 8 | 11.7 | 119 | 88 |
| seq hand shock-lead | 3 | 5 | 0 | 8 | 12.9 | 116 | 94 |
| seq hand fire-lead | 3 | 5 | 0 | 8 | 10.0 | 102 | 135 |
| seq pierce>incendiary>frost | 2 | 6 | 0 | 8 | 9.2 | 110 | 161 |
| hand | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| frost+pierce | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| seq pierce>frost>shock | 1 | 7 | 0 | 8 | 16.2 | 122 | 142 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 120 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 168 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 200 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 201 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 207 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 217 |
| shock+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 239 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 246 |
| seq pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 260 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq shock | 0 | 8 | 0 | 8 | n/a | 120 | 261 |

### arena-boss-wet

Mireclaw Alpha with its stock resists, standing wet.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| seq hand frost-lead | 3 | 5 | 0 | 8 | 11.7 | 119 | 88 |
| seq hand shock-lead | 3 | 5 | 0 | 8 | 12.9 | 116 | 94 |
| seq hand fire-lead | 3 | 5 | 0 | 8 | 10.0 | 102 | 135 |
| seq pierce>incendiary>frost | 2 | 6 | 0 | 8 | 9.2 | 110 | 161 |
| hand | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| frost+pierce | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| seq pierce>frost>shock | 1 | 7 | 0 | 8 | 16.2 | 122 | 142 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 120 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 168 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 200 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 201 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 207 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 217 |
| shock+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 239 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 246 |
| seq pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 260 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq shock | 0 | 8 | 0 | 8 | n/a | 120 | 261 |

### arena-boss-lightning-wet

Mireclaw Alpha weak to lightning and standing wet, so a shock chain could land.

A passive player (no fire, no movement) is downed on 8/8 seeds, after a median 5.6 s.

| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |
|---|---|---|---|---|---|---|---|
| seq hand frost-lead | 3 | 5 | 0 | 8 | 11.7 | 119 | 88 |
| seq hand shock-lead | 3 | 5 | 0 | 8 | 12.9 | 116 | 94 |
| seq hand fire-lead | 3 | 5 | 0 | 8 | 10.0 | 102 | 135 |
| seq pierce>incendiary>frost | 2 | 6 | 0 | 8 | 9.2 | 110 | 161 |
| hand | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| frost+pierce | 1 | 7 | 0 | 8 | 13.8 | 121 | 94 |
| seq pierce>frost>shock | 1 | 7 | 0 | 8 | 16.2 | 122 | 142 |
| frost | 0 | 8 | 0 | 8 | n/a | 123 | 120 |
| seq pierce>frost | 0 | 8 | 0 | 8 | n/a | 123 | 168 |
| incendiary+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 192 |
| seq pierce>shock>incendiary | 0 | 8 | 0 | 8 | n/a | 121 | 196 |
| seq frost | 0 | 8 | 0 | 8 | n/a | 123 | 200 |
| incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 201 |
| seq pierce>incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 207 |
| seq incendiary | 0 | 8 | 0 | 8 | n/a | 120 | 217 |
| shock+pierce | 0 | 8 | 0 | 8 | n/a | 120 | 239 |
| shock | 0 | 8 | 0 | 8 | n/a | 120 | 246 |
| seq pierce>shock | 0 | 8 | 0 | 8 | n/a | 120 | 260 |
| none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq none | 0 | 8 | 0 | 8 | n/a | 120 | 261 |
| seq shock | 0 | 8 | 0 | 8 | n/a | 120 | 261 |

### arena-boss vs arena-boss-lightning

| build | arena-boss | arena-boss-lightning | seeds with an identical hp trace |
|---|---|---|---|
| none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| hand | 1/8 won, 13.8 s, 121 dmg | 1/8 won, 13.8 s, 121 dmg | 8/8 |
| shock+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| incendiary+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost+pierce | 1/8 won, 13.8 s, 121 dmg | 1/8 won, 13.8 s, 121 dmg | 8/8 |
| seq none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>incendiary>frost | 2/8 won, 9.2 s, 110 dmg | 2/8 won, 9.2 s, 110 dmg | 8/8 |
| seq pierce>shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 8/8 |
| seq pierce>frost>shock | 1/8 won, 16.2 s, 122 dmg | 1/8 won, 16.2 s, 122 dmg | 8/8 |
| seq hand shock-lead | 3/8 won, 12.9 s, 116 dmg | 3/8 won, 12.9 s, 116 dmg | 8/8 |
| seq hand fire-lead | 3/8 won, 10.0 s, 102 dmg | 3/8 won, 10.0 s, 102 dmg | 8/8 |
| seq hand frost-lead | 3/8 won, 11.7 s, 119 dmg | 3/8 won, 11.7 s, 119 dmg | 8/8 |

### arena-boss-wet vs arena-boss-lightning-wet

| build | arena-boss-wet | arena-boss-lightning-wet | seeds with an identical hp trace |
|---|---|---|---|
| none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| hand | 1/8 won, 13.8 s, 121 dmg | 1/8 won, 13.8 s, 121 dmg | 8/8 |
| shock+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| incendiary+pierce | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| frost+pierce | 1/8 won, 13.8 s, 121 dmg | 1/8 won, 13.8 s, 121 dmg | 8/8 |
| seq none | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>shock | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>incendiary | 0/8 won, n/a s, 120 dmg | 0/8 won, n/a s, 120 dmg | 8/8 |
| seq pierce>frost | 0/8 won, n/a s, 123 dmg | 0/8 won, n/a s, 123 dmg | 8/8 |
| seq pierce>incendiary>frost | 2/8 won, 9.2 s, 110 dmg | 2/8 won, 9.2 s, 110 dmg | 8/8 |
| seq pierce>shock>incendiary | 0/8 won, n/a s, 121 dmg | 0/8 won, n/a s, 121 dmg | 8/8 |
| seq pierce>frost>shock | 1/8 won, 16.2 s, 122 dmg | 1/8 won, 16.2 s, 122 dmg | 8/8 |
| seq hand shock-lead | 3/8 won, 12.9 s, 116 dmg | 3/8 won, 12.9 s, 116 dmg | 8/8 |
| seq hand fire-lead | 3/8 won, 10.0 s, 102 dmg | 3/8 won, 10.0 s, 102 dmg | 8/8 |
| seq hand frost-lead | 3/8 won, 11.7 s, 119 dmg | 3/8 won, 11.7 s, 119 dmg | 8/8 |

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
| 9 | yes | 2.4 | 6 | 7.6 | 70 | 210 |
| 9 | no | 1.9 | 11 | 7.4 | 84 | 0 |
| 10 | yes | 2.9 | 9 | 7.5 | 84 | 210 |
| 10 | no | 2.4 | 9 | 7.7 | 112 | 0 |
| 11 | yes | 3.2 | 5 | 7.7 | 42 | 182 |
| 11 | no | 2.9 | 9 | 7.5 | 84 | 0 |
| 12 | yes | never | 0 | 8.2 | 0 | 42 |
| 12 | no | never | 0 | 8.2 | 0 | 0 |

<!-- census:end -->
