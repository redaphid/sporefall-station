# Why combining things is fun, and how to make Sporefall's combinations matter

A research whitepaper on the combinatorial weapon mechanic, the science of why
it is enjoyable, and what that science says to build next.

Status: research and recommendations. Nothing here is built. Owner quotes come
from `INSPO.md` (open as #82 on the `docs/inspo` branch) and from the loadout
brief of 2026-09-25. Measured numbers come from the arena census (#121,
`docs/design/arena-census.md`), the substrate census (#122,
`docs/design/substrate-census.md`), and the persona playtests of the three
loadout prototypes (#111, #112, #113). The three loadout design docs, their
brief, the playtest protocol and the playtest scores are in
[`docs/design/loadout-exploration/`](design/loadout-exploration/), and the
research notes behind this paper are in
[`docs/whitepaper-research/`](whitepaper-research/). Every claim about a study cites a source in
[References](#8-references) that was opened while writing this, and each
reference says whether its full text, its abstract, or only its record was
read.

## 1. Abstract

Sporefall's core mechanic is a weapon built by combining scarce mods. The owner
wants the combinations to be meaningful, not just numerous. Different runs
should make players build different weapons. A player should be able to
prepare for a boss that is weak to lightning. And his nephews, aged about 8 to
12, should be able to see what their weapons do and plan around each other's.

This paper reads the owner's rulings as one design (section 2), then sets out
what the research on game enjoyment says about each part of it (section 3).
The findings that matter most:

- Close, uncertain fights are enjoyed more than certain wins.
- A dominant strategy collapses a large choice space into one answer.
- A choice between three to five options, repeated a few times, suits a child
  choosing mid-run.
- Agency needs a desire that the game both creates and satisfies.
- Working memory is small and still growing across the nephews' age range:
  about 2 to 2.5 items in the early school years, 3 or 4 in adults, with
  roughly linear growth until about 14.

Section 4 reads the persona playtests and the two censuses through that
research. The three loadout prototypes did not fail for lack of combinations.
They failed for two reasons. The world asked no questions: floor-1 foes lost
the damage race by 3 to 9 times, and after #92 one build won all 40 non-boss
fights. And the kids could not see what their builds did. The census did find
the one fight where preparing for a lightning weakness pays: a flooded lair in
which Tesla wins 8/8 and frost, fire and the generic hand win 0/8.

Section 5 turns this into recommendations, each with a prediction that the
census or the playtest tool can check. Section 6 covers risks, including the
ethics of random rewards for children. Section 7 lists the next experiments.
The last of them is the only one that measures the real audience: watching the
nephews play.

## 2. What the owner is actually after

### 2.1 The combinations are the game

The owner's framing fits in two sentences: "the combinatorial complexity matters
a lot. That's the core game mechanic." In the loadout brief he sharpened it to
"significant, meaningful combinatorial complexity". The word doing the work is
*meaningful*.

Design B counted 22,620 possible wands of up to four chips. The arena census
fought 21 builds through the real sim and found that today's elements give about
three distinct answers: frost, fire, and fire plus a lock. After #92 made
burning foes panic, the substrate census (with #99 and #101 merged alongside)
found one build, `incendiary+pierce`, that won all 40 non-boss fights. The gap
between 22,620 and one is the subject of this paper. A combination only counts
if it plays differently from its neighbours in a situation the game actually
puts in front of the player.

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
  rejected backbuffer shaders that sat "randomly on the ground with no effect",
  called the on-screen labels "obtuse", and asked to "use shaders to make
  lightning look like lightning". The truthful mod UI (#93) is now on `main`.

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
differently because you did. That loop needs three things: a way to learn the
weakness, a way to act on it, and a fight where acting on it changes the result.
Section 4 measures how far the game is from each. The
earlier Dark Souls ask ("I want bosses like
Dark souls") points the same way, and `docs/design/boss-variety.md` sets the bar
that makes it testable: "If two bosses are beaten by doing the same thing, there
is only one boss."

### 2.4 The social payload

When he first asked for mods, he gave the reason: "I think the family would have
fun having really unique guns." The game exists to be played with his nephews,
on phones over Bluetooth, on a couch, with a controller. The heist ask shows
what he wants the kids to do together: "a multi-stage bank heist or something.
that requires careful planning amongst my nephews." The combinations are what
the family talks about. "Look what my gun does" is the sentence the mechanic
exists to produce. His ask for NPC memory says the same about the world: "I want
the players actions to name differences in the world and characters they can
_feel_."

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
luck. And he wants kids at the same table who can see what their guns do and
plan around each other's. Section 3 shows that each of those clauses matches a
known driver of enjoyment. Section 4 shows that today the missing clauses are
the questions, the information and the legibility, not the combinations.

## 3. The science of why this is enjoyable

This section covers what the research says about each clause of the
interpretation in section 2.6. Two warnings apply to all of it. First, almost
every study below used adults or adolescents. Where a study used children, the
text says so. Second, some sources are essays or talks, not studies. They are
labelled, and they are used for vocabulary, not as evidence.

### 3.1 Three needs: competence, autonomy, relatedness

Self-determination theory explains motivation through three needs. Ryan, Rigby
and Przybylski (2006) ran four studies, from 89 undergraduates playing Super
Mario 64 to a survey of 730 online players, and found that "SDT's theorized
needs for autonomy, competence, and relatedness independently predict enjoyment
and future game play." Their account of each need reads like a description of
Sporefall's goals:

- **Autonomy** is "enhanced by game designs that provide considerable
  flexibility over movement and strategies, choice over tasks and goals".
- **Competence** is enhanced where "game controls are intuitive and readily
  mastered, and tasks within the game provide ongoing optimal challenges and
  opportunities for positive feedback." One of their questionnaire items is a
  good one-line brief for a Sporefall floor: "The game kept me on my toes but
  did not overwhelm me."
- **Relatedness**, in their multiplayer study, "promotes a sense of presence,
  game enjoyment, and an intention for future play."

Przybylski, Rigby and Ryan (2010) add two points that matter here. Mastery of
the controls is "a necessary, but not sufficient, condition": it gates the fun
but does not explain it once the three needs are measured. And the kind of
feedback matters. Feedback that shows "how the player excelled and suggest[s]
tactics for future improvement" should support the needs, while feedback given
"only in terms of what went wrong" is "likely undermining". The authors present
the feedback point as a proposal, not a tested result.

For Sporefall, this gives each playtest failure a name. A build that wins every
fight takes away autonomy, because the choice no longer changes anything. A
floor that never threatens takes away competence, because nothing is overcome.
A build the kid cannot read takes away the feedback that competence runs on.

### 3.2 Challenge, suspense and uncertain outcomes

Flow (Csikszentmihalyi, 1990) is the older frame. Sweetser and Wyeth (2005)
turned it into GameFlow, a checklist of eight elements for evaluating games:
concentration, challenge, player skills, control, clear goals, feedback,
immersion and social interaction. Several of their criteria read as direct
tests for Sporefall:

- Challenge: "If the challenges are greater than the skills, the result is
  anxiety; if the challenges are less than the skills, the result is apathy".
- Feedback: "players should receive immediate feedback on their actions" and
  "should always know their status or score".
- Control: players should feel "free to play the game the way that they want
  (not simply discovering actions and strategies planned by the game
  developers)".

GameFlow is a heuristic model checked by expert review of two strategy games,
not a player study. The stronger evidence comes from Abuhamdeh and
Csikszentmihalyi. In online chess and in experience sampling, they found that
"perceived challenge strongly predicted enjoyment", that games against
stronger opponents were more enjoyable than games against weaker ones, and that
"close games were more enjoyable than blowouts" (Abuhamdeh & Csikszentmihalyi,
2012). A later experiment manipulated how close a competitive video game was.
"Greater outcome uncertainty led to greater enjoyment, and this effect was
mediated by suspense." Winning by a wide margin "maximized perceived
competence", but those games "were less enjoyable than closer games", and when
participants chose which game to play again, they chose the suspenseful one
(Abuhamdeh, Csikszentmihalyi & Jalal, 2015).

This is the finding that matters most for Sporefall's dominant builds. A build
that always wins makes the player feel strong, and it also removes the
suspense that the enjoyment depends on. Being strong and having fun are not the
same measurement.

The one study of children found for this section points the same way. Inal and
Cagiltay (2007) observed 33 children aged 7 to 9 over six weeks and found that
"challenge and complexity elements of games had more effect on the flow
experiences of the children than clear feedback." That is one small study, and
it is about flow, not about understanding a build. It does suggest that young
children do not need the challenge taken out.

Jenova Chen's essay "Flow in games" (2007, a viewpoint piece, not a study) adds
a design argument that fits a mixed-age couch. Players have different flow
zones, so a single fixed difficulty misses most of them. His answer is to
"embed choices inside the core activities", so each player can steer their own
challenge through play rather than through a menu.

### 3.3 Fun is learning a pattern, until the pattern runs out

Raph Koster's *A Theory of Fun for Game Design* (2004) is a designer's book,
not a study. Its outline, as Koster reproduces it on his site, is "Games are
about cognition and pattern mastery / We play games until we master or fail to
master". He later restated the theory: fun "is the feeling you get when you are
exercising your brain by solving a cognitive puzzle", and "whenever you reach
the point where fighting the new enemy can be done using the same tactics as
the previous enemy, you have not actually added a new challenge to the game.
This is where players find repetition" (Koster, 2012).

That last sentence is a test the census can run. If a new arena or enemy
leaves the best build unchanged, it added no new pattern to learn.

Lantz, Isaksen, Jaffe, Nealen and Togelius (2017) make the idea formal. They
define a game's depth as its "capacity ... to absorb dedicated problem-solving
attention and allow for sustained, long-term learning", and tie it to the length
of a game's "skill chain": the number of steps in a ranking of players where
each step beats the steps below it "some significant percentage of the time".
"Trivially easy games can't support long skill chains." A dominant build is a
cheap partial solution. Once it is found, thinking harder about builds stops
paying.

### 3.4 Few rules, many games

Juul (2002) split games into two structures: "emergence (a number of simple
rules combining to form interesting variation) and ... progression (separate
challenges presented serially)." Emergence games "tend to be replayable and
tend to foster tournaments and strategy guides." The owner's per-mod grammar is
emergence by Juul's definition. A hand-authored pair table is closer to
progression, one designed answer at a time.

The costs of emergence are well described. Sweetser and Wiles (2005) place
scripting and emergence at two ends of one continuum. Emergence brings "a loss
of creative control, difficulties in giving feedback and direction to players
and uncertainty in how the game will respond to the player", but "emergent
systems are easier to modify and extend" and have "high replayability".
Dormans (2012) adds the point that matters most here: "Emergent properties of a
system only surface when a system is put into motion." You cannot read a
grammar's balance off its rules. You have to run it. He also argues that
"Simply adding more, and more detailed rules is only a poor substitute for
creating complex gameplay through a lean and elegant rule system", and that a
lean system is "easier to learn for the player."

Grow and colleagues (2017) surveyed 64 crafting systems in 47 games and give
the choice a vocabulary. A "strongly defined recipe" system gives the designer
full control and lets them "explicitly enumerate all possible craftable
objects". Systems with undefined recipes "use an underlying simulation", which
"opens more possibilities for experimental and creative play, but reduces the
game creators' control". When players find such recipes themselves, it can be
"a delightful and surprising meeting of minds between the player and system."
Sporefall chose the simulation end. The census is how it buys back the control
it gave up.

Salen and Zimmerman's *Rules of Play* (2004) gives the standard for whether a
combination means anything. "Meaningful play occurs when the relationships
between actions and outcomes in a game are both discernable and integrated
into the larger context of the game." They define both terms. "Discernability
means that a player can perceive the immediate outcome of an action.
Integration means that the outcome of an action is woven into the game system
as a whole."

This pair of tests is the backbone of section 4. A combination that a child
cannot see fails discernability. A combination that wins every fight, or that
fights identically to another combination, fails integration, because the
outcome does not depend on the rest of the game.

### 3.5 Dominant strategies close the question

Every source found that discusses dominant strategies treats them as a defect.
Juul (2002): "If the optimal strategy for playing the game leads to dull game
sessions, the game will be considered dull." Salen and Zimmerman (2004) call a
strategy that "ensures victory every time" degenerate. Such strategies let
"players shortcut all of the attention lavished on a game's rich set of
possibilities", and "the only real way to root them out is through rigorous
playtesting. If you see players drawn to a particular set of strategies again
and again, they may be exploiting a weakness in your design." Mahlmann, Togelius
and Yannakakis (2012): "The existence of a dominant strategy that wins against
all others is usually considered evidence of poor balancing."

Paul (2011) describes what players do once a best build exists. Theorycraft's
goal "is to figure out what is best and, once the best is determined, the
choices are distilled to the single best choice." Play shifts "from sifting
through a sea of choices to a search for the optimal solution, resulting in
what are often called 'cookie cutter builds'", and "the game loses depth,
variety, and choice, as one approach marginalizes all others." His definition
of what theorycraft optimises includes "an order in which to cast spells",
which is Sporefall's sequenced wand.

This is the scholarly form of the owner's ruling that a dominant pair is a
failure even when it is fun. The suspense findings in section 3.2 give the
player-side reason: a certain win is enjoyed less. The sources above give the
system-side reason: once a best answer exists, the other answers read as
broken.

### 3.6 Finding dominant builds by machine

Sporefall's census belongs to a known family of methods. Nelson (2011) argues
that "not all information needs to (or ought to) come from empirical
playtests", and describes the census's method almost exactly: "what happens
when the game is played by a player who always attacks, except heals when low
on health? If that player does very well, the game might be a bit too simple."

The published work suggests four upgrades.

- **Ban one part and measure the loss.** Jaffe and colleagues (2012) measure
  "the win rate of an agent who is restricted from ever (or often) taking that
  action". A mod whose removal costs the most is essential, against their goal
  that in shooters "no one weapon should be essential". A mod whose removal
  costs nothing is dead weight.
- **Keep the best build in each niche.** Fontaine and colleagues (2019) bin
  Hearthstone decks by behaviour, keep the best deck in each bin, and mine the
  winners for recurring cards. If a pattern shows up across many niches, "it is
  almost certainly powerful in a variety of settings (perhaps too powerful)."
  de Mesentier Silva and colleagues (2019) found that cards with a high "win
  rate when drawn" were the ones whose nerf moved a deck's win rate most.
- **Set a target shape, not equal win rates.** Hernandez and colleagues (2020)
  let the designer draw which strategies should beat which, "beyond a simple
  requirement of equal win chances", and then tune parameters toward it. For
  Sporefall the target is intransitive: frost wins the swarm, fire wins the
  armoured pack, lightning wins the flood, and nothing wins everything.
- **Use more than one bot.** Holmgård and colleagues (2019) built four
  "single-minded personas" (runner, monster killer, treasure collector,
  completionist) as synthetic playtesters. A build that dominates for one play
  style may not dominate for another.

On the language-model personas, Xiao and Yang (2025) found LLM agents played
Slay the Spire far worse than humans, but their results correlated "up to
0.871" with how hard human players found each boss. Trust the personas' rank
order, not their absolute results. A preprint (Bateni, Pratt & Whitehead, 2025,
not peer-reviewed) found language models reading card text "struggle with
detecting positive and, particularly, negative synergies", including errors of
timing. The census, which runs the real sim, should stay the ground truth for
what a combination does.

### 3.7 Interesting decisions, and how many options

Sid Meier's line that a game is "a series of interesting decisions" is a
designer's talk, not research. It is useful because his GDC 2012 talk
(reported by Alexander, 2012) gives tests a designer can apply. "If a player
always chooses the first from among a set of three choices, it's probably not
an interesting choice; nor is a random selection." Interesting decisions
"involve some kind of tradeoff", are situational, "affect the game for a
certain amount of time, as long as the player has enough information to make
the decision", and get a response: "The worst thing you can do is just move
on."

On how many options to offer, the research is more mixed than its famous
example suggests. In Iyengar and Lepper's (2000) jam study, a display of 24
jams drew more shoppers than a display of 6 (60% against 40% stopped), but
"Nearly 30% (31) of the consumers in the limited-choice condition subsequently
purchased a jar ... in contrast, only 3% (4) of the consumers in the
extensive-choice condition did so". A meta-analysis of 50 experiments then
found "a mean effect size of virtually zero but considerable variance between
studies" (Scheibehenne, Greifeneder & Todd, 2010), and found that "decision
makers with strong prior preferences or expertise benefit from having more
options to choose from." A later meta-analysis of 99 observations explained
the variance (Chernev, Böckenholt & Goodman, 2015). Overload appears with
"higher levels of decision task difficulty, greater choice set complexity,
higher preference uncertainty, and a more prominent, effort-minimizing goal".

A child picking a mod between fights has all four conditions. The options are
combinations that are hard to compare, the pick happens mid-run, the child
often does not yet know what they want, and they want to get back to shooting.
A third meta-analysis, of choice and intrinsic motivation across 41 studies
with child and adult samples, gives a positive answer for the same shape
(Patall, Cooper & Robinson, 2008). Choice "enhanced intrinsic motivation,
effort, task performance, and perceived competence", with the effect stronger
"when 2 to 4 successive choices were given" and "when rewards were not given
after the choice manipulation". Options per choice of three to five did best
(d = 0.38, against 0.20 for two and 0.26 for more than five), though that
difference was only marginal.

A floor draft that offers three and takes one, once per floor, sits in the
best-performing cell of that literature. The same literature says the risk of
a larger draft falls as preference becomes clear. A player who knows the next
boss is weak to lightning has a clear preference.

### 3.8 Agency needs a desire and a way to act on it

Janet Murray (1997) defined agency as "the satisfying power to take meaningful
action and see the results of our decisions and choices" (quoted from
Wardrip-Fruin et al., 2009; the book itself was not opened). She contrasts it
with a game of chance where "the players' actions have effect, but the actions
are not chosen and the effects are not related to the players' intentions."
Random drops with nothing to decide are that game of chance.

Wardrip-Fruin, Mateas, Dow and Sali (2009) sharpen the definition: agency
"occurs when the actions players desire are among those they can take (and
vice versa) as supported by an underlying computational model." It is a match
between what the game makes the player want and what it lets them do. A
lightning-weak boss creates a desire. If the draft never offers lightning, or
lightning does nothing, the game has created a want it cannot satisfy. That is
exactly what the arena census measured on `main`.

The one empirical agency study found adds a cheaper lever. Fendt and colleagues
(2012) compared a branching story with linear ones and found "in most cases no
significant difference in players' reported feelings of agency" between the
branching story and a linear one "with explicit acknowledgement of their
choices". Choices felt low-agency when they were "two different means to the
same end". The sample was adults reading text stories, a long way from a
twin-stick shooter. It still points the same way as Meier's rule: much of what
feels like agency is the game visibly answering the choice.

### 3.9 Curiosity is a gap the player believes they can close

Loewenstein (1994) defines curiosity as "a form of cognitively induced
deprivation that arises from the perception of a gap in knowledge or
understanding." Among his triggers are "the posing of a question or
presentation of a riddle or puzzle" and "a sequence of events with an
anticipated but unknown resolution", which is heightened when the person makes
a prediction. He also predicts that curiosity rises with knowledge: someone who
knows 47 state capitals feels the gap of the missing 3.

Kang and colleagues (2009) measured the shape of it. Curiosity "was indeed an
inverted-U-shaped function of P, reaching its maximum when P was around .50",
where P was the person's confidence in their own answer. Curious participants
spent scarce tokens or waiting time to learn answers, and higher curiosity was
"correlated with better recall of surprising answers 1 to 2 weeks later." The
sample was 19 adults in a scanner plus two small behavioural follow-ups.

Malone (1981) built a theory of motivating instruction from studies of computer
games. He lists "hidden information" and "randomness" among the ways to make a
goal's outcome uncertain, and says curiosity is aroused by making people
"believe their knowledge structures are incomplete". To, Ali, Kaufman and Hammer
(2016) connect this to games directly, and add a limit: "players' confidence in
their ability to close a knowledge gap makes them more tolerant of uncertainty."
The model they build on ties gaps the player cannot close to "helplessness,
frustration, or anger."

Costikyan's *Uncertainty in Games* (2013) is the designer's version: games
need uncertainty, and the book's chapter 5 sorts its sources. A review of the
book (England, 2016; the book itself was not opened) lists among them
performative uncertainty, hidden information, randomness, and the analytical
complexity of the system. Sporefall already has all four.

One empirical level-design study gives a warning. With 254 players in an open
world, "Having an explicit goal severely reduces exploratory behavior until
that goal is fulfilled", and payment for playing reduced exploration too
(Gómez-Maureira et al., 2021).

For Sporefall, a boss weakness is a ready-made information gap, and the
research says how to open it. Give a partial clue, so the player is near 50/50
(is it lightning or frost?). Make sure the gap can always be closed, because a
gap a child cannot close is frustration, not curiosity. Let the player guess
before the fight and see the answer in it. And keep the experiment with mods
separate from the moment of a hard goal, because an explicit goal narrows
exploration until it is met.

### 3.10 Failure that teaches

Juul's *The Art of Failure* (2013, an essay) names the puzzle: we avoid
failure, we fail constantly in games, and we seek games out anyway. His answer
is that failure is "something that helps us reconsider our strategies and see
the strategic depth in a game, a clear proof that we have improved when we
finally overcome it." Games "promise us a fair chance of redeeming ourselves."

Three empirical studies support the shape of that claim, all with adults.
Surveyed right after the release of Dark Souls III, 95 players reported that
"achievement and learning moments strongly contribut[ed] to positive
experiences", and that those moments "were enabled by negative events such as
difficulties and avatar death" (Petralito et al., 2017). From 182 players'
accounts of success and failure, Frommel, Klarkowski and Mandryk (2021)
separated "temporary and perpetual failure": the temporary kind "is integral
to the experience of success", and "players who enjoy a challenge are more
likely to experience competence and find enjoyment within experiences of
failure." In a case study of breakdowns in play, involvement rose "when the
player feels responsible for progress" (Iacovides et al., 2015).

The owner's "bosses like Dark Souls" is therefore a request for a specific
kind of failure: one that is readable, that points at a fix, and that ends in a
win within the session. No peer-reviewed study of attack telegraphs was found.
Designers' talks fill the gap and are labelled as such. Stout (2015) describes
each attack as a question: "If players don't understand the questions they are
being asked, they actually can not play your game." Keren's GDC 2018 boss
talk puts it as a rule: "Keep attacks predictable, telegraphed (or at least
memorizable)... Players tend to give up when they are helpless, or perceive
themselves to be." His slides also list "Glowing weak spot = clear
vulnerability", which is what a lightning weakness should look like in the
fight.

Hunicke (2005) is the standard reference for adjusting difficulty during
play. Its abstract says adjustment "must be performed without disrupting or
degrading the core player experience." Its results were not checked, so this
paper cites it only for that principle.

### 3.11 What a child can hold in mind

Sweller (1988) showed that solving a problem by means-ends search "requires a
relatively large amount of cognitive processing capacity which is consequently
unavailable for schema acquisition." Working out a build in the middle of a
fight competes with learning what the build does.

The capacity involved is small, and it is smaller in children. Cowan (2001)
put adult capacity at "about four chunks". Cowan (2016) reviews the
developmental work: "typically in the range of 3 or 4 objects in adults ...
with smaller estimates in preschoolers and children in the early elementary
school years, about 2 to 2.5 items". The difference holds even when strategy
and knowledge are controlled for. With more than 700 children aged 4 to 15,
Gathercole and colleagues (2004) found that working memory has its adult
structure by age 6, but performance on their tests increased "linearly from 4
to 14 years". An eight-year-old and a twelve-year-old at the same couch are far
apart.

For Sporefall, this is the most direct constraint in the paper. "What does my
build do", "what is the boss about to do" and "where is my cousin" can already
fill an eight-year-old's working memory. Information has to live in the world,
where the eye already is, rather than in the player's head: the tell on the
boss, the element on the bullet. A four-mod build has to read as one thing, a
"storm gun", rather than four effects to track. And the thinking about a build
belongs at the draft, not during the fight.

### 3.12 Juice helps only when it carries information

"Juice" is redundant feedback, where "a single player action triggers
multiple non-functional reactions" (Hicks et al., 2019). The results are
consistent and cautionary.

- Hicks, Gerling, Dickinson and Vanden Abeele (2019), with 72 players over two
  studies: embellishments "contribute to the visual appeal of all games, but
  only affects aspects such as competence under specific circumstances."
- Kao (2020), with 3,018 players of four versions of an action RPG: "both None
  and Extreme amounts of juiciness lead to significantly decreased play time,
  significantly decreased player experience, significantly decreased intrinsic
  motivation, and significantly decreased performance relative to both Medium
  and High."
- Juul and Begy (2016), a preliminary poster with 46 students: juice raised
  the game's rating but not ease of use, and scores were lower (not
  significant). The authors suggest juice may "split the attention of a user,
  increasing cognitive load".
