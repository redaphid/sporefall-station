# PLAYBOOK: Prototype B, "One Wand, Made Deep" (wand reactions)

This branch is a thin, playable slice of loadout design B. There is one gun. Its
mods are an ordered wand, and each mod is one **chip**. Statuses stay on enemies,
and the next element that lands on them **reacts** with the status already there.
The order of your chips decides which reactions happen. You can **eject** a chip
onto the floor, and a dropped element chip can be **shot to burst** over everyone
near it.

Everything is behind the `wandReactions` flag, which is off by default. With it
off, every run plays exactly as on `main`.

## Start

```sh
pt() { npx tsx scripts/playtest.mts "$@"; }   # from the repo root; zsh does not word-split $VAR
pt run.json new --seed 101 --wandReactions                          # a real floor-1 run with the rule on
pt run.json new --seed 18 --scenario wand-lab --wandReactions       # the showcase (see Scenarios)
pt run.json new --seed 18 --scenario wand-boss --wandReactions      # the lightning-weak boss
```

`--wandReactions` is required for plain runs. The two `wand-*` scenarios switch
the rule on by themselves, so the flag is optional there. A mistyped option is
rejected, so a typo cannot silently give you a default-rules run. Check that
`look` says `"modCasting":"reactive"`.

For the protocol's S1 hand, this prototype's equivalent is the four protocol
chips plus the one new element. Each `addMod` adds one chip at the end of the
wand:

```sh
for m in shock incendiary frost pierce soak; do pt run.json addMod <playerId> $m; done
```

In the app, the same switch is **Settings, Wand reactions (prototype B)**. It
applies to the next run you start.

## How the wand fires

This is the existing sequenced-mods rule. Only the reactions are new.

- The pistol has **4 live slots**. Entries 0 to 3 of the list fire. Entries after
  that are the **pocket**, and they do not fire. The wand holds at most
  **6 chips** (4 slots plus a pocket of 2).
- An **element chip** (Soak, Cryo, Incendiary, Tesla) ends a cast. Each trigger
  pull fires the next cast, and every chip before the element rides on it. For
  example, `[heavy][shock]` is one Heavy Tesla round.
- A chip after the last element fires as a **bare** round, with no element.
- When the wand runs off its end it **wraps** and recharges for **20 ticks**.
- One chip is one entry. `[soak][shock][soak]` is legal. Each mod caps its copies
  per wand: Soak 3; Tesla, Cryo and Incendiary 1 each; the others 2 to 5.

## New player actions (InputCmd fields, playable through `step`)

Both actions use the existing `InputCmd.modSwap` field, packed as `(a << 8) | b`.
The `step` verb accepts friendlier sugar for them. Each one fires on the **first
tick of the step only**, and a step may carry only one of them.

| Action | `step` JSON | What the sim does |
|---|---|---|
| Reorder | `{"swap":[a,b]}` (or raw `{"modSwap":a*256+b}`) | Swaps list entries `a` and `b`. A pocket chip can be swapped into a live slot. Reordering does not reset the cast position or the recharge. |
| Eject | `{"eject":i}` (or raw `{"modSwap":i*257}`) | Removes entry `i` and drops it at your feet as a chip on the floor. |

You can combine either action with movement or fire in the same step, for example
`{"eject":4,"moveX":-1}`. Indices are the numbers `look` prints in
`player.wand.entries`.

Examples:

```sh
pt run.json step 1 '{"swap":[0,4]}'                    # pocket chip 4 into slot 0
pt run.json step 1 '{"eject":3}'                       # drop chip 3 on the floor
pt run.json step 30 '{"eject":4,"moveX":-1}'           # drop a chip and walk off it
pt run.json step 45 '{"aimAt":726,"attack":true}'      # fire at an entity
pt run.json step 10 '{"aimAt":733,"attack":true}'      # shoot a dropped chip (aim at its id)
```

## The reaction table

The **primer** is the status already on the body. The **incoming** half is what
your round carries. If a body has several statuses, the primer is the first of
frozen, wet, burning, electrified.

| Primer \ incoming | Soak (wet) | Cryo (frozen) | Incendiary (burning) | Tesla (electrified) | Bare round |
|---|---|---|---|---|---|
| none | soak | freeze | ignite | zap and stun | hit |
| **wet** | refresh | freeze (stays wet) | **FIZZLE**: no fire, and the water boils off | **ZAP CHAIN**: 20 damage to every wet body connected within 1.6 tiles, scaled by `resist.electrified` | hit |
| **frozen** | *numb* (nothing lands) | *numb* | **THERMAL CRACK**: the ice breaks, 30 damage, and the body is left **wet** | *numb* | **SHATTER**: 5x the blow |
| burning | wet as well | freeze | refresh | zap | hit |
| electrified | wet | *numb* | ignite | zap | hit |

