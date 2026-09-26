# PLAYBOOK: Prototype A, Primer and Striker

Design doc: loadout design A, "Primer and Striker" (the owner's two-gun idea).
This build is a thin slice of it, off by default behind a run rule.

## What changes with the rule on

You carry **two guns**, and both fire from their own trigger.

- **Striker**: your normal gun (a pistol), fired by `attack`. It does the damage.
  Its element mod decides the **verb** each shot lands.
- **Primer**: the **Lobber**, fired by `prime`. It does **no damage**. It lobs a glob
  that bursts on the first body it touches (or at 9 tiles, or on a wall) and
  **coats** every enemy in its splash with a **substance**.

The same mod means different things in each gun:

| Mod | In the Primer (substance it coats) | In the Striker (verb it lands) |
|---|---|---|
| `soak` (Soaker, new) | SOAK: wet | WASH: wets what it hits, puts out fire, extra shove |
| `incendiary` | OIL | FLAME: burning |
| `frost` | RIME: slows the body 40% | FROST: frozen |
| `shock` | MAGNET: coated bodies drift into one clump (about 2 tiles/s) | SPARK: electrified, plus a 6 jolt |
| anything else | changes the glob (`explosive` widens the splash from 0.9 to 2.5, `pierce` passes through bodies, and so on) | as today |

A Striker verb meeting a coat **reacts**. Every reaction uses up the coat.

| Verb on | SOAK (wet) | OIL | RIME | MAGNET |
|---|---|---|---|---|
| SPARK | **ARC**: 30 to every connected wet body | **IGNITE**: wildfire | nothing extra | **HOP**: 60% to every magnetised body within 4 tiles |
| FLAME | **STEAM**: no burn; the enemy is blinded 3 s | **WILDFIRE**: burns and bursts every connected oiled body | **MELT**: rime turns into wet | HOP |
| FROST | **FLASH FREEZE**: every connected wet body freezes | **FIZZLE**: nothing happens, and the oil stays | **DEEP FREEZE**: full-length freeze | HOP |
| plain round (IMPACT) | nothing | nothing | **CRACK**: 2x damage, and armour is ignored | nothing |

"Connected" means within 1.6 tiles of another coated body. A flood reaches at
most 6 bodies, and each hop past the first deals 85%. A frozen body still
shatters for 5x on the next impact (existing rule).

**Weak to lightning is real.** Every Spark source (the 6 jolt, the 30 arc, and
the 60% hop) is multiplied by the target's `resist.electrified`. `look` shows
`resist`.

Players are never coated, so there is no friendly fire through a teammate.

## Start

```sh
pt() { npx tsx scripts/playtest.mts "$@"; }
pt s.json new --seed 101 --primerStriker                        # a real floor 1, both guns
pt s.json new --seed 7 --scenario primer --primerStriker        # the showcase
pt s.json new --seed 202 --scenario primer-boss --primerStriker # the lightning-weak boss
```

`--primerStriker` switches the rule on exactly as the app's flag does (it also
turns on sequenced mods). On a plain `new` you start with a pistol Striker with
no mods and a Lobber Primer holding one `soak`. The two scenarios switch the rule
on by themselves, but pass the flag anyway.

## Reading your guns: `look`

`look` adds `striker` and `primer` to `player`:

```json
"striker":{"weapon":"pistol","slots":4,"ready":true,"mods":["0:pierce","1:shock","2:heavy"],"cycle":["SPARK +pierce","IMPACT +heavy"],"next":0},
"primer":{"weapon":"primerLobber","slots":3,"ready":true,"mods":["16:explosive","17:soak"],"cycle":["SOAK splash 2.5 +explosive"],"next":0}
```

- `mods`: each mod with its **swap index**. The Striker uses 0 to 15 and the
  Primer uses 16 to 31. `(stowed)` marks a mod past the gun's `slots`, which
  does not fire.
- `cycle`: what each trigger pull actually fires, in order. Each gun is a
  sequenced wand. Modifiers ride on the next element mod, and an element mod
  ends a cast. When a gun reaches the end of its cycle it wraps and
  **recharges** (Striker pistol 20 ticks, Lobber 40 ticks). `ready:false`
  means it is recharging.
- `next`: the cast your next pull fires.
- Each nearby body's `fx` shows its coats: `wet`, `oiled`, `rimed`,
  `magnetised`, `steamed`, and elements such as `burning`. `asleep: true` marks
  a sleeping body.

## New player actions (all are `InputCmd` fields; all work in `step`)