- Kao, Ballou, Gerling, Breitsohl and Deterding (2024), a pre-registered
  experiment with 1,699 players: feedback that depended on how well the player
  did "enhanced all motives, while amplification unexpectedly reduced them".
  They conclude that good juice guidance comes down to "legible action-outcome
  bindings and graded success". Curiosity was "the strongest enjoyment and
  only playtime predictor".

A developer framework from the same group (Hicks et al., 2018) turns this into
questions a designer can ask of each effect. "Can information be connected to
actions and only interpreted in one way?" "Does feedback reflect the
importance of the event?" Swink's early article on game feel (2007) makes the
same point from the design side: polish exists "to convey the physical
properties of objects through their motion".

For Sporefall, this changes what it means to make the combos feel great. The
effect budget should go to events that matter, scaled to how much they matter,
and bound to the shot that caused them. A zap chain across a wet pack should be
the loudest thing on screen. A plain hit should be quiet. Four elements
stacking particles on one small phone screen is the "Extreme" condition.

### 3.13 Playing together, in the same room

Playing with someone in the room changes the game. Gajadhar, de Kort and
IJsselsteijn (2008) compared playing with a computer, a remote person and a
person in the room: "a co-located co-player significantly adds to the fun,
challenge, and perceived competence in the game", with the effect running
through social presence.

