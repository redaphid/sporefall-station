# PLAYBOOK: Prototype C, essence bubbles

Design: loadout design C, "essences are things in the world" (`design-C.md`, §11
is the slice built here). This file is everything a playtester needs besides the
protocol.

## The idea in three lines

- Your gun is a **rack** of mods that fire in order (sequenced mods).
- You can **vent** any mod out of the rack. It hangs in the air where you stand
  as a glowing **bubble**.
- A bullet from any player that flies through a bubble picks up that mod (a
  **lens**). An enemy that walks into a lightning, ice or fire bubble sets it off
  (a **mine**). Walk up to a bubble and press interact to take it back.

## Start

```sh
pt() { npx tsx scripts/playtest.mts "$@"; }
pt s.json new --seed 101 --essenceBubbles                      # a real floor 1 with the prototype on
pt s.json new --seed 7 --scenario lens --essenceBubbles         # the showcase
pt s.json new --seed 7 --scenario lens-coop --essenceBubbles    # two divers, the co-op "aha"
pt s.json new --seed 7 --scenario lens-boss --essenceBubbles    # the lightning-weak boss
```

`--essenceBubbles` also turns on `--sequenced`: the prototype needs a rack. The
three `lens*` scenarios switch both rules on themselves, so they also work
without the flag. In the app the flag is **Settings > Essence bubbles
(prototype)**, together with **Sequenced mods**, and applies to the next run.

## Your new inputs (all through `step`)

| `step` field | What it does | Example |
|---|---|---|
| `"vent": i` | Pop rack entry `i` (a `rack.entries[].i` from `look`) out as a bubble at your feet. First tick of the step only. | `pt s.json step 1 '{"vent":3}'` |
| `"vent": "next"` | Vent the chamber that fires next (the one `look` marks `next`). The keyboard's **V** key sends this. | `pt s.json step 1 '{"vent":"next"}'` |
| `"still": n` | The raw `InputCmd.still` field: `(op << 8) \| index`, op 1 = plant. `"vent"` is the friendly form. | `pt s.json step 1 '{"still":259}'` (plant entry 3) |
| `"interact": true` | Next to a bubble (within 1.3 tiles), catch it back into the **end** of your rack. Anyone can catch anyone's bubble. | `pt s.json step 1 '{"interact":true}'` |
| `"modSwap": n` | (Existing) swap rack entries `a` and `b`, packed `(a << 8) \| b`. | `pt s.json step 1 '{"modSwap":258}'` (swap 1 and 2) |
| `"player": N` | Act as diver N (co-op). | `pt s.json step 12 '{"player":1,"moveX":1}'` |

`look [radius] [playerId]` now shows, under `player.rack`, every entry with
`i`, `live` (fires) or not (stowed), `next` (fires on the next pull), and
`charges` if it is a part-used lens you caught back; plus `rechargeLeft`. Every
bubble in `near` shows `bubble: {mod, charges, ttl, by}`. `look 12 1` looks
through diver 1.

New `step` event counts: `bubblePlant`, `bubbleCatch`, `bubblePop` (spent,
expired, capped or burst), `lens` (a round picked up a bubble), `conductor` (an
arc shattered frozen ice).

## The rules

| Rule | Detail |
|---|---|
| Rack | Sequenced mods: each cast takes modifiers up to the next element (frost, incendiary, shock), which ends the cast. Entries past the gun's slots are stowed (pistol 4 slots, 1 cast per pull; shotgun 4 slots, 2 casts). Running off the end reloads (recharge). |
| Vent | Venting a **live** entry costs the reload (pistol 20 ticks, shotgun 30) and restarts the rack at the first chamber. Venting a **stowed** entry is free. |
| Cap | Two planted bubbles per diver. A third pops your oldest. |
| Expiry | A bubble pops 600 ticks (20 s) after it was planted. Bubbles do not survive the stairs. |
| Lens | A player's round that crosses a bubble gets its mod: one extra mod per round, one charge per round. Charges: 6 for one stack, 9 for two or more. A round that already carries that element passes through for free. A shotgun can drain a lens in one pull. Enemy rounds are never lensed. |
| Two elements | A lens is the **only** way to put two elements on one round. Cold always lands first. |
| Mine | An enemy touching a **Storm** (shock), **Cold** (frost) or **Flame** (incendiary) bubble bursts it: zap, freeze, or fire on everything within 1.5 tiles, **you included**. Any other bubble is a lens only; enemies walk through it. Players never set mines off. |
| Conductor | Lightning now runs through **frozen** bodies the way it runs through wet ones, and a zap on frozen ice **shatters** it: 20 × 5 = 100 damage per frozen body in the chain. A zap on a dry, unfrozen body only stuns. |
| Weak to lightning | Zap damage is multiplied by the target's `resist.electrified`. A boss at 2 takes 200 per Conductor shatter, and 40 per wet arc. It still takes **nothing** extra from a plain shock round on a dry body, so the weakness only pays if you set it up. |

## Scenarios

- **`lens`** (showcase). Floor 3. Shotgun racked `[frost][choke][shock][bulk]`,
  a Storm bubble already planted 2 tiles east, six Derelict Units (armour 0.4, so
  plain pellets ping off) 6 to 8 tiles east, charging. Shoot the frost cast
  through the violet bubble.