| `step` field | InputCmd | Kind | What it does |
|---|---|---|---|
| `"prime": true` | `prime` | held | Fires the Primer on its own clock. Hold it together with `attack` to fire both guns. |
| `"swap": [a, b]` | `modSwap` | first tick only | Swaps two mods by swap index. Within one gun this is a free reorder. **Across guns** it swaps them, and both guns start recharging. An index past the end of a list **moves** the mod there, for example `[3, 20]` moves Striker mod 3 into the Primer. |
| `"eject": i` | `modSwap` = `(i, 255)` | first tick only | Pops mod `i` out as a cartridge 1 tile ahead of you. You cannot re-grab your own cartridge for 45 ticks; a teammate can grab it at once. |
| `"modSwap": n` | `modSwap` | first tick only | The raw packed form `(a << 8) \| b` (255 = floor). Use at most one of `modSwap`, `swap`, `eject` per step. |

Walking over a mod cartridge puts it in the **Primer** if the Primer has a free
slot, otherwise in the **Striker**. Then move it with `swap`.

Examples:

```sh
pt s.json step 20 '{"aimAt":222,"prime":true}'                # lob a glob at 222 (it lands within the burst)
pt s.json step 25 '{"aimAt":222,"attack":true}'               # fire the Striker
pt s.json step 30 '{"aimAt":269,"attack":true,"prime":true,"moveX":-1}'  # both triggers while backing off
pt s.json step 1 '{"swap":[17,18]}'                           # reorder inside the Primer
pt s.json step 1 '{"swap":[1,16]}'                            # Striker mod 1 <-> Primer mod 16 (both recharge)
pt s.json step 1 '{"swap":[0,19]}'                            # move Striker mod 0 to the end of the Primer
pt s.json step 1 '{"eject":2}'                                # drop Striker mod 2 on the floor
```

The `step` reply counts reactions by name, and `reached` sums the bodies each
one touched. Use it to see whether an arc chained:

```json
{"tick":45,"advanced":25,"player":219,"aimAtGone":true,"events":{"hit":7,"death":2,"reaction:arc":1},"reached":{"arc":4}}
```

Globs and rounds take time to fly (a glob moves at 10 tiles/s, a pistol round
at 14). A burst shorter than the flight time ends before the hit, and the hit
lands in the next step.

Staging (only to set up a fight, never to win it): `addMod <playerId> <mod>` puts
a mod in the **Striker**. To build the protocol's hand of four, run
`addMod <id> shock`, `addMod <id> incendiary`, `addMod <id> frost` and
`addMod <id> pierce`. The Primer already holds `soak`. Then arrange the mods
with `swap`, which is the player action.

## Scenarios

- **`primer`** (showcase, seed 7). This is an open hall. You hold a Striker
  `[pierce][shock][heavy]` and a Primer `[explosive][soak]`. Two groups of
  thugs are asleep, so their spacing holds until you hurt them:
  - a **tight pack** of 4 (ids 220 to 223, 1 tile apart) to the north-east.
    One soak and one spark chain through all four.
  - a **spread pack** of 5 (centre 224, the other four 2.2 tiles out) to the
    east. The soak splash coats all five, but the arc cannot jump 2.2 tiles,
    so it reaches one.
  - a **Magnet cartridge** (`shock`) on the floor, 2 tiles north of you.
  The puzzle: make the spread pack chain.
- **`primer-boss`** (seed 202). The Mireclaw Alpha (id 269, 320 hp) starts
  8 tiles east with `resist.electrified: 2`, which makes it weak to lightning.
  You hold the hand of four in the Striker, in an order not built for this
  fight: `[incendiary][pierce][frost][shock]`. The Primer holds `[soak]`.

## What to try

1. In the showcase, soak and spark the tight pack. Then do the same to the
   spread pack and watch `reached.arc` stay at 1.
2. Pick up the Magnet. It goes into the Primer. Reorder it so `cycle` reads
   `MAGNET splash 2.5 +explosive`, `SOAK splash 0.9`. Magnetise the spread
   pack, wait about 1.5 s, soak the clump, then spark it.
3. Put `frost` in the Striker instead of `shock`: water also carries cold
   (FLASH FREEZE), and a follow-up `heavy` round shatters the frozen bodies.
4. Try the traps: FLAME on a wet body (steam, no burn) and FROST on oil (fizzle).
5. A brute has `physical: 0.35`. Put `frost` in the Primer (RIME) and hit the
   brute with a plain Striker round (CRACK, armour ignored).
6. Before the boss, rebuild. Look for a loop that eject and re-pick makes free,
   and for a build that wins everything.

## Smoke runs (made with this build)

Showcase, from `new`: the tight pack, then the Magnet aha on the spread pack.

