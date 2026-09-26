# Design B: One Wand, Made Deep

Angle: no second gun. The one permanent weapon becomes a combo string. The order of
chips in it decides which reactions land on a target, the world keeps the half-finished
combo on the enemy's body, and every chip can leave the wand to become a thing in the
room.

Everything here is design. Nothing in the repo was edited. Claims about code cite the
file I read at `origin/main` 7e3d38c. Numbers labelled **model** come from
`b-sweep/space.py`, `space2.py`, `space3.py` and `slots.py` in this directory, a
Python enumeration of my proposed rules. They are not measurements of the game.

---

## 1. The pitch, for a 10-year-old

Your gun fires its chips in order, one after another, like a combo. Some chips go
together: soak a monster and then zap it, and the lightning jumps through everyone who
is wet. You can pop a chip out and drop it on the floor, where your friend can grab it
or you can shoot it to make it burst.

---

## 2. The core loop, beat by beat

### A normal floor (about two minutes)

1. **Arrive.** The floor banner names the floor modifier (#89) if there is one. Bog
   tide means "everything down here gets wet", and that changes what the wand does
   before the player has touched it.
2. **Fight the first group.** The player fires. The HUD strip
   (`src/ui/sequenceModel.ts`, already built for the flag) lights the next chip. Each
   trigger pull fires the next cast. Statuses pile up on enemies in the order the wand
   fired them, and **reactions pop** with a name and an icon over the target ("ZAP
   CHAIN!").
3. **Pick up a chip.** A chip on the floor (5 per floor today, `6c7a343`) or the draft
   hand (#84) offers something new. The wand has 4 live slots on the pistol
   (`src/game/data/items.ts`, pistol `slots: 4`) and a pocket of 2. The player decides
   where it goes.
4. **The puzzle moment.** Two seconds of holding Y: move the new chip into the slot
   right after the chip it combos with. This is the whole puzzle in miniature. **Which
   chip should fire right before which other chip, against the thing in front of me?**
5. **Eject or crack.** The pocket is full, so something has to go. Drop the spare Soak
   chip in the middle of the room. When the next pack walks over it, shoot it. The
   whole pack is soaked, and the next Shock round chains through all of them.
6. **Stairs.** Chips left on the floor are gone. Chips in the wand come with you.

### Before a boss

1. **The Dossier** appears at the exit of the floor before the boss floor, and again
   at the boss floor's arrival point. It is a short card with the boss's **Hide**
   (the status it always carries) and its pips: "⚡ jumps through it. 🔥 fizzles off
   it." (§4)
2. **The Reagent Hand.** The draft hand on the floor before the boss is dealt from a
   forked stream biased toward the forecast boss (§4). It is not a guaranteed answer.
   It is a better chance at one.
3. **The Bench.** The boss floor's arrival room holds a Rack object. Interacting with
   it opens the full wand editor, with the pocket and any chips on the ground within 3
   tiles. In solo the sim pauses. In co-op it does not, but the arrival room spawns
   nothing, so it is safe.

### During a boss

- The prepared wand does its job on phase 1.
- At the phase change the boss's Hide changes (Mireclaw dries off), and a combo that
  worked now fizzles. The player does **one swap mid-fight**: hold Y, move one chip,
  release. That is the skill test.
- The co-op partner cracks a chip on the brood cluster so the next chain round clears
  the adds.

### Where exactly the puzzle is

The puzzle has three places, each on a different timescale:

| Timescale | Question | Where it is answered |
|---|---|---|
| Every trigger pull | Does the status already on that target combo with what I fire next? | The target's body and the HUD preview |
| Every chip pickup (about 5 per floor) | Which slot does this chip go in, and what leaves to make room? | The wand strip, hold Y |
| Every boss | Which 4 chips, in which order, answer this Hide and its phase change? | The Dossier, the Reagent Hand, and the Bench |

---

## 3. The puzzle, precisely

### 3.1 What stays from `modSequence.ts`

Everything in the shipped grammar stays, and I read it in full
(`src/game/systems/modSequence.ts`):

- A **payload** ends a cast and supplies its one element (`isPayloadMod`: any mod with
  `onHit`).
- A **modifier** rides on the next payload.
- Running off the end **wraps** and starts `rechargeOnWrap`.
- **Free reordering** (`applyModSwap`) does not reset `castIndex` or the recharge. That
  rule is correct and INSPO ruling 6 requires it.

### 3.2 What is new

**Rule 1: status memory on the target.** The combo lives on the enemy, not in the gun.
A status a cast leaves (`Entity.fx`, the existing store) is the **primer**. The next
element to land on that body is the **incoming** element. The pair decides a reaction
from one fixed 4 by 4 table (3.3). The reaction runs whoever fired either half. That
includes a teammate, a floor hazard, a cracked chip, or the boss's own Hide.

**Rule 2: four player elements, one of them new.** `frost` (frozen), `incendiary`
(burning), `shock` (electrified) exist today (`src/game/data/mods.ts`). I add **Soak**
(`soak`, applies `wet`). `wet` exists in `src/game/data/elements.ts` and the wet plus
shock chain exists in `src/game/systems/interactions.ts`. **Today no player-held mod
makes anything wet**, so the one reaction already in the code cannot be performed from
the wand. Soak makes it performable. Poison and spore stay enemy and world elements
(sporelings are immune, `npcs.ts`). Four elements with six pairs follows INSPO ruling 2
("depth beats breadth").

**Rule 3: three form chips (a new category, `form`).** Form chips are modifiers. They
ride the next payload like any other modifier, but they change cast structure, not
stats:

- **Twin (♊).** The next **two** payloads fuse into one cast and one round. On hit it
  applies the first element and then the second in the same tick, so the reaction goes
  off instantly on a fresh target. It costs one slot, and in exchange it turns a
  two-pull combo into one pull.
- **Trail (〰).** The next payload is laid **on the ground** along the round's path as
  a strip of field cells (at most 4). It does not apply on hit. Bodies that walk through
  pick up the status. This primes a corridor or a doorway.
- **Relay (📡).** The cast after this one does not leave the gun. It rides inside this
  round and fires from the **impact point**, aimed along the original direction. This
  is Noita's trigger spell. It carries a detonator around a corner, or behind the shield
  line of a breacher.

**Rule 4: every chip is also a world object** (§5). Ejected payload chips can be
**cracked**, which bursts their element in radius 2.

**Rule 5: one chip is one entry.** Today `applyDraftPick` (`src/game/systems/draft.ts`)
merges a second copy into `stacks` on the existing entry. In this mode each chip is its
own list entry, so `[Soak][Shock][Soak][Shock]` is expressible. `maxStacks` becomes "max
copies in one wand".

### 3.3 The reaction table (the whole thing)

Each element has one verb of its own, which composes with #87 (elements differ by
verb). #87 owns the final verbs, and these are the ones this design assumes:

| Element | Verb alone |
|---|---|
| Soak (wet) | Conducts. Harmless on its own. |
| Frost (frozen) | Holds (immobilized, `IMMOBILIZE_STATUSES` in `statusFx.ts`) |
| Fire (burning) | Burns and panics (the #87 illustration) |
| Shock (electrified) | Stops for a moment (immobilized, 30 to 45 ticks) |

The primer is the status on the body, and the incoming element is what arrives:

| primer \ incoming | Soak | Frost | Fire | Shock | Bare impact |
|---|---|---|---|---|---|
| **none** | soak | freeze | ignite | zap | hit |
| **wet** | refresh | **FLASH FREEZE**: frozen, and the freeze spreads to every wet body within 1.6 tiles | *fizzle*: the fire is wasted and the wet is removed | **ZAP CHAIN**: exists today, `interactions.ts` | hit |
| **frozen** | *nothing* | *numb*: blocked by anti-chainlock | **THERMAL CRACK**: thaws with a hard burst, and the body is left **wet** (meltwater) | *numb*: blocked | **SHATTER**: exists today, `combat.ts` |
| **burning** | **STEAM**: fire out, and a steam cloud (radius 2, 3 s) blocks NPC sight | *quench*: both cancel | refresh | **WILDFIRE**: fire jumps to every body within 2 tiles | hit |
| **electrified** | soak (no chain) | *numb*: blocked | ignite | *numb*: blocked | hit |

That is six named reactions, four of them new, and four named duds. Every cell is
defined, so every arrangement has an outcome by construction. That was INSPO's
objection to a pair table, and a 5 by 5 table that never grows answers it. The
**grammar** that produces variety is the wand (order, forms, delivery), not the table.

The six reaction verbs are all different, and none of them is "more damage":

- **Chain** jumps through a crowd.
- **Flash Freeze** spreads the hold across a puddle.
- **Crack** converts ice into water. It exists to re-prime.
- **Steam** blinds, using the existing sight checks (`canSeeEntity` in `goals.ts`).
- **Wildfire** spreads fire and panic.
- **Shatter** breaks one target hard. It exists today, and PR #79 made it a very hard
  hit rather than an execute.

**Rule change I recommend: Shatter needs a bare impact.** An element landing on ice
reacts (Fire causes Crack) or is numbed. Only an element-free cast (a trailing
modifier cast at the wrap, or a melee swing) shatters. §10 shows why. Without this
rule, Frost is a universal primer.

**Order of resolution at the hit site.** `projectiles.ts:242-246` calls `applyDamage`
(which shatters a frozen body) *before* `applyStatus`. Crack has to pre-empt Shatter,
so the reaction resolver runs first: `reactOnHit(w, target, incoming)` reads `fx`,
decides the reaction, and tells `applyDamage` whether this impact may shatter.

### 3.4 Three worked examples (pistol: 4 slots, 1 cast per pull, 20-tick wrap)

**Example A: "Wet the pack, wire the line." A clean, readable build.**

`[Explosive][Soak][Pierce][Shock]`

- Pull 1 fires Explosive with Soak. The splash wets everything within 1.6 tiles of the
  impact (`explosive.explodeRadius 1.6`).
- Pull 2 fires Pierce with Shock. The round passes through the first body and zaps it.
  The body is wet, so **ZAP CHAIN** floods the whole wet cluster
  (`interactions.ts CHAIN_RADIUS 1.6`, 20 damage per wet body).
- The wrap costs 20 ticks.

It answers a **drowner tide**: the `raider` behavior in groups moves in bunches. It is
weak against a single tough target, because Chain's value is the crowd.

**Example B: the "aha". You make your own water.**

`[Twin][Frost][Fire][Shock]`

- Pull 1 fires a Twin round carrying Frost and then Fire. On hit it applies frozen and
  then fire in the same tick, which is **THERMAL CRACK**: a hard burst, and the target
  is left *wet*.
- Pull 2 fires Shock at a now-wet target, which is **ZAP CHAIN**.
- The loop is two pulls and a wrap. A player who has only ever seen Chain on a flooded
  floor discovers they can make the flood themselves, from three chips that do not
  look related.

Without Twin, `[Frost][Fire][Shock][Heavy]` does the same over three pulls, with a bare
Heavy cast at the wrap. That bare cast shatters anything still frozen, so the slower
build has a finisher and the faster build does not. Two good answers with different
handling is the goal (INSPO ruling 3).

**Example C: the trap. Three elements that look strong and do nothing.**

`[Soak][Fire][Shock][Explosive]`

- Pull 1 soaks the target.
- Pull 2 fires Fire into wet, which **fizzles**. The fire is wasted and the wet is
  removed.
- Pull 3 fires Shock at a dry target. It is a plain zap with no chain.
- Pull 4 is a bare explosive.

In the default mode today, "more elements" at least means one of them lands. Here it
means they cancel. The fix is a single swap, `[Soak][Shock][Fire][Explosive]`: Chain,
then Fire into an electrified body (plain ignite), then a bare blast. Or reverse the
pair to `[Fire][Soak]...` for **STEAM**, which blinds the pack so you can walk past it.
The trap teaches the table without a tutorial, because the fizzle has its own sound, a
grey puff, and a word over the target.

### 3.5 Why this is a puzzle and not a lookup

A lookup has one right answer that you can read off a chart. This does not, for five
reasons:

1. **Half the state is not in your wand.** The primer is on the enemy, and it gets
   there from teammates, bog-tide floods (#89), cracked chips, and boss Hides. The same
   wand fizzles on Mireclaw's soaked hide and chains on the brood beside it.
2. **Clocks.** Primers expire (`elements.ts`: wet 150 ticks, frozen 90 in the table
   and 120 from the mod, electrified 30). A combo split across the 20-tick wrap
   survives on wet and may not on electrified. A 6-slot machine gun (`rechargeOnWrap:
   45`) cannot carry an electrified primer across its wrap at all. The weapon's shape
   decides which combos are stable.
3. **Budget.** There are 4 live slots and a pocket of 2. Twin costs a slot to save a
   pull. Trail and Relay cost a slot to change the delivery shape. There is never room
   for everything.
4. **Hidden and partial information.** A reaction the party has not triggered yet shows
   as **?** in the HUD preview (the preview follows #88: it shows what will execute,
   including "Fire, fizzles on wet"). A boss's second-phase Hide is not on the Dossier.
   It is learned by fighting.
5. **The enemies move.** An area primer with a single-target detonator answers a
   clumped tide. A line detonator answers a corridor. Relay answers a shield line. The
   formation is the question, and `src/game/systems/groups.ts` already makes tides,
   packs, and hives move differently.

---

## 4. Boss preparation

### 4.1 How a player learns the weakness before the fight

**The Hide.** A boss gets one new data field: a status it keeps on itself, re-applied
on a clock. That makes "weak to lightning" a **fact you can see** (the boss drips
water, and the existing `uWet` shader in `src/render/statusUniforms.ts` draws it). It
is also a **rule the table already covers**, so no special case is needed. A boss that
is weak to lightning is a boss whose Hide is `wet`.

**The Dossier.** The boss floor is not fixed. `generateMission`
(`src/game/systems/missions.ts:94-117`) rolls `assassinate` (which spawns `boss`) at 50%
from the mission stream for that floor. That stream is a pure function of seed and
floor, so the **next** floor's mission can be forecast by building floor N+1 in a
scratch `World` that is thrown away. It is pure, deterministic, identical on every
peer, and costs zero wire bytes. It perturbs no live RNG, because it runs in a
separate world instance.

The Dossier is a sign object at the exit of floor N. It shows:

```
 NEXT: MIRECLAW ALPHA
 HIDE  💧 soaked
 ⚡  jumps through it
 🔥  fizzles off it
```

This matches the owner's example exactly, and for kids the explicit pip is right. The
**second phase** is deliberately not on the card.

Cost: one extra level generation per floor entry. That is a guess until measured.
`scripts/test/` is the place for a timing probe. If it is too slow on a phone, fall
back to a Dossier at the boss floor's arrival room, which still comes before the fight
because the boss sits in a building room (`roomCenter(building)`) and the entrance
triggers at `REVEAL_RANGE 11` (`mireclaw.ts`).

**The Reagent Hand.** #84 deals the draft from `draft:<floor>` (`floorDraftOffer`,
`draft.ts`). On a floor whose forecast says "boss next", deal from
`draft:<floor>:forecast` instead: the same weighted draw, with one card redrawn if the
hand holds no chip that combos with the forecast Hide. This is a forked stream, so
existing seeds are untouched.

### 4.2 A concrete boss: Mireclaw Alpha

What exists (`src/game/systems/mireclaw.ts`, `npcs.ts` `boss`):

- Phase 1, above 50% HP: it summons brood.
- Phase 2, 20 to 50%: it regenerates in a spore cloud unless it or the cloud is on
  fire. **Fire is already the answer to phase 2.**
- Phase 3, below 20%: it enrages.
- Its resist is `{ physical: 0.75, burning: 1.25, poisoned: 0.5, spore: 0 }`.

What this design adds (about 30 lines of data plus a tick hook):

- **Hide: soaked, phase 1 only.** It came out of the bog. It re-applies `wet` to itself
  every 60 ticks, and it leaves wet field cells where it walks, so brood standing near
  it get wet too.
- `resist.electrified: 1.6`. Reaction damage is tagged by the reaction's element, so
  `resistMult(e, 'electrified')` (`entity.ts:462`) reads it with no new code path.
- **It dries off at 50%.** It shakes (this needs the #1 telegraph; the circle
  annotation the boss doc cites is enough) and the Hide stops. That is the phase-2
  entrance, and phase 2 wants fire.

### 4.3 The fight, beat by beat

**Preparation (the Bench).** The player has `[Heavy][Shock][Fire][Pierce]` and a
pocket of `[Soak][Twin]`. Reading the Dossier gives three facts:

1. Lightning jumps through it, so Shock must fire into it while it is wet.
2. Fire fizzles off it while it is soaked, so Fire is a dead slot in phase 1.
3. From the old boss, the kid may know that fire stops the regen later.

They build `[Pierce][Shock][Heavy][Fire]`, with Soak and Twin in the pocket:

- Pull 1 fires a piercing Shock. It hits the soaked boss (**CHAIN** through the boss
  and every wet brood in its puddle) and passes on.
- Pull 2 fires Heavy riding on Fire. Heavy is a modifier, so it rides the next
  payload. Fire into wet **fizzles**, leaving a heavy impact with no fire. It is a
  known dead element, kept for phase 2 because the pocket is full.
- The wrap costs 20 ticks.

**Phase 1.** The chain clears brood as they spawn. The kid who put Fire last notices
the fizzle word and shrugs, because the heavy impact still knocks the boss back.

**The shake (50%).** Mireclaw dries off and goes to its spore cloud to regenerate. Now
Shock is a plain zap and Fire is the answer. The player holds Y and swaps Fire to the
front: `[Fire][Shock][Heavy][Pierce]`.

- Fire ignites the boss, which stops the regen (existing rule).
- Shock into burning is **WILDFIRE**. The fire jumps to every brood within 2 tiles,
  and they panic away from the boss.
- Heavy and Pierce now sit after the last payload, so they fire as one bare cast
  before the wrap. A bare impact is a Shatter finisher if anything is frozen.

That single swap is the best moment in the fight.

**The prepared answer versus the improvised one.** A player who brought Soak can crack
it on the spore cloud in phase 2, which wets the cloud and the boss. Then Shock chains
again, or Fire makes STEAM, which blinds the boss while the party repositions. Three
routes through phase 2 all work, and none dominates. That is "what did this run make
me build" (INSPO ruling 4).

**What goes wrong, on purpose.** A kid who built `[Soak][Fire]...` because "the boss
is weak to fire" (burning 1.25 today) fizzles every fire round in phase 1. The Dossier
told them. The fizzle word tells them again. The fix is one swap.

### 4.4 Other bosses from `docs/design/boss-variety.md`

These are designed but not on `main`. A grep for `vigil`, `sealkeeper` in `src/game`
finds nothing.

- **Echo** adapts its `resist` per damage kind. Reactions are separate damage kinds
  (chain, crack, wildfire), so Echo rewards a wand that cycles reactions. The design
  doc's "role split by element" becomes "role split by reaction".
- **Vigil** wakes on noise. STEAM blinds without noise, and Trail lays a status with no
  impact. This design gives Vigil a quiet toolset it does not have today.
- **Sealkeeper** hides behind doors. Relay fires the detonator from the impact point,
  and cracking a chip at a doorway primes the room beyond.

---

## 5. Unloading mods into the world

### 5.1 The verb

**Eject.** In the wand strip, press B on a chip. The chip drops at your feet as a
pickup entity. The existing mod pickup is a `pickup` with a mod `itemId`, picked up by
`autoPickup` in `src/game/systems/interaction.ts:117-134`. The ejected chip gets a
`chip` tag: `ejectedBy` and `armedAt`.

What a chip on the ground does:

1. **Stash.** Park chips you are not using this fight. The pocket is 2 and the live
   window is 4, so a 7th chip means a decision.
2. **Trade.** Your teammate walks over it and it goes into *their* wand, because
   `applyModPickup` already routes to the grabber's weapon. "I'll give you my Shock,
   you be the zapper."
3. **Crack.** An armed **payload** chip is a bomb. Any projectile that hits it,
   including an enemy's, destroys it and bursts its element in radius 2: it applies the
   status to every body and lays field cells. That runs the reaction table on everything
   in range. Crack a Soak chip under a tide and every body is primed. Crack a Frost chip
   on a wet crowd and FLASH FREEZE spreads across all of it.
4. **Bait and trap.** Drop a Fire chip in a doorway and crack it when the pack
   arrives. Drop a Soak chip where the Mireclaw walks. The chip is a placed trap that
   costs a chip.

Form and stat chips cannot be cracked. They are for trading and stashing only, so a
stray bullet never costs you a Twin.

### 5.2 What stops it from being degenerate

**"If unload plus re-pick is free, is scarcity dead?"** No, because moving a chip never
creates one. Scarcity is the number of chips the party owns, which comes only from
drops and the draft. Unload moves chips between wands, the pocket, and the floor. The
invariant, which is a test: **the total chips in all wands, pockets, and on the ground
never goes up except on a `modPickup` from a floor drop or a draft pick.** Cracking is
the only sink, and it is a real cost. You spend a permanent source of soaks for one
big soak.

Specific exploits and their guards:

| Exploit | Guard |
|---|---|
| **Eject as a free reload.** `planCasts` treats a `castIndex` past the window as "start from 0 **without** a recharge" (`modSequence.ts:81-84`). Ejecting chips shrinks the window below `castIndex`, which skips the recharge. | An eject that leaves `castIndex >= live.length` starts the recharge as if the wand wrapped. This is the first adversarial test. |
| **Eject, then re-pick to reorder.** | Nothing is gained, because reordering is already free (ruling 6). A re-picked chip appends to the end, which is strictly worse than a swap. |
| **Instant self-re-pick** when you step on the chip you just dropped. | Your own ejected chip ignores `autoPickup` for you until you have left its radius once. A deliberate B press still grabs it. |
| **Crack farming.** | A cracked chip is destroyed, so there is no farming. |
| **A stash that grows across floors.** | Ground chips are floor-local. The level regenerates from `seed+floor`, and anything left on the ground is lost on the stairs. |
| **A full wand ignores new drops** (autopickup would waste them, or overflow). | At capacity, a chip on the ground shows a lock and is not auto-picked. The player must eject first. That is the decision. |
| **A teammate's stray round cracks your stash.** | Not guarded, deliberately. Only ejected chips are crackable, and only after they arm (30 ticks), so floor loot is never destroyed. Losing a stash to your brother's stray bullet is a co-op story, and the reaction banner names who did it (§7). |

---

## 6. Two guns: no

### 6.1 The decision

**One wand.** The owner wants a second gun for **agency** ("instead of randomly taking
stuff off the ground") and for **preparation** ("prepare for a boss who is weak to
lightning"). This design delivers both without a second gun:

- **Agency** comes from free reordering (it exists), eject and stash, trading, the
  Reagent Hand, the Bench, and cracking. The player stops taking what the ground gives
  them. They choose what fires first, what leaves, what gets spent, and who gets what.
- **Preparation** comes from the Dossier, the Hide rule, and the Bench (§4).

### 6.2 Why one deep wand beats two shallow ones

1. **Combos need length, and scarcity sets the length.** At 5 chips per floor
   (`6c7a343`), a player has about 4 to 8 chips by the first boss. In the **model**, a
   wand of up to 4 chips reaches 232 distinct reaction plays (reaction by primer
   delivery by detonator delivery). A wand of up to 2 chips reaches 14 (`slots.py`).
   Two 2-slot guns give 14 plus 14 of the *same* 14 kinds. One 4-slot wand gives 232.
   Splitting the chips across two guns does not double the space. It collapses it by
   about 16 times.
2. **Two guns is alternation. INSPO ruling 7 asks for composition.** With two guns, the
   combo "soak with gun A, zap with gun B" is a weapon swap in the middle of a fight.
   That is the pattern the owner rejected when he said the arrangement should make
   *different projectiles*, not take turns. Twin is the opposite: two elements in one
   round.
3. **It re-creates "I only use the one with the mods."** The gun you did not feed
   becomes the pistol from PR #53's complaint. With a single wand, every chip you own
   is always in play.
4. **The pad has no free button.** Every standard button is bound
   (`src/input/padProfile.ts:102-116`). A weapon swap needs L3 or R3, which are already
   the hotbar, or a hold chord. The wand strip needs one hold chord (§9). Two guns would
   need both.
5. **Co-op already has a second gun: your teammate's.** Two wands on two kids with
   shared status memory on the enemies is two weapons composing. The "second gun" the
   owner wants for a boss exists in co-op by construction, and it makes the kids talk
   (§7).

### 6.3 What the owner loses (honestly)

- **The instant switch.** A second gun lets a kid hold a "boss gun" in reserve and
  press one button. Here, adapting mid-fight is a swap in the strip, which takes about
  a second and a half. For a 7-year-old that may be too slow in a panic. This is the
  biggest loss, and §10 names it as a thing to measure.
- **Two handling feels at once.** A shotgun for the close room and a pistol for the
  corridor is a real pleasure this design gives up. Partial answer: a **Frame chip** in
  the draft, at most once per run, re-shapes the one weapon (pistol to shotgun shape,
  keeping every chip). Handling varies by run, not within a fight.
- **A simple mental model for the youngest player.** "The blue gun is for the boss" is
  easier than "put Shock second". The Dossier's pips and the HUD preview carry that
  weight, and that is a risk.
- **The collector fantasy** of two named guns on your back.

---

## 7. Co-op

**What player 2 does.** The same thing player 1 does, on the same enemies, and the
enemies remember both of them. Status memory is on the target, so co-op combos need no
new code:

- Leo's Soak round plus Mia's Shock round makes a **ZAP CHAIN**.
- The reaction banner names both players: "ZAP CHAIN! Leo ➜ Mia". The `reaction`
  event carries `primerBy` and `byId`. The primer's owner is the entity that applied
  the status, recorded on the `fx` entry.
- Roles appear without being designed: **the Wetter** and **the Zapper**, or **the
  Freezer** and **the Cracker**. Kids who pick roles have to say them out loud.

**Does it make kids talk?** Yes, for three reasons:

1. **The fizzle names who did it.** "FIZZLE! Mia 🔥 on Leo 💧". Leo's soak put out
   Mia's fire. That is the answer to INSPO's open question, *does "bad combos are
   funny" survive co-op?* It survives **when the game says whose fault it was**. It
   turns into resentment when it is silent. The current mod UI is silent. The
   `reaction` and `fizzle` events are what make it funny.
2. **Trading is physical.** "Drop me your Twin" means walking to your brother and
   standing there.
3. **Cracking needs a caller.** "Wait, wait, they're on the chip. NOW."

**Risk to measure:** fizzles per minute between two players, in real couch sessions
(the `observer` skill). If one kid's build keeps wasting the other's, the Dossier and
preview are not enough, and the fix is a team preview. §10 covers this.

---

## 8. Data shape

### 8.1 Registries (pure data)

```ts
// src/game/data/mods.ts
export type ModCategory = 'stat' | 'behavior' | 'trigger' | 'form'
export type FormKind = 'twin' | 'trail' | 'relay'

export interface ModDef {
  // ...existing fields
  /** Structural modifier: changes how the cast is assembled, not its stats. */
  form?: FormKind
}

// New entries, appended to MODS and to WIRE_MODS (net/protocol/messages.ts:176):
//   soak  : { category: 'behavior', onHit: { status: 'wet', ticks: 150 }, maxStacks: 3 }
//   twin  : { category: 'form', form: 'twin',  maxStacks: 1 }
//   trail : { category: 'form', form: 'trail', maxStacks: 2 }
//   relay : { category: 'form', form: 'relay', maxStacks: 1 }
// `maxStacks` means max copies per wand in this mode (Rule 5).
```

```ts
// src/game/data/reactions.ts (new). The whole table, exhaustively tested.
export type PayloadStatus = 'wet' | 'frozen' | 'burning' | 'electrified'
export type Incoming = PayloadStatus | 'impact'

export type ReactionId = 'chain' | 'flashFreeze' | 'crack' | 'steam' | 'wildfire' | 'shatter'
export type DudId = 'fizzle' | 'quench' | 'numb'

export type ReactionOutcome =
  | { kind: 'reaction'; id: ReactionId }
  | { kind: 'dud'; id: DudId }
  | { kind: 'apply' } // no interaction: apply the incoming status normally
  | { kind: 'refresh' }

/** Total over (primer | none) x incoming. A Record over a union, so a missing
 * cell is a compile error, not a runtime default. */
export const REACTIONS: Record<PayloadStatus | 'none', Record<Incoming, ReactionOutcome>>

export interface ReactionDef {
  id: ReactionId
  name: string          // "ZAP CHAIN"
  icon: string
  /** The damage kind reaction damage is tagged with, for resistMult. */
  damageKind: string    // chain -> 'electrified', crack -> 'frozen', wildfire -> 'burning'
  /** The status the body is left with, if any (crack -> 'wet'). */
  leaves?: PayloadStatus
  radius?: number
}
```

```ts
// src/game/data/npcs.ts
export interface NpcDef {
  // ...existing
  /** A status the body keeps on itself: re-applied every `every` ticks while
   * `untilHpFrac` is not yet crossed. Makes a boss's weakness visible and
   * rule-driven instead of a hidden multiplier. */
  hide?: { status: PayloadStatus; every: number; untilHpFrac?: number; trailsField?: boolean }
}
// boss: hide: { status: 'wet', every: 60, untilHpFrac: 0.5, trailsField: true },
//       resist: { ...existing, electrified: 1.6 }
```

### 8.2 Entity fields

```ts
// src/game/entity.ts
export interface Entity {
  // ...existing
  pickup?: {
    itemId: string
    qty: number
    /** Ejected weapon chip (Design B). Absent on floor loot. */
    chip?: { ejectedBy: EntityId; armedAt: number; ownerLeft: boolean }
  }
  /** A ground status cell laid by Trail, a cracked chip, a Hide, or a reaction.
   * The same lifecycle as `fire` / `spore` (fuel burns down 1 per tick). */
  field?: { status: 'wet' | 'frozen' | 'electrified' | 'steam'; fuel: number; by?: EntityId }
  projectile?: {
    // ...existing (ownerId, damage, ttl, mods, onHit, ...)
    /** Twin: the ordered elements this round applies in one tick. */
    onHitSeq?: StatusApply[]
    /** Relay: the cast this round fires from its impact point. */
    relay?: { mods: WeaponMod[]; damage: number; speed: number }
  }
}
// Fx entries gain `by?: EntityId` so a reaction can credit the primer's owner.
```

```ts
// src/game/world.ts
export type ModCasting = 'fold' | 'sequence' | 'reactive'
// 'reactive' = sequence + reactions + forms + eject + per-chip entries.

export interface World {
  // ...existing
  /** Reactions this party has triggered this run; the HUD shows '?' for the rest. */
  reactionsSeen?: number // bitmask over ReactionId, 6 bits
}
```

`ItemStack` (`entity.ts:182`) is unchanged. `castIndex` and `rechargeUntil` already
live there, and the pocket is the part of `mods` past `slots` (`liveEntries` already
calls it "stowed"). Only the cap is new: `mods.length <= slots + POCKET` (POCKET = 2).

### 8.3 InputCmd

**No new field.** Eject rides the existing `modSwap` scalar. `applyModSwap` ignores
`a === b` today (`modSequence.ts:147`), so **`packModSwap(i, i)` means "eject entry
i"**. An old host ignores it, and an input packet without it is byte-identical. The
wire is already `u16` (`messages.ts:348`). `modSwapQueue.push` drops `a === b` today
(`src/input/modSwapQueue.ts`), so an explicit `ejectAt(i)` is needed there.

The Bench's full editor sends the same swaps and ejects, one per tick through the
queue. The queue's `MAX_PENDING 16` is enough for a full re-sort of 6 entries.

### 8.4 Serialization and wire cost

`serializeWorld` is JSON of plain objects, so every field above round-trips with no
codec work. Absent fields stay absent, so every existing fixture is byte-identical.

| Addition | Wire bytes | Notes |
|---|---|---|
| 4 new mod ids | 0 | `WIRE_MODS` fits 5 bits (`messages.ts:279`). 18 are used, 22 after this, and the cap is 32. |
| Projectile `onHitSeq` / `relay` | 0 | Already implied by `projectile.mods` on the wire, since the client derives look from mods. The relayed cast spawns as an ordinary projectile on the host. |
| `field` cells | about 10 per cell | One entity record (id 2, archetype 1, flags 1, x 2, y 2, facing 1, hp 1, `messages.ts:262-270`). The status goes into the archetype (`field-wet`, `field-ice`, `field-charge`, `steam`): 4 archetypes, 0 extra bytes. **Cap 24 live field cells per floor**, so the worst case is 240 bytes. Trail lays at most 4, a crack at most 9, a Hide at most 1 per second with a fuel of 150. |
| Ejected chips | about 10 | Same as a mod pickup today. |
| **Element status on enemies** | **+1 per statused entity** | **This one is real.** I found no `fx` or element field in the snapshot codec: `SnapFlags` (`src/game/snapshot.ts`) is full at 8 bits, and a grep of `messages.ts` for `wet`/`frozen`/`fx` finds nothing. So a co-op client probably does not see who is wet (inferred, not tested on a phone). This design is unplayable without seeing primers, so it adds one byte (4 bits of status, 4 bits of coarse remaining time) for entities with any payload status, flagged by the high bit of the archetype byte (archetypes fit 7 bits). A 12-enemy fight with everyone primed costs 12 bytes per snapshot. |
| `reaction` / `fizzle` events | about 8 each | Kind, x, y, two player ids. Bounded by hits. |
| `reactionsSeen` | 1, once | In `InventoryMsg` or `GameStart`. |

The status byte also fixes an existing gap if it is real, because the `uWet` and
`uFrost` shaders on a client need it too. It should be confirmed on two phones before
anyone builds on it.

### 8.5 Determinism

- Reactions run at the host's hit site, in `w.entities` id order, like the existing
  chain flood (`interactions.ts`).
- The Dossier forecast builds a throwaway world from `seed+floor+1` and touches no live
  stream.
- The Reagent Hand uses `draft:<floor>:forecast`, a new fork label.
- Eject and crack are `InputCmd`s and hit events, and nothing new reads a clock or
  `Math.random`.

---

## 9. Pad UI

The one new binding is **hold Y**. Y is `special` today, duplicated on X
(`padProfile.ts:127`, `special: [2, 3]`). X keeps the grenade, and Y becomes the wand.

| Input | Wand strip closed | Wand strip open (holding Y) |
|---|---|---|
| Left stick | move | move (you keep moving) |
| D-pad left/right | move | **cursor** along the wand and pocket |
| A | fire | **grab** chip at cursor, then **drop** it on another slot (a swap) |
| B | interact | **eject** chip at cursor (hold 0.25 s, so a tap cannot throw a chip away) |
| Fire buttons (RB/LT/RT) | fire | fire (you can shoot while editing) |
| Release Y | | close |

The sim never pauses for the strip, because co-op cannot pause. A single swap is hold
Y, a d-pad press, A, a d-pad press, A, and release, in about 1.5 seconds (a guess,
§10). The strip draws above the HUD, and it is the existing `sequenceModel` view model
with three additions:

- **Arrows between chips** show which reaction each adjacent pair makes against a
  *fresh* target: "💧 ➜ ⚡ = ZAP CHAIN", "🔥 ➜ 💧 = STEAM", "💧 ➜ 🔥 = fizzle" in grey,
  and "?" for reactions not yet seen. This is #88's "show what will execute", extended
  one step to what executes on the *next* hit.
- **Pocket** slots in a dimmer row, after a divider.
- **Chips on the ground within 3 tiles** in a third row. A (grab) on one of them walks
  nothing. It is a pickup request that succeeds only if you are in range.

**Touch** keeps tap-two-to-swap, which exists, and adds long-press to eject.

**The Bench** is the same strip at full screen. Interact with the Rack to open it.
There is no new control grammar.

**Readable combos on the enemy.** A primed enemy wears its status shader (it exists)
plus a small icon over its head for the status the *next* chip in *your* wand reacts
with. Your Shock is next and that drowner is wet, so it shows ⚡. That is the "tap to
inspect" substrate the CLAUDE.md calls for, applied to the puzzle.

---

## 10. Risks and the failure modes to measure

### 10.1 The dominant-strategy risk: Frost as the universal primer

As first written (any impact shatters ice, which is today's rule in `combat.ts`), the
**model** shows SHATTER reachable from 4,689 of 22,620 wands up to length 4 (20.7%).
The next reaction, FLASH FREEZE, is reachable from 1,314 (5.8%) (`space2.py`). Frost
plus anything is a combo, and that is how every run collapses into "Frost first".

With the rule change in 3.3 (**only a bare impact shatters**), the spread flattens
(`space3.py`):

| Reaction | Wands reaching it (up to length 4, of 22,620) |
|---|---|
| Shatter | 1,827 (8.1%) |
| Flash Freeze | 1,773 (7.8%) |
| Zap Chain | 1,242 (5.5%) |
| Wildfire | 1,198 (5.3%) |
| Steam | 759 (3.4%) |
| Thermal Crack | 700 (3.1%) |

Reachability is not strength. **The sweep that detects dominance** is an in-sim test,
not a model:

- **Arenas.** Five frozen fixtures under `src/game/__fixtures__/`: a brute pack, a
  cinder pack, a sporeling swarm, a drowner tide on a bog-tide floor, and Mireclaw
  Alpha. Each has a player at a fixed position with scripted aim at the nearest enemy.
- **Builds.** Every wand up to length 4 over the class-collapsed alphabet (the same
  12 symbols as the model, each instantiated with one real mod). That is 22,620 wands.
  Two or three minutes of headless `runTicks` per shard, across 8 shards, is
  affordable on CI nightly (guess, measure it).
- **Metric.** Time-to-clear per arena, which is damage per second *including* recharge
  and wasted casts (INSPO ruling 3's failure mode).
- **Fail condition.** Any single wand in the top decile on 4 or more of the 5 arenas,
  or any single *reaction* present in more than 60% of the top-decile wands across
  arenas.
- **Location.** `src/game/systems/wandDominance.test.ts` runs the smallest slice (100
  seeded samples), and the full sweep lives in `scripts/test/wand-sweep.mts`.

### 10.2 Other risks

- **Legibility on a phone.** If a kid cannot see *wet* on a drowner at couch distance,
  the whole design is noise. Measure with a soul-desktop Playwright still at the
  Icewind-Dale zoom INSPO §8 names, reviewed by the VLM gate.
- **The status byte on the wire (§8.4).** If clients do not see statuses today, co-op
  combos are invisible for player 2. Verify on two phones first. This is a blocker, not
  a tuning question.
- **Mid-fight editing speed.** 1.5 seconds per swap is a guess. Put a 7-year-old on
  the boss scenario, measure time from "Mireclaw shakes" to "Fire is first", and count
  how many never make the swap. If most never make it, the answer is the **Bench plus a
  second preset**: two saved arrangements of the *same chips*, flipped with a tap of Y.
  That is the closest this design comes to a second gun, and it keeps every chip in one
  wand.
- **Co-op griefing through fizzles.** Measure fizzles per minute across players with
  the `observer` skill. If it is high and the kids are unhappy, add a team preview:
  your strip's arrows also show your teammate's next chip.
- **Chain reactions blowing the BLE budget.** Wildfire and Flash Freeze spread, and
  spreading lays fields. The 24-cell cap and the one-pass BFS (like `interactions.ts`)
  bound it. The adversarial test is a 40-body wet room with a cracked Frost chip. Assert
  the snapshot size stays under the current worst case.
- **Anti-chainlock.** Flash Freeze spreading freeze to a crowd must go through
  `applyImmobilize`'s lockout (`statusFx.ts`), or a Frost and Soak wand stun-locks a
  boss. Test it with two players.
- **The HP tuning trap INSPO records.** Reactions restore mod-based counters. Brute and
  robot HP were cut when counters did not exist. If reactions ship without revisiting
  that, everything is too easy, and "nothing goes red for too easy". The dominance sweep
  also reports mean time-to-clear against today's baseline, so an across-the-board drop
  is visible.

---

## 11. Combinatorial space

The owner's addendum: *"I'm looking to add significant, meaningful combinatorial
complexity."* INSPO §1 records the same thing from August: *"the combinatorial
complexity matters a lot. That's the core game mechanic."*

### 11.1 How I counted

A count of raw arrangements is meaningless: 18 mods in 4 ordered slots is 104,976
(INSPO's "~105k"), and most of them are the same gun with a different damage number.
So `space.py` collapses every mod into its **verb class** before counting:

| Class | Mods (today) | Why one class |
|---|---|---|
| Payload: one per element | frost, incendiary, shock, plus soak (new) | Each is a different verb |
| AREA | explosive, split, splinterShot, bulk | Hits a group |
| LINE | pierce, bounce | Hits a row or goes around a corner |
| SEEK | homing | Finds a target |
| DET | detonator | On-kill blast |
| STAT | overload, rapid, heavy, choke, velocity, glassCannon, lifesteal | Numbers only, so all one class |
| Forms (new) | twin, trail, relay | Each changes cast structure |

Two wands count as distinct only if their **cast signatures** differ: the ordered
casts, each with its elements and delivery classes, up to rotation. A **reaction play**
is a triple: which reaction, how the primer is delivered (single, area, line, seek,
ground, relay, or twin), and how the detonator is delivered. That is the thing a player
would describe differently mid-fight ("I wet the pack with the splash and then pierced
them with lightning").

### 11.2 The numbers (model, up to 4 chips)

| Rule set | Distinct cast signatures | Reaction plays | Named reactions reachable from the wand |
|---|---|---|---|
| Today, default fold (`resolveWeapon`) | 108 | 4 | 1 (Shatter, only if Frost wins the sort) |
| Today, `sequencedMods` flag | 1,709 | 16 | 1 (Shatter) |
| **Design B** | **5,650** | **232** | **6** |

Design B has about 3.3 times the distinct *shapes* of today's sequence mode, and about
**14.5 times the distinct reaction plays** (232 against 16). Today's wand can reach one
reaction, because the one other reaction in the code (wet plus shock) needs water that
no player chip provides.

It also produces **multi-reaction loops**, a category that does not exist today: 1,535
wands (964 with the bare-shatter rule) trigger two or more different reactions on one
target within one loop. 43 of them run the full **Crack into Chain** chain, where ice
becomes water and then lightning.

As the wand lengthens, depth keeps growing (`slots.py`):

| Max wand length | Reaction plays |
|---|---|
| 2 | 14 |
| 3 | 88 |
| 4 (pistol) | 232 |
| 6 (machine gun) | 294 |

This is also why a longer wand is a real reward, and why the machine gun's 6 slots and
45-tick wrap are a different puzzle, not a bigger number.

### 11.3 Why these combinations are meaningful and not stat soup

Three tests, each one INSPO's:

1. **Each reaction is a different verb.** Chain jumps, Flash Freeze spreads the hold,
   Crack converts, Steam blinds, Wildfire spreads panic, and Shatter breaks. None of
   them can be described as "more damage" (ruling 1).
2. **Each one answers a different enemy.** The roster in `npcs.ts` is rock paper
   scissors on *damage kind*. Reactions add a second axis, which is *formation* and
   *behavior*:

   | Enemy (from `npcs.ts` / `groups.ts`) | The answer | Why |
   |---|---|---|
   | Drowner tide (bunched) | Chain | It floods a wet cluster |
   | Brute (`physical 0.35`, `burning 1.5`) | Wildfire, or Crack then Chain | Bullets bounce off it, and reactions are not `physical` |
   | Cinder (`burning 0.2`) | Flash Freeze, or Shatter | Fire is dead on it |
   | Sporeling swarm (fragile, fast) | Area Soak plus a Chain round | Too fast to single-target |
   | Gloamhound pack / stalkers (hunt by sight) | Steam | It removes sight, which is their verb |
   | Bellwether behind a raid | Relay | Fire the detonator behind the line |
   | Mireclaw phase 1 / phase 2 | Chain / Wildfire | §4 |

3. **Order changes the verb, not a number.** `[Fire][Soak]` is Steam (blind them).
   `[Soak][Fire]` is a fizzle (nothing). `[Soak][Shock]` is Chain. `[Shock][Soak]` is a
   zap and a soak. The same chips in a different order are different tools, which is
   INSPO ruling 7 made literal.

Stat mods do not disappear. They become **handling**, as INSPO ruling 3 asks: Rapid
makes the primer-to-detonator gap shorter, and Glass Cannon makes the wrap longer. They
change *which combos are stable*, not whether a combo exists.

### 11.4 How the space stays open

A big space that collapses into one build is worth one build (ruling 4). Five
mechanisms keep it open:

1. **Enemies disagree.** No reaction is best on all five dominance arenas by
   construction (11.3 table). The sweep in §10.1 checks that the construction held.
2. **Floors disagree.** Bog tide (#89) primes everything with water, so Chain wands
   peak there and Steam wands do not. Brownout favors Steam less, because sight is
   already low. The best wand changes by floor, so the Reagent Hand and the draft
   create a different answer each run.
3. **The shatter rule** (bare impact only) removes the one measured dominant primer.
4. **Duds are a cost.** A wand that tries to hold every element fizzles or quenches
   itself (Example C), so "take everything" is not a strategy.
5. **Scarcity holds.** 5 chips per floor plus one draft pick, 4 live slots, a pocket of
   2, and cracking as the only sink. You never own all 22.

---

## 12. The smallest prototype that proves the fun

**Goal of the slice:** a kid discovers "soak then zap" on their own, and a second kid
fizzles their fire and laughs. If neither happens, stop.

**Flag:** add `wandReactions` to `src/app/featureFlags.ts`. When a host builds a run,
it writes `World.modCasting = 'reactive'`, exactly the sanctioned run-rule exception
`sequencedMods` already uses. `retire` means deleted if two couch sessions fail the
goal above, and flipped to default if they pass.

**In the slice (one focused session):**

1. **The `soak` mod** is data only. Append it to `MODS` in `src/game/data/mods.ts` and
   to `WIRE_MODS` in `src/net/protocol/messages.ts`.
2. **Three reaction cells plus the dud:** Chain (it exists, and now it is reachable),
   Thermal Crack (it leaves the body wet), Fizzle, and the bare-impact Shatter rule.
   Add `reactOnHit` in `src/game/systems/interactions.ts`, called from
   `src/game/systems/projectiles.ts` before `applyDamage` at the hit site
   (`:242-246`), and tell `combat.applyDamage` whether this hit may shatter.
3. **One chip, one entry** in reactive mode: `applyDraftPick` in
   `src/game/systems/draft.ts` appends instead of merging.
4. **Eject:** `packModSwap(i, i)` in `src/game/systems/modSequence.ts` removes entry i,
   spawns a pickup with `chip`, and applies the eject-recharge guard. Add the owner lock
   to `autoPickup` in `src/game/systems/interaction.ts`, and add `chip` to `pickup` in
   `src/game/entity.ts`. Also add `ejectAt(i)` in `src/input/modSwapQueue.ts`.
5. **Crack, for Soak chips only:** a projectile that hits an armed chip applies wet in
   radius 2 and kills the chip, in `src/game/systems/projectiles.ts`.
6. **Scenario `wand-lab`** in `src/game/scenarios.ts`: the `armed` kit swapped to a
   pistol with `[Frost][Fire][Shock][Heavy]` and a pocket of one Soak chip, on floor 3,
   facing a drowner tide (`groups.ts` has the raid). Open it with
   `?mode=solo&seed=18&scenario=wand-lab&floor=3`, next to the owner's familiar
   `armed` URL (`src/app/deepLink.test.ts`).
7. **Pad strip, minimal:** hold Y, d-pad cursor, A swap, B eject, added to
   `src/input/padProfile.ts` and `src/input/gamepadCoop.ts`. The strip view is the
   existing `src/ui/sequenceModel.ts` with a fizzle/reaction arrow between adjacent
   chips.

**Out of the slice:** Twin, Trail, Relay, Steam, Wildfire, Flash Freeze, Hides, the
Dossier, the Bench, the Reagent Hand, and the status byte. Solo on one device does not
need the byte. The slice's co-op test is same-machine co-op (the `verify-sporefall`
skill), which renders from the host world.

**Tests the slice ships with**, each built with `deserializeWorld` or `testkit` and run
through `runTicks`:

- **Soak then Shock** on a wet cluster: every wet body within 1.6 is electrified and
  takes 20 damage. That uses the existing `interactions.ts` numbers.
- **Soak then Fire** fizzles: no `burning`, wet is removed, a `fizzle` event is emitted,
  and damage is plain impact only.
- **Frost then Fire** cracks: no `shatter` event, and the body is left `wet`. Then
  **Frost then bare Heavy** shatters.
- **Eject past `castIndex`** starts a recharge. This is an adversarial test: fire 3 of
  4, eject 2, pull, and assert no shot.
- **Chip conservation**: across 1,000 random `InputCmd` streams of swaps, ejects, and
  walks, the total chip count never increases.
- **An old recording with no `modSwap` replays byte-identically.** With the flag off,
  golden digests are unchanged, the same proof PR #78 used.
- **An e2e video**: `e2e/` `record()` of `wand-lab`, showing a chain, a fizzle, and a
  crack in 20 seconds. That clip is the pitch to the owner.

**What the slice proves or kills:** whether "the order of my chips is a combo I can
feel" survives a real fight at arcade pace. If a kid never reorders, even after a
fizzle, the depth is invisible and the second-gun design (one button, obvious) wins.