- **`lens-coop`**. Diver 0: shotgun `[bulk][frost][choke][frost]`, no storm.
  Diver 1 (one tile south): pistol `[heavy][shock]`, no frost. Same six robots.
  Neither diver can make Conductor alone. Drive diver 1 with `"player":1`.
- **`lens-boss`**. Floor 3. Mireclaw Alpha (416 hp here, physical 0.75) 10 tiles
  east with `resist.electrified: 2`. Pistol `[heavy][frost][pierce][shock]`,
  `split` stowed. It summons sporelings on sight.

All three give the diver 240 hp.

## Smoke test transcripts (run on this branch)

**One burst in the showcase.** The first pull fires `[frost]` (3 pellets) and
`[choke][shock]` (2 pellets). The 3 frost pellets cross the Storm bubble:

```
$ pt A.json new --seed 7 --scenario lens --essenceBubbles
{"tick":0,"floor":3,...,"essences":"bubbles","player":{"id":219,...,"weapon":"shotgun","rack":{"slots":4,"castsPerTrigger":2,"rechargeLeft":0,"entries":[{"i":0,"mod":"frost","live":true,"next":true},...
$ pt A.json step 20 '{"aimAt":599,"attack":true}'
{"tick":20,"advanced":20,"player":219,"aimAtGone":true,"events":{"aiGoal":4,"lens":3,"hit":3,"shock":2,"conductor":2,"shatter":2,"death":2}}
$ pt A.json look 10     (trimmed to bubbles and robots)
near: mod.shock bubble {charges:3, ttl:580}; robot 600 91/91 aggro; robot 602 88/91 [electrified];
      robot 598 91/91; robot 601 91/91          (robots 599 and 597 shattered)
```

**One lightning-weak boss burst.** Vent the frost (entry 1) as a mine, back off
3 tiles so the burst does not freeze you, then fire the rack (`[heavy][pierce][shock]`
is now one cast) through the Cold bubble at the boss:

```
$ pt B.json new --seed 7 --scenario lens-boss --essenceBubbles
boss 596 at 10 tiles, 416/416, resist {"physical":0.75,...,"electrified":2}
$ pt B.json step 1 '{"vent":1}'
{"tick":1,"advanced":1,"player":219,"events":{"aiGoal":2,"bubblePlant":1,"bossReveal":1}}
$ pt B.json step 20 '{"moveX":-1}'
{"tick":21,"advanced":20,"player":219,"events":{"aiGoal":3}}
$ pt B.json step 45 '{"aimAt":596,"attack":true}'
{"tick":66,"advanced":45,"player":219,"events":{"lens":1,"aiGoal":1,"hit":3,"shock":1,"conductor":1,"bubblePop":1,"shatter":2,"death":2}}
$ pt B.json look 12
boss 596 hp "202/416" fx ["electrified"]      (both sporelings also shattered)
```

The same 66 ticks **without** the vent (walk back 21, fire 45) leave the boss at
`402/416`, frozen, with the two sporelings alive at 15/29.

**Co-op (`lens-coop`).** Diver 1 walks 10 ticks east, vents its shock (entry 1),
and diver 0 fires the frost casts through it:

```
$ pt C.json step 10 '{"player":1,"moveX":1,"moveY":-0.3}'
$ pt C.json step 1 '{"player":1,"vent":1}'
{"tick":11,...,"events":{"bubblePlant":1}}
$ pt C.json step 30 '{"aimAt":597,"attack":true}'
{"tick":41,...,"events":{"aiGoal":1,"lens":1,"hit":2,"shock":2,"conductor":2,"shatter":2,"death":2}}
```

One lensed pellet froze and zapped its robot, and the arc jumped to a second
robot another frost pellet had just frozen.

## What to try

- **Is the lens worth a live slot?** Vent a live element (costs a reload) versus
  a stowed one (free). Which is better before a fight?
- **Lens or mine?** The same Storm bubble is a lens for your frost rounds and a
  mine for whoever walks into it. In `lens`, the robots charge the bubble: shoot
  first or it is spent as a mine that only stuns dry robots.
- **Different enemies, different answer.** A dry, unfrozen enemy ignores
  lightning damage. Wet enemies (`wet` status) arc. Frozen ones shatter. Robots
  and brutes shrug off bullets (`physical` resist), but Conductor is not physical.
  The cinder shrugs off fire.
- **The lightning-weak boss.** "Weak to lightning" does nothing unless the zap
  lands on ice or water. Find two ways to set that up (hint: a lens and a mine).
- **Try to break it.** Vent then catch as a free reload? Plant, drain, catch,
  re-plant to refill a lens? Stand in your own mine? Put a bubble at your feet
  and fire every round through it? Steal a teammate's bubble? Let one expire?

## Known gaps (not built)

- No pad controls and no rack ring UI. On a keyboard, **V** vents the next
  chamber; on a phone or pad you cannot vent yet. Headless `step` is the full
  interface.
- No toss, taps, cored echoes, soundings, Approach floor, or boss schedule. Only
  the Conductor pair reaction (no Steam, no Wildfire). Mirror, Flight and Weight
  bubbles are lenses only, never mines.
- A modifier lens cannot add pellets (`bulk` as a rider only lowers damage).
  `split` forks do not carry the round's element; `splinterShot` fragments do.
- Friendly arcs and bursts always hit players (the design's casual-mode
  exception is not built).
- No e2e video yet.
