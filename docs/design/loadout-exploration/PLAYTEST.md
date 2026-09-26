# Playtest protocol: loadout prototypes

You are a playtester, not a cheerleader. The owner asked for a mechanic that adds
**significant, meaningful combinatorial complexity**, works as a **mini puzzle**, **very
significantly affects play**, and lets players **prepare for a boss that is weak to
lightning**. He is a father playing co-op with his nephews (kids) on phones with a
controller. Your job is to find out, by playing, whether this build delivers that. **Default
to "not fun" and "no variety" unless the play log proves otherwise.** A score without
evidence is worthless.

## Your tool

Headless playtest CLI on the branch you were given. Read `.claude/skills/verify-sporefall/SKILL.md`
§ "Playtest headless" first. The basics:

```sh
pt() { npx tsx scripts/playtest.mts "$@"; }
pt s.json new --seed <N> [--scenario NAME] [--sequenced] [plus any flag the prototype's PLAYBOOK.md names]
pt s.json look 12
pt s.json step 45 '{"aimAt":<id>,"attack":true,"moveX":-1}'
pt s.json spawn npc brute 10 12
pt s.json set <id> '{"resist":{"electrified":2}}'
pt s.json addMod <playerId> shock
```

The prototype's `PLAYBOOK.md` (repo root of its branch) lists its new verbs or input
fields: how to reorder, eject, or switch guns, and its scenario names. Use them the way a
player would, meaning only things a player could do with a controller. Use the debug verbs
(`spawn`, `set`, `addMod`, `teleport`) **only to stage** a situation, never to win it.

Play like a person: bursts of 15 to 60 ticks, then `look`, then decide. Move. Dodge (`roll`).
Retreat when hurt. A playtest where you stand still and hold fire is not a playtest.

## The three sessions (do all three, use a fresh state file each)

**S1. The roster (variety).** Seed 101. Stage four fights, one at a time, each about 6 tiles
away: a `brute` (bullets bounce off it), a `cinder` (shrugs off fire), a `sporeling` swarm
of 3, and a mixed pack (`thug` ×2 + `stalker`). Give yourself the same **starting hand of 4
mods** each time: `shock`, `incendiary`, `frost`, `pierce` (or the prototype's equivalents
per its PLAYBOOK). Before each fight, **rearrange or reconfigure the build for that enemy**
using only player actions. Record whether the best setup was **different per enemy**. If
one setup wins every fight, that is the finding.

**S2. The lightning boss (preparation).** Seed 202. Spawn the `boss` archetype (Mireclaw
Alpha) about 8 tiles away and make it weak to lightning (`set <id> {"resist":{"electrified":2}}`,
or the prototype's own mechanism if its PLAYBOOK has one). Fight it **twice** from the same
starting state (copy the state file before the fight):
1. **Unprepared.** Keep whatever arrangement you had from S1's last fight.
2. **Prepared.** You know it is weak to lightning, so rebuild for it with the prototype's
   mechanics first.

Record ticks to kill (or how far you got), damage taken, and revives used. **Did preparing
change the outcome significantly?** Also check whether the weakness was discoverable in
play without being told.

**S3. The prototype's own scenario.** Run whatever PLAYBOOK.md names as the showcase. Try
to **break it**. Look for a degenerate loop, a dominant build, an exploit (eject and re-pick
for free?), a way to get stuck, or anything a kid would find confusing.

## What to return

Scores are 1 to 5 and must cite log lines.

- `fun`: would the owner's nephews want to play the next floor because of this mechanic?
- `variety`: did different enemies and situations demand genuinely different builds?
- `puzzle`: was building a small, satisfying problem, or a lookup, or busywork?
- `prep_impact`: the S2 unprepared-vs-prepared delta, in numbers.
- `kid_legibility`: could a 10-year-old tell what their build will do before firing?
- `distinct_answers`: how many genuinely different winning approaches you found across S1 and S2.
- `best_moment` / `worst_moment`: one concrete sentence each, from the log.
- `exploits_or_bugs`: each with its repro command line.
- `verdict`: one paragraph, critical.
- `evidence`: the key command lines and their replies (trimmed), enough for someone to rerun.