Rules that follow from the table:

- **Only a bare round shatters ice.** An element round that hits ice reacts
  (Incendiary cracks it) or is numbed. It does not shatter.
- **Chain damage reads `resist.electrified`**, so "weak to lightning" is a real
  number. An immune body (`0`) takes no damage but still passes the chain on.
- An **explosive** round's blast carries its element to every body it catches.
  `[explosive][soak]` soaks a pack.
- A wet cluster is chained **once per tick**. One round can never flood the same
  pack more than once.
- A body that the impact kills does not react.

## Chips on the floor

- **Eject** drops the chip at your feet. It **arms after 30 ticks**, and `look`
  shows `"chip":"arming"`, then `"armed"`.
- **Crack**: any projectile that touches an **armed element chip** destroys it and
  bursts its element over every body within **2 tiles**, through the reaction
  table. That includes enemy rounds. A Soak chip wets a pack, and a Tesla chip on
  a wet pack chains through it. Cryo and Incendiary chips work the same way.
  Stat and behaviour chips (Heavy, Pierce, and so on) never crack, and neither
  does floor loot.
- **Your own rounds crack your chips too.** A chip lying in your firing line
  bursts when your next shot passes over it, once it is armed. The exception is
  a chip within 1 tile of you, which your rounds pass over.
- **Pick up** by walking over a chip. It goes at the **end** of your wand. If the
  wand is full (6 chips) or already holds the copy cap for that mod, the chip
  stays on the floor. Your own ejected chip ignores you until you have stepped
  off it once.
- Nothing creates a chip. Eject moves one out of the wand, picking it up moves it
  back, and cracking destroys it.
- **Ejecting the not-yet-fired tail starts the recharge.** It is not a free
  reload. Ejecting a chip that already fired keeps the same next chip next.

## Boss: Mireclaw Alpha, and "weak to lightning"

In a reactive run the Mireclaw has a **hide**. While it is above half health it
keeps itself **wet** (`look` shows `fx: ["wet"]`), and its resist includes
`"electrified": 1.6`. So:

- Tesla rounds into it **chain**, for 1.6x chain damage, and also through any wet
  brood beside it.
- Incendiary rounds **fizzle** off it until it dries at half health.

Nothing on screen tells you this before the fight. You find it out from `look`
(the `wet` status and the resist table) and from the step reply (`reaction:fizzle`).
To stage the protocol's S2 in a plain run, `spawn npc boss X Y` in a
`--wandReactions` run already gives the hide and the weakness. You can still
`set <id> {"resist":{"electrified":2}}` to follow the protocol exactly.

## Reading the replies

- `step` counts reactions by name: `reaction:chain`, `reaction:fizzle`,
  `reaction:thermalCrack`, `reaction:shatter`, `reaction:numb`. It also counts
  `chipEject`, `chipBurst:<mod>`, and `shock` (one per body the chain damaged).
- `look` gives:
  - `player.wand.entries`: the index to pass to `swap` and `eject`, and which
    chips sit in the pocket.
  - `nextPull`: what your next trigger pull fires.
  - `wrapsAfterNextPull` and `rechargeLeft`.
  - `fxLeft` on every body: the ticks left on each status. Wet lasts 150 ticks,
    Cryo 120, Tesla's stun 30 to 45, and fire 240.
  - `chip` on dropped chips.

## Scenarios

- **`wand-lab`** (the showcase, floor 3 by default, `--floor N` changes it).
  - Your pistol wand is `[frost][incendiary][shock][heavy]`, with **Soak** in the
    pocket. As loaded, the Tesla round is wasted and the fire does nothing
    special.
  - A spare Soak chip lies 2 tiles away.
  - A **drowner tide** of 4 arrives in sight about 7 tiles away. They hold range
    and shoot pistols, in two tight pairs.
  - You have 240 HP and you are not invulnerable.
- **`wand-boss`**: the same wand, with a Mireclaw Alpha (416 HP on floor 3)
  standing in sight 8 tiles away. It summons sporeling brood.

## What to try

1. In `wand-lab`, fire the wand as loaded. Then reorder it until a Tesla round
   lands on something wet. Watch for `reaction:chain`.