The closest study to Sporefall's audience is the cooperative-games work of
Seif El-Nasr and colleagues (2010). Its abstract describes 60 participants in
groups of 2 or 3 playing four co-op games. The companion master's thesis
(Aghabeigi, 2011, not peer-reviewed) describes them as "kids ages 8-12",
though its results chapter elsewhere says 6 to 14. The study coded video for
cooperative behaviours: laughter and excitement together, worked-out
strategies, helping, global strategies, waiting for each other, and getting in
each other's way. The thesis reports that "complementarity, shared goals,
shared puzzles, and shared objects had a major impact" on those behaviours.
It found that "Helping occurred when the game was difficult for players", and
that "visual style and animation as well as cut scenes caused much of the
Laughter and Excitement Together". It also describes the Left 4 Dead pattern of
characters calling out danger automatically, which "encourages players to play
close together and support each other."

The study built on co-op design patterns first named by Rocha, Mascarenhas and
Prada (2008). One of them, "synergies between abilities", is the cross-player
form of Sporefall's grammar: one character makes an enemy "more vulnerable to
shadow damage, which also causes an increase of damage that the warlocks are
causing". Harris, Hancock and Scott (2016) add timing. In "sequential"
interdependence, "one player removes the protective casing from an armoured
enemy with a grenade, allowing the second player to finish the enemy off at
their leisure". Coincident timing, where both must act at once, is "distinctly
harder to execute". Their adult study was designed for pairs "such as
grandparents and grandchildren, highly skilled players and novices". Beznosyk
and colleagues (2012) found that tightly coupled co-op (complementary roles,
acting on the same object) beat loosely coupled co-op for adults who could not
talk. They suspect players in the same room get more from looser patterns.