```
$ pt sm.json new --seed 7 --scenario primer --primerStriker
{"striker":{"mods":["0:pierce","1:shock","2:heavy"],"cycle":["SPARK +pierce","IMPACT +heavy"],"next":0},"primer":{"mods":["16:explosive","17:soak"],"cycle":["SOAK splash 2.5 +explosive"],"next":0}}   (trimmed)
$ pt sm.json step 20 {"aimAt":222,"prime":true}
{"tick":20,"advanced":20,"player":219,"events":{"reaction:coat.soak":1},"reached":{"coat.soak":4}}
$ pt sm.json step 25 {"aimAt":222,"attack":true}
{"tick":45,"advanced":25,"player":219,"aimAtGone":true,"events":{"hit":7,"death":2,"reaction:arc":1},"reached":{"arc":4}}
$ pt sm.json step 20 {"moveY":-1}
{"tick":65,"advanced":20,"player":219,"events":{"modPickup":1,"hit":1}}
$ pt sm.json step 20 {"moveY":1}
{"tick":85,"advanced":20,"player":219,"events":{}}
$ pt sm.json step 1 {"swap":[17,18]}
{"tick":86,"advanced":1,"player":219,"events":{}}
$ pt sm.json look 1        (primer only)
{"mods":["16:explosive","17:shock","18:soak"],"cycle":["MAGNET splash 2.5 +explosive","SOAK splash 0.9"],"next":0}
$ pt sm.json step 12 {"aimAt":224,"prime":true}
{"tick":98,"advanced":12,"player":219,"events":{}}
$ pt sm.json step 48 {"aimAt":224}
{"tick":146,"advanced":48,"player":219,"events":{"reaction:coat.magnet":1},"reached":{"coat.magnet":4}}
$ pt sm.json look 12       (npcs only: four magnetised bodies pulled into one clump)
224 (33.4,21.5) 225 (33.9,21.0) 226 (33.7,22.1) 228 (34.3,21.8), all "magnetised"
$ pt sm.json step 12 {"aimAt":224,"prime":true}
{"tick":158,"advanced":12,"player":219,"events":{}}
$ pt sm.json step 30 {"aimAt":224,"attack":true}
{"tick":188,"advanced":30,"player":219,"aimAtGone":true,"events":{"reaction:coat.soak":1,"hit":10,"death":3,"reaction:arc":1,"reaction:magnetHop":1},"reached":{"coat.soak":3,"arc":3,"magnetHop":3}}
```

(The Spark arced through the 3 wet bodies and also hopped through the 3 still
magnetised, killing 3 of the 4 in the clump.)

Control, the same spread pack without the Magnet: the soak coats all 5 and the arc reaches 1.

```
$ pt c.json new --seed 7 --scenario primer --primerStriker
$ pt c.json step 30 {"aimAt":224,"prime":true}
{"tick":30,"advanced":30,"player":219,"events":{"reaction:coat.soak":1},"reached":{"coat.soak":5}}
$ pt c.json step 30 {"aimAt":224,"attack":true}
{"tick":60,"advanced":30,"player":219,"aimAtGone":true,"events":{"hit":3,"death":1,"reaction:arc":1},"reached":{"arc":1}}
```

Lightning-weak boss, seed 202. Each run stands still and holds the triggers in
30-tick bursts, with a `look` after each burst. This is a crude, fixed script,
not play.

```
$ pt b.json new --seed 202 --scenario primer-boss --primerStriker
striker cycle ["FLAME","FROST +pierce","SPARK"], primer ["SOAK splash 0.9"], boss 269 320/320 resist {..,"electrified":2}

# As dealt, Striker only:            '{"aimAt":269,"attack":true}'
270 player 30/120 boss DEAD
# As dealt, both triggers:           '{"aimAt":269,"attack":true,"prime":true}'
30  {"reached":{"coat.soak":1,"flashFreeze":1}} ... 60 {"reached":{"coat.soak":1,"steam":1}} ...
210 player 90/120 boss DEAD          {"reached":{"coat.soak":2,"arc":2}}
# Prepared for lightning: step 1 {"swap":[0,3]}; step 1 {"eject":2}; step 1 {"eject":2}
#   -> striker ["SPARK","IMPACT +pierce"], primer ["SOAK splash 0.9"]; then both triggers:
93  boss 192/320 {"reached":{"arc":1}}   (one wet arc on a weak boss: 94 hp)
213 player 80/120 boss DEAD
# The same prepared build, but the boss set neutral:  set 269 {"resist":{"electrified":1}}
93  boss 234/320 {"reached":{"arc":1}}   (the same arc: 58 hp)
243 player 0/120 downed, boss 49/320
```

What the boss runs say, stated plainly:

- The weakness matters. The same all-Spark build kills the weak boss at tick
  213 with 80 hp left, and loses to a neutral boss (downed, boss at 49/320).
- Using the Primer at all matters more than tailoring for lightning. The
  as-dealt wand with both triggers (tick 210, 90 hp left) did as well as the
  lightning build, because it already holds `shock` and `frost`. FLASH FREEZE
  plus the existing 5x shatter carries it. This is the first thing S2 should
  probe.

## Not in this slice

The bench UI, a pad button for the Primer (keyboard `I` only, solo only), toss,
the pocket, the Specimen Tank and dossier, the boss's soaked cloud, ground
puddles and cartridge leaks, and the co-op wire (the `prime` input and coat
statuses do not cross the network yet). There is no e2e video yet.
