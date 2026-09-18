# Enemy groups — tides, packs and hives

Status: **built** on `feat/enemy-groups`. Code: `src/game/systems/groups.ts` (the
group layer), `src/game/systems/behaviors.ts` (the member brains),
`src/game/systems/groupFx.ts` (rally/rage modifiers). Tests:
`src/game/systems/groups.test.ts`.

The ask was more enemies, with group mechanics in the spirit of RimWorld's raids.
The bar this doc holds to is the one `boss-variety.md` set: **if two mechanics are
beaten by doing the same thing, there is only one mechanic.** Each entry below
says what you have to do differently.

## What already existed, and was left alone

Per-body AI was already rich: squads that stack on doors and flank
(`squad`), a hive swarm drawn to stimuli (`vermin`), a predator that culls the
weakest (`predator`), dormant ambushers (`lurker`, pods, dormancy), crowd
stampedes (contagious fear), barricaders, the station-alert manhunt, infection,
and the complex director's vent swarms, bunk ambushes and lights-out.

What was missing is a layer **above** the individual. Every one of those is a
body deciding for itself. RimWorld's raids read as an *enemy* rather than a mob
because something above the pawns decides when to go, where to gather, who the
officer is and when the nerve breaks. That layer is the new work.

## The layer

`World.groups` holds each group's shared state as plain JSON: kind, phase, target,
rally point, and an intel mark on the target. `groupSystem` runs once per tick,
advances phases, and applies the group-wide effects. Members carry only
`ai.group = {id, role}`; their considerations read the group and propose goals
through the ordinary tiered arbitration. Nothing in the group layer steers a
body, so every existing rule (hysteresis, tiers, routing, perception) still holds.

Lore: raids are **tides**. The swamp redreams a colony work crew or security
detail and exhales it at you together, in the order it remembers.

## The roster (7)

| archetype | name | role | what it changes |
|---|---|---|---|
| `drowner` | Drowned Diver | raid grunt | the body of every tide: a harpoon (pistol-grade) diver echo. Dangerous in numbers, not alone |
| `bellwether` | Tide Bellwether | officer | its bell rallies raiders within 6 tiles: +15% speed, -25% damage taken. Kill it and the raid routs |
| `mender` | Bog Mender | medic | unarmed, hangs behind the line and heals; wounded raiders fall back to it |
| `breacher` | Blast Diver | sapper | walks the raid through locked hatches: plants a charge, backs off, blows the door |
| `lobber` | Spore Mortar | siege gun | a spore-ogre hauling a mortar tube: keeps 7-10 tiles off and lobs shells over walls and heads at the raid's fix on you |
| `gloamhound` | Gloam Hound | pack beast | encircles before closing; hurting one sends the pack manhunter |
| `hivespire` | Hive Spire | infestation | rooted; buds sporelings at anyone near and plants new spires over time |

Resist tables keep the #78 rule (no single weapon clears the deck): fire is the
answer to spires and mortars, the officer shrugs off some impact, the medic
ignores toxins.

## The mechanics (6)

**1. Raid strategies.** A tide rolls one of four, by depth:

- *Assault* (floor 2+): dropped in 6-9 tiles away, already hunting. Verb: **react**.
- *Staging* (2+): arrives out of sight, gathers at a rally point, then every member
  commits **on the same tick**. Being spotted mid-muster springs it early; a
  straggler cannot hold it past 14s. Verb: **catch them gathering**.
- *Sappers* (3+): arrives behind a locked hatch if the floor has one. The breacher
  plants a 1.6s charge and clears the blast; escorts stack behind it. Verb: **stop
  the breacher, or be where the door isn't**.
- *Siege* (4+): the mortar sets up in its band and shells your position whenever
  any raider can see you; escorts guard it. The siege becomes an assault after 30s,
  or at once if you get within 6 tiles of a gun. Verb: **charge the battery**.