On families, the evidence is thinner and mostly correlational. A report from
the Joan Ganz Cooney Center (Takeuchi & Stevens, 2011, not peer-reviewed) sets
out conditions for productive joint media use. "Neither partner is bored nor
participates out of sheer obligation to the other." Roles should match
"individual maturity", and designers should "have partners work toward a
common goal together, and force them to talk to coordinate their efforts." In
Voida and Greenberg's (2009) study of family console play, "More expert gamers
enjoyed teaching and mentoring less expert gamers", and players contrasted a
game where "the other one's just kind of the helper" with one where "you're
both chopping stuff." Wang, Taylor and Sun (2018) found, in a survey of 361
parents, that families who play together more often report more family
satisfaction and closeness. Coyne and colleagues (2011) found associations
with better outcomes after parent co-play "for girls only". Neither study can
show cause.

For Sporefall, the grammar already contains the most promising co-op shape.
One player sets a state and another cashes it, in sequence, not in the same
frame. The pair shares a target and can talk about it. The adult can take the
setter role while the child lands the big, visible payoff. Automatic callouts
can do what voice chat would do online. And a hard fight is where helping
starts.

### 3.14 Players want different things, and one player wants several

Yee (2006) surveyed 3,000 online players and found ten motives in three groups:
achievement, social and immersion. One achievement motive is called
*Mechanics*: "Having an interest in analyzing the underlying rules and system
in order to optimize character performance". The combinatorial weapon exists
to feed that motive. Yee's other main result is that motives do not trade off:
"If a player scored high on the achievement component that did not mean they
scored low on the social component." Tondello and colleagues (2019) reached the
same conclusion with a validated 25-item scale of five preference traits,
starting from the title: "I don't fit into a single type".

The Quantic Foundry Gamer Motivation Model, often quoted in industry, comes
from the same researcher. It is a market-research model built from web survey
data, and its survey is, in Tondello and colleagues' words, "a proprietary
instrument". No peer-reviewed validation of it was found while writing this
paper. It is useful vocabulary (its Strategy, Discovery and Challenge
motivations describe the mod system well) but it is not evidence.

For Sporefall, this means the adult who wants to optimize and the nephew who
wants to be part of the team can both be served by the same run. Neither
motive has to be traded for the other. All the samples here are teenagers or
adults, so the claim that this holds for 8 to 12 year olds is an inference.

### 3.15 Summary

| What the owner wants (section 2) | What the research says drives it | Main sources | Kind of evidence |
|---|---|---|---|
| Combinations that mean something | Learning a pattern; emergence from few rules; outcomes that are discernable and integrated | Koster 2004; Juul 2002; Salen & Zimmerman 2004; Lantz et al. 2017 | Design theory |
| Different builds win different fights | Close fights beat blowouts; a dominant strategy collapses choice | Abuhamdeh & Csikszentmihalyi 2012; Abuhamdeh et al. 2015; Paul 2011; Mahlmann et al. 2012 | Experiments with adults; theory; simulation |
| Scarcity makes the choice | Choice raises motivation; 3 to 5 options did best; overload grows with difficulty and uncertainty | Patall et al. 2008; Chernev et al. 2015; Scheibehenne et al. 2010 | Meta-analyses; Patall includes children |
| Preparing for a boss | Agency as a desire met by an action; curiosity as a gap that can be closed; failure that ends in a win | Wardrip-Fruin et al. 2009; Kang et al. 2009; Frommel et al. 2021 | Theory; small experiments and surveys with adults |
| The screen tells the truth | Competence runs on feedback; children in the early school years hold about 2 to 2.5 items; juice helps only when it tracks success | Ryan et al. 2006; Cowan 2016; Kao 2020; Kao et al. 2024 | Large experiments; developmental data on children |
| The family at the couch | A player in the room adds fun; sequential interdependence; complementary roles and shared targets | Gajadhar et al. 2008; Harris et al. 2016; Seif El-Nasr et al. 2010 | One study of children aged 8 to 12; the rest adults or correlational |

The weakest part of this evidence is the part that matters most. Almost all of
it comes from adults. The exceptions are Inal and Cagiltay (2007), Seif El-Nasr
and colleagues (2010), the child samples within Patall and colleagues (2008),
and the working-memory studies. Every prediction in section 5 about the nephews
is an inference from adult data until the last experiment in section 7 runs.

## 4. What the playtests and the census say, read through that science

### 4.1 How much weight each source carries

Two kinds of evidence exist, and they deserve different weight.

The persona playtests are eight headless sessions played through
`scripts/playtest.mts`: each of the three prototypes played by a "kid" persona
and a "planner" persona, plus the current fold and sequenced modes as controls.
The players were language models told to play like a ten-year-old or like a
careful adult. Their scores are informed guesses about human reactions, not
observations of children. Treat them as hypotheses. They are still useful,
because every score had to cite a log line, and the log lines are real sim
output.

The censuses are measurements of the sim. A fixed bot fought every build in
every arena on 8 seeds: 1,512 fights in the arena census, byte-identical across
runs. They say nothing about fun. They say exactly which builds win which
fights.

### 4.2 The scores

| session | fun | variety | kid legibility | distinct answers |
|---|---|---|---|---|
| A (Primer and Striker), kid | 2 | 1 | 1 | 2 |
| A, planner | 3 | 2 | 2 | 3 |
| B (One Wand, Made Deep), kid | 2 | 1 | 1 | 2 |
| B, planner | 2 | 2 | 1 | 3 |
| C (essence bubbles), kid | 2 | 2 | 1 | 2 |
| C, planner | 2 | 2 | 1 | 3 |
| baseline, fold | 2 | 1 | 2 | 1 |
| baseline, sequenced | 2 | 1 | 2 | 2 |

Scores are 1 to 5, from
[`playtest-results.json`](design/loadout-exploration/playtest-results.json). No prototype scored more than one point above the better of the
two controls on any axis.
Every kid persona scored legibility 1.

The three designs are different mechanics. A splits the build across two guns, B
deepens one ordered wand, and C puts mods into the world as objects. When three
different answers fail the same test, the test is probably measuring something
they share. The census found what they shared.

### 4.3 No threat, so no question

The census computed why the playtesters were never in danger. Against a
pistol that always hits, single floor-1 foes lose the damage race by 3 to 9
times. A thug dies in 1.2 s and needs 3.5 s to down a player. Only the brute
and the boss win a one-on-one race. Ranged foes did not answer fire from beyond
8 tiles, so a player could shoot them for free. The planner persona on design B
wrote it plainly: "None of the four floor-1 fights ever threatened me." The
design A planner found the same thing from the other side: "No fight asked me
to rebuild."

This is the blowout that section 3.2 predicts is enjoyed less: close games beat
lopsided ones, and a challenge below the player's skill produces apathy. It also
removes the competence signal of section 3.1. If no build can lose, no build
choice can matter, and the mechanic has nothing to be meaningful about. Once the
census staged fights that kill a passive player in 3.8 to 5.6 s, builds started
to differ: the plain pistol lost every brute and boss fight, and only fire plus
a lock beat the brute pair on every seed.

This is the first finding and the most important one. Threat is not a separate
feature from combinatorics. It is what makes a combination an answer.

### 4.4 A dominant answer, then another one

On `main` before #92, a frozen foe could not act and the next hit shattered it
for 5 times damage. No archetype could resist a freeze. The generic hand fought
identically to `frost+pierce` in every arena, and that build was the best fold
build against gangsters, the swarm and the cinders. After #92 made burning foes
panic, fire replaced it. Panic ignores the fire resist, so even the cinders,
built to punish fire, stopped punishing it. `incendiary+pierce` won 40 of 40
non-boss fights.

This is a degenerate strategy in Salen and Zimmerman's sense, one that "ensures
victory every time" (section 3.5). The census found it before any player did,
which is the work Paul's theorycrafters do (section 3.5). The census also
measured the fix. A `panic` resist key with the brute at 0 makes fire lose the
brute pair 0/8 again, drops it to 32 of 40, and brings back fire plus a lock as
the pair's best answer. That is the shape of every fix in this area: each verb
needs at least one foe it fails against.

The census shows a second, quieter kind of collapse. It lists builds that fought
with identical hp traces. Against one brute, 21 builds produce 13 distinct
traces, because `pierce` adds nothing against a single target and fold mode
keeps only the newest element. A build that fights identically to another build
fails Salen and Zimmerman's integration test (section 3.4). It is not a separate
combination for the player. It only looks like one in the inventory.

### 4.5 A weakness nobody could use

The lightning ask failed completely on `main`. `resist.electrified: 2` changed
nothing for any of 21 builds on any of 8 seeds, dry or wet, because a Tesla hit
only immobilized and nothing in play applied `wet`. A player who prepared for
the lightning boss got the same fight as one who did not.

This is agency failing in exactly the way Wardrip-Fruin and colleagues
describe (section 3.8). The game created a desire, "bring lightning", and gave
no action that satisfied it. In Murray's terms, the player's preparation had no
effect related to their intention.

