# Design A: Primer and Striker

Angle: take the owner literally. Two weapons you build, plus unloading mods into
the world. This document builds the strongest version of two guns it can, then
tests whether two guns earn their place. They do, for one specific reason, stated
in §6.

Grounded against `origin/main` at `7e3d38c`. File paths are real; line numbers
are omitted where they drift.

---

## 1. The pitch

1. Your left trigger shoots **goo** (water, oil, frost, magnet goo) that sticks to
   monsters and the floor, and your right trigger shoots **sparks, flames, ice or
   bullets** that set the goo off.
2. Water plus a spark zaps a whole crowd, oil plus fire makes a wildfire, and
   water plus fire just makes steam, so you have to think about which goo goes
   with which zapper.
3. You build both guns from mods you find, you can pop a mod out and drop it on
   the floor or toss it to your brother, and before a boss you get to see what
   hurts it and rebuild your guns to match.

---

## 2. The core loop, beat by beat

### The two guns

Every player carries two permanent guns for the whole run.

- **The Primer** (left trigger). It does almost no damage. Its payload mod
  decides which **substance** it coats a target with: Soak, Oil, Rime or Magnet.
  Its shape mods decide **who** gets coated: one target, a line, a splash, a fan.
- **The Striker** (right trigger). It does real damage. Its payload mod decides
  which **verb** it lands: Spark, Flame, Frost, or plain Impact when it carries
  no element. Its shape mods decide who gets struck.

Both are wands in the existing sequencing grammar
(`src/game/systems/modSequence.ts`). Modifiers ride on the next payload, a
payload ends a cast, running off the end wraps and recharges. Neither gun
replaces the other, and both fire at once from two different triggers. There is
no weapon switch.

The damage of the game lives in the **reaction** between what the Primer left and
what the Striker lands. The grammar is in §3.

### A normal floor (about two minutes)

1. **Enter a room.** Four thugs and a brute, spread out.
2. **Prime.** Squeeze left trigger once. The Primer (say `[explosive][soak]`)
   lobs a glob that splashes the group wet and leaves a puddle cell on the floor.
3. **Strike.** Squeeze right trigger. The Striker (`[pierce][shock]`) sends a
   spark into the nearest wet body. Soak conducts Spark, so the arc floods the
   wet cluster through the existing `shock()` flood in
   `src/game/systems/interactions.ts`. Four thugs are stunned and hurt. The
   brute, standing two tiles off the puddle, is not wet and is not in the chain.
4. **Adapt.** The brute resists physical hard (`resist.physical: 0.35` in
   `src/game/data/npcs.ts`). Plain Striker bullets barely scratch it. The player
   either walks the brute into the puddle, or re-primes it, or burns it.
5. **Loot.** A mod cartridge drops (the existing exact-count scattered pickups,
   `feat(loot): mods per floor becomes an exact count`). The player must decide
   **which gun** it goes in, because every element mod has a different face in
   each gun (§3.2).
