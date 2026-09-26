# Why combining things is fun, and how to make Sporefall's combinations matter

A research whitepaper on the combinatorial weapon mechanic, the science of why it
is enjoyable, and what that science says to build next.

Status: research and recommendations. Nothing here is built. Owner quotes come
from `INSPO.md` (open as #82 on the `docs/inspo` branch) and from the loadout
brief of 2026-09-25. Measured numbers come from the arena census (#121,
`docs/design/arena-census.md`), the substrate census (#122,
`docs/design/substrate-census.md`), and the persona playtests of the three
loadout prototypes (#111, #112, #113). Every claim about a study cites a paper
in [References](#8-references) that was opened and checked while writing this.

## 1. Abstract

SECTION_1

## 2. What the owner is actually after

### 2.1 The combinations are the game

The owner's framing fits in two sentences: "the combinatorial complexity matters
a lot. That's the core game mechanic." In the loadout brief he sharpened it to
"significant, meaningful combinatorial complexity". The word doing the work is
*meaningful*.

Design B counted 22,620 possible wands of up to four chips. The arena census
fought 21 builds through the real sim and found that today's elements give
about three distinct answers. The gap between 22,620 and three is the subject
of this paper. A combination only counts if it plays differently from its
neighbours in a situation the game actually puts in front of the player.

### 2.2 Eight rulings, one taste

His rulings on mods (INSPO §1, §7 and §8) read like a list. They come from one
taste.

- **Verbs, not numbers.** "we need to ensure each element feels different - they
  can't all be damage over time". INSPO turns this into a test: could you say
  what the element does without naming a number?
- **A grammar, not a table.** Each mod carries a transformation rule, so every
  arrangement has a defined result by construction. A hand-authored pair table
  grows factorially and never finishes.
- **Composition, not alternation.** "maybe the arrangement makes _different_
  projectiles". `[frost][heavy]` is one new shot, not two shots taking turns.
- **Free reordering.** If pickup order fixes the arrangement, "it's a slot
  machine".
- **Run-to-run variety beats power.** The question is "what did this run make me
  build". A dominant pair counts as a failure even when it is fun.
- **Scarcity makes the decision.** Twenty mods a floor is a pile. Being offered
  three and taking one is a choice. Drops went from 20 to 5 for this reason.
- **Handling comes out of the composition.** "We should remove the concept of
  ammo." A heavy composition should feel heavy to fire, with no balance table
  behind it.
- **The screen tells the truth.** INSPO names the defect class: "the status
  display is truthful about intent and false about behaviour." The same taste
  rejected backbuffer shaders that sat "randomly on the ground with no effect"
  and asked for them on "bullet effects for appropriate mods" instead.

Read together, the rulings describe a system a player can reason about. Each
piece does one recognisable thing. Pieces combine by rule, so any result is
predictable in principle, but the space is too large to memorise. The screen
shows honestly what a combination does. That is a game you get better at by
understanding it, not by grinding it.

### 2.3 Agency, and a loop with a before and an after

The loadout brief adds agency. "The only reason I'd want a 2nd gun is to give
the players some agency when building their weapons, instead of randomly taking
stuff off the ground. I want them to be able to prepare for a boss who, for
example, is weak to lightning."

That sentence holds two ideas. Randomness alone is not the fun. And the fun he
wants has a before and an after: you learn something about a fight that has not
happened yet, you change your weapon because of it, and the fight goes
differently because you did. The earlier Dark Souls ask ("I want bosses like
Dark souls") points the same way, and `docs/design/boss-variety.md` sets the bar
that makes it testable: "If two bosses are beaten by doing the same thing, there
is only one boss."

### 2.4 The social payload

When he first asked for mods, he gave the reason: "I think the family would have
fun having really unique guns." The game exists to be played with his nephews,
on phones over Bluetooth, on a couch, with a controller. The heist ask shows what
he wants the kids to do together: "a multi-stage bank heist or something. that
requires careful planning amongst my nephews." The combinations are what the
family talks about. "Look what my gun does" is the sentence the mechanic exists
to produce.

### 2.5 The constraint around all of it

Everything has to fit inside the pace recorded in `docs/LORE.md`: "fast, hard,
arcadey", a "new level every couple of minutes", "you kill everyone you see". A
build decision that needs a long menu session fails. So does one a nine-year-old
cannot read at a glance.

### 2.6 The interpretation in one paragraph

The owner wants a small set of legible verbs that combine by rule into a very
large space of weapons. He wants a world that asks different questions, so that
different weapons are right at different times. He wants enough scarcity that
choosing matters, and enough information that choosing is skill rather than
luck. And he wants kids at the same table who can see what their guns do and plan
around each other's. Section 3 shows that each of those clauses matches a known
driver of enjoyment. Section 4 shows that today the missing clauses are the
questions, the information and the legibility, not the combinations.

## 3. The science of why this is enjoyable

SECTION_3

## 4. What the playtests and the census say, read through that science

SECTION_4

## 5. Design implications

SECTION_5

## 6. Risks and ethics

SECTION_6

## 7. Open questions and experiments to run next

SECTION_7

## 8. References

SECTION_8
