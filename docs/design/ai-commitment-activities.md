# Goal commitment and settler activities

NPCs used to change their minds several times a second, and settlers had
nothing to do but stand at their posts. This change makes a chosen goal hold,
and gives settlers things to do at the props around them: cards at a table,
tinkering at a lab bench, rest in a bunk.

## How it was measured

`scripts/goal-census.mts` runs every crafted scene plus five generated city
floors and five station floors for 90 s each, with idle players, and records
every NPC's goal each tick (`src/debug/goalCensus.ts`). It reports goal
switches per NPC-minute, the median time spent in a goal, and A→B→A
flip-flops (a goal left and re-adopted within 2 s). Run it in this branch and
in an export of main (with `goalCensus.ts` and the script copied in) to compare.

```
npx tsx scripts/goal-census.mts [--seconds 90] [--json out.json]
```

## The mechanism

`decide` (`systems/behaviors.ts`) re-scores every consideration on every think,
about 6 times a second. The only stickiness was a 25% score bonus for the
standing goal, and that bonus only applies while the standing goal is still
offered. The measured flip-flops all came from candidates that vanish at a hard
edge:

- A settler catches a fear pulse within `FEAR_RADIUS` and flees (`contagiousFear`,
  panic tier). Six ticks later it is outside the radius, the candidate is gone,
  and `garrison` walks it straight back in. Each re-entry into flight screams a
  new pulse, so two settlers kept each other running with no threat present.
- A predator's `packAvoid` fires inside `PACK_RADIUS`. Fleeing carries it out,
  `stalkWeakest` brings it back in. Flee, battle, flee every 9 ticks.
- A fighter that blinks out of sight drops `battle` for a memory or ambient goal
  for one think, then takes it up again.

RNG noise and score ties played no part: the loops are deterministic limit cycles.

## The design

**Commitment.** A goal holds for `commitTicks(code, tier)` ticks. While it
holds and its candidate is no longer offered, a candidate on a lower tier never
replaces it, and one on the same tier only does if it names a new target: a
thug that loses sight of one player turns on another at once. A goal that is
still offered competes as before, through the margin, so a wounded fighter
still turns to flee. Flight only commits when panic started it (a scream, a
pack too strong to face). Flight from an enemy seen at the threat tier ends by
the behavior's own memory, as on main: holding it kept badly wounded Castle
Siege defenders running blind, and the scripted bot lost the scene.
Steering releases the commitment when it finishes or abandons the goal: on
arrival, when cornered, or when a trail goes cold. Two spatial deadbands remove
shared edges: a predator does not stalk back toward a healthy pack until the
pack is `PACK_MARGIN` tiles beyond the range it broke off at, and a fight on a
target stays `battle` until the target is `ENGAGE_MARGIN` past `ENGAGE_RANGE`.

**Activities as smart objects** (`systems/activities.ts`). A table with chairs
round it, a lab bench or a bunk advertises an activity. A settler (civ faction)
whose cooldown has run out proposes the nearest free seat (`unwind`, ambient
tier), claims it, walks there, sits facing the prop, and performs. A card game
starts only when every claimant has sat down and at least two have; the start
rolls one end tick that every seat shares, so the table gets up together. The
claim (`ai.activity`) lives only on the NPC, and a site's occupancy is derived
from the live claimants, so a death or an interrupt frees the seat with no
second record to update. A held claim outscores every other ambient goal through
the incumbent margin. A threat (a higher tier) ends it at once, and so does
gunfire or a blast in earshot: the settler looks up from its cards and goes to
see.

**Rejected: a routine layer.** A stateless per-settler schedule (work, then
leisure, then rest) cut settler time at activities from 36% to 23% and the card
games from 8 to 6, and changed the flip-flop rate by nothing measurable. The
cooldown between sessions already gives the rhythm.

## Results (census, 19 worlds × 90 s)

Main at 85394077 against this branch, the same worlds:

| | switches/min | median dwell | A→B→A <2 s /min | settler A→B→A | settler median dwell | settler time in activity |
|---|---:|---:|---:|---:|---:|---:|
| main | 1.85 | 1.50 s | 0.78 | 0.15 | 2.4 s | 0% |
| **this branch** | **1.59** | **4.20 s** | **0.15** | **0.04** | **20.0 s** | **37%** |

Settler switches rise (0.41 → 1.83 per minute) because settlers now go and do
things, and each of those switches starts a goal that lasts about 20 s.

While designing, the same census compared (a) commitment alone, (b) activities
alone and (a)+(b) through temporary toggles, since removed. (a) alone held the
flip-flops down without giving settlers anything to do. (b) alone reopened a
settler work→flee→work loop (60 times) that (a) removes. A routine layer on top
cut activity time from 36% to 23% with no measurable change in flip-flops.

The authored regression in `systems/commitment.test.ts` (the scream and pack
loops, 60 s each) is held against what main did on the same scenes: 237
switches and 231 flip-flops there, against 10 and 2 now.

## Co-op

The AI runs on the host. A seated settler's activity, and whether play has
started, rides a sparse trailer after the status trailer in every snapshot
(`WIRE_ACTIVITIES`, protocol 9), so a client draws the same card game.

## Where to look

- `systems/behaviors.ts`: `commitTicks`, `holdTier`, `decide`, `unwind`.
- `systems/activities.ts`: the activity table, seat claims, `activitySystem`.
- `render/activityFxModel.ts`: the card fan, the card laid each beat, the pile,
  and the card over each player's head.
- Tests: `systems/commitment.test.ts`, `systems/activities.test.ts`, and the
  `card-night` scene in `scenes/scenes.test.ts`.