The substrate census found the fight where preparation pays. With #92's Tesla
routing and a flooded boss room (an experiment, not a design), Tesla beat the
lightning-weak Mireclaw 8/8 on 9 damage while frost, fire and the generic hand
each won 0/8. The stock-resist boss in the same flood lost to Tesla 7/8. So the
water did most of the work and the weakness added margin. That is the best news
in the whole pile: a boss that one build beats and every other build loses to is
exactly the loop the owner asked for, to "prepare for a boss who, for example,
is weak to lightning". What is missing is the design around it: a way to learn
about the weakness, and a level that actually floods.

The persona sessions agree in miniature. In design C, one vent press turned a
loss into a win with no damage taken against the weak boss. Against a boss
without the weakness, the same play still won but cost 90 hp. Design A's
prepared build killed the boss 43% faster. Design B's obvious preparation,
ejecting the element that fizzled, got the planner killed.

### 4.6 The kids could not read their builds

Every kid persona scored legibility 1 of 5, and every worst moment was invisible
state. In design A, the kid walked over a shiny lightning cartridge that
silently became "MAGNET splash 0.9", which is not lightning, and only the debug
`look` verb said so. In design C, mashing a new button drained the rack to one
mod with a 29-tick reload while robots walked up, and "nothing on screen would
tell me why". In the fold baseline, held Incendiary never fired against the
fire-weak brute because Tesla sorts last and took the only on-hit slot. The
fight took about 330 ticks instead of 180.

All three fail discernability (section 3.4): the player could not perceive
the immediate outcome of the action. They also fail the feedback criteria of
section 3.2, which ask that players "always know their status". And each one
asks a child to hold a hidden rule in working memory, which section 3.11 says an
eight-year-old has little room for.

### 4.7 The best moments were big, visible, and caused

Every prototype's best moment was the same kind of event. In C, one Conductor
hit took the boss from 320 to 109 hp. In A, the Primer fired Magnet then Soak,
the pack drifted into a clump, and one Striker burst killed all five thugs. In
B, one swap produced freeze, thermal crack, then a zap chain, and took a brute
to 30 of 95 hp in 45 ticks where the loaded order reached 82.

These are what Grow and colleagues call a "meeting of minds between the player
and system" (section 3.4). They are also the feedback Kao and colleagues found
motivating: large, dependent on the player's success, and bound to the action
that caused it (section 3.12). Not every big moment was earned. The fold
baseline's best moment, one pistol round killing two sporelings, "came from
pierce, not from any choice I made." A moment the player caused on purpose
becomes something to repeat and to tell a teammate about. A moment that only
happened to them is a surprise, and nothing more.

### 4.8 The diagnosis

The three designs did not fail because their combinations were shallow. Each
had a real "aha". They failed on the other two layers from section 2. The world
asked no questions, so one answer won. And the kids could not see the answer
they had built. Adding a fourth combination mechanic to the same world would
fail the same way. The next work belongs in threat, counters, information and
legibility.

## 5. Design implications

Each recommendation below names the mechanism behind it and a prediction the
census or the playtest tool can check. Section 7 lists the runs.

### 5.1 Define "meaningful" as a number the census prints

Salen and Zimmerman's integration test (section 3.4) and the dominance
literature (section 3.5) point to one measurement. Sporefall can make the
owner's word measurable. A combination is meaningful when it wins a fight that
other combinations lose, or loses one they win. Two counts capture that, and the
census already has the data for both:

- **Distinct outcomes.** The number of distinct hp traces per arena. Builds that
  fight identically are one combination to the player, however many icons they
  use.
- **Builds that are best somewhere.** The number of builds that are best or tied
  best in at least one arena.

Prediction: content that adds combinations without adding questions raises the
first count and leaves the second flat. Only a new question raises the second.

### 5.2 Give every verb a foe it fails against

Restricted play (Jaffe et al.) and a target graph of which build should
beat which fight (Hernandez et al.) are the published forms of this (section
3.6). The substrate census already measured the pattern. A `panic`
resist key with the brute at 0 took fire from 40 of 40 non-boss wins to 32 and
brought back a fight fire loses. Do the same audit for every verb: frost needs a
foe that shrugs off a freeze or punishes a frozen ally's shatter, fire needs a
foe that does not panic, lightning needs a dry foe that grounds it.

