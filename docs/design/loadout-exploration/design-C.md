# Design C: Essences are things in the world

Designer C. Angle: mods are physical, and co-op is the puzzle.

Grounded against `origin/main` at `7e3d38c`. Nothing here is built. Every claim
about existing code names its file. Counts labelled **model** come from
`scratchpad/loadout-design/space.py` (a script I wrote and ran for this document,
explained in §3b); counts labelled **measured** would come from the sweep in §10,
which does not exist yet.

---

## 1. The pitch, for a 10-year-old

Every monster has a glowing marble inside it, and the colour tells you what the
marble does: purple is lightning, white is ice, orange is fire. You put marbles in
your gun to change its bullets, and you can pop one back out and leave it floating
in the air, where any bullet that flies through it (yours or your friend's) picks
up its power, and any monster that walks into it gets zapped. Before a big boss,
you find clues about what it's scared of, but each clue only shows up on the
screen of whoever grabbed it, so you have to tell each other.

---

## 2. The core loop, beat by beat

### The objects

There are four kinds of thing in this design, and they are all world entities.

| Thing | Fiction (LORE.md) | What it is in the sim |
|---|---|---|
| **Essence bubble** | A mod is the essence of a drowned object, caught as a bubble (canon #1). | The existing `pickup` entity with archetype `mod.<id>` (`populate.ts:921`), plus a `bubble` component. |
| **Cored echo** | Every echo congeals around one opaque junk core; the core bursts last and falls as the drop; its glow hue is the hue of the essence (night-brainstorm proposals: *echo design rule*, *hue-telegraph*). | An NPC with an optional `core` field. It glows the core's hue. On death the core becomes a drifting bubble. |
| **The still** (your gun) | Launchers are stolen stills; the chamber is where essences mix (canon #2, *launchers are stolen stills*). | Your one permanent weapon. Its mod list is the ordered chamber rack from `modSequence.ts`. |
| **Still-tap** | The colony was an essence refinery. Its plumbing is still in the walls. | A new `OBJECTS` row (`data/objects.ts`) that accepts one bubble of a named hue and opens a linked door. |

Plus one special bubble, the **sounding**, which carries a clue about the boss
instead of an essence (§4).

### A normal floor (about two minutes)

1. **Read the room.** You open a door on a crew module. Four echoes. One glows
   violet, one glows white, two are dull (no core). Colour is the drop. You now
   know what this room pays out before firing a shot.
2. **Choose your kill order.** You want lightning for later, so the violet one
   dies first and fastest. The kid who wants ice goes for the white one. This is
   the first decision, and today it does not exist: today mods sit on the floor
   of one room in three (`populate.ts:21`, `MOD_PICKUP_ROOM_CHANCE = 1/3`) and you
   grab whatever is there.
3. **Catch.** A popped core drifts toward the nearest diver and is caught on
   contact, the same auto-pickup path as today (`interaction.ts:116-139`). It
   goes into your chamber rack at the end.
4. **Arrange.** Hold L2 to open your still (a one-second fiddle, you can still
   be hit). Swap chambers with the existing reorder input (`packModSwap`,
   `modSequence.ts:133`). Order matters: modifiers ride on the next payload.
5. **Vent or keep.** Your rack is full, or this essence is wrong for your gun.
   Vent it. It pops out of the still and hangs in the air where you stand, a
   **planted bubble**. Or toss it along your aim to your teammate.
6. **Use the world.** A planted bubble does two things at once. Any bullet that
   passes through it picks up its essence (a **lens**). Any enemy body that
   touches it bursts it (a **mine**). The next fight in the corridor is decided
   by where you planted it, not by who has the better gun.
7. **Tap or not.** A still-tap on a sealed side-room wants a white bubble. Through
   its porthole you can see two bubbles glowing inside, one violet and one silver.
   Spending your ice buys a choice between two others. Or keep your ice.
8. **Floor clear.** The floor draft (#84, `draft.ts`) offers three. You take one.
   Down the stairs. Planted bubbles do not cross floors ("the swamp takes back
   what nobody holds").

### The floor before a boss: the Approach

The floor before a boss floor is flagged as **the Approach**. It is a normal floor
with three extra things:

- **Three soundings**, placed far apart. Each carries one clue about the boss
  below. The clue shows only on the screen of the diver who caught it (§4, §7).
- **A guaranteed core of the boss's weakness hue** somewhere on the floor, so a
  bad loot roll never dead-ends the fight (the Mirefather risk called out in
  `docs/design/boss-variety.md` §4.4, "if the party has no shock source the fight
  must still be winnable").
- **One still-tap vault**, whose wanted hue and porthole contents are rolled on
  their own RNG fork.

The Approach is the prep floor. The party has one floor to hunt the right hues,
arrange stills, and decide who carries what down the stairs.

### A boss floor

1. The boss is revealed on first sight (`mireclaw.ts:82-88`, `maybeReveal`,
   which every boss inherits per `boss-variety.md` §1.4).
2. The boss bar shows the weakness hue, but only for divers who caught the hue
   sounding. On the others' screens it is a grey swatch until someone says it out
   loud or a hit lands with that essence (a hit reveals it to everyone).
3. The fight is where the prep pays off: planting mines in the boss's path,
   firing through a teammate's lens, and choosing when to spend.

### Where the puzzle is

The puzzle is not "what order do my four chambers go in". That exists already
(`modSequence.ts`) and this design keeps it. The new puzzle is **what to keep in
the still, what to put in the world, and where**, under three pressures: scarcity
(about five essences a floor, INSPO §1 ruling 5), partial information (hue tells
the family, not the member; boss clues are split across players), and spending
(a planted bubble is gone once its charges run out).

---

## 3. The puzzle, precisely

### 3a. The rules

**R1. Hue families.** Every mod belongs to exactly one hue family. The hue is
what an echo glows and what a bubble looks like. Six families, drawn from the 18
mods in `data/mods.ts`:

| Hue | Family | Members | LORE flavour line (on catch) |
|---|---|---|---|
| Violet | **Storm** | `shock` | essence of: a battery that outlived the colony |
| Pale blue | **Cold** | `frost` | essence of: the cryo bay, the night it failed |
| Ember | **Flame** | `incendiary` | essence of: a cook-stove nobody turned off |
| Silver | **Mirror** | `split`, `splinterShot`, `bulk` | essence of: a shaving mirror, cracked |
| Brass | **Flight** | `pierce`, `bounce`, `homing`, `velocity`, `choke` | essence of: a hornet nest in a vent |
| Rust | **Weight** | `heavy`, `overload`, `glassCannon`, `rapid`, `explosive`, `detonator`, `lifesteal` | essence of: an anchor chain |

A diver knows the family from the glow. They learn the member only on catch. Three
of the families have one member, so they are fully readable. The other three are
partially hidden, which is deliberate: a silver echo is "some kind of more
bullets", and you commit to killing it before you know which kind.

**R2. The still.** Your weapon's mod list is the ordered rack from
`modSequence.ts`. Sequenced casting is **on** in this design (it is the flag
`sequencedMods` today, `src/app/featureFlags.ts`). Elemental mods are payloads
and end a cast; everything else is a modifier that rides on the next payload
(`modSequence.ts:1-17`). Weapon shapes are unchanged: pistol 4 slots, 1 cast;
shotgun 4/2; machine gun 6/1; sledgehammer 8/1 (`data/items.ts`). Entries past
`slots` are stowed, not live (`liveEntries`, `modSequence.ts:55`). Two stowed
entries are allowed. That is the bandolier (LORE canon #5).

**R3. Venting.** A diver may vent any rack entry. Venting a live entry:
- removes it from the rack and places a **planted bubble** at the diver's feet
  (or tosses it along the aim, R7);
- starts the weapon's `rechargeOnWrap` recharge, exactly as if the rack wrapped.
  Venting is never free fire-rate.

Venting a stowed entry costs no recharge, because it was not firing.

Catching a planted bubble back takes a deliberate interact (B), not walk-over.
It goes to the end of the rack. `castIndex` is not reset (the same rule
`applyModSwap` already follows, `modSequence.ts:143-148`, "resetting it would
make reordering a free reload").

**R4. Lens.** A projectile that passes through a planted bubble picks up that
bubble's mod as a **rider**, once per projectile, one rider maximum. The bubble
loses one charge. A bubble has `3 + 3 × stacks` charges, at most 9.
- A modifier rider applies as if it were in the cast (a silver `split` rider
  makes the round fork on its first hit).
- An elemental rider gives the round a **second element**. This is the only way
  in the game a round carries two elements. In both of today's modes a cast
  carries exactly one (`resolveWeapon.ts:88`: "last (sorted-key) elemental mod
  wins the single onHit slot"; `modSequence.ts:9`: the cast carries "exactly that
  one element").
- A round that already carries that element gains nothing and does not spend a
  charge.
- Every projectile counts, pellets included. A shotgun blast through a lens can
  drain it in one pull. This is deliberate handling-as-composition (INSPO §1
  ruling 3): a slow, heavy single shot gets the most out of a lens.

**R5. Mine.** An enemy body (any non-player with `health`) that touches a planted
bubble bursts it. The burst applies the family's **burst verb** in radius 1.5:

| Family | Burst verb |
|---|---|
| Storm | `shock()` on every body in radius (`interactions.ts:43`), so it arcs through anything wet. |
| Cold | `freeze()` every body in radius (`interactions.ts:37`). |
| Flame | `igniteCell` on every cell in radius (`fire.ts:41`). |
| Mirror | Shrapnel ring: the `splinter` fragment spawn from `projectiles.ts`, 6 shards. |
| Flight | A shove: knockback 18 outward on every body in radius. |
| Weight | A blast: the `detonate` path (`combat.ts`), radius 1.6, damage 20. |

Players never burst mines. They catch them (R3) or walk through them. This keeps a
careless kid from blowing up their own trap, and it keeps friendly fire out of the
common case.

**R6. Expiry.** A planted bubble rises and pops after 600 ticks (20 s) if nothing
spends it. Lore: an essence nobody holds is taken back by the swamp. Drifting
bubbles (fresh from a core) do not expire until the floor ends. A diver may have
at most two planted bubbles at once; venting a third pops the oldest.

**R7. Toss.** Venting with toss lobs the bubble along the aim, reusing the
thrown-item arc (`combat.ts:540`, `throwItem`). A teammate it touches in flight
catches it (auto, because it was aimed at them). If it lands without a catch it
becomes a planted bubble where it lands.

**R8. Pair reactions.** Three elements give exactly three pairs. Each is one
sentence and each is a rule change to an interaction that already exists in
`interactions.ts`, not an entry in an arbitrary table:

| Pair | Name | The sentence a kid would say | The rule |
|---|---|---|---|
| Cold + Storm | **Conductor** | "Lightning jumps through ice now." | `shock()` treats frozen bodies as conductive like wet ones, and an arc into a frozen body shatters it (`SHATTER_DAMAGE_MULT`, `combat.ts:62`). |
| Flame + Cold | **Steam** | "It makes everyone wet." | The hit puts out fire in radius 2 and applies `wet` to every body in radius 2. |
| Flame + Storm | **Wildfire** | "The zap sets them on fire." | Every body an arc reaches is also set `burning`. |

These are the "depth beats breadth" pairs (INSPO §1 ruling 2): three elements, three
pairs, each a sentence. Every other lens combination is the grammar applying the
rider's own mod, so every arrangement has a defined result by construction
(INSPO §1, *a grammar, not a table*).

**R9. Taps.** A still-tap names a hue. A bubble of that hue vented within one
tile of it is consumed and opens the linked door, the same way a Spore Node's
death opens its linked hatch (`door.nodeId`, `sealSystem`,
`interaction.ts:88-96`). The room behind holds two bubbles whose hues show
through a porthole. You can see what you would buy, but only the families.

### 3b. Why this is a puzzle and not a lookup

A lookup is "boss weak to lightning, so equip lightning." Here every step has a
hidden quantity, a constraint, or a trade-off:

- **Hidden or partial information.** Hue gives the family, not the member (R1).
  Tap vaults show families, not members. Boss clues are split between players,
  and one of them is a warning about how *not* to fight (§4). The Approach tells
  you which boss is coming only if someone catches the right sounding.
- **Constraints.** Slots per weapon, casts per trigger, one rider per projectile,
  lens charges, two planted bubbles per diver, 20-second expiry, and about five
  essences per floor (`6c7a343`, "drops 20 -> 5").
- **Trade-offs.** Keeping Storm in the chamber means every cast stuns. Planting it
  means one teammate's burst of Conductor rounds, then it is gone. Tapping spends
  one known essence for a choice between two partly known ones. Venting costs a
  recharge. A lens helps whoever shoots through it, including the teammate who is
  about to waste it on a machine gun.

### 3c. Worked example 1: the solo corridor (pistol)

Solo diver, pistol (4 slots, 1 cast per pull, recharge 20). Held: `heavy`,
`frost`, `pierce`, `shock`, stowed `split`. Five drowned divers (`drowner`,
`npcs.ts`) are coming down a corridor in single file.

- **Arrangement A**: `[heavy][frost][pierce][shock]`. Casts alternate: a heavy
  freezing round, then a piercing stun round. Pierce lets the stun round go
  through the line and electrify everyone, but they are dry, so it is a stun with
  no arc (`interactions.ts:52`, "a dry origin is a dead end").
- **Arrangement B**: vent `shock` in the corridor mouth as a mine, and arrange
  the rest as `[pierce][heavy][frost]`. Every pull is one piercing heavy freeze
  round, but the rack is one cast long, so the recharge comes every pull. The
  first drowner walks into the Storm mine, which does little: it is dry, so the
  burst stuns one body and stops.
- **Arrangement C, the answer**: rack `[pierce][frost][heavy][shock]` (two
  casts), and vent the stowed `split` as a lens one tile ahead of you. Venting a
  stowed entry costs no recharge (R3). The pierce-frost round passes the lens,
  gains a `split` rider, freezes the first body, and forks into the bodies
  behind it. Next pull, the heavy-shock round: no conduction, because nobody is
  wet, but it is a solid impact on a frozen body, so it shatters
  (`combat.ts:29-62`). Assumption to verify in the prototype: fork fragments
  inherit the cast's element. If they do not, the lens gives pierce-width, not
  three freezes.

Point: the stowed `split` was dead weight in the chamber. As a lens it is worth
three frozen bodies. The solo puzzle is "which of my essences is worth more in
the air than in the gun".

### 3d. Worked example 2, the aha: Conductor across two kids

Two divers. Kid A: shotgun (4 slots, 2 casts per pull, recharge 30), rack
`[bulk][frost][choke][frost]` (two frost, one from the draft). Kid B: pistol with
`shock` somewhere in the rack. A pack of eight sporelings is coming out of a
hive room.

- Kid B vents `shock` into the doorway as a planted bubble. `shock` has
  `maxStacks: 1` (`mods.ts`), so it has 6 charges (R4).
- Kid A fires through it. The shotgun throws 2 casts × its pellets; every pellet
  that crosses the bubble becomes **frost + storm**. Six pellets get the rider
  before the bubble pops.
- **Conductor (R8):** the freeze lands, then the rider's arc runs `shock()` from
  each struck body. Frozen bodies conduct. The arc crawls across the frozen pack,
  and each arc into a frozen body is a shatter.
- Neither kid could do this alone. Kid A has no Storm. Kid B has one Storm and
  no frost to make the conductor. The combination exists only in the doorway,
  and only because they said "wait, stand there, shoot through my purple one".

Why this is the aha and not a known trick: frost and shock have been separate
bullets their whole lives. Nobody expects the ice to carry the lightning. The
first time the arc walks across a frozen crowd it looks like an accident, which
is the Noita "discovered, not taught" feeling (INSPO §1 Noita).

### 3e. Worked example 3, the trap: Steam against the Mireclaw

The Mireclaw Alpha heals in phase 2 by standing in a spore cloud that is not on
fire, while itself not burning (`mireclaw.ts:91-95`, `inSafeCloud`). The known
answer is fire.

A party arrives with Flame in Kid A's chamber, and Kid B plants a Cold lens
"for control". Kid A shoots through it. **Steam** (R8): the hit puts out fire in
radius 2 and wets the boss. The cloud Kid A had set burning is now out, the boss
is no longer burning, and `inSafeCloud` is true again. The lens just healed the
boss.

The right play is to hold the Cold bubble until phase 3 (enrage, `ai.enraged`,
speed ×1.4) and plant it in the chase path as a **mine**: the boss runs into it
and is frozen, which is the one moment in phase 3 you get to stop running.

The trap is legible after the fact (the boss bar starts going up again, and the
fire visibly goes out), which is what makes it a trap and not a gotcha.

### 3f. Combinatorial space

The owner's headline is *significant, meaningful combinatorial complexity*. Three
honest counts follow, then what makes the combinations meaningful, then how a
dominant build is kept from collapsing the space.

**Count 1: projectile signatures reachable from one hand (model).** A signature is
`(set of elements on the round, set of behaviour verbs on the round)`, ignoring
pure stat mods (stat soup). Verbs are `pierce, bounce, homing, explosive, split,
splinterShot, detonator, lifesteal`. Averaged over 400 random 5-mod hands drawn
from the 18 mods (`space.py`):

| Mode | Distinct signatures reachable per diver | Where the choice lives |
|---|---|---|
| Today, default fold (`resolveWeapon.ts`) | **1.0** | None. Every mod folds into every shot. |
| Today, `sequencedMods` flag (`modSequence.ts`) | **9.7** | Order and which 4 of 5 are live. |
| This design, solo (own lenses) | **10.4** | Adds the dual-element rounds. |
| This design, two divers sharing lenses | **36.7** per diver | Your rack × your teammate's planted bubbles. |

Signature universe (every signature that can exist at all): today
`4 element states × 2^8 verb sets = 1024`; with lens pairs
`(4 + 3) × 2^8 = 1792`.

Two findings from building this model. First, in today's default fold the
single `onHit` slot is resolved by sorted key (`resolveWeapon.ts:83-88`), so
`shock` always beats `incendiary`, which always beats `frost`. Holding Tesla
Rounds silently disables Cryo and Incendiary on every shot. That is the "screen
lies" defect class from #88, and it is live on `main`. Second, the solo gain from
lenses is small (9.7 to 10.4) because a lens you plant is an essence you took out
of your own rack. The multiplication comes from the party. That is the design's
thesis in one number: **the combinatorial space quadruples when two kids share.**

**Count 2: sentences (depth, not breadth).** INSPO's test: if a pair cannot be
described in a sentence a player would recognise mid-fight, it is noise. Today a
player can say about 12 sentences: 3 elements, shatter, wet-shock chain, 7
behaviours. This design adds 3 pair reactions (R8), 6 burst verbs (R5), the lens
itself ("bullets through a bubble get its power"), and the tap. That is 22, each
checked against the sentence test in the tables above.

**Count 3: decisions per floor.** Today a normal floor has about one real choice
(the draft, once #84 lands; before that, zero). This design adds: which cored
echo to kill first (up to five a floor), vent or keep, where to plant, whom to
toss to, tap or keep, and on the Approach, who holds which clue. A conservative
floor has six to ten such choices.

**What makes these meaningful rather than stat soup.** A combination is
meaningful when it answers a different enemy differently. The existing
`resist` roster is the scoreboard (`data/npcs.ts`):

| Enemy | Resist row | Answered by | Verb |
|---|---|---|---|
| Brute | `physical 0.35, burning 1.5` | Flame, or a Cold mine then a Weight hit (shatter bypasses its armour by being ×5) | burn / freeze-shatter |
| Cinder | `burning 0.2` | Plain rounds, Mirror for volume | shoot / multiply |
| Sporeling pack | `burning 1.5, poisoned 0.15` | Wildfire, or Flame + Mirror | spread fire through a crowd |
| Robot | `physical 0.4, burning 1.5` | Conductor (freeze, then arc) | control, then shatter |
| Drowner tide | `poisoned 0.7` | Steam, then Storm: wet the tide, then one arc hits all | set up, then chain |
| Mireclaw | heals in unburnt spore | Flame on the cloud; Cold as a phase-3 mine; never Steam | deny, then pin |
| Mirefather (planned) | `physical 0.1` while wet | Storm mine in its own water | turn its terrain into the circuit |

Every row has a different best answer, and the best answer is a verb, not a
bigger number. The Steam row is the important one: a combination that is
useless on its own (it deals no damage) is the setup for the strongest play
against one enemy. That is what "meaningful" means here.

**Keeping a dominant build from collapsing the space.** Four structural guards,
then one measurement (§10):

1. **Lenses are spent.** Charges cap the value of any lens combination. A
   dominant pair still has to be re-bought every fight from a supply of about
   five essences a floor.
2. **Every pair has a counter-case.** Steam heals the Mireclaw (§3e). Conductor
   does nothing on a dry, unfrozen target. Wildfire is wasted on the cinder
   (`burning 0.2`). No pair is good against the whole roster by rule.
3. **Echo punishes repetition** (`boss-variety.md` §4.2): its `resist` rises for
   whatever it is hit with. A party that always runs Conductor loses that fight.
4. **The hand is dealt by hue, chosen by kill order.** A dominant pair needs its
   two hues on the same floor, and the Approach's guaranteed core is the boss's
   weakness hue, not the dominant pair's.

---

## 4. Boss preparation

### How you learn the weakness

The Approach (§2) holds three **soundings**. Lore: the lair exhales. Before a
boss surfaces, its essence leaks up through the station rings, and it condenses
into grey bubbles with a faint hue at the centre (LORE: *sporefall, named*: "the
swamp exhales"). Each sounding carries one of three clues:

| Clue | What the catcher sees (their screen only) | Why it matters |
|---|---|---|
| **Silhouette** | The boss's name and its junk core: "SOUNDING: something that carries the bog. Its core: a drowned bilge pump." | Which boss. Tells you what kind of fight. |
| **Hue** | A swatch in the weakness hue: "It fears VIOLET." | What to hunt for on this floor. |
| **Warning** | What the boss punishes: "Don't stand in its water." | The trap to avoid, which is often an essence you would otherwise bring. |

A sounding is caught like any drifting bubble. It does not go into your rack. It
goes into your **locket** (LORE: *succession locket*), a HUD icon only you see.

**Where the truth comes from.** Today a boss floor is a coin flip inside mission
generation (`missions.ts:93-117`, `rng.chance(0.5)` picks steal or assassinate;
`:130-150` picks contain or infiltrate on floor 5+). The Approach must know the
next floor's boss in advance. So the boss schedule becomes a pure function
`bossSchedule(seed, floor)` on its own RNG fork `'boss-schedule'`, and mission
generation consults it when the flag is on. With the flag off, mission RNG is
untouched and every frozen fixture stays byte-identical, the same discipline as
the `npc-mods` fork (`populate.ts:98`).

**Weakness has to be real in the sim.** Today no `resist` row has an
`electrified` or `frozen` key, and `shock()`'s 20 damage bypasses
`applyDamage` and `resistMult` entirely (`interactions.ts:57-62`). "Weak to
lightning" is not expressible yet. The fix is small: `shock()` scales
`ELEC_DAMAGE` by `resistMult(e, 'electrified')`, and a boss row may set
`electrified: 2`. Boss weakness is then one `resist` key per boss, the field
`boss-variety.md` §1 calls "the most under-used field in the game".

### Acting on it

Once you know "violet", the Approach turns into a hunt: kill violet echoes first,
tap the vault if it shows violet through the porthole, and decide whose still
carries it. The guaranteed violet core means the hunt always has an answer.

### Walkthrough: the Mirefather, two kids

Mirefather is the planned boss in `boss-variety.md` §4.4: sheathed in bog water
(`resist.physical ≈ 0.1` while wet), floods cells as it walks, prefers to stand in
them. Its designed counterplay is `wet + electric ⇒ chain`. This walkthrough
assumes that design lands, plus `resist.electrified: 2`.

**Floor 6, the Approach.**

1. Kid A (shotgun) catches a sounding in the mess hall. Only A's screen shows:
   *"SOUNDING: something that carries the bog. Its core: a drowned bilge pump."*
   A says "it's a water thing".
2. Kid B (pistol) catches one in the reactor. Only B's screen shows a violet
   swatch: *"It fears VIOLET."* B says "we need purple". Now both know.
3. Nobody catches the third. It rises and pops (R6). They go down without the
   warning. That is fine. It is the one they will learn the hard way, and next run
   they will fight for it.
4. The hunt: two violet echoes on the floor, one guaranteed. B kills one and
   catches `shock`. A kills a white one: `frost`. The tap vault wants Flame; A has
   an `incendiary` and taps it. The porthole showed violet and silver. A takes the
   violet: a second `shock`.
5. The plan, said out loud at the stairs: "I keep one purple in my gun. You keep
   yours to plant in its water."

**Floor 7, the Mirefather.**

1. It reveals (`maybeReveal`) and floods the room. B's boss bar shows violet as
   its weakness. A's shows it too, because A caught the silhouette and B told
   him; the game only shows the swatch to catchers, but A's first shock hit
   reveals it to both (§2).
2. Bullets bounce off. A's shotgun rack is `[frost][choke][shock][bulk]`: one frost
   cast, one shock cast per pull (2 casts per trigger). The shock pellets stun it
   when it is wet. The frost pellets would freeze it but a frozen, wet body is a
   Conductor target: if B's arc comes next, it shatters.
3. B vents her `shock` into a flooded cell ahead of the boss. It is a **mine** in
   water. When the Mirefather walks into it, the burst runs `shock()` from the
   boss, it is wet, and the arc floods every wet body in reach. With the
   water-cell extension (`boss-variety.md` §4.4: extend `shock()` from "wet bodies"
   to "wet bodies and wet cells") the whole puddle is the circuit.
4. The warning they never caught was "don't stand in its water." Kid A is standing
   in it. The arc hits him too. On casual difficulty friendly arcs are off (§10);
   on normal, A goes down, B revives. Next run, they fight for the warning.

---

## 5. Unloading mods into the world

### What it enables

- **Stashing**, for about 20 seconds (R6). Vent your Mirror before the fight so
  your rack casts the Storm every pull, then catch it back after.
- **Trading** (R7). "I've got two frost, want one?" is a toss.
- **Lenses** (R4). The only source of dual-element rounds.
- **Traps** (R5). A mine in a doorway, in a chase path, in a boss's water.
- **Taps** (R9). Spend a known essence to buy a choice between two partly known
  ones, and open a room.

### What stops it from being degenerate

| Exploit | Why it does not work |
|---|---|
| Vent and re-catch as a free reload | Venting a live entry starts `rechargeOnWrap` (R3). Re-catch does not reset `castIndex`, the same rule as `applyModSwap` (`modSequence.ts:143`). |
| Plant a lens and hold the trigger forever | Charges: 3 + 3 × stacks, at most 9 (R4). A machine gun drains one in under a second. |
| Stash everything in the world and carry nothing | Planted bubbles expire in 20 s (R6), cap at two per diver, and never cross floors. The only durable storage is the rack and two stowed slots. |
| Unload plus re-pick means scarcity is dead | Scarcity lives in the supply (about five cores a floor plus one draft pick), not in the act of holding. Venting moves an essence; it never makes one. Spending (lens charges, mine bursts, taps) destroys them. |
| Farm cores by leaving echoes alive | Cores come only from kills and are fixed at populate time on a fork (`populate.ts:98` pattern). No respawning cores. |
| Tap with a junk essence | A tap names one hue. A wrong hue does nothing. |
| Grief a teammate by catching their planted bubble | Catching a planted bubble takes a deliberate B press, so walking through it is safe. Stealing is possible and loud. That is a conversation, which is the point (§7). |

---

## 6. Two guns: no

**Decision: one permanent still per diver. No second built gun.** The second
"gun" in this design is the world, and in co-op it is your teammate.

The owner wants a second gun for agency: "instead of randomly taking stuff off the
ground... prepare for a boss who is weak to lightning". This design delivers that
agency in three places a second gun would not reach:

1. **Acquisition is chosen.** Hue on the echo tells you what a kill pays before
   you fire (R1). Kill order is acquisition order. That replaces "randomly taking
   stuff off the ground" directly.
2. **Discarding is chosen.** Venting (R3) means a bad essence is a planted lens,
   not a bricked slot. INSPO's slot-machine ruling (§1, "free reordering is not
   optional") extends to "free *removal* is not optional".
3. **Preparation is chosen.** The Approach (§4) gives a floor-long window to
   hunt for a specific hue and set up both stills for one fight.

Why not two guns anyway:

- **It re-creates the complaint.** The one-weapon rule exists because the owner
  "only used the pistol because it carried the mods" (INSPO §7, PR #53). With two
  built guns and five essences a floor, the rational play is to put everything in
  one of them. Splitting five essences across two racks halves every
  combination.
- **The pad does not have room.** On the 8BitDo Lite 2 the attack is on A, RB,
  and both triggers (`padProfile.ts:125`, `attack: [0, 5, 6, 7]`). A weapon swap
  is another button and another thing to do in a fight every couple of minutes.
- **The stowed bandolier already gives a reserve.** Two stowed entries (R2) are a
  second loadout you can swap in with the existing reorder input, without a second
  weapon: "keep the Storm stowed until the boss".

**Optional, recommended: pick your still at run start.** Each diver chooses one
of the four sequence shapes (pistol, shotgun, machine gun, sledgehammer) as their
permanent weapon on the start screen. This is not weapon loot, so the one-weapon
rule holds. It gives two kids complementary roles: the shotgun eats lenses in one
pull, the pistol gets the most out of one, and the sledgehammer can **bat** a
planted bubble (a melee hit on a bubble launches it along the swing, where it
bursts on the first body). Weapon identity becomes "what I do with bubbles",
which is INSPO's "weapon identity and combination depth are one system" (§1).

---

## 7. Co-op

### What the second player does

The same things, and something only the pair can do: dual-element rounds (§3d).
Roles emerge from still shapes and from who caught which clue, not from a class
system.

### Why kids have to talk

This design puts information and power in different heads on purpose. Every
mechanic below produces a spoken sentence:

| Mechanic | The sentence it makes |
|---|---|
| Hue-telegraph (R1) | "Kill the purple one, we need lightning!" |
| Split soundings (§4) | "Mine says it's a water thing." "Mine says purple!" |
| Lens (R4) | "Wait, stand there. Shoot through my purple one." |
| Toss (R7) | "I've got two ice, catch." |
| Mine (R5) | "Don't lead it through there, that's my freeze trap." "Lead it through there!" |
| Tap (R9) | "The door wants orange. Who has orange?" |
| Lens charges | "Stop shooting through it with the machine gun, you're wasting it!" |
| Steam trap (§3e) | "Why is it healing?" "You put the fire out!" |

The split soundings are the strongest lever. The clue lives only on the catcher's
screen (per-player HUD, rendered from a sim event, §8), so the only way to share it
is to say it. On one shared screen (local pad co-op, `docs/controllers.md`) the
asymmetry cannot exist, so all clues show to everyone. It only works over BLE, on
separate phones, which is how the owner plays.

### Does "bad combos are funny" survive co-op?

INSPO leaves this open (§1 Noita). This design answers it by moving the funny part
into the world where both kids see it. A bad rack still only hurts its owner
(sequencing is per-weapon). A bad *world* combo is shared and visible: the steam
that heals the boss, the Storm mine that arcs into a wet teammate, the machine gun
draining a lens. Those are slapstick, they are loud, and they have an obvious
culprit to laugh at. The one case that is not funny, friendly arcs downing a kid,
is gated by difficulty (§10).

### Solo

Everything works solo: you can plant and shoot through your own lens (with the
lower gain in §3f), soundings all go to you, and taps work the same. Solo loses
only the second rack. No mechanic here requires two players to win, which
`boss-variety.md` §6 insists on ("check the solo case first").

---

## 8. Data shape

Every new field is optional and absent by default, the repo's snapshot-stability
discipline (`entity.ts:185-188`, the comment on `ItemStack.mods`). With the flag
off, no world, fixture, or snapshot changes.

### Registry: `src/game/data/essences.ts` (new)

```ts
export type HueFamily = 'storm' | 'cold' | 'flame' | 'mirror' | 'flight' | 'weight'

export type BurstVerb =
  | { kind: 'status'; status: 'electrified' | 'frozen'; via: 'shock' | 'freeze' }
  | { kind: 'ignite' }
  | { kind: 'shrapnel'; shards: number }
  | { kind: 'shove'; knockback: number }
  | { kind: 'blast'; radius: number; damage: number }

export interface HueDef {
  family: HueFamily
  /** Render tint for the echo glow, bubble, and swatch. Inert to the sim. */
  color: number
  burst: BurstVerb
}

export const HUES: Record<HueFamily, HueDef> = { /* six rows, table in §3a R5 */ }

/** Every mod id belongs to exactly one family. A test asserts total coverage
 * over MODS, so a new mod without a family fails CI rather than rendering grey. */
export const MOD_FAMILY: Record<keyof typeof MODS, HueFamily> = { /* 18 rows */ }
```

### Entity (`src/game/entity.ts`)

```ts
export type BubbleState = 'drift' | 'planted' | 'tossed'

export type Bubble =
  | {
      kind: 'essence'
      mod: WeaponMod            // the essence, stacks included
      state: BubbleState
      charges: number           // lens passes left (R4)
      expiresTick?: number      // planted only (R6)
      ventedBy?: EntityId       // for the 2-per-diver cap and toss self-catch
    }
  | {
      kind: 'sounding'
      clue: 'silhouette' | 'hue' | 'warning'
      state: 'drift'
    }

interface Entity {
  // ...
  /** Present on an essence or sounding bubble (a `pickup` entity). */
  bubble?: Bubble
  /** Present on a cored echo: the mod its junk core releases on death (R1). */
  core?: WeaponMod
  playerCtl?: {
    // ...
    /** Soundings this diver caught this run-floor. Drives the per-player HUD. */
    locket?: ('silhouette' | 'hue' | 'warning')[]
  }
  projectile?: {
    // ...
    /** A lens rider (R4): one extra mod picked up in flight, at most one. */
    rider?: WeaponMod
  }
}
```

The discriminated union makes the illegal states unrepresentable: a sounding has
no charges and cannot be planted.

### World (`src/game/world.ts`)

```ts
interface World {
  // ...
  /** Flag gate, alongside modCasting. Absent = off, byte-identical to main. */
  essenceBubbles?: true
  /** Set on the Approach floor: the boss the next floor will field. Pure
   * function of seed+floor via bossSchedule on the 'boss-schedule' fork. */
  approach?: { bossId: string; weakness: HueFamily; warning: string }
}
```

### Objects (`src/game/data/objects.ts`)

```ts
stillTap: { id: 'stillTap', name: 'Still-Tap', hp: 9999, damageThreshold: 9999, tap: { wants: 'flame' } }
```

`ObjectDef` gains `tap?: { wants: HueFamily }`. The door it opens links by a
`tapId` on the door, mirroring `door.nodeId`.

### Input (`src/game/types.ts`)

```ts
interface InputCmd {
  // ...
  /** Essence bubbles only: vent a rack entry this tick. Packed
   * `(op << 8) | index`, op 1 = plant, 2 = toss. Edge-triggered and optional,
   * exactly like modSwap: absent on every input that does not ask. */
  still?: number
}
```

Catching a planted bubble uses the existing `interact`. Socketing a tap is a
plant within one tile of a tap (R9), so it needs no extra op.

### Serialization

`serializeEntity` clones entities verbatim (`serialize.ts:73`, per
`boss-variety.md` §4.5), so `bubble`, `core`, `locket`, and `rider` round-trip
with no codec change. RNG: cores are assigned on a new `'cores'` fork, taps on
`'taps'`, and the boss schedule on `'boss-schedule'`. The layout stream is never
touched.

### Wire cost (BLE)

| Data | Encoding | Bytes |
|---|---|---|
| A bubble | Existing `mod.<id>` archetype (already registered, `messages.archetypes.test.ts:40`). Charges ride in `hpPct` (charges / 9). State in two bits of `flags`. | **0 new** |
| A sounding | New archetype `sounding`, registered, `PROTOCOL_VERSION` bump (`src/net/types.ts:24`, today 4). The clue is not on the wire. | 0 new per entity |
| A lens rider | Appended to the projectile's existing mod provenance list (`messages.ts:275`, 1 byte per mod, `WIRE_MOD_CAP`). The renderer composes the dual look for free (Nova Drift, INSPO §1). | **+1** per lensed bullet |
| A cored echo's hue | Extend the projectile-only mod list to NPC records that carry a `core`: 1 length byte + 1 packed mod byte. | **+2** per cored echo in interest radius, typically ≤ 5, so ≤ 10 per snapshot |
| The `still` input | Optional trailing u16 on the input frame, +1 biased, the `modSwap` pattern (`messages.ts:344`). | **+2** only on the tick it is used |
| Sounding clue text | Not sent. The client computes it from `seed`, `floor`, and the `soundingCaught { byId, clue }` event, because it is a pure function of seed+floor. | 0 |

Entity budget: bubbles count against the 48-entity snapshot (`messages.fuzz.test.ts:87`).
Two planted per diver × 4 divers = 8 worst case, plus up to 5 drifting cores.
Measure it with a 4-diver fuzz case before shipping.

### Systems

| File | Change |
|---|---|
| `src/game/systems/essence.ts` (new) | `ventEntry`, `catchBubble`, `lensPass` (projectile crosses bubble), `burstMine`, `expireBubbles`, `releaseCore`. Pure over `World`, iterating in id order. |
| `src/game/systems/combat.ts` | Apply `projectile.rider` at the hit: modifier riders fold via `resolveWeapon`; elemental riders apply a second `onHit` and fire the pair reaction. |
| `src/game/systems/interactions.ts` | `shock()` reads `resistMult(e, 'electrified')` and treats frozen as conductive (Conductor); Steam and Wildfire hooks. |
| `src/game/systems/interaction.ts` | `autoPickup` skips planted bubbles; `interact` catches them; taps consume matching bubbles. |
| `src/game/systems/missions.ts` | Consult `bossSchedule` when flagged. |
| `src/game/populate.ts` | Assign cores on the `'cores'` fork instead of room drops when flagged; place soundings and the tap on the Approach. |
| `src/game/world.ts` | `essenceSystem` slot in `tickWorld`, after projectiles move and before hit resolution. |

---

## 9. Pad UI

Pad-first, no mouse, no menu that pauses the fight.

### Controls

| Button (standard mapping, `padProfile.ts:125-133`) | Today | This design |
|---|---|---|
| A, RB, RT | attack | attack |
| **LT (6)** | attack (duplicate) | **hold: open the still** |
| B | interact | interact; catches a planted bubble |
| Select (8) | throw grenade | throw grenade |
| LB | roll | roll |

LT leaves the attack list (A, RB, RT remain), so nobody loses fire.

**While LT is held** (you keep moving at half speed, you can be hit):
- The rack appears as a ring of bubbles around your diver, the locket-cage from
  LORE canon #5. The live chambers are bright; the two stowed are dim.
- **Right stick** points at a chamber (it is the aim stick, already
  radial-deadzoned in `readPad.ts`). The selected bubble swells.
- **A**: pick up the selected bubble, point at another, **A** again to swap
  (emits `modSwap`, the existing input).
- **B**: vent the selected bubble at your feet (plant). Next to a tap, this
  sockets it.
- **X**: toss the selected bubble toward the nearest teammate in the aim cone, or
  along the aim if none.
- Release LT to close.

The ring shows what will actually execute (#88): chambers are grouped into casts
with a bracket, a modifier that rides on nothing is drawn cracked, and a rider
preview appears on a chamber when you stand behind one of your planted bubbles.

### Screens and HUD

- **Echo glow.** Cored echoes carry a soft hue halo, the *hue-telegraph* tint
  shader from LORE (engine tint on existing sprites). Coreless echoes do not glow.
- **Planted bubbles** show charge pips around them, and a ring that shrinks to
  the 20-second expiry.
- **Catch toast.** "essence of: a battery that outlived the colony", one line,
  1.5 s, bottom edge (INSPO §8: do not cover the game with text).
- **Sounding card.** On catch, a card in the catcher's bottom corner for 3 s, then
  a locket icon that stays on that diver's HUD only. D-pad is movement
  (`readPad.ts:190`), so the card needs no input to dismiss.
- **Boss bar.** A weakness swatch next to the name. Grey for divers without the
  hue clue until the first hit with that essence reveals it to all.
- **Taps.** The wanted hue glows on the tap. The porthole shows the vault's two
  hues.

---

## 10. Risks and the failure mode to measure

### The dominant-strategy risk

**Conductor everywhere.** Frost + Storm freezes, then chains, then shatters. It is
the flashiest pair and the one most likely to be strongest against the whole
roster, because no `resist` row resists `frozen` or `electrified` today (every
row in `npcs.ts` keys only `physical`, `burning`, `poisoned`, `spore`). If it is
top against more than half the roster, runs collapse into "hunt white and violet",
and the owner's ruling 4 is broken (INSPO §1: "a dominant pair is a failure of the
mechanic even when it is fun").

The second risk is **lens farming**: a glass-cannon pistol behind a Storm lens.
Charges cap it, but the cap is a number, so it has to be measured.

### The sweep that detects it

Build the lever (a script, not a hand check): `scripts/test/build-space-sweep.ts`.

1. Enumerate, for each of the four still shapes, every rack of up to `slots` over
   a 5-mod hand, plus each possible single lens rider from a second 5-mod hand.
   INSPO measured that length-4 racks over 18 mods is about 105k sequences, which
   is exhaustively testable; sampling 2,000 hands per shape keeps it to minutes.
2. For each composition and each roster archetype, load a fixture with
   `loadFixture` (`src/game/testkit.ts`), place one pack of that archetype at
   range 6, and `runTicks` for 20 s with scripted fire.
3. Record an outcome vector: time to kill the pack, seconds of enemy control,
   bodies affected per trigger pull, damage taken by the shooter, lens charges
   spent.
4. Report:
   - **Dominance.** For each composition, the share of archetypes where it is
     top-5% by time to kill. **Fail** if any composition exceeds 50%.
   - **Distinct in play.** Cluster outcome vectors (k-medoids on normalised
     vectors); report the number of clusters with a distinct best-answered
     archetype. That is the **measured** version of §3f Count 1. Target: at least
     one cluster per roster row in the §3f table.
   - **Dead combos.** Compositions indistinguishable from an empty rack. Each one
     is a lie on the screen (#88).
5. Run it in CI on a fixed seed as a regression gate, and save the per-archetype
   table as a PR artifact.

### Other risks

| Risk | Mitigation |
|---|---|
| Friendly arcs down kids (Storm mine plus a wet teammate). | Arcs skip players on `casual` (`world.ts:105` already gives casual endless self-revives); on normal they hit, which is the warning clue's payoff. Adversarial test: two wet players, one mine. |
| Legibility on a phone: glows, pips, riders, rings. | Six hues only, drawn from the existing essence palette (teal, ember, violet in LORE). Riders render through the existing Nova Drift composition, no new art. Verify at phone size with `verify-sporefall`. |
| Snapshot budget. | 2 planted per diver cap; fuzz case with 4 divers and 13 bubbles against the 48 ceiling. |
| Soundings missed entirely. | The guaranteed weakness core and the reveal-on-hit rule keep the fight winnable without clues. Clues make it easier, never possible. |
| Mission RNG change for existing seeds. | `bossSchedule` on its own fork, consulted only under the flag; golden digests from `main` stay green with the flag off (the PR #78 method). |
| Solo-unwinnable Approach tap (no matching hue). | Taps are optional side rooms, never on the critical path. |
| Composing with in-flight work. | #84 (draft) is untouched, still one pick at clear. #87 (element verbs) changes what each burst verb *feels* like, not the rules here; R5 names the functions it calls, so #87's changes flow through. #88 is required for the ring UI. #89 (bog tide) supplies water cells that make Storm mines stronger on flooded floors. |

---

## 11. The smallest prototype that proves the fun

**Question it answers:** is shooting through a friend's bubble fun, and does it
make two people talk? Everything else (soundings, taps, cores, the Approach)
waits on that answer.

**Flag:** `essenceBubbles` in `src/app/featureFlags.ts`, requiring
`sequencedMods`. Off by default. With it off, the golden digests from PR #78 stay
byte-identical.

**In the slice:**

1. Vent to plant only (no toss). `InputCmd.still` with op 1.
2. Planted bubble entity: charges, 20 s expiry, B to catch back.
3. Lens: one rider per projectile, applied at hit.
4. Mine: Storm, Cold, and Flame burst verbs only.
5. One pair reaction: **Conductor**. It is the aha, so it is the one to test.
6. LT-hold still ring with right-stick select, A swap, B vent. Keyboard binds for
   the headless recorder.

**Out of the slice:** toss, taps, cores, hue glow, soundings, Approach, boss
schedule, Steam, Wildfire, wire changes beyond the input u16 (bubbles already ride
as `mod.<id>`).

**Scenario:** `?scenario=lens` in `src/game/scenarios.ts`, built like `armed`
(`scenarios.ts:881`): floor 3, the diver holds a shotgun with
`[frost][choke][shock][bulk]`, a Storm bubble already planted two tiles ahead,
and a pack of six robots (`physical 0.4`, so plain fire is poor and Conductor is
the answer) released from a room ahead. Also run it as `?scenario=boss-freeze`
(`scenarios.ts:964`) plus a planted Cold bubble to check the phase-3 mine against
the Mireclaw.

**Files touched:**

| File | Why |
|---|---|
| `src/app/featureFlags.ts` | The flag. |
| `src/game/types.ts` | `InputCmd.still`. |
| `src/game/entity.ts` | `bubble`, `projectile.rider`. |
| `src/game/data/essences.ts` (new) | `MOD_FAMILY`, three burst verbs. |
| `src/game/systems/essence.ts` (new) | vent, catch, lens pass, mine burst, expiry. |
| `src/game/systems/combat.ts` | Apply the rider at the hit. |
| `src/game/systems/interactions.ts` | Conductor: frozen conducts, arc shatters. |
| `src/game/systems/interaction.ts` | `autoPickup` skips planted; interact catches. |
| `src/game/world.ts` | `essenceSystem` in `tickWorld`. |
| `src/net/protocol/messages.ts` | Optional trailing u16 for `still`. |
| `src/input/padProfile.ts`, `src/input/gamepadCoop.ts` | LT leaves attack; LT-hold ring inputs. |
| `src/ui/` (new `stillRing.ts`) | The ring. |
| `src/game/scenarios.ts` | `lens` scenario. |

**Tests (adversarial, via `deserializeWorld` and `runTicks`):**

- Vent starts the recharge; catch-back does not reset `castIndex`.
- A lens gives exactly one rider per projectile, never two, and a round that
  already has the element spends no charge.
- Charges hit zero, the bubble dies, the next pellet gets nothing.
- Expiry at exactly tick 600 after plant.
- A third plant pops the oldest.
- A player walking through a planted bubble neither catches nor bursts it.
- Conductor: a frozen pack plus one storm-rider hit shatters every body in the
  chain; the same with an unfrozen dry pack stuns one body and stops.
- Determinism: two runs, same seed and inputs, byte-identical `serializeWorld`.
- Flag off: golden digests match `main`.

**Video:** an `e2e/` recording (`record()` in `e2e/lib.mjs`) of the `lens`
scenario: plant, fire, the arc walking across a frozen pack. That clip is the pitch
for everything else in this document. If the clip is not exciting, stop here.

**What would make me cut the design.** If, in a BLE play session with the owner
and a nephew, nobody says "shoot through my bubble" unprompted within three
floors, the co-op thesis has failed and the lens should be demoted to a solo trap
mechanic. That is the one observation that decides it.