2. Find the **trap**: Soak before Incendiary fizzles. Then find the order that
   turns it around (Incendiary before Soak does not fizzle).
3. Find Cryo, Incendiary, Tesla: the crack leaves meltwater, and the next Tesla
   round chains off it.
4. Make an area primer. Drop a Soak chip where the pack will be, or in the middle
   of it, and shoot it once it is armed. Then chain the whole pack.
5. Against the boss, compare the wand as loaded with a wand you rebuilt for "wet
   and weak to lightning". Ejecting chips that do nothing against it is a legal
   move.
6. Try to break it. Look for eject and re-pick loops, recharge skipping,
   stun-locking the boss, a single order that wins everywhere, or chips your own
   fire keeps cracking.

## Smoke tests (run on this branch, seed 18)

Showcase burst: reorder so Soak comes before Tesla, walk closer, then fire.

```text
$ pt lab.json new --seed 18 --scenario wand-lab --wandReactions
{"tick":0,...,"modCasting":"reactive","player":{"id":261,...,"hp":"240/240",
 "wand":{"entries":["0:frost","1:incendiary","2:shock","3:heavy","4:soak (pocket)"],
 "slots":4,"capacity":6,"nextPull":["frost"],...}},"near":[{"id":728,"kind":"pickup",
 "archetype":"mod.soak","dist":2,...}, ... {"id":726,"archetype":"drowner","dist":7,"hp":"49/49",...}, ...]}
$ pt lab.json step 1 '{"swap":[0,4]}'
{"tick":1,"advanced":1,"player":261,"events":{"aiGoal":4}}
$ pt lab.json step 1 '{"swap":[1,2]}'
{"tick":2,"advanced":1,"player":261,"events":{}}
$ pt lab.json step 20 '{"moveX":1}'
{"tick":22,"advanced":20,"player":261,"events":{"modPickup":1}}
$ pt lab.json step 45 '{"aimAt":726,"attack":true}'
{"tick":67,"advanced":45,"player":261,"aimAtGone":true,"events":{"hit":3,"aiGoal":3,"reaction:chain":1,"shock":1,"death":1}}
$ pt lab.json look 6
... "wand":{"entries":["0:soak","1:shock","2:incendiary","3:heavy","4:frost (pocket)","5:soak (pocket)"],
 "nextPull":["heavy"],"wrapsAfterNextPull":true, ...}
```

In that burst, the Soak round wets drowner 726 and the Tesla round chains it. The
Incendiary round kills it, so no fizzle is reported. Walking east picked up the
spare Soak, which went to the end of the wand. The chain hit only one body,
because only that body was wet. Wetting the pair takes an area primer.

Lightning-weak boss burst: Tesla first.

```text
$ pt boss.json new --seed 18 --scenario wand-boss --wandReactions
... {"id":724,"archetype":"boss","dist":8,"hp":"416/416","resist":{"physical":0.75,"burning":1.25,
 "poisoned":0.5,"spore":0,"electrified":1.6},"mode":"idle",...}
$ pt boss.json step 1 '{"swap":[0,2]}'
{"tick":1,"advanced":1,"player":261,"events":{"aiGoal":2,"bossReveal":1}}
$ pt boss.json step 90 '{"aimAt":724,"attack":true,"moveX":-0.5}'
{"tick":91,"advanced":90,"player":261,"events":{"aiGoal":4,"hit":7,"reaction:chain":2,"shock":2,"death":1,"doorToggle":1}}
$ pt boss.json look 12
... "wand":{"entries":["0:shock","1:incendiary","2:frost","3:heavy","4:soak (pocket)"],...}
... {"id":724,"archetype":"boss","dist":4.2,"hp":"316/416","fx":["wet","electrified"],
 "fxLeft":{"wet":30,"electrified":6},"resist":{...,"electrified":1.6},"mode":"aggro",...}
```

For comparison, the same 90 ticks with the wand as loaded (no swap) took the boss
to 326/416. That burst had one `reaction:shatter` from the bare Heavy round, and
the brood soaked up two rounds. The preparation delta is yours to measure.

## Not in this slice

Twin, Trail and Relay form chips. Steam, Wildfire and Flash Freeze. The Dossier,
the Bench and the Reagent Hand. The co-op status byte on the wire. Pad and touch
controls for eject: in the app, the HUD strip only swaps, so eject is headless
and `step` only for now. On-screen reaction pops and fizzle words. An e2e video.
Melee still uses the old shatter-on-any-impact rule.