Prediction and fail condition: no build wins more than about 80% of non-boss
fights, and no build is in the top decile of 4 or more of 5 arenas (the fail
condition in design B's section 10.1). Because the mods compose by grammar, the
census must sweep generated compositions, not only the authored ones, which
INSPO already asks for.

### 5.3 Make every fight able to lose, and keep it short

Close games beat blowouts, and a certain win is enjoyed less even though it
feels most competent (section 3.2). The one child study in section 3.2 found
challenge and complexity drove flow at ages 7 to 9. The arena census calibrated
the threat level in a way that fits the arcade pace: every arena downs a passive
player in 3.8 to 5.6 s, and the plain pistol loses at least half its fights.
That is threat per fight, not longer fights. Carry the same calibration into the
level generator: pack sizes, ranged foes that answer fire (#101), and wet
streets where a stun gun is dangerous.

Prediction: once real floor-1 fights meet the arena calibration, the persona
variety score rises without any change to the mod system, because the same
builds start to lose different fights.

### 5.4 Four verbs, six pairs, a sentence each

Children in the early school years hold about 2 to 2.5 items in working memory,
adults 3 or 4, and capacity keeps growing until about 14 (section 3.11). INSPO
already holds the ruling: "four elements with six distinct pairs beats eight
elements with twenty-eight mushy ones." The working-memory research gives a
reason to hold it for children in particular. Since #92, each of the three
element mods has a verb: frost locks, fire panics, shock jumps. Spore's blind
exists as a status but not as a mod. Four verbs give six pairs, few enough to
learn one at a time as named patterns. Give each pair a name and one sentence a
player would say mid-fight: "soak then zap jumps to everyone wet."

Prediction: each named pair is the best build in at least one arena. A pair
that is best nowhere is noise, and cutting it is a legitimate change.

### 5.5 Show what the build will do before the trigger is pulled

Discernability (section 3.4), feedback that tracks success and stays bound to
its cause (section 3.12), and the working-memory limits (section 3.11) all ask
for the same thing: show the rule in the world, at the moment it matters.
Three rules follow for Sporefall:

1. **No silent conversions.** A pickup that changes what a mod does (design A's
   cartridge becoming Magnet) must say so on screen at pickup time, in words and
   in colour.
2. **The bullet looks like its recipe.** The Nova Drift rule is already shipped.
   Extend it so the next shot's composition is visible on the weapon itself
   before firing, not only in a panel.
3. **Name the reaction when it fires.** A short, large callout ("ZAP CHAIN",
   "SHATTER") on the target turns an accident into a pattern the player can
   repeat. Keep it brief: the owner already ruled that text must not cover the
   game.

Prediction: the predict-then-fire hit rate in section 7 rises, and the kid
personas' worst moments stop being ones where "nothing on screen would tell me
why".

### 5.6 Build the lightning boss as a three-beat loop

The preparation loop from section 2.3 has three beats, and each needs
its own mechanism.

**Learn.** Curiosity peaks when a player is about 50/50 on the answer, and it
turns to frustration when the gap cannot be closed (section 3.9). Show the
weakness in the world, before the fight, as a clue a child can finish in one
step. LORE's proposed hue telegraph fits: an echo's glow would be the hue of the
essence it drops, so a violet-lit lair says "lightning". The flooded boss room
says "water". A kid who has once seen a zap chain on wet targets can finish that
inference. Split clues between players' screens (design C's idea), because an
information gap that one player can close for another gives them a reason to
talk.

**Build.** The floor before the boss offers a themed draft with at least one
counter in the hand, and a pad-first way to reorder. INSPO notes that a themed
floor offering a themed hand is one mechanism, not two.

**Fight.** Temporary failure that ends in a win is part of the fun, and
perpetual failure is not (section 3.10). The weakness must decide the fight. The
flooded-lair numbers are the target: the prepared build wins 7/8 or better, the
unprepared builds win half or less. Attacks need telegraphs (issue #1) so a
failed attempt teaches something. On `casual`, the unprepared route must stay
winnable, so a kid who picked wrong still finishes.

Prediction: in the boss-preparation census, each boss has a different best
build, and every boss's best build loses to at least one other boss.

### 5.7 Keep the hand small and the choice quick

Three to five options per choice, over a few successive choices, did best in the
choice-motivation meta-analysis, and all four conditions that make overload
likely are present mid-run (section 3.7). The floor draft offers three. Keep it
at three for this audience, give each offer its verb and one sentence, and make
picking a single pad press. Prediction: pick time on a pad stays under a few
seconds, and across seeds the builds at floor 5 differ.

### 5.8 Make co-op a chain, not two copies

A player in the room adds fun and felt competence, sequential interdependence is
the form a novice can execute, and shared targets with complementary roles drove
cooperation among children aged 8 to 12 (section 3.13). Sporefall's element
grammar already contains interdependence: one state sets up (wet, frozen) and
another cashes it (lightning, impact). Let builds specialise so that one
player's shot sets the state and the other's cashes it. Design A's primer and
striker and design C's shared bubbles were both aimed here. At the couch, this
has a family-specific use. The adult can play the setter and let the child land
the payoff.

Prediction: in a co-op census, two complementary builds beat two copies of the
best solo build in at least one arena class. In observed play, players call out
states to each other ("he's wet, zap him").

## 6. Risks and ethics

### 6.1 Random rewards and children

Random drops are a variable reward, and variable rewards are what makes a slot
machine work. Fiorillo, Tobler and Schultz (2003) found two dopamine signals:
one tracks how surprising a reward is, and a second ramps up while the reward
is awaited and is largest when the outcome is a coin flip ("maximal at P =
0.5"). That is a reason uncertain rewards feel compelling, both in a floor
draft and in a loot box.

The harm research is about paid random rewards. Zendle and Cairns (2018)
surveyed 7,422 adult gamers and found a link between loot box spending and
problem gambling (η² = 0.054) that was much stronger than the link for other
paid items (η² = 0.004). With 1,155 gamers aged 16 to 18, the link was larger
(η² = 0.120), "stronger than relationships previously observed in adults"
(Zendle, Meyer & Over, 2019). Both studies are correlational surveys of
self-selected players. For 16% of the adolescents' coded reasons for buying,
the draw was "the fun, excitement and thrills of opening the box itself".
King and Delfabbro (2018) define predatory schemes as purchasing systems "that
disguise or withhold the longterm cost of the activity until players are
already financially and psychologically committed". Drummond and Sauer (2018)
compared loot boxes with psychological criteria for gambling. That paper's
body was not opened. A university summary of it reports that, across 22 games,
"almost half the loot boxes they examined met the psychological criteria for
gambling".

Sporefall has no money in it, so its drops are not loot boxes by any of these
definitions: nothing of value is staked, and nothing is lost by not playing.
The risk is drift. A family game for eight-year-olds should hold these lines
even as it grows:

- **Nothing buys a roll.** No currency, earned or paid, that exchanges for a
  random draft or drop.
- **No odds that bend to keep a player hooked.** Drop weights can depend on the
  floor and the boss, as the themed draft does, but never on how long a child
  has played or how close they came to quitting.
- **No timed pressure.** No offers that expire, no daily chests.
- **Randomness serves skill, not the other way round.** King and Delfabbro list
  "manipulation of reward outcomes to encourage purchasing behaviours over
  skilful play" as a predatory tactic. The draft exists so a player can plan.
  The thrill should come from what the pick does in the fight, not from the
  reveal.
- **Don't reward choosing.** Patall and colleagues found choice motivated
  more "when rewards were not given after the choice manipulation" (section
  3.7). The mod is the reward.

### 6.2 The census can be gamed by the people who read it

The census bot never kites, rolls, or picks targets, as the substrate census
says in its limits section. A change that makes the bot's builds even can
still leave a dominant build for a human who moves. And once "builds that are
best somewhere" is a number on a PR, it becomes tempting to raise it with
arenas staged to favour one build. The protection is the same as for any
metric: stage arenas from real floors where possible, keep the list of arenas
fixed across PRs, and treat a jump in the number as something to explain.

### 6.3 Persona playtests are not children

Every legibility score in section 4 came from a language model imitating a
child. The personas can say that a HUD field is missing. They cannot say whether
a nine-year-old notices a colour change mid-fight, or would rather be told than
shown. Section 7's last experiment exists because nothing else in this paper
measures the real audience.

### 6.4 Preparation can turn into a chore

A weakness that is always shown and always decisive becomes a checklist: read
the sign, pick the counter, win. The suspense results in section 3.2 predict
that a certain win is enjoyed less. Two guards help. The counter should make a
win likely, not certain (the flooded lair's 8/8 on 9 damage is probably too
certain). And the clue should sometimes take a step to read, such as a hue in
the lair or a word from a teammate, rather than a label on the door.

### 6.5 Complexity that nobody sees

The grammar will produce combinations nobody designed. Most will be harmless.
Some will be degenerate, like the sequenced machine gun that hit a 45-tick
recharge after every shot and let a single brute take a player from 240 to 15
hp. The census catches degenerate outcomes only for the builds it sweeps. It
needs to sweep generated compositions, and the grammar needs a rule for what an
unknown pair does that is safe by default.

## 7. Open questions and experiments to run next

Each experiment below names the tool that already exists to run it. The
census (`scripts/census.mts`, #121) and the headless playtest
(`scripts/playtest.mts`) are deterministic, so every result is rerunnable and
every before-and-after is a diff.

1. **Add a meaningfulness block to the census.** Three numbers per run: the
   count of distinct hp traces per arena (a lower bound on combinations that
   play differently), the count of builds that are best or tied-best in at least
   one arena, and the share of arenas each build wins 8/8. Track all three per
   PR. Prediction: a change that adds content without adding a counter raises
   the first number and leaves the second flat.
2. **Take the `panic` resist key (change B in the substrate census) and rerun.**
   Then ask the same question of each element in turn: which archetype does this
   verb fail against? Prediction: after one counter per verb, no build wins more
   than about 32 of the 40 non-boss fights, and at least three different builds
   are best somewhere.
3. **A boss preparation census.** For each boss, fight it with its best build
   and with the best build of every other boss. Prediction for a working loop:
   each boss's own answer wins 7/8 or better, and the other bosses' answers lose
   at least half their fights. Today the Mireclaw fails this, because no build
   beats it dry on more than 3 of 8 seeds.
4. **Flood a real lair.** The flooded-lair result is an experiment on a staged
   room (`EXPERIMENT_FLOODED_ROOMS`). Build one real boss floor where the tide
   reaches the boss room, and rerun `arena-bog-boss` against the level
   generator's room instead of the staged one. The client-prediction gap for
   wading (substrate census, Limits) must be fixed first.
5. **A predict-then-fire protocol for persona playtests.** Before each fight,
   the persona writes one sentence predicting what its build will do, using only
   what the HUD shows (no `look` fields the screen does not render). Score the
   prediction against the step log. This turns "kid legibility" from a 1-to-5
   impression into a hit rate that a UI change can move.
6. **A co-op census.** The substrate census already has `teamFight`. Fight two
   identical best builds against two complementary builds (one sets a state, the
   other cashes it). Prediction: if co-op roles matter, the complementary pair
   wins at least one arena class the identical pair loses.
7. **Draft size.** Run persona sessions with offers of 2, 3 and 4 per floor, pad
   only. Measure time to pick, how often the pick changed the final build, and
   how many distinct builds reach floor 5 across seeds.
8. **Watch the nephews.** None of the evidence above is about children. The
   `observer` skill can attach read-only to a live session. Count three things
   per session: callouts between players about builds, rebuilds before a boss,
   and moments of visible confusion. This is the only experiment on the list
   that measures the thing the game is for, and it also answers INSPO's open
   question of whether bad combos stay funny in co-op.

## 8. References

Every source below was opened while writing this paper, and its title, authors,
year and venue were checked on the page that was opened. The note after each
entry says how much was read:

- **full text**: the paper or an author copy was read, and quotes come from it.
- **abstract**: only the abstract and record were read. Nothing beyond the
  abstract is claimed.
- **record**: only the bibliographic record was read. Claims attributed to the
  work come from the secondary source named in the note.

Talks, blog posts, reports, theses and preprints are marked as such. None of
them is peer-reviewed.

- Abuhamdeh, S., & Csikszentmihalyi, M. (2012). The importance of challenge for the enjoyment of intrinsically motivated, goal-directed activities. *Personality and Social Psychology Bulletin, 38*(3), 317-330. https://doi.org/10.1177/0146167211427147 (abstract)
- Abuhamdeh, S., Csikszentmihalyi, M., & Jalal, B. (2015). Enjoying the possibility of defeat: Outcome uncertainty, suspense, and intrinsic motivation. *Motivation and Emotion, 39*(1), 1-10. https://doi.org/10.1007/s11031-014-9425-2 (abstract)
- Aghabeigi, B. (2011). *Understanding and evaluating cooperative video games* [Master's thesis, Simon Fraser University]. https://summit.sfu.ca/_flysystem/fedora/sfu_migrate/11576/etd6462_BAghabeigi.pdf (full text; thesis)
- Alexander, L. (2012, March 7). GDC 2012: Sid Meier on how to see games as sets of interesting decisions. *Game Developer*. https://www.gamedeveloper.com/design/gdc-2012-sid-meier-on-how-to-see-games-as-sets-of-interesting-decisions (full text; press coverage of a talk)
- Bateni, B., Pratt, B., & Whitehead, J. (2025). *Rule synergy analysis using LLMs: State of the art and implications* (arXiv:2508.19484). https://arxiv.org/abs/2508.19484 (full text; preprint)
- Beznosyk, A., Quax, P., Lamotte, W., & Coninx, K. (2012). The effect of closely-coupled interaction on player experience in casual games. In *Entertainment Computing - ICEC 2012* (LNCS 7522, pp. 243-255). Springer. https://doi.org/10.1007/978-3-642-33542-6_21 (full text)
- Chen, J. (2007). Flow in games (and everything else). *Communications of the ACM, 50*(4), 31-34. https://doi.org/10.1145/1232743.1232769 (full text; viewpoint essay)
- Chernev, A., Böckenholt, U., & Goodman, J. (2015). Choice overload: A conceptual review and meta-analysis. *Journal of Consumer Psychology, 25*(2), 333-358. https://doi.org/10.1016/j.jcps.2014.08.002 (full text)
- Costikyan, G. (2013). *Uncertainty in games*. MIT Press. ISBN 978-0-262-01896-8. (record; contents via England, 2016)
- Cowan, N. (2001). The magical number 4 in short-term memory: A reconsideration of mental storage capacity. *Behavioral and Brain Sciences, 24*(1), 87-114. https://doi.org/10.1017/S0140525X01003922 (abstract)
- Cowan, N. (2016). Working memory maturation: Can we get at the essence of cognitive growth? *Perspectives on Psychological Science, 11*(2), 239-264. https://doi.org/10.1177/1745691615621279 (full text)
- Coyne, S. M., Padilla-Walker, L. M., Stockdale, L., & Day, R. D. (2011). Game on... girls: Associations between co-playing video games and adolescent behavioral and family outcomes. *Journal of Adolescent Health, 49*(2), 160-165. https://doi.org/10.1016/j.jadohealth.2010.11.249 (abstract)
- Csikszentmihalyi, M. (1990). *Flow: The psychology of optimal experience*. Harper & Row. (record; flow elements via Sweetser & Wyeth, 2005)
- de Mesentier Silva, F., Canaan, R., Lee, S., Fontaine, M. C., Togelius, J., & Hoover, A. K. (2019). Evolving the Hearthstone meta. In *2019 IEEE Conference on Games (CoG)* (pp. 1-8). https://doi.org/10.1109/CIG.2019.8847966 (full text)
- Dormans, J. (2012). *Engineering emergence: Applied theory for game design* [Doctoral dissertation, Universiteit van Amsterdam]. https://eprints.illc.uva.nl/id/eprint/2118/1/DS-2012-12.text.pdf (full text; thesis)
- Drummond, A., & Sauer, J. D. (2018). Video game loot boxes are psychologically akin to gambling. *Nature Human Behaviour, 2*(8), 530-532. https://doi.org/10.1038/s41562-018-0360-1 (record and standfirst; findings via Massey University's summary at https://www.massey.ac.nz/research/research-impact-stories/protecting-vulnerable-gamers/)
- England, L. (2016, October 4). *Review: Uncertainty in Games by Greg Costikyan*. https://lizengland.com/blog/2016/10/review-uncertainty-in-games-by-greg-costikyan/ (full text; blog review)
- Fendt, M. W., Harrison, B., Ware, S. G., Cardona-Rivera, R. E., & Roberts, D. L. (2012). Achieving the illusion of agency. In *Interactive Storytelling: ICIDS 2012* (pp. 114-125). Springer. https://doi.org/10.1007/978-3-642-34851-8_11 (full text, author preprint)
- Fiorillo, C. D., Tobler, P. N., & Schultz, W. (2003). Discrete coding of reward probability and uncertainty by dopamine neurons. *Science, 299*(5614), 1898-1902. https://doi.org/10.1126/science.1077349 (abstract)
- Fontaine, M. C., Lee, S., Soros, L. B., de Mesentier Silva, F., Togelius, J., & Hoover, A. K. (2019). Mapping Hearthstone deck spaces through MAP-Elites with sliding boundaries. In *Proceedings of GECCO '19* (pp. 161-169). ACM. https://doi.org/10.1145/3321707.3321794 (full text)
- Frommel, J., Klarkowski, M., & Mandryk, R. L. (2021). The struggle is spiel: On failure and success in games. In *FDG '21* (pp. 1-12). ACM. https://doi.org/10.1145/3472538.3472565 (abstract)
- Gajadhar, B. J., de Kort, Y. A. W., & IJsselsteijn, W. A. (2008). Shared fun is doubled fun: Player enjoyment as a function of social setting. In *Fun and Games 2008* (LNCS 5294, pp. 106-117). Springer. https://doi.org/10.1007/978-3-540-88322-7_11 (abstract)
- Gathercole, S. E., Pickering, S. J., Ambridge, B., & Wearing, H. (2004). The structure of working memory from 4 to 15 years of age. *Developmental Psychology, 40*(2), 177-190. https://doi.org/10.1037/0012-1649.40.2.177 (full text)
- Gómez-Maureira, M. A., Kniestedt, I., van Duijn, M., Rieffe, C., & Plaat, A. (2021). Level design patterns that invoke curiosity-driven exploration: An empirical study across multiple conditions. *Proceedings of the ACM on Human-Computer Interaction, 5*(CHI PLAY), Article 271. https://doi.org/10.1145/3474698 (full text)
- Grow, A., Dickinson, M., Pagnutti, J., Wardrip-Fruin, N., & Mateas, M. (2017). Crafting in games. *Digital Humanities Quarterly, 11*(4). https://dhq-static.digitalhumanities.org/pdf/000339.pdf (full text)
- Harris, J., Hancock, M., & Scott, S. D. (2016). Leveraging asymmetries in multiplayer games: Investigating design elements of interdependent play. In *CHI PLAY '16* (pp. 350-361). ACM. https://doi.org/10.1145/2967934.2968113 (full text)
- Hernandez, D., Toyin Gbadamosi, C. T., Goodman, J., & Walker, J. A. (2020). Metagame autobalancing for competitive multiplayer games. In *2020 IEEE Conference on Games (CoG)* (pp. 275-282). https://doi.org/10.1109/CoG47356.2020.9231762 (full text)
- Hicks, K., Dickinson, P., Holopainen, J., & Gerling, K. (2018). Good game feel: An empirically grounded framework for juicy design. In *Proceedings of DiGRA 2018*. https://doi.org/10.26503/dl.v2018i1.936 (full text)
- Hicks, K., Gerling, K., Dickinson, P., & Vanden Abeele, V. (2019). Juicy game design: Understanding the impact of visual embellishments on player experience. In *CHI PLAY '19* (pp. 185-197). ACM. https://doi.org/10.1145/3311350.3347171 (abstract)
- Holmgård, C., Green, M. C., Liapis, A., & Togelius, J. (2019). Automated playtesting with procedural personas through MCTS with evolved heuristics. *IEEE Transactions on Games, 11*(4), 352-362. https://doi.org/10.1109/TG.2018.2808198 (full text, preprint)
- Hunicke, R. (2005). The case for dynamic difficulty adjustment in games. In *ACE '05* (pp. 429-433). ACM. https://doi.org/10.1145/1178477.1178573 (abstract)
- Iacovides, I., Cox, A. L., McAndrew, P., Aczel, J. C., & Scanlon, E. (2015). Game-play breakdowns and breakthroughs: Exploring the relationship between action, understanding, and involvement. *Human-Computer Interaction, 30*(3-4), 202-231. https://doi.org/10.1080/07370024.2014.987347 (abstract)
- Inal, Y., & Cagiltay, K. (2007). Flow experiences of children in an interactive social game environment. *British Journal of Educational Technology, 38*(3), 455-464. https://doi.org/10.1111/j.1467-8535.2007.00709.x (abstract)
- Iyengar, S. S., & Lepper, M. R. (2000). When choice is demotivating: Can one desire too much of a good thing? *Journal of Personality and Social Psychology, 79*(6), 995-1006. https://doi.org/10.1037/0022-3514.79.6.995 (full text)
- Jaffe, A., Miller, A., Andersen, E., Liu, Y.-E., Karlin, A., & Popović, Z. (2012). Evaluating competitive game balance with restricted play. In *Proceedings of AIIDE 2012* (pp. 26-31). AAAI. https://doi.org/10.1609/aiide.v8i1.12513 (full text)
- Juul, J. (2002). The open and the closed: Games of emergence and games of progression. In F. Mäyrä (Ed.), *Computer Games and Digital Cultures Conference Proceedings* (pp. 323-329). Tampere University Press. https://doi.org/10.26503/dl.v2002i1.9 (full text)
- Juul, J. (2013). *The art of failure: An essay on the pain of playing video games*. MIT Press. ISBN 978-0-262-01905-7. (record, plus the chapter 1 excerpt published by Salon at https://www.salon.com/2013/07/13/video_games_make_us_all_losers/)
- Juul, J., & Begy, J. S. (2016). *Good feedback for bad players? A preliminary study of 'juicy' interface feedback* [Poster]. First Joint FDG/DiGRA Conference, Dundee. http://www.jesperjuul.net/text/juiciness.pdf (full text; poster)
- Kang, M. J., Hsu, M., Krajbich, I. M., Loewenstein, G., McClure, S. M., Wang, J. T., & Camerer, C. F. (2009). The wick in the candle of learning: Epistemic curiosity activates reward circuitry and enhances memory. *Psychological Science, 20*(8), 963-973. https://doi.org/10.1111/j.1467-9280.2009.02402.x (full text)
- Kao, D. (2020). The effects of juiciness in an action RPG. *Entertainment Computing, 34*, 100359. https://doi.org/10.1016/j.entcom.2020.100359 (abstract)
- Kao, D., Ballou, N., Gerling, K., Breitsohl, H., & Deterding, S. (2024). How does juicy game feedback motivate? Testing curiosity, competence, and effectance. In *CHI '24* (pp. 1-16). ACM. https://doi.org/10.1145/3613904.3642656 (abstract)
- Keren, I. (2018). *Boss up: Boss battle design fundamentals and retrospective* [Conference talk]. Game Developers Conference. https://www.gdcvault.com/play/1024921/Boss-Up-Boss-Battle-Design (slides read in full; talk)
- King, D. L., & Delfabbro, P. H. (2018). Predatory monetization schemes in video games (e.g. 'loot boxes') and internet gaming disorder. *Addiction, 113*(11), 1967-1969. https://doi.org/10.1111/add.14286 (abstract, plus the University of Adelaide press release at https://www.eurekalert.org/news-releases/462377)
- Koster, R. (2004). *A theory of fun for game design*. Paraglyph Press. ISBN 1-932111-97-2. (record; claims via Koster, 2006 and 2012)
- Koster, R. (2006, March 6). *A Theory of Fun milestone - and postmortem* [Blog post]. Read via the Internet Archive: https://web.archive.org/web/2024/https://www.raphkoster.com/2006/03/06/a-theory-of-fun-milestone-and-postmortem/ (full text; blog)
- Koster, R. (2012, January 24). *An atomic theory of fun game design* [Blog post]. Read via the Internet Archive: https://web.archive.org/web/2024/https://www.raphkoster.com/2012/01/24/an-atomic-theory-of-fun-game-design/ (full text; blog)
- Lantz, F., Isaksen, A., Jaffe, A., Nealen, A., & Togelius, J. (2017). *Depth in strategic games* [Workshop paper]. AAAI 2017 Workshop on What's Next for AI in Games. http://www.nealen.net/papers/Lantz2017Depth.pdf (full text)
- Loewenstein, G. (1994). The psychology of curiosity: A review and reinterpretation. *Psychological Bulletin, 116*(1), 75-98. https://doi.org/10.1037/0033-2909.116.1.75 (full text)
- Mahlmann, T., Togelius, J., & Yannakakis, G. N. (2012). Evolving card sets towards balancing Dominion. In *2012 IEEE Congress on Evolutionary Computation* (pp. 1-8). https://doi.org/10.1109/CEC.2012.6256441 (full text)
- Malone, T. W. (1981). Toward a theory of intrinsically motivating instruction. *Cognitive Science, 5*(4), 333-369. https://doi.org/10.1207/s15516709cog0504_2 (abstract)
- Meier, S. (2012). *Interesting decisions* [Conference talk]. Game Developers Conference. https://gdcvault.com/play/1015756/Interesting (talk page; content via Alexander, 2012)
- Murray, J. H. (1997). *Hamlet on the holodeck: The future of narrative in cyberspace*. Free Press. ISBN 0-684-82723-9. (record; definition as quoted by Wardrip-Fruin et al., 2009)
- Nelson, M. J. (2011). Game metrics without players: Strategies for understanding game artifacts. In *AAAI Technical Report WS-11-19* (pp. 19-24). AAAI. https://doi.org/10.1609/aiide.v7i3.12479 (full text)
- Patall, E. A., Cooper, H., & Robinson, J. C. (2008). The effects of choice on intrinsic motivation and related outcomes: A meta-analysis of research findings. *Psychological Bulletin, 134*(2), 270-300. https://doi.org/10.1037/0033-2909.134.2.270 (full text)
- Paul, C. A. (2011). Optimizing play: How theorycraft changes gameplay and design. *Game Studies, 11*(2). https://gamestudies.org/1102/articles/paul (full text)
- Petralito, S., Brühlmann, F., Iten, G., Mekler, E. D., & Opwis, K. (2017). A good reason to die: How avatar death and high challenges enable positive experiences. In *CHI '17* (pp. 5087-5097). ACM. https://doi.org/10.1145/3025453.3026047 (abstract)
- Przybylski, A. K., Rigby, C. S., & Ryan, R. M. (2010). A motivational model of video game engagement. *Review of General Psychology, 14*(2), 154-166. https://doi.org/10.1037/a0019440 (full text)
- Quantic Foundry. (n.d.). *Gamer motivation model*. https://quanticfoundry.com/gamer-motivation-model/ (full text; industry model)
- Rocha, J. B., Mascarenhas, S., & Prada, R. (2008). Game mechanics for cooperative games. In N. Zagalo & R. Prada (Eds.), *Actas da Conferência ZON | Digital Games 2008* (pp. 72-80). Universidade do Minho. http://www.lasics.uminho.pt/ojs/index.php/zondgames08/article/view/343 (full text)
- Ryan, R. M., Rigby, C. S., & Przybylski, A. (2006). The motivational pull of video games: A self-determination theory approach. *Motivation and Emotion, 30*(4), 344-360. https://doi.org/10.1007/s11031-006-9051-8 (full text)
- Salen, K., & Zimmerman, E. (2004). *Rules of play: Game design fundamentals*. MIT Press. ISBN 0-262-24045-9. (full text of an ebook rendering; printed page numbers not checked)
- Scheibehenne, B., Greifeneder, R., & Todd, P. M. (2010). Can there ever be too many options? A meta-analytic review of choice overload. *Journal of Consumer Research, 37*(3), 409-425. https://doi.org/10.1086/651235 (full text)
- Seif El-Nasr, M., Aghabeigi, B., Milam, D., Erfani, M., Lameman, B., Maygoli, H., & Mah, S. (2010). Understanding and evaluating cooperative games. In *CHI '10* (pp. 253-262). ACM. https://doi.org/10.1145/1753326.1753363 (abstract; details via Aghabeigi, 2011)
- Stout, M. (2015, September 2). Enemy attacks and telegraphing. *Game Developer*. https://www.gamedeveloper.com/design/enemy-attacks-and-telegraphing (full text; practitioner article)
- Sweetser, P., & Wiles, J. (2005). Scripting versus emergence: Issues for game developers and players in game environment design. *International Journal of Intelligent Games and Simulation, 4*(1), 1-9. https://eprints.qut.edu.au/46349/ (full text)
- Sweetser, P., & Wyeth, P. (2005). GameFlow: A model for evaluating player enjoyment in games. *Computers in Entertainment, 3*(3), Article 3. https://doi.org/10.1145/1077246.1077253 (full text)
- Sweller, J. (1988). Cognitive load during problem solving: Effects on learning. *Cognitive Science, 12*(2), 257-285. https://doi.org/10.1207/s15516709cog1202_4 (abstract)
- Swink, S. (2007, November 23). Game feel: The secret ingredient. *Game Developer*. https://www.gamedeveloper.com/design/game-feel-the-secret-ingredient (full text; practitioner article)
- Takeuchi, L., & Stevens, R. (2011). *The new coviewing: Designing for learning through joint media engagement*. The Joan Ganz Cooney Center at Sesame Workshop. https://joanganzcooneycenter.org/wp-content/uploads/2011/12/jgc_coviewing_desktop.pdf (full text; report)
- To, A., Ali, S., Kaufman, G., & Hammer, J. (2016). Integrating curiosity and uncertainty in game design. In *Proceedings of DiGRA/FDG 2016*. https://doi.org/10.26503/dl.v2016i1.793 (full text)
- Tondello, G. F., Arrambide, K., Ribeiro, G., Cen, A. J., & Nacke, L. E. (2019). "I don't fit into a single type": A trait model and scale of game playing preferences. In *Human-Computer Interaction - INTERACT 2019* (pp. 375-395). Springer. https://doi.org/10.1007/978-3-030-29384-0_23 (full text, author preprint)
- Voida, A., & Greenberg, S. (2009). Wii all play: The console game as a computational meeting place. In *CHI '09* (pp. 1559-1568). ACM. https://doi.org/10.1145/1518701.1518940 (full text)
- Wang, B., Taylor, L., & Sun, Q. (2018). Families that play together stay together: Investigating family bonding through video games. *New Media & Society, 20*(11), 4074-4094. https://doi.org/10.1177/1461444818767667 (abstract)
- Wardrip-Fruin, N., Mateas, M., Dow, S., & Sali, S. (2009). Agency reconsidered. In *Proceedings of DiGRA 2009*. https://doi.org/10.26503/dl.v2009i1.369 (full text)
- Xiao, C., & Yang, Z. (2025). LLMs may not be human-level players, but they can be testers: Measuring game difficulty with LLM agents. *Proceedings of the ACM on Human-Computer Interaction, 9*(6), 1097-1123. https://doi.org/10.1145/3748634 (full text, preprint)
- Yee, N. (2006). Motivations for play in online games. *CyberPsychology & Behavior, 9*(6), 772-775. https://doi.org/10.1089/cpb.2006.9.772 (full text)
- Zendle, D., & Cairns, P. (2018). Video game loot boxes are linked to problem gambling: Results of a large-scale survey. *PLOS ONE, 13*(11), e0206767. https://doi.org/10.1371/journal.pone.0206767 (full text)
- Zendle, D., Meyer, R., & Over, H. (2019). Adolescents and loot boxes: Links with problem gambling and motivations for purchase. *Royal Society Open Science, 6*(6), 190049. https://doi.org/10.1098/rsos.190049 (full text)

### Not cited, because they could not be verified

- Koster's widely quoted book line "Fun is just another word for learning" was
  found only on quote sites, not in a primary source.
- Swink's widely quoted book definition of game feel was not found on any page
  that was opened. The 2007 article is cited instead.
- No peer-reviewed study of attack telegraphs, of roguelite build-crafting, or
  of Noita-style ordered spell composition was found.
- No peer-reviewed validation of the Quantic Foundry model was found.
- Abuhamdeh et al. (2015): the sample of 72 and the "69 percent" replay figure
  appear only in a press release, so they are not used.
