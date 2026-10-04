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
flip-flops (a goal left and re-adopted within 2 s). `--flags` runs any
combination of the `aiFlags` toggles, so every variant below comes from the same
binary and the same worlds.

```
npx tsx scripts/goal-census.mts --flags commitment=false,activities=false   # main's AI
npx tsx scripts/goal-census.mts                                              # shipped
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

**Commitment.** A goal adopted with an entry in `COMMIT_TICKS` holds for that
many ticks. While it holds, if its candidate is no longer offered, only a
candidate on a higher tier replaces it. A goal that is still offered competes
as before, through the margin, so a wounded fighter still turns to flee.
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
second record to update. A claim holds its goal against every other ambient
candidate. A threat (a higher tier) ends it at once.

**Rejected: a routine layer.** A stateless per-settler schedule (work, then
leisure, then rest) cut settler time at activities from 36% to 23% and the card
games from 8 to 6, and changed the flip-flop rate by nothing measurable. The
cooldown between sessions already gives the rhythm.

## Results (census, 19 worlds × 90 s)

On main as of ed65863 (every floor from 3 is the indoor station):

| variant | switches/min | median dwell | A→B→A <2 s /min | settler A→B→A | settler median dwell | settler time in activity |
|---|---:|---:|---:|---:|---:|---:|
| main | 1.23 | 3.00 s | 0.32 | 0.06 | 3.0 s | 0% |
| commitment only | 1.03 | 3.20 s | 0.11 | 0.03 | 3.2 s | 0% |
| activities only | 2.11 | 2.80 s | 0.80 | 0.62 | 8.0 s | 38% |
| **both (shipped)** | **1.44** | **4.20 s** | **0.13** | **0.09** | **20.0 s** | **39%** |

Activities alone bring back a settler loop (work→flee→work, 60 times) that
commitment then removes, which is why the two ship together. Total switches
rise with activities because settlers now go and do things: each of those
switches starts a goal that lasts about 20 s.

On the station floors main built before #149 the same census measured a far
worse baseline, dominated by the loops described above: 2.13 switches/min,
0.33 s median dwell and 1.30 flip-flops/min, falling to 1.38, 4.00 s and 0.18
with both shipped (settler flip-flops 1.59 → 0.06 per minute).

The authored regression in `systems/commitment.test.ts` (the scream and pack
loops, 60 s each) falls from 74.7 to 4.6 switches/min and from 72.8 to 0.9
flip-flops/min.

## Co-op

The AI runs on the host. A seated settler's activity, and whether play has
started, rides a sparse trailer after the status trailer in every snapshot
(`WIRE_ACTIVITIES`, protocol 6), so a client draws the same card game.

## Where to look

- `systems/behaviors.ts`: `COMMIT_TICKS`, `holdTier`, `decide`, `unwind`.
- `systems/activities.ts`: the activity table, seat claims, `activitySystem`.
- `render/activityFxModel.ts`: the card fan, the card laid each beat, the pile,
  and the card over each player's head.
- Tests: `systems/commitment.test.ts`, `systems/activities.test.ts`, and the
  `card-night` scene in `scenes/scenes.test.ts`.