6. **Stairs.** The floor draft (#84) offers three cards. The pick goes through
   the same bench screen as a cartridge, so it also asks "which gun, which slot".

Where the puzzle is on a normal floor: steps 4 and 5. The room geometry and the
roster make a single build imperfect, and each new cartridge forces a placement
choice with two different meanings.

### Before a boss (the floor before)

1. The stair landing shows **NEXT: Mireclaw Alpha** with the boss portrait (§4).
2. Somewhere on this floor is a **Specimen Tank**: a caged juvenile of the boss.
   Shooting it with any Primer/Striker combination shows WEAK / RESIST / IMMUNE
   floaters and adds an icon to the boss's page in the pause dossier.
3. The player has the rest of the floor to **rebuild**: re-slot, unload into the
   world, trade with a teammate, and use the between-floor draft to fill the gap.

The puzzle here is information plus capacity. You learn the answer by
experimenting, and then discover you cannot carry every answer at once.

### During a boss

The boss changes the question between phases. Mireclaw's phase 2 retreats into a
spore cloud to heal (`src/game/systems/mireclaw.ts`). Under this design that
cloud is also **Soaked** ground, so the boss is standing in a conductor. The
player now holds two correct answers that conflict:

- **Burn the cloud.** Denies the heal, the fight's authored counter. But Flame on
  Soak makes steam, not fire, so the Striker's Flame must first eat through the
  wet, which costs time.
- **Spark the boss.** Big arc damage to it and every wet brood sporeling around
  it. But the heal keeps ticking.

Two triggers let the player do both in one breath if they built for it: Oil
primer to overwrite the soak on the cloud, then Spark ignites Oil (§3). That is
the "aha" of the fight, and you only find it if you tested the specimen.

---

## 3. The puzzle, precisely

### 3.1 The rules

**Rule 0. Two wands.** The Primer and the Striker each hold an ordered mod list
and fire through `planCasts` (`modSequence.ts`). Each chassis has its own
`slots` / `castsPerTrigger` / `rechargeOnWrap` (`src/game/data/items.ts`).
Proposed starting shapes:

| Gun | Chassis | slots | casts/trigger | recharge |
|---|---|---|---|---|
| Primer | **Lobber** (arcing glob, splash 1.2) | 3 | 1 | 40 |
| Primer | **Mister** (short cone, 3 droplets) | 3 | 1 | 25 |
| Primer | **Tagger** (fast dart, long range, single) | 2 | 1 | 15 |
| Striker | Pistol | 4 | 1 | 20 |
| Striker | Shotgun | 4 | 2 | 30 |
| Striker | Machine gun | 6 | 1 | 45 |
| Striker | Sledgehammer | 8 | 1 | 75 |

You choose one Primer chassis and one Striker chassis at run start. They are
permanent. No weapon loot returns (the PR #53 ruling holds; see §6).

**Rule 1. Mods are dual-faced.** Element mods do different things depending on
which gun they sit in. This is the single rule that turns the second gun into a
decision instead of a second inventory.

| Mod | In the Primer (substance) | In the Striker (verb) |
|---|---|---|
| `soak` (new) | **Soak**: wet (existing `wet` status, 150 t); area delivery also lays a puddle cell | **Wash**: heavy knockback jet, wets only what it hits, puts out burning allies |
| `incendiary` | **Oil**: new `oiled` status, 300 t; area delivery lays an oil-slick cell | **Flame**: `burning` (existing) |
| `frost` | **Rime**: new `rimed` status, 180 t; target is slowed 40% and **brittle** | **Frost**: `frozen` (existing, shatter rules from PR #79) |
| `shock` | **Magnet**: new `magnetised` status, 150 t; magnetised bodies drift toward each other | **Spark**: `electrified` (existing) |

Shape mods (`pierce`, `bounce`, `homing`, `explosive`, `split`, `splinterShot`,
`bulk`, `choke`, `velocity`) work in both guns and mean **delivery**: in the
Primer they decide who gets coated, in the Striker who gets struck. Stat mods
(`overload`, `heavy`, `rapid`, `glassCannon`) and `lifesteal` / `detonator`
behave as today in the Striker. In the Primer, stat mods only change handling
(fire rate, splash size); the Primer's damage stays near zero by clamp.

**Rule 2. Substances have properties, verbs have kinds.** The grammar is two
tables of tags, not a table of pairs.

| Substance | Properties |
|---|---|
| Soak | `conducts`, `douses` |
| Oil | `flammable` |
| Rime | `brittle` |
| Magnet | `networked` |

| Verb | Kind | Its medium |
|---|---|---|
| Impact | kinetic | none |
| Spark | electric | `conducts` |
| Flame | heat | `flammable` |
| Frost | cold | `conducts` |

**Rule 3. Propagation.** When a verb meets its medium, it spreads by breadth-first
flood to every body within `CHAIN_RADIUS` (1.6 tiles, `interactions.ts`) that
also carries the medium, in ascending id order. This is exactly the existing
wet+shock flood, generalized from one pair to three. A propagation consumes the
substance on every body it touches.

**Rule 4. Transmutation.** Five property rules, each one sentence a kid could
say mid-fight:

- Heat on `douses` makes **steam**: no damage; the target loses its target and
  sight for 90 ticks (an AI verb, not a number).
- Heat on `brittle` **melts** it: Rime becomes Soak. The body is now a conductor.
- Cold on `brittle` makes a **deep freeze**: `frozen` for the full duration, and
  the diminishing-returns tracker in `statusFx.ts` is not advanced.
- Kinetic on `brittle` **cracks** it: that hit ignores resist and knocks back
  double, and consumes the rime.
- Electric on `flammable` **ignites** it: the body starts burning, and Rule 3
  then carries the flame through connected oil.
- Cold on `flammable` **fizzles**: nothing happens and the oil stays. (The trap.)

**Rule 5. Networked.** A non-kinetic verb landing on a magnetised body hops once
to every magnetised body within 4 tiles at 60% strength, then consumes the
magnet everywhere. It does not chain further. Magnetised bodies drift toward the
nearest other magnetised body at 0.6 tiles/s, which is what makes clumps.

**Rule 6. Consumption.** Every reaction consumes the substance it used. A prime
is a one-shot setup, not a permanent debuff. This is the pacing lever: the Primer
has to keep working, so it never becomes a "fire once and forget" gun.

**Rule 7. Anything that is not a reaction just happens.** A verb with no matching
property applies normally, and the substance stays for a later verb.

The grammar is checked in `a/grammar.mjs` next to this document. Running it
enumerates all 20 substance-by-verb cells from Rules 2 to 7 and reports 20
distinct outcomes, 12 of them named reactions. No cell is hand-written.

### 3.2 Why it is a puzzle and not a lookup

A lookup has one right answer you can read off a chart. This has four things that
keep the answer open.

1. **Capacity.** Seven slots across both guns (3 + 4 on the default chassis), 5
   scattered pickups a floor plus one draft pick. You cannot carry every
   substance and every verb. You choose which two or three reactions this run is
   *about*.
2. **Dual faces.** You own one `shock` mod. Magnet or Spark? The same card is two
   different tools, and choosing one closes the other. Every pickup is a fork.
3. **Geometry.** Propagation needs bodies within 1.6 tiles. Whether Soak+Spark
   clears a room depends on how the enemies are standing, which you read live.
   Magnet exists to change that geometry, and costs a Primer slot to do it.
4. **Hidden resist.** Enemy `resist` tables (`npcs.ts`) are not on screen. The
   Specimen Tank and the tap-inspect row reveal them by experiment, and bosses
   like Echo (`docs/design/boss-variety.md` §4.2) change them mid-fight.

Order inside each wand still matters through the existing grammar: a modifier
rides the next payload. `[explosive][soak][pierce][incendiary]` in a 4-slot Primer
is two different casts, an area Soak then a piercing line of Oil, fired
alternately. Free reordering stays (INSPO ruling 6), through the existing swap
input (`packModSwap`), extended across both guns (§8).

### 3.3 Worked example 1: the room clear

- Primer (Lobber): `[explosive][soak]`
- Striker (Pistol): `[pierce][shock][heavy]`

Cast plan: the Primer's one cast is an area Soak; the glob splashes radius
1.2 + 1.6 and leaves a puddle cell. The Striker's first cast is a piercing Spark;
its second cast is a heavy plain bullet, then wrap.

Result: prime the pack, spark the nearest body, the arc floods everyone wet
(Rule 3), each takes the existing `ELEC_DAMAGE 20` and is electrified. The heavy
follow-up round mops up. Against a spread pack (bodies more than 1.6 tiles
apart), the arc dies after one or two bodies. This build is great in corridors
and bad in open halls.

### 3.4 Worked example 2 (the "aha"): Magnet makes water work

The player wants Magnet and Spark, but owns one `shock` (`maxStacks: 1`), so it
can be one or the other. The build they settle on:

- Primer: `[explosive][shock][soak]` (casts alternate: area Magnet, then plain
  Soak glob, because `explosive` rode the first payload only)
- Striker: `[pierce][frost][heavy][rapid]`

What a player discovers: Soak+Spark failed in the big hall because the thugs
stood 3 tiles apart. Magnet first pulls them into a clump over about two
seconds. Now the Soak glob wets a tight ball. But the Spark is gone (it became
the Magnet). The Striker carries Frost instead, and **Frost's medium is also
`conducts`** (Rule 2). A Frost round flash-freezes the whole wet clump, and the
heavy round cracks them one at a time (shatter from PR #79).

That is the aha: "I have no lightning, but water also carries cold." The kid
discovers that Soak is not the lightning goo, it is the *conductor* goo, and the
Magnet made the conductor connect. Three mods, two guns, one sentence.

### 3.5 Worked example 3 (the trap): water and fire

- Primer (Mister): `[bulk][soak]`
- Striker (Machine gun): `[incendiary][rapid][overload]`

What a kid expects: "two elements, double damage".

What happens: every Flame round on a wet target is Heat on `douses`, so it
makes **steam** (Rule 4). No burn, no damage from the element, and the machine
gun keeps turning the Soak into steam as fast as the Mister lays it. The room is
full of blinded enemies wandering aimlessly and nobody is dying.

Why it is a good trap and not a bad one: it fails **visibly** (steam puffs, no
fire) and it is the correct answer somewhere else. Steam blinds. Against the
Vigil (`boss-variety.md` §4.1, "be quiet") a blind boss that loses its target is
exactly what you want. The trap teaches the rule that wins a later fight.

The second trap is quieter: Oil primer with a Frost striker **fizzles** (Rule 4).
The oil stays on, so a teammate with Spark or Flame can still use it. In co-op
the "trap" becomes a handoff (§7).

---

## 4. Boss preparation

### 4.1 How the player learns the weakness

Three layers, from cheapest to richest.

**Layer 1: the next-floor banner.** The stair landing on floor N shows
`NEXT: <boss>` with a portrait. Today `generateMission`
(`src/game/systems/missions.ts`) rolls the assassinate/steal choice from
`w.rng.fork('mission')`, a fork of the live sim stream, so floor N+1's boss is not
knowable from `seed+floor` alone. The fix, behind the flag: pre-roll floor N+1's
mission template from a **new** fork `hashLabel(seed, 'bossPlan:' + (N+1))`
while generating floor N, store it as `World.nextMission` (serialized), and have
`generateMission` honor it. With the flag off, nothing reads the new fork and
existing seeds are untouched.

**Layer 2: the Specimen Tank.** On the floor before a boss, one room holds a
caged juvenile of that boss: a new archetype `specimen.<bossArchetype>`, placed
by the existing object placement on a new fork `specimen:<floor>`. It has
effectively infinite HP, never moves, never attacks, and copies the boss's
`resist` table. Every hit on it emits the existing `hit` event, plus a tag
derived from `resistMult` (`entity.ts`): WEAK above 1.2, RESIST below 0.8,
IMMUNE at 0. Reactions show their own name ("DEEP FREEZE", "STEAM"). The first
time a tag lands, it is written into the boss dossier.

This is the point of the design. You do not read that the Mireclaw is weak to
fire. You **find out** by shooting it with things, which is the only version of
"preparation" that feels like play instead of homework.

**Layer 3: the dossier.** The pause screen (pad Start, already bound, button 9 in
`src/input/padProfile.ts`) gets one extra page: the boss portrait, its phases as
text from the boss data (the generalized HUD from `boss-variety.md` §3.2), and
the tag icons discovered so far. Undiscovered tags are "?". The dossier persists
across runs in local storage (UI layer, not sim), so a veteran starts with the
icons already filled in, and a new nephew has to test.

### 4.2 Walkthrough: Mireclaw Alpha, weak to lightning (by circumstance)

The owner's example is a boss weak to lightning. Here is one where the weakness
is **situational**, which is better than a table entry because the player can
create it or deny it.

Data today (`npcs.ts`, the `boss` row): `resist: { physical: 0.75, burning:
1.25, poisoned: 0.5, spore: 0 }`, hp 320, phases in `mireclaw.ts`: summon brood
above 50%, retreat to spore cloud to heal between 20% and 50%, enrage below 20%.

Proposed change, flag-gated: Mireclaw's spore clouds count as **Soaked ground**
(bog water), so anything standing in one is wet. The boss is only neutral to
electricity, but in its cloud it is a conductor sitting in a pond of its own
brood.

**Floor N (the prep floor).**

1. Landing banner: `NEXT: Mireclaw Alpha`.
2. Kid A finds the Specimen Tank in the lab wing. Plain bullets show RESIST
   (0.75). The Flame striker shows WEAK. The dossier fills in the flame icon.
3. Kid B has a `[explosive][soak]` Primer and sparks the wet specimen. The
   floater reads **"ARC"** with the flat `ELEC_DAMAGE` of 20, which `shock()`
   applies straight to hp, past every resist. The dossier fills in "wet +
   spark". That bypass is itself the lesson: arcs ignore armour.
4. They now know two answers: burn it, or wet-and-spark it.

**The rebuild (same floor, 30 seconds on the stair landing).**

- Kid A: Primer `[explosive][incendiary]` (area Oil), Striker
  `[pierce][shock][heavy][rapid]` (Spark, plus bullets). Oil + Spark ignites
  (Rule 4). Kid A can light the cloud alone.
- Kid B: Primer `[bounce][soak]`, Striker `[split][frost][overload]`. Kid B's
  job is the brood: sporelings flood into the wet cloud, and Frost propagates
  through wet bodies (Rule 3).
- Before the rebuild, Kid A held the team's only `frost` and Kid B the only
  `shock`. Each needed the other's. They **toss** them across the landing (§5).
  They only knew to trade because the dossier showed both answers.

**The fight.**

- **Phase 1 (summon).** Brood of sporelings every 90 ticks, capped at 8.
  Sporelings resist toxins and have `burning: 1.5`. Kid A's area Oil plus Spark
  starts a wildfire through the oiled brood (Rule 3 over `flammable`).
- **Phase 2 (retreat to the cloud and heal).** The boss is now wet. Two correct
  plays compete. Kid A overwrites the soak with Oil (the new substance lands,
  Rule 7 keeps both), then Spark: Electric on `flammable` ignites, Electric on
  `conducts` arcs to every wet sporeling in the cloud. One trigger pull, two
  reactions, and the burning boss is standing in a cloud that is now on fire,
  which is the authored heal denial.
- **Phase 3 (enrage, speed x1.4).** It chases. Kid B Rimes it with the bounce
  Primer and cracks it with the overload Striker: Kinetic on `brittle` ignores
  resist. Rime also slows it 40%, which turns "a chase you can barely win" into
  a chase you win.

The kids never read "weak to lightning". They made it weak to lightning by
fighting it in its own pond, and they learned that on the prep floor.

### 4.3 How this composes with the other bosses

- **Echo** (never repeat a damage type): two guns means two verbs in flight at
  all times, and co-op means four. This is the boss that most directly rewards
  building two guns differently.
- **The Vigil** (be quiet): Steam (the Soak+Flame "trap") blinds it, so the
  counter is a build most players discovered by accident.
- **Mirefather** (shoot the ground): Primer area deliveries lay ground cells,
  which is the verb this boss asks for.

---

## 5. Unloading mods into the world

### 5.1 The mechanic

A mod in either gun can be **ejected**. It leaves the gun as a **cartridge**: the
existing mod pickup entity (a `pickup` whose `itemId` is a mod id, auto-collected
in `autoPickup` in `src/game/systems/interaction.ts`), with two new fields.

- **Drop.** Eject lands the cartridge at your feet.
- **Toss.** Eject while aiming lobs it 4 tiles along the aim, like a grenade
  arc. Aim at a teammate and it lands at their feet.
- **Pocket.** One cartridge can be held unslotted in a pocket (shown on the HUD).
  The pocket is the only stash that crosses floors.

A cartridge on the ground is **live**. It is not just loot, it is an object:

1. **It leaks.** An element cartridge on the ground makes a 1-tile field of its
   Primer substance every 30 ticks. A dropped Soak cartridge is a puddle
   emitter. A dropped Oil cartridge is a slick. Drop one in a doorway, pull a
   pack through it, and spark.
2. **It cooks off.** A verb that reacts with the cartridge's own substance
   (Spark on a Soak cartridge, Flame on Oil) detonates it: a 2.5-tile burst of
   that reaction, and the cartridge is **destroyed**. A mod turned into a bomb
   is a mod gone for the rest of the run. That is a real sacrifice play, and
   the only one in the game.
3. **Enemies can cook it off too.** An enemy flamethrower, a barrel, a detonator
   death blast. Leaving a cartridge on the floor is a risk.

### 5.2 What stops it being degenerate

The worry in the brief: if unload plus re-pick is free, scarcity dies.

It does not, because **scarcity was never about acquisition, it is about
capacity**. What you can use at once is slots (7 across two guns) plus one
pocket. Unloading does not add a slot. The only things unloading makes free are
*rearrangement* and *transfer*, and INSPO ruling 6 already says rearrangement
must be free.

The specific exploits and their stoppers:

| Exploit | Stopper |
|---|---|
| Eject and re-slot to reset a gun's recharge (a free reload) | Loading any mod into a gun **starts that gun's `rechargeOnWrap`**. `applyModSwap` already refuses to reset `castIndex` for the same reason; this extends the rule. |
| Hoard a pile of spare cartridges and carry them forward | Cartridges on the ground are lost on floor transition (`nextFloor` rebuilds `w.entities`). Only the pocket crosses. |
| Swap faces mid-reaction for free | Rule 6 consumes the substance on reaction, so there is nothing to swap into. |
| Drop a Soak cartridge as a permanent free puddle | Leak cells have a TTL. A cartridge only leaks within 8 tiles of a player (stops off-screen farming) and emits one cell at a time. |
| Auto-pickup re-grabbing a dropped cartridge instantly | New `pickup.noGrabUntil` (tick) and `pickup.dropperId`. The dropper cannot re-grab for 45 ticks; everyone else can immediately. |
| One player hoards everything in co-op | Nothing stops it, and that is fine: capacity is per player, so hoarding means your extras sit on the ground where your brother can grab them. |

### 5.3 Auto-pickup with two guns

Today a mod pickup goes straight into the one gun (`applyModPickup`,
`src/game/systems/inventory.ts`). With two guns and dual faces, silent
placement would make the choice for the kid. The rule:

- A cartridge walked over goes into the **pocket** if it is empty.
- If the pocket is full, the cartridge stays on the ground and shows a prompt:
  "hold B to bench".
- The bench (§9) is where it gets slotted, into a gun and a face.

The draft pick (#84) routes to the same bench.

---

## 6. Two guns: yes

### 6.1 The case

**Yes. Two guns, both always live, on two triggers.**

The reason is not capacity, and not variety. It is **timing**. A reaction is a
setup and a payoff, and the player needs to control *when* each happens,
independently.

Try doing Primer/Striker inside one gun, as a single wand `[soak][shock]`. The
wand alternates: glob, spark, glob, spark. The spark fires whether or not the
glob landed, whether or not the pack has clumped, and it fires at the thing you
are aiming at *now*, not the body you soaked a second ago. The setup and the
payoff are welded together in time by the wand order. That is the "shots taking
turns" alternation the owner rejected (INSPO §1, argument 2).

Two triggers break the weld. Soak the pack, wait for the Magnet to clump them,
roll out of a lunge, *then* spark. That wait is the puzzle playing out live, and
only a second trigger lets the player choose it. Every reaction in §3 depends on
it.

Second reason: **dual faces need a second place to be put**. The single decision
"is my `shock` a Magnet or a Spark?" only exists because there are two guns with
different grammars. With one gun, `shock` has one meaning, and each pickup is a
yes. With two, each pickup is a which.

Third reason: **prep needs a knob small enough to turn**. Rebuilding a whole
7-slot wand before a boss is a menu session. Re-slotting a 3-slot Primer is 3
decisions. The Primer is the boss-prep dial.

### 6.2 How switching works on a pad

There is no switching. Left trigger fires the Primer, right trigger fires the
Striker, and both can be held together. Each has its own cooldown and recharge
on its own `ItemStack` (`castIndex`, `rechargeUntil`, `entity.ts`), which already
works per stack.

### 6.3 How it avoids "I only use the one with the mods"

The old failure: the pistol was the only gun worth firing because the mods sat on
it (PR #53). Here that cannot happen, by construction.

- **The Primer does no damage.** Its damage is clamped to at most 2 in
  `resolveWeapon`. There is no reason to fire it alone, and no reason to fire
  the Striker alone at anything with a resist, because the Striker's numbers are
  tuned against primed targets.
- **Neither gun can hold what the other needs.** Substances only exist in the
  Primer. Reactions only happen when the Striker lands. A build that fires one
  gun has turned off half its mods.
- **It is measured, not hoped.** §10 defines `primerShare`: the fraction of
  Striker damage dealt through a reaction. If it falls under 35% in the sweep or
  in live telemetry, the design has failed and the numbers go back.

### 6.4 Where the second gun is wrong, honestly

- On touch screens, a second trigger is a second on-screen button, and
  twin-stick touch already uses both thumbs. Touch gets a "prime" button that
  fires the Primer at the current aim. That is worse than a trigger, and it is a
  real cost.
- Two guns double the HUD for wand state. §9 keeps it to two chip rows.
- If the owner finds that kids only ever hold right trigger, the fallback is the
  single-wand version with a **divider** (slots left of it are Primer faces,
  right of it are Striker faces) and one trigger that fires the Primer on tap and
  the Striker on hold. It keeps the dual faces and loses the timing. It is a
  worse design, but it is the prepared retreat.

---

## 7. Co-op

**Substances are world state on entities, not per-player.** A body Soaked by kid
A conducts kid B's Spark. So the natural co-op split is one kid priming and one
kid striking, and they **must** talk to time it:

- "Wet them!" "They're wet!" "Zap!"
- "Don't burn, they're wet, it'll just steam!"
- "I've got oil on the big one, who has fire?"
- "Throw me your frost."

**What the second player does:** they are the other half of every reaction. In
a two-player run the pair can specialize across players instead of across guns
(one player carries two substances, the other three verbs), which opens builds
one player cannot hold.

**Friendly fire, the open INSPO question.** Players can get wet from a puddle.
A Spark arc through a wet teammate **stuns them and does no damage**. It is
slapstick, it is visible, it is a lesson, and it never downs anybody. Steam
blinds only NPCs (players keep their screen). That answers "does bad-combos-are-
funny survive co-op": yes, if the cost is a two-second stun and a laugh, and no
if it is a down.

**Trading** is the tossed cartridge (§5). It is a physical act on screen, which
kids understand better than a menu.

---

## 8. Data shape

All new fields are optional, so a world with the flag off serializes
byte-identically (the same technique `modSwap` and `castIndex` already use).

### 8.1 Registries

```ts
// src/game/data/reactions.ts (new)
export type SubstanceId = 'soak' | 'oil' | 'rime' | 'magnet'
export type VerbId = 'impact' | 'spark' | 'flame' | 'frost'
export type Property = 'conducts' | 'douses' | 'flammable' | 'brittle' | 'networked'
export type VerbKind = 'kinetic' | 'electric' | 'heat' | 'cold'

export interface SubstanceDef {
  id: SubstanceId
  status: string               // 'wet' | 'oiled' | 'rimed' | 'magnetised'
  props: readonly Property[]
  groundCell?: 'puddle' | 'slick'
}
export interface VerbDef {
  id: VerbId
  kind: VerbKind
  medium?: Property            // Rule 3
  onHit?: StatusApply          // the plain verb (Rule 7)
}
export type Transmute =
  | { kind: 'steam'; blindTicks: number }
  | { kind: 'melt'; into: SubstanceId }
  | { kind: 'deepFreeze' }
  | { kind: 'crack'; knockbackMul: number }
  | { kind: 'ignite' }
  | { kind: 'fizzle' }

/** Rule 4 is keyed by (verb kind, property), not by (substance, verb). */
export const TRANSMUTES: Partial<Record<VerbKind, Partial<Record<Property, Transmute>>>>
export const SUBSTANCES: Record<SubstanceId, SubstanceDef>
export const VERBS: Record<VerbId, VerbDef>
```

```ts
// src/game/data/mods.ts: ModDef gains dual faces
export interface ModDef {
  // ...existing fields...
  /** Face in the Primer. Absent = the mod is a modifier there. */
  primer?: SubstanceId
  /** Face in the Striker. Absent = falls back to today's `onHit`. */
  striker?: VerbId
}
// New entry, appended (wire mod index is 5 bits, 18 used, room for 32):
soak: { id: 'soak', name: 'Soaker', icon: '💧', category: 'behavior', rarity: 'common',
        maxStacks: 1, primer: 'soak', striker: 'impact', /* Wash: knockback via mul */ ... }
```

```ts
// src/game/data/items.ts: WeaponDef gains a role; new Primer chassis rows
export interface WeaponDef {
  // ...existing...
  role?: 'primer' | 'striker'   // absent = striker (today's guns)
  groundSplash?: number         // Lobber: lay a cell on landing
}
// lobber / mister / tagger rows, each with slots/castsPerTrigger/rechargeOnWrap
```

### 8.2 Entity and world

```ts
// src/game/entity.ts
export interface Loadout {
  inventory: ItemStack[]
  activeSlot: number
  /** Index of the Primer stack in `inventory`. Absent = one-gun (today). */
  primerSlot?: number
  /** One unslotted cartridge. Absent = empty. */
  pocket?: WeaponMod
}
// Pickup component gains
noGrabUntil?: number
dropperId?: EntityId
// Projectile gains (so a Primer glob never deals Striker damage and reactions know the verb)
role?: 'primer' | 'striker'
```

New statuses reuse `Entity.fx` (the keyed status map already serialized):
`oiled`, `rimed`, `magnetised`, `steamed`. `wet` exists. Ground cells (puddle,
slick) are hazard entities with `kind: 'fire'`-style handling, the path
`spore.ts` already uses. That respects §3.5 of the boss doc (the sim never
mutates tiles).

```ts
// src/game/world.ts
nextMission?: { template: 'assassinate' | 'steal' | ...; boss?: string } // §4.1
// The boss dossier is not sim state: it lives in UI-side local storage.
```

### 8.3 InputCmd

```ts
// src/game/types.ts
export interface InputCmd {
  // ...existing...
  /** Fire the Primer (level-triggered, like attack). Absent = false. */
  prime?: boolean
  /** Existing field, index space widened: 0-15 Striker list, 16-31 Primer
   * list, 0xFE = pocket, 0xFF = floor (eject). (a,b) swaps; (i,0xFF) ejects;
   * (0xFE,i) loads the pocket into slot i. */
  modSwap?: number
  /** Aim-tossed eject: set together with modSwap (i,0xFF) to throw instead of drop. */
  toss?: boolean
}
```

One field (`modSwap`) carries every bench operation, so the host applies all of
them through one extended `applyModSwap`. Loading into a gun sets that stack's
`rechargeUntil = tick + rechargeOnWrap` (§5.2).

### 8.4 RNG

Two new forks, both keyed off the seed, never off the sim stream:
`bossPlan:<floor>` and `specimen:<floor>`. Nothing in this design rolls dice
during combat. Propagation is BFS in id order (the existing `shock()` pattern).

### 8.5 Wire cost

Measured against the snapshot codec in `src/net/protocol/messages.ts`:

- **Per-entity substance state.** The `flags` byte is full (8 of 8 bits in
  `SnapFlags`, `src/game/snapshot.ts`). Element statuses do not cross the wire
  per entity today at all. Proposal: a **sparse trailer** after the entity list,
  `u8 count` then `(u16 id, u8 mask)` per primed entity, where mask bits are
  wet/oiled/rimed/magnetised/steamed. Cost: 1 + 3k bytes; k is rarely above 10
  in interest radius, so about 31 bytes worst typical. A `PROTOCOL_VERSION`
  bump.
- **Projectiles.** Already carry up to 12 mods at 1 byte each. Add a 1-bit role
  by packing it into the mod count byte (count is at most 12, 4 bits). Zero
  extra bytes.
- **InputCmd.** `prime` is one bit; `modSwap` is an existing optional u16;
  `toss` one bit. Input is client to host and tiny.
- **InventoryMsg.** `primerSlot` (u8) and `pocket` (2 bytes). Reliable channel,
  sent on change only.
- **Cartridges.** Existing pickup entities. `noGrabUntil` and `dropperId` are
  host-only (the client never picks up locally), so they never cross the wire.

---

## 9. Pad UI

Controller: 8BitDo Lite 2, standard mapping in `src/input/padProfile.ts`. Today
attack is bound to `[0, 5, 6, 7]` (A, RB, LT, RT), roll to 4 (LB), interact to 1
(B), special to 2/3, throw to 8, pause to 9, hotbar to the stick clicks.

### In play

| Button | Action |
|---|---|
| RT (7), A (0) | Fire Striker |
| LT (6), RB (5) | Fire Primer (removed from `attack`) |
| LB (4) | Roll (unchanged) |
| B (1) tap | Interact (unchanged) |
| B (1) hold on a cartridge | Open the bench with that cartridge held |
| D-pad down (13) hold | Open the bench |
| Start (9) | Pause, dossier page |

### The bench (not a menu, an overlay)

A two-row strip over the bottom of your own screen quadrant. The game does not
pause (co-op), but while the bench is open your character moves at half speed
and cannot fire, which is why you do it on the landing.

```
 PRIMER   [💣][⚡][💧]            → casts: MAGNET(area) · SOAK
 STRIKER  [🏹][❄️][🪨][⚡fire]    → casts: FROST(pierce) · IMPACT(heavy)
 POCKET   [🔥]      on floor: [❄️]
```

- D-pad moves a cursor across all slots, the pocket and the nearest floor
  cartridge.
- A picks up the chip under the cursor; A again drops it there (swap). Every
  swap is one `modSwap` input.
- X ejects the chip to the floor. Y tosses it along your aim.
- B closes.
- The right side of each row shows **what will actually execute**, one label per
  cast from `planCasts`, with the face resolved (MAGNET, not "shock"). That is
  INSPO ruling 9 and it is issue #88's job; this design depends on it.
- When a chip moves between rows, its icon flips face in place (⚡ becomes 🧲)
  with a short animation. That flip is the dual-face rule taught without text.

The draft screen (#84) opens the same bench with the drafted card held.

---

## 10. Risks and the failure mode to measure

### 10.1 Dominant-strategy risks, named

1. **Soak + Spark everywhere.** The one pair that already exists in the engine,
   now easy to reach. Room clears are strong, and kids will find it first.
2. **Magnet as a universal medium.** Rule 5 lets every verb hop through magnet.
   Magnet plus any Striker may beat choosing a medium.
3. **Primer ignored.** Kids hold RT only and the Primer becomes decoration.
4. **Handling is additive, reactions compound.** INSPO ruling 3's warning: if
   reactions multiply while handling costs add, one arrangement wins.

### 10.2 Built-in brakes

- **Roster resists substances, not just damage.** The cinder burns oil off on
  contact (`oiled` does not stick to a body with `burning` resist below 0.3).
  Robots cannot be Rimed. Sporelings dry out (Soak lasts half as long). One
  resist-table key per substance, in the existing `resist` map.
- **Propagation is capped:** at most 6 bodies per flood, each hop at 85% of the
  last (hyperbolic, the RoR2 rule from INSPO §1).
- **Magnet hops once, at 60%, and consumes itself.** It is a positioning tool
  that happens to carry verbs, not a better medium.
- **Floor modifiers (#89)** can tilt the table: "Dry deck" halves Soak
  duration, "Fuel leak" pre-oils the floor. Run-to-run variety comes from the
  floor asking a different question.

### 10.3 The sweep

Build the lever: a vitest-driven sweep in `src/game/systems/reactionSweep.test.ts`.

- **Builds.** Every Primer window of up to 3 and Striker window of up to 4, drawn
  from the 19 mods, with dual faces resolved, deduplicated by `planCasts`
  output (the cast plan, not the mod list, is the identity). Class-level
  deduplication brings this from millions to a few thousand.
- **Scenarios.** For each roster archetype in `npcs.ts`: lone, spread pack (3
  tiles apart), tight pack (1 tile), plus the Mireclaw fixture. Fixtures via
  `loadFixture` / `runTicks` in `src/game/testkit.ts`, one scripted player
  firing Primer then Striker at the nearest target on a fixed cadence.
- **Metrics per (build, scenario):** ticks to clear; `primerShare` (fraction of
  Striker damage delivered through a reaction).
- **Failure predicates (the test fails):**
  - Any build within 10% of the best time-to-clear in more than 60% of
    scenarios is **dominant**.
  - Median `primerShare` across builds below 0.35 means the Primer is decorative
    (risk 3).
  - Any scenario where a Primer-less build is within 10% of the best means the
    Striker alone is a complete weapon there, which is allowed in at most a
    third of scenarios (trash rooms should be easy).
  - Any build with zero clears across the roster is fine (a bad build is funny),
    unless it is reachable from a single draft pick on floor 1.
- **Report:** a table of the top 20 builds by scenario win count, committed as a
  snapshot so balance changes show as a diff.

### 10.4 In play

The `observer` skill (`.claude/skills/observer`) watches a live couch session.
Two numbers to log per floor: `primeFires / strikeFires` per player, and the
count of named reactions per minute. If a nephew's prime ratio is near zero
after floor 3, the bench and the tutorial failed, whatever the sweep said.

---

## 11. Combinatorial space

The owner's headline: *significant, meaningful combinatorial complexity*.

### 11.1 Today

- **Default mode** (`resolveWeapon.ts`). Mods fold in sorted-id order, so order
  is irrelevant, and `onHit` keeps exactly one element (the last in id order).
  The verbs a projectile can carry: plain, frozen, burning, electrified. That is
  **4 verbs**. The other mods are stat soup or delivery. Crossed with 4 delivery
  footprints that differ in play (single, line, area, fan), that is **16 play-
  distinct projectiles**, and against the roster the answer collapses to damage
  type: **about 4 distinct answers**.
- **Sequence mode** (flag off). Arrangements explode (INSPO counts about 105k
  sequences of length at most 4 over 18 mods), but each cast still carries at
  most one of the same 4 verbs. More sequences, same answers. The combinations
  change rhythm, not what a shot *does to an enemy*.

Wet+shock, the one real cross-element reaction in the engine
(`interactions.ts`), is **unreachable by a player**: no mod or weapon applies
`wet`. It exists only in scenarios and the debug verb.

### 11.2 This design

Counted by `a/grammar.mjs` (the rules of §3, enumerated, not authored):

| Measure | Today | Design A |
|---|---|---|
| Verbs a single shot can land | 4 | 4 |
| Prime states a body can carry | 0 (wet unreachable) | 5 (none + 4), 11 with two layered |
| Substance x verb cells | n/a | 20 |
| Distinct outcomes from those cells | 4 | **20** |
| Of which named reactions (not "plain") | 0 reachable | **12** |
| With two layered substances | n/a | 38 distinct outcomes |
| x play-distinct delivery on each gun (4 x 4) | 16 | **320** (608 layered) |

The honest count is the middle of the table, not the bottom. 320 is a real
number of different things that happen on screen, but a kid does not experience
320 things. A kid experiences **12 named reactions**, each describable without a
number, and **four places to put them** (who gets primed, who gets struck).

### 11.3 What makes a combination meaningful here

A combination is meaningful if it changes **which enemy it answers** or **what
the player does next**. Every named reaction passes that test:

| Reaction | Verb (no numbers) | Answers |
|---|---|---|
| Soak + Spark | arcs through a wet crowd | packs in corridors |
| Soak + Frost | freezes a wet crowd solid | fast swarms; sets up shatters |
| Soak + Flame | steam blinds | the Vigil; escaping; reviving a teammate |
| Oil + Flame | wildfire through oiled bodies | sporeling swarms, the brute (burning 1.5) |
| Oil + Spark | ignites at range, and stuns | when your Flame is a Magnet |
| Oil + Frost | fizzles, oil stays | a handoff to a teammate |
| Rime + Impact | cracks, ignores resist | the brute (its physical 0.35 is bypassed) |
| Rime + Frost | deep freeze past diminishing returns | the enrage chase |
| Rime + Flame | melts into water | turning a single target into a conductor |
| Magnet + any | clumps, and the verb hops once | spread-out rooms; makes Soak work |

The cinder is the clearest proof. Today it resists fire and is weak to bullets,
so the answer is "don't use your incendiary". In Design A the answer is Rime +
Impact, a *different action*, and the Oil you carry is not wasted: it goes to
your brother, whose Spark ignites it on the sporelings.

### 11.4 How the space is kept from collapsing

A big space that collapses to one build is a space of one (INSPO ruling 4).
Four mechanisms keep it open, and one sweep proves it:

1. **The roster asks different questions** (§10.2): each substance has at
   least one enemy it will not stick to, so no substance is universal.
2. **Capacity forces a thesis.** Seven slots and one copy of each element mod
   (`maxStacks: 1` on frost, incendiary, shock in `mods.ts`) mean a build holds
   two or three reactions, never all twelve.
3. **Dual faces make every copy exclusive.** Your one `shock` is a Magnet or a
   Spark. Owning more cards never means owning both.
4. **Floors and bosses tilt the table** (#89 modifiers, the Specimen Tank, Echo
   adapting), so the best thesis changes from floor to floor.
5. **The sweep in §10.3 fails the build** if any build wins more than 60% of
   scenarios.

---

## 12. The smallest prototype that proves the fun

**Question it answers:** do two triggers and one reaction make a kid say "whoa"
and want to reorganize, or do they just hold right trigger?

**Scope, behind a new flag `primerStriker`** in `src/app/featureFlags.ts`
(implies `sequencedMods`):

1. **Primer chassis.** One chassis only: `lobber` in `src/game/data/items.ts`
   (`role: 'primer'`, 3 slots, damage clamped to 0).
2. **Dual faces for three mods.** `soak` (new) and `shock` / `frost` get
   `primer` / `striker` faces in `src/game/data/mods.ts`. Soak and Magnet
   substances only; skip Oil and Rime.
3. **Reactions.** New `src/game/data/reactions.ts` with Rules 3, 5 and one
   transmute (steam). Implement Rule 3 by generalizing `shock()` in
   `src/game/systems/interactions.ts` to take a medium, then call it for
   Spark-on-conducts and Frost-on-conducts. Magnet drift in the same file.
4. **Fire path.** `src/game/systems/combat.ts` (`fireWeapon`) reads
   `Loadout.primerSlot` and fires it on `InputCmd.prime`. The projectile hit
   path applies the substance or runs the reaction.
5. **Input.** `prime?: boolean` in `src/game/types.ts`, bound to LT in
   `src/input/padProfile.ts` and right mouse in `src/input/keyboard.ts`.
6. **Scenario.** `?scenario=primer` in `src/game/scenarios.ts`: the `armed` kit
   (`setupArmed`) with a Striker `[pierce][shock][heavy]` and a Lobber
   `[explosive][soak]`, plus a spread pack of 6 thugs in an open hall and a
   corridor with 4. Magnet is left **on the floor** as a cartridge so the player
   can find the aha by picking it up (no bench needed yet; a walked-over
   cartridge goes into the first empty Primer slot in this slice).
7. **Tests.** `src/game/systems/reactions.test.ts`: Soak + Spark floods a wet
   cluster and stops at a 1.7-tile gap; Magnet pulls two bodies inside 1.6
   tiles within N ticks; Frost floods wet; steam blinds; flag off leaves every
   golden digest identical (the pattern in `modSequence.flagOff.test.ts`).
8. **Video.** One `e2e/` recording (`record()` in `e2e/lib.mjs`): the spread pack
   fails to chain, the player grabs Magnet, the same pack chains.

Skip for the slice: the bench UI, eject and toss, the pocket, the Specimen Tank,
the dossier, Oil and Rime, the wire trailer (the prototype is solo), and the
sweep.

**What would change the plan:** if in the recording the Magnet clump takes longer
than about two seconds, the aha is too slow for this game's pace and Rule 5's
drift speed is the first number to move. If playtesters never press LT, §6.4's
single-wand fallback gets built next instead of the bench.

Files touched: `src/app/featureFlags.ts`, `src/game/data/items.ts`,
`src/game/data/mods.ts`, `src/game/data/reactions.ts` (new),
`src/game/systems/interactions.ts`, `src/game/systems/combat.ts`,
`src/game/types.ts`, `src/input/padProfile.ts`, `src/input/keyboard.ts`,
`src/game/scenarios.ts`, `src/game/systems/reactions.test.ts` (new),
`src/net/protocol/messages.mods.test.ts` (the new `soak` wire index), one
`e2e/` scenario file.