Raids know where you are only through an intel mark refreshed every 3s (like the
station alert's broadcast), so they are evadable.

**2. Command & morale.** The officer's aura is refreshed every tick and lapses
10 ticks after it dies. A raid **routs** when its officer falls, or when half its
muster is dead (raids of 3+). Routed raiders flee the nearest player; any that stay
out of sight for 6s dissolve back into the swamp with no drop. Verb: **decapitate**.

**3. Retreat to heal.** Below 40% hp, a raider with a living medic falls back to
it (PANIC tier) and holds until healed to 80%, then rejoins. The medic heals the
worst-hurt member within 2.2 tiles every second. Verb: **kill the medic, or catch
the wounded on the way back**.

**4. Encirclement.** A pack that spots prey fixes an approach bearing and each hound
takes an evenly spaced slot on a 3-tile ring. The ring closes when everyone is in
place (or after 4s), then they go in together. Verb: **don't let them get round
you — break the ring or back into a corner**.

**5. Manhunter rage.** A player's landed blow on any hound enrages its pack for 20s:
+20% speed (5.04, faster than you), no fear, tracks the aggressor. The howl carries
to any pack within 14 tiles. Verb: **pick your fights — or don't fight near two packs**.

**6. Infestation.** A spire buds a sporeling every 8s while a player is within 16
tiles (at most 3 alive), and every 30s roots a half-grown spire 4-7 tiles away (floor
cap: 2 + floor/2, at most 5). Verb: **burn it early**.

## Spawning and depth

- Floor 1: nothing new. Its population is untouched.
- Hound packs: one likely on floors 2-4, two from floor 5. Size 3-5.
- Hive spires: from floor 3, two from floor 6.
- Tides: `tideCount(floor)` raids per floor (1 on floor 2, up to 3), the first
  32-42s in, then every 40-60s. Size `2 + floor`, at most 8. At most 12 raiders
  alive at once, which keeps inside the 48-entity snapshot budget.
- City and complex floors both get these. On complex floors the director's vent
  swarms and ambushes still run as well.

## Determinism and cost

- The group layer never draws from `w.rng`. Its dice are stateless forks of the
  run seed (`groupRng`), and populate places groups on its own `groups` fork after
  every other stream. Existing layout, loot and dice are byte-identical per seed.
  Only the entity list grows. There is a test that asserts `w.rng` does not move.
- `World.groups` serializes only when present. Mid-raid snapshots replay
  byte-identically, and this is tested.
- Cost per tick is O(members x entities) for the few live groups. The two
  searches (arrival flood fill, sapper route) run once per raid or door. Spires are
  rooted in `movement.ts`, so bodies give way to them.
- Wire: 7 archetypes appended, `PROTOCOL_VERSION` 3 → 4.

## Art

All seven were generated through the repo's ComfyUI pipeline
(`scripts/assets/generate.py sweep` → `curate` → `hires_chars.py` for the 96px
pack, `final` for the 48px pack), 8 seeds per character, and the picks are recorded
in `curation.json` with durable raws in `scripts/assets/raws/`. Contact sheet:
`docs/assets/enemy-groups/contact-sheet.png`.

- **The recipe that matched the hi-res cast was the r2 one**: juggernautXL at 768
  with the chunky-biped prompt for the upright kinds (`CHUNKY_BIPEDS` in
  generate.py). The first round on the anime base (anything-xl) was rejected. It
  drew grey figures that the palette lock would have left in the metals, anime
  girls for the medic (15 of 16 across two prompt versions), and sleek power armour
  with no charge on it for the sapper.
- Compromises: juggernaut drew the Spore Mortar as a biped hauling its tube (7 of 8
  seeds), not the four-legged beast in the prompt. Every hive-spire seed came with
  an isometric plinth, and the pick has the smallest one.
- South idle only; every direction borrows it, as the rest of the cast does.

## Reproducible scenarios (for `?state=` capture)

Each one runs on the seed's own generated level (no tile carving), so a
`sporefallShare()` capture restores. `src/game/groupScenarios.test.ts` asserts on
seed 3 that every one stays shareable and that its moment happens.
Open `/?seed=3&scenario=<name>&debug` (solo). The player is made unkillable.

| scenario | what to watch | when (seed 3) |
|---|---|---|
| `tide-staging` | the muster walks in from several directions, gathers, then all charge on one tick. Shoot the brass-bell officer and the raid routs | attack ~1.5s |
| `tide-siege` | the mortar walks to its band and lobs shells; the escorts hold round it. Rush the gun and the siege breaks | first shell ~2.3s |
| `tide-sappers` | the player is sealed in a building with every doorway locked. The Blast Diver walks to a door, plants, backs off, and blows it | charge ~10s, breach ~11.7s |
| `hound-ring` | the near pack fans out around the player before it closes. Shoot a hound and both packs go manhunter | ring closes ~2s |
| `hive-spread` | the spire buds sporelings at the player, and 30s in it roots a second spire | bud ~2s, spread 30s |
| `tide-medic` | wounded raiders fall back to the Bog Mender, get healed, and return | heals from ~0s |

Seed 3 on floor 1 spawns the player in a map corner (1.5, 1.5). That is fine for
most of these, but the hound ring there is a half ring against the walls.
`docs/assets/enemy-groups/sim-render.png` shows four of the moments.

## Not built, on purpose

- **Kidnapping downed players** (RimWorld's raiders carry off colonists). The downed
  and revive flow is solo-self-revive plus co-op revive. Dragging a body fights both,
  and it needs a design pass of its own.
- **Cover.** Only walls and closed doors block sight (`los.ts`). "Take cover" would
  mean inventing cover, not using it.
- **A mortar telegraph on screen.** A `lob` event carries the landing point and the
  flight time (0.8-2s), so a renderer can draw the circle. That drawing is not in
  this branch. Open issue #1 (wind-up/telegraph) is the general fix.
- **Per-direction art.** Every new kind ships a south-facing idle that all
  directions borrow, which matches the current cast.
