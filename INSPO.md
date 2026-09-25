# INSPO.md — where Sporefall Station's mechanics came from

Every game, book, building and research paper that has been named as a reference
for this project, what was actually taken from it, and where that stands in the
code today. Written so an agent can act on it: each entry says what to look at
in `src/`, and each claim carries a citation you can go re-read.

This is a **reference, not a wish list.** An idea being in here is not approval
to build it. Entries marked `discussed only` were proposed and never ruled on;
entries marked `rejected` were turned down and the reasoning is preserved so the
same idea does not get re-pitched.

## Status vocabulary

| Status | Means |
|---|---|
| `shipped` | On `main` today, with the file named |
| `partly shipped` | Some of it is on `main`; the rest is named as missing |
| `behind a flag` | Implemented but off by default; the flag is named |
| `discussed only` | Proposed in a session, PR or doc; never built, never ruled out |
| `rejected` | Turned down. The reason is quoted |

## Provenance conventions

- `mindmeld <session>/<msg>` — a session and message id in the local mindmeld
  index. Read it with `mcp__mindmeld__getMessage({ id })`, or
  `getSession({ sessionId })` for the digest.
- Quotes attributed to the owner are reproduced from the archive verbatim. Many
  of them survive only inside a later agent's digest rather than as a raw
  message; where that is the case it is said so, because a digest can mislabel
  what it quotes (see [Contested](#contested-and-uncertain)).
- In-repo sources are given as paths. PRs and issues are `#n` on
  `redaphid/sporefall-station`.

---

## 1. Mods, elements and composition — the spine

The owner's own framing, and the thing everything else is judged against:

> "And also the combinatorial complexity matters a lot. That's the core game
> mechanic."
> — quoted in mindmeld 7431/1613915 (2026-08-12)

### ROUNDS (Landfall) — weapon modifiers that bundle a downside

- **Taken:** per-pickup modifier cards that stack onto the gun, each pairing an
  upgrade with a cost (reload time, damage, attack speed), plus rarity tiers —
  common stat boosts, uncommon new mechanics, rare build-definers.
- **Why it fits:** the owner asked for it by name for a specific reason —
  *"I want a mechanic that's kind of like ROUNDS' weapon mods - I think the
  family would have fun having really unique guns."* (mindmeld 2847/497306, via
  the digest at 6511/1437575). The game is played with his nephews; "unique
  guns" is the social payload.
- **Status: shipped.** `src/game/data/mods.ts` holds 18 mods; `resolveWeapon.ts`
  composes them deterministically into a weapon. PR #78 records the registry as
  *"authored from a study of ROUNDS (bundle-a-downside balance, rarity tiers) +
  Risk of Rain 2 (per-effect scaling curves)"* (mindmeld 59006/3203738).
- **Research base:** mindmeld 5009/1322448 is a full sourced card-by-card study
  of ROUNDS with wiki links, including the correction that ROUNDS has **no**
  vanilla split-bullet or smoke card (those are mods, not base game) — worth
  knowing before citing ROUNDS for a feature it does not have.

### Risk of Rain 2 — pick the scaling curve per effect

- **Taken:** the three stacking curves — linear `1 + a·x`, hyperbolic
  `1 − 1/(1+a·x)`, exponential `aˣ` — and the rule that anything which could
  reach 100% (a chance, a reduction, a stun) must stack hyperbolically so it
  asymptotes instead of arriving.
- **Why it fits:** the game has already been bitten twice by effects that hit
  their ceiling — stun-lock and the frost execute. Hyperbolic stacking is the
  single most transferable formula in the research.
- **Status: shipped.** `resolveWeapon`'s clamps were swept and reported airtight
  (mindmeld 7431/1613915). The shatter payout was derived from it directly:
  *"1.83 = 14 × hyperbolic(0.15, 1), verified from first principles."*

### Noita — order is the mechanic

- **Taken:** a weapon as an ordered list of modifiers, where a modifier
  transforms what follows it, and the player rearranges freely.
- **Why it fits:** `onHit` keeps only one element per hit and silently drops the
  rest, so the combination space was capped at one. Sequencing turns that
  limitation into the rule instead of a bug. Three mods give six arrangements
  instead of one combination.
- **Status: behind a flag.** PR #78, flag `sequencedMods` in
  `src/app/featureFlags.ts` (default **off**); sim in
  `src/game/systems/modSequence.ts`. With the flag off, behaviour is proven
  byte-identical to `main` by golden digests captured on `main` @ `9d0894d`.
- **The design arguments, in the order they were made** (mindmeld 6880/1431697,
  6880/1431682, 7431/1613915) — these are the valuable part and none of them are
  written down elsewhere in the repo:
  1. **Free reordering is not optional.** *"If order here is fixed by pickup
     order, it's a slot machine: you get the arrangement you were dealt and a bad
     one is a bricked run."* Shipped as tap-two-to-swap chips (PR #78).
  2. **Composition, not alternation.** The owner's refinement: *"I also wouldn't
     want the projectiles to simply fire the element mods in the sequence that
     they do something - maybe the arrangement makes _different_ projectiles"*
     (his message arrived cut off mid-word; treat it as direction, not a complete
     statement). `[frost][heavy]` yields one projectile, not two shots taking
     turns. This killed the strongest objection on the table — "what if the shot
     you want is third in line" — because every trigger pull fires the composed
     projectile.
  3. **A grammar, not a table.** *"Every arrangement needs a defined result"*
     does not scale: arrangements grow factorially and a hand-authored pair table
     is finite work that never finishes, and is precisely how the design becomes
     arbitrary. Define per-mod *transformation rules* instead and every
     arrangement has an outcome by construction. The counter-measurement:
     capping length at 4 over 18 mods makes all ~105k sequences exhaustively
     unit-testable, so the factorial objection is not fatal either way.
  4. **The risk that comes with a grammar:** it generates results nobody
     designed — which is the point, and also how you get an exploit nobody wrote.
     Clamps must be designed *into* the rules, and the sweep run against
     generated compositions, not only authored ones.
  5. **Weapon identity and combination depth are one system.** If a weapon's
     sequence shape is its recipe capacity, a shotgun and a sledgehammer compose
     *different projectiles from the same mods*. Shipped in PR #78 as `slots` /
     `castsPerTrigger` / `rechargeOnWrap` per weapon.
- **Open question the owner has not answered** (PR #78): does Noita's "bad combos
  are funny" feel survive co-op? In Noita a bad wand only hurts you; here a
  mis-ordered wand means the teammate who asked you to freeze the brute gets a
  fire round.

### Nova Drift — the bullet looks like what it is made of

- **Taken:** compose the projectile's procedural appearance from its modifiers
  rather than authoring a sprite per combination.
- **Why it fits:** it is the cheapest possible answer to the legibility
  requirement, and it is the same substrate the owner asked for directly —
  *"I want the effects applied to the characters to be more obvious, and more
  awesome. Use shaders to make lightning look like lightning… modifying the look
  of the shaders via uniforms that are related to the weapon and it's mods as
  floats"* (mindmeld 2964/529417, via 6511/1437575).
- **Status: shipped.** The projectile codec carries the doc comment *"COMPOSE the
  bullet's procedural look from its mods, Nova-Drift style. Absent = vanilla
  shot"*; landed as `00433f4 Merge feat/procedural-bullet-visuals`.

### Enter the Gungeon — named, scoped synergies with in-UI discovery

- **Taken (as a model, not as code):** hundreds of hand-authored *named*
  synergies whose stat effects apply **only** to the guns in the synergy, plus
  the Ammonomicon highlighting which held items are currently synergising.
- **Why it considered well:** a named effect is more memorable and legible than
  emergent stat soup, and legibility is the hard requirement this whole system
  keeps failing.
- **Status: discussed only** (mindmeld 5009/1322448). It is also the design this
  project deliberately moved *away* from: the grammar route was chosen precisely
  because authoring pairs "collapses at about a dozen mods" (mindmeld 6507).
  Gungeon's separate contribution — the dodge roll — did ship; see §2.

### Gunfire Reborn — type tags as the synergy key

- **Taken:** inscriptions that change *damage type*, which then unlocks synergy
  with perks; higher-tier ascensions replace lower ones rather than stacking,
  while element-specific perks compound multiplicatively to reward focus.
- **Why it fits:** the owner's ruling that *"mods carry the rock-paper-scissors"*
  works exactly this way — an incendiary mod re-types the damage to fire and
  bypasses a brute's `physical: 0.35` resist. Type-tagging is the mechanism.
- **Status: discussed only** as an explicit reference (mindmeld 5009/1322448);
  the re-typing behaviour it describes is what `src/game/data/npcs.ts`'s resist
  tables already depend on.

### Brotato — additive pools, per-weapon scaling coefficients

- **Taken:** transparent additive stat pools (order does not matter, the maths is
  readable) plus a per-weapon scaling percentage on each stat.
- **Why it was raised:** as the mitigation for order-dependence confusion —
  "prefer additive pools where order doesn't matter".
- **Status: discussed only** (mindmeld 5009/1322448), and in tension with the
  Noita direction, which makes order the whole point. Recorded because if
  sequencing is ever abandoned, this is the named fallback.

### Nuclear Throne — the anti-example

- **Taken:** nothing, deliberately. Cited to show that a stacking system is a
  choice: Nuclear Throne has no weapon-mod system at all; variety comes from
  swapping whole weapons, and the only build layer is level-up mutations.
- **Status: discussed only** (mindmeld 5009/1322448). Its shape is closest to the
  direction the one-weapon rule moved *away* from.

### Rulings that came out of all of the above

These are owner decisions or decisions taken against his stated principles. They
constrain any future mod work.

1. **Elements must differ by VERB, not by number.**
   > *"I don't mind that ice followed by a hit found major damage + maybe
   > knockback. But we need to ensure each element feels different - they can't
   > all be damage over time"* (mindmeld 7431/1613915)

   A mod currently adds an `onHit` status whose DoT is resisted independently, so
   every element is the same mechanic wearing a different colour. That is a
   design flaw, not a tuning value. The test: **could I describe what this does
   without mentioning a number?** Frost passes (it controls). Burning fails
   (damage, but slower). A verb need not live in the damage system at all — AI
   states, aggro, dormancy, fleeing, line of sight, positioning and knockback are
   all already exposed. **Status: partly shipped** — frost-as-control is built
   (PR #79: a frozen shatter is a very hard hit, not an execute); the other
   elements have not had the pass.
2. **Depth beats breadth.** *Four elements with six distinct pairs beats eight
   elements with twenty-eight mushy ones.* Test: if a pair cannot be described in
   a sentence a player would recognise mid-fight, it is noise. Cutting the
   element set is explicitly a legitimate recommendation. **Status: discussed
   only.**
3. **Handling as an artifact of composition.**
   > *"Infinite ammo. We should remove the concept of ammo. We have bullet speed.
   > We could have range or cooldown as well, maybe as an artifact of the
   > combinations"* (mindmeld 6880/1431697)

   Compositions should differ in *how the weapon feels to fire*, not in a damage
   figure, because handling is self-announcing through play where effects need a
   UI. It is also self-balancing — a heavier composition pays in fire rate with
   no balance table. **The failure mode to measure, not hope for:** if handling
   costs are additive while effects compound multiplicatively, a strictly-best
   arrangement reappears and the self-balancing is an illusion. Enumerate
   arrangements mechanically and sweep effective throughput (damage per second
   *including* cooldown). **Status: discussed only** for the general rule; the
   ammo half shipped as PR #8.
4. **Run-to-run variety is the payoff, not power.** The question is not "which
   pair is strongest" but *"what did this run make me build."* A dominant pair is
   a failure of the mechanic even when it is fun, because every run collapses
   into it. **Status: discussed only**; this is the argument that promotes floor
   theming from "maybe" to a candidate mechanism.
5. **Scarcity creates the combination.** Twenty mods a floor means you hold
   everything, which is a pile rather than a decision. Mods-per-floor is a
   core-loop parameter, derived from "how many decisions should the player make",
   not from a drop table. **Status: shipped in part** — `6c7a343 feat(loot): mods
   per floor becomes an exact count, and drops 20 -> 5`.

---

## 2. Combat feel and player mobility

### Enter the Gungeon — the dodge roll

- **Taken:** a dodge roll with i-frames as the core mobility verb.
- **Owner ask:** *"I'm also thinking about a 'dodgeroll' mechanic, and giving
  things a little 'enter the gungeon' flavor."* (mindmeld 2847/497348).
- **Status: shipped, but the binding was rejected twice.**
  `src/game/systems/roll.ts`; the entity field is commented *"Active dodge-roll
  (Enter-the-Gungeon style)"*.
  - > *"merge: feat/dodge-roll - not something we can merge"* (2847/497471) —
    the first branch was rejected outright.
  - > *"i didn't like how the controls default to 'backflip'. I wanted only for
    > the 'use' key backflip is there's nothing to use"* (2966/531172) — the roll
    was demoted to a **fallback on USE when nothing is usable**
    (`tryStartRoll`). Do not give it a dedicated default binding again.

### Dark Souls — bosses with learnable movesets

- **Taken:** a learnable moveset with readable telegraphs, attacks that commit to
  where you *were* so dodging is real, punish windows after big swings, phased
  escalation, arena ceremony (name banner, health bar, retry loop), and a mind
  that adapts between phases.
- **Owner ask:** *"Let's design a more sophisticated ai system. I want bosses
  like Dark souls"* (mindmeld 2632/430290 and 2757/466283, 2026-07-12). The
  design doc it produced was `docs/boss-souls-design.md` (mindmeld 2776/474637);
  that file is **not** in this repo today.
- **Status: partly shipped.** Mireclaw Alpha is the phased descendant (summon /
  retreat-to-spore-regen / enrage). Three more shipped in PR #77 (Vigil, Echo,
  Sealkeeper) and are designed in `docs/design/boss-variety.md`. **The
  telegraph half is still missing** — `boss-variety.md` §3.3 records that no
  telegraph system exists anywhere in the sim, which is open issue #1, and
  several designs are unfair without it.
- **The bar the doc sets, worth keeping:** *"If two bosses are beaten by doing
  the same thing, there is only one boss"* — so each design leads with the
  **player verb**, not the monster (PR #74).

### Diminishing returns and post-status immunity (genre-standard, no single source)

- **Taken:** each re-apply of a control effect within a window gives a fraction
  of the duration (45, 22, 11, 0…), plus a brief immunity window after an
  immobilise expires.
- **Why it fits:** the stun-lock was the worst live bug found, and *it happens TO
  the player and needs no choice at all* — unlike the frost exploit, which
  required choosing a mod (mindmeld 7431/1613915). Two sledgehammer carriers
  landing inside 20 ticks held a player indefinitely, and the alert escalation
  shipped the same night made that condition more likely.
- **Status: shipped** (PR #10, anti-chain-lock + 18-tick immunity + diminishing
  returns). `docs/notes/ideas.md` proposes generalising it to frozen/sleep and
  adding **mash-to-shorten** as a co-op "help me!" moment — **discussed only.**

---

## 3. Co-op, and the BLE constraint that shapes everything

The project exists to be played with his nephews on two phones over Bluetooth,
with no cell service (mindmeld 2847/495857). That is not context, it is the
binding constraint on every feature below.

### Ocean's Eleven — the multi-stage heist

- **Taken:** a planned, interdependent, multi-role operation rather than a
  firefight.
- **Owner ask:** *"think about a multi-stage bank heist or something. that
  requires careful planning amongst my nephews. an 'oceans 11' type thing."*
  (mindmeld 2847/497336).
- **Status: partly shipped.** It produced the `gameplay-experiments` skill and
  `docs/gameplay-experiments.md`, which records a working six-stage heist
  (cloak → sleep-takedown → hack the vault → grab loot → alarmed getaway) driven
  entirely from the debug and annotation surface with no core-system changes.
  Real emergent mechanics found there: **noise lure**, **sleep takedown**,
  **wet + shock chain**, **deep freeze**.
- **The engine gaps that doc names** (still open, do not hack inline): no
  camera/sensor entities, so "cut the cameras" has no in-engine referent; the
  alarm is a bare 0-3 scalar and theft does not trip it; no driven patrol routes,
  suspicion ramp, or reaction to bodies and open vaults.
- **Honesty rule from the same doc:** in a headless run only one local player
  provides input, so a staged multi-player scene's between-beat motion is
  teleported puppetry. Always say which parts are real.

### Left-4-Dead-style downed/revive (no source named)

- **Taken:** solo death ends the run; a co-op death is a **downed** state a
  teammate can revive, with a lone-downed exception so one player cannot end a
  co-op run.
- **Owner rejections that shaped it:**
  - > *"well now the respawn on death is instant and makes the stakes way too
    > slow [low]. file that"* (2847/496197) — instant respawn killed.
  - > *"wait solo kill should _not_ respawn. you misunderstood. I mostly wanted
    > to make sure that when the multiplayer game ends the clients stay connected
    > so they can play again"* (2847/496471) — free respawn on solo death
    rejected; the real ask was **never drop the BLE link.**
- **Status: shipped.** The **solo self-revive** proposed in `docs/notes/ideas.md`
  has since landed too: `src/game/systems/combat.ts:225` — *"solo bleeds out to a
  self-revive"* — with a per-run `revivesLeft` budget and endless self-revives on
  the `casual` difficulty (`src/game/world.ts:105`).

### PvP mode

- **Owner ask:** *"i want a pvp mode"* (mindmeld 2847/496294).
- **Status: discussed only.** There is no `pvp` anywhere in `src/`.

### RimWorld — raiders carrying off downed colonists

- **Taken:** nothing. Explicitly **rejected** in
  `docs/design/enemy-groups.md` § "Not built, on purpose": dragging a body fights
  both the solo-self-revive and the co-op revive flows and needs a design pass of
  its own.

### Hard constraints that came from actually playing over BLE

All from the live-play session (mindmeld 2847, via the digest at 6511/1437575):

- **One BLE game, cap ~5.** He asked to stress-test 8 players; BLE caps at ~5-7
  and no WiFi transport exists, so 8 phones cannot join one game.
- **Finding each other is a design problem.** *"we can join each other's _games_,
  but it's easy to lose each other on the map"* → teammate markers (PRs #48,
  #49, #51 tuned them down again when they obscured the character).
- **Never force an app restart.** *"in multiplayer once we die we both need to
  restart the app to play again"*. Codified as: no frozen state escapable only by
  killing the app.
- **Join at any time** (2847/496107) → late-join, shipped and hardened (#36, #45).
- **Instant builds to everyone's phone** (2847/496162) — this is why OTA, the
  version-in-lobby and the title-screen release notes exist.
- **Controller is the only input.** Recorded mid-playtest: the player has no
  keyboard or mouse at the couch, so every UI and feature must be pad-first
  (`docs/playtest-2026-08-23-live-observer-session.md`, directive #3). He uses an
  8BitDo Lite 2, which caused a nonstandard-button-index bug.

---

## 4. Level generation — real architecture, not dungeon tropes

`docs/design/floorplan-principles.md` is the design doc; its §5 is a full source
list. This section names what each source contributes so you do not have to read
706 lines to find out. **Status for the whole section: discussed only unless
stated** — §4 of that doc is a 13-item gap list of what the current generator
lacks, in suggested build order.

The complaint that started it, and the only time he used the word himself:

> *"we are currently making some pretty boring buildings often"* (mindmeld
> 2966/531195)

Measured diagnosis over 40 seeds × 6 floors (mindmeld 2965/530337): **interiors
were 100% empty — zero props or cover ever placed**, 470-1050 bare floor tiles
per level, while the swampspace theme *shipped* prop art the generator never
placed. *"That's the biggest offender."* Then: empty-box monoculture, every room
a perfect rectangle, no AI-legible structure, and no landmarks — "Reach the
Launch Bay" had no Launch Bay in the geometry. **Status: shipped** — filled
interiors (cover tiles 0 → 86-174), room-role metadata, chokepoints, typed rooms.

### Buildings and planning theory

| Source | What is taken |
|---|---|
| Christopher Alexander, *Intimacy Gradient* | P2: a depth gradient — public, then semi-private, then private |
| Louis Kahn, served and servant spaces | P6: a back-of-house route separate from the front |
| Space syntax (Hillier) | The measure behind circulation hierarchy and loop analysis |
| Poche | P7: thick walls with space carved out of them |
| Enfilade / Beaux-Arts parti | P5: a row of rooms with lined-up doors; P4: a grand axis with symmetric wings |
| Hardwick Hall, long gallery | P13: one signature long gallery per floor |
| Versailles, El Escorial | Apartment sequencing and ceremonial depth |
| Servants' quarters / green baize door | The hard boundary between served and servant circulation |

### Whole-floor archetypes (six, weighted)

| Archetype | Real-world referent |
|---|---|
| Palladian station (w20) | Kedleston Hall, Villa La Rotonda; Stiny & Mitchell's *Palladian Grammar* paper |
| Cloister ring (w20) | The Plan of Saint Gall |
| Concentric keep (w15) | Beaumaris Castle, Krak des Chevaliers (and its bent entrance → P3) |
| Pavilion hospital (w15) | Lariboisière; Halley VI's module caravan |
| Ship deck (w20) | Fleet-type submarine compartmentation; Halley VI |
| Radial hub (w10) | Eastern State Penitentiary, the Panopticon |

### Games and procgen referenced

- **Brogue** — level generation method.
- **Unexplored** — cyclic dungeon generation (loops rather than trees; feeds P10,
  "no long dead ends").
- **Hitman** (three GDC talks) — level design as a guided social space; subtle
  social cues.
- **Dishonored 2, the Clockwork Mansion** — a level that reconfigures itself.
- **Deus Ex** (Spector) — player-first design choices.
- **RimWorld / Prison Architect** — deployment and canteen zoning as the model for
  giving rooms a functional reason to be occupied.
- **Townscaper and WaveFunctionCollapse** — constraint-based placement.
- **Dwarf Fortress** — developer interviews on generative depth.
- Lopes et al., *A Constrained Growth Method for Procedural Floor Plan
  Generation* (GAME-ON 2010) — the academic method.

### The through-line that ties this to the AI work

> *"sophisticated AI ⇄ meaningful buildings, each giving the other a reason to
> exist."* (mindmeld 2965/530317)

A gang holds a wing, workers are in labs, guards defend the objective wing,
civilians flee home. Rooms being anonymous was diagnosed as the reason NPCs had
no functional reason to occupy any of them.

### Stairs and storeys

`docs/design/stairs-and-storeys.md` designs stacked storeys inside a floor, with
the structural rule that upper storeys must bear on lower walls. **Status:
discussed only**, phased plan in §5.

---

## 5. Missions, stealth and alarm

### What exists

Five templates — `reach` / `steal` / `assassinate` / `contain` / `infiltrate`
(`src/game/world.ts:31`, `src/game/systems/missions.ts`). **None of them can be
failed**; the only loss condition in the game is a party wipe, and only one has a
clock (PR #74).

### Locked doors you can always shoot open — rejected

> *"The 'door locked' mechanic where I can always 'lockpick' it or shoot them
> open is silly. I want better missions, that are more themmatic with the space
> swamp theme"* (mindmeld 2964/529342)

**Status: rejected, and replaced.** Bog-grown seals you burn or clear, keycard +
power-cut biolocks, "breach-is-loud", and the `contain` / `infiltrate` templates
(2964/529503). `src/game/systems/sporefall.livingSeal.test.ts` and
`sporefall.credentials.test.ts` are the descendants.

### Extraction — the cheapest new-feeling mission

- **Taken:** fire `stationAlert` at *pickup* instead of at completion, so you
  start with the prize and the objective is the door you came in by.
- **Why it fits:** identical machinery, only the ordering changes. PR #74 calls
  it *"the highest ratio of new-feeling to lines-changed in the document."* Today
  `stationAlert` fires **after** the objective, so the escape it builds is a
  victory lap.
- **Status: discussed only.** `src/game/systems/missions.ts` has no `extraction`.

### Floor modifiers — orthogonal to template

Bog tide, brownout, hunted. They multiply rather than add. **Status: discussed
only** (PR #74).

### Alarm-gated exit

From `docs/notes/ideas.md`: raising the alarm locks *more* doors, rewarding
stealth and punishing the run-and-gun that currently gets you swarmed. Also
noted there: the alarm does not react to the player being attacked near witnesses
or even to the player firing — a whole fight by the player's spawn left alarm at
0. **Status: discussed only.**

### The constraint that governs all mission work

Adding a mission template **must not perturb the RNG stream**
(`missions.ts:76-81`), or every seed regenerates and the frozen fixtures break
(PR #74).

---

## 6. NPCs, factions and enemies

### Streets of Rogue — the substrate, then deliberately left behind

- **Taken:** the item/use model. `src/game/systems/inventory.ts` says it plainly:
  *"Re-expressed from observed Streets of Rogue behavior, not ported."* The repo
  itself began life as `mobile-streets-of-rogue`, then "Backseat", then Sporefall
  Station.
- **Deliberately not taken:** the street-crime cast and its identity.
  > *"We can't call it `streets-of-rogue` related name anymore. we must use a
  > code name"* (mindmeld 2847/496992, 2966/530870)
- **Still outstanding, recorded but explicitly not to be implemented yet:**
  re-fiction the character vocabulary — there are no "cops" or "thugs" anymore.
  Rename player-facing language (and eventually the `faction` values in
  `src/game/entity.ts` and the `relationships.ts` matrix) to station roles —
  security/wardens, scavengers/raiders, crew/civilians — keeping the mechanical
  matrix intact. **Status: discussed only**, and marked *"do not implement yet"*
  in `docs/playtest-2026-08-23-live-observer-session.md`.
- **Not found anywhere in the archive:** hireable NPCs, or Streets-of-Rogue-style
  per-class kits (bartender / scientist / gorilla). If you are looking for a
  precedent for those here, there isn't one.

### Rainbow Six — the squad archetype

- **Taken:** stack up on both sides of a door, breach together, flank the
  leader's target. Specced verbatim as a *"Rainbow-Six vibe"* (mindmeld 4448).
- **Status: shipped** — squad / barricader / lurker archetypes plus deterministic
  A* (`src/game/path.ts`), release note *"Enemies hunt smart: squads & ambushes."*
- **Worth knowing:** pathfinding had been declared out of scope by an earlier
  investigation as *"a steering problem, not a brain problem"* (mindmeld 4430).
  That was an agent's scope call; he commissioned A* two days later.

### The rock-paper-scissors roster

The design comment in `src/game/data/npcs.ts`: *"each DEMANDS a different tool. A
rock-paper-scissors so no single weapon clears the deck: the brute laughs off
bullets (burn it), the cinder shrugs off fire (shoot it), the sporeling ignores
toxins."* Proven by an anti-dominance table in sim (mindmeld 2965/530359).
**Status: shipped**, and load-bearing — PR #53's balance pass deliberately fixed
pistol-only time-to-kill via **HP rather than resist**, because softening
`resist.physical` would have broken the roster (`enemyVariety.test.ts` asserts
`weak('brute','physical')`).

**The owner's ruling that mods, not weapons, carry the counters:**
> *"I believe the rock-paper-scissors thing can be done via weapon mods"* /
> *"mods. Collecting mods effectively creates different weapons"* (mindmeld
> 7431/1613915)

The compounding hazard recorded alongside it: the branch had already pushed the
tuning into HP (brute 95→68, robot 70→52) plus a pistol buff. If mods restore the
counters, that HP nerf solves a problem that no longer exists, and both together
give weakened enemies *and* mod-based counters — trivially easy, and far harder to
notice because **nothing goes red for "too easy."**

### Enemy groups — tides, packs and hives

`docs/design/enemy-groups.md` adds a group layer above individual AI: raid
strategies by depth (assault / staging / sappers / siege), officer-and-morale
with a rout on decapitation, retreat-to-medic, encirclement, manhunter rage on a
hit, and spire infestation. Each names its **player verb** — react, catch them
gathering, stop the breacher, charge the battery, decapitate, break the ring,
burn it early. **Status: shipped** (`src/game/systems/groups.ts`).

An emergent behaviour found in play and kept: a raid's rounds pass through its own
members, so a muster firing down a corridor shot its own front rank.

### Specific enemy design rules taken from the lore

- **Echo design rule** (LORE.md): every essence-echo is a translucent cluster of
  bubbles congealed into the silhouette of what drowned, around **one opaque junk
  core**; shots pop the outer bubbles, the core bursts last and falls as the mod
  drop. One sprite rule gives both the kill fiction and the drop fiction.
- **Hue-telegraph**: an echo's glow hue = the hue of the essence it drops. Pure
  tint shader, zero art.
- **Pod rooms as a stealth set-piece** — *"tiptoe through, or set it off"*;
  **lurkers as the jump-scare** — fragile on purpose: it wins the ambush or dies
  in the open (design comments in `npcs.ts`).

### Spore contagion / player infection

`src/game/systems/infection.ts:31` — `INFECTION_ENABLED = false`, shipped behind
a toggle awaiting the owner's word. **Player** infection was excluded on purpose:
*"it's a whole design axis of its own"* (mindmeld 4430). **Status: behind a
flag** (NPC side) / **discussed only** (player side).

### What he called boring, in his own words

> *"Spawn a subagent to watch the game for 'ai stupidity' and take notes - ai
> running in to walls, or breaking or being boring or predictable."*
> (mindmeld 2966/531674)

The watcher's working definition of boring (mindmeld 4435): *"identical tight
patrol loops, NPCs bunched inert, no behavioral variety, trivially exploitable
routines."* And the root causes it found: goal-thrash with zero deadband (19
flips per 20 thinks), a **dead faction matrix** (a cop and a gangster four tiles
apart in open sight both returned `wander`; a 6v6 clash ran 500 ticks with 0 hits
and 0 deaths), and *"the theme is skin-deep in the brain"* — no consideration read
spore, fire, wet, light or corpses. **Status: shipped** (goal hysteresis, the
faction matrix, predator-prey, hive draw-field, panic stampede, dormancy).

### AI that remembers you

> *"Let's do commitment. And have the ai store memories of player that affect its
> behavior. I want the players actions to name differences in the world and
> characters they can _feel_"* (mindmeld 6507, relay message `mskzsv69-cf08k7`,
> 2026-08-08)

**Status: partly shipped.** The commitment half became attack wind-up / telegraph
/ recovery work (mindmeld 6885) and is still open as issue #1. The **memory**
half — NPCs storing player-specific memories that change behaviour — has no
implementation named anywhere in the archive.

---

## 7. Progression and acquisition

### ROUNDS' "pick one of a small hand" — the floor draft

- **Taken:** being offered three and taking one, instead of picking everything up.
- **Why it matters:** *"If combinations are the core, acquisition must be a
  choice — picking up everything is not a decision, being offered three and
  taking one is."* It also recasts the scarcity number as **offers per floor**
  rather than items on the ground, and it composes with floor theming: a themed
  floor offering a themed hand is one mechanism, not two (mindmeld 7431/1613915).
- **Status: written and still disconnected.** `floorDraftOffer` /
  `applyDraftPick` (`src/game/systems/draft.ts`) and `createDraftScreen`
  (`src/ui/draftScreen.ts`) exist and are correct, but `src/main.ts` only wires
  them inside the `?e2e` block, behind `window.__draftShow`. The comment at
  `main.ts:451` says so: *"The automatic floor-clear trigger lands with floor
  progression (deferred)."* **This was flagged as a live gap on 2026-08-12 and is
  still true on `main` today.** Wiring up what already exists is a much cheaper
  route to the core loop than a new acquisition system.

### One permanent weapon — the standing rule

- **What it is:** the player carries one weapon permanently. No switching, no
  weapon loot, no weapon drops from corpses. Mods are the progression.
- **Why:** his complaint was that he only used the pistol *because it carried the
  mods*.
- **Status: shipped and in force.** PR #53 (merged 2026-08-20).
  `src/game/systems/interaction.ts:357` still refuses a melee/ranged pickup;
  `equipSlot` still accepts throwables and consumables only. PR #78 confirms it
  from the other side: *"Under the one-weapon rule players only ever hold the
  pistol, and weapon pickups are refused."*
- See [Contested](#contested-and-uncertain) before citing anything that claims
  this was undone.

### Ammo — removed

> *"Infinite ammo. We should remove the concept of ammo."* (mindmeld 6880/1431697)

**Status: shipped**, PR #8. No live behaviour change: `INFINITE_AMMO` had been
shipping `true` its whole life, so this deleted a concept nobody had played with,
and removed a whole pickup category — which serves scarcity directly.

### Meta-progression

LORE.md canon #3 — death dissolves you and your gear back into essences, and a
later run can catch bubbles distilled from your previous character; meta-progress
is "what you caged somewhere dry", rendered as the **dry wall** in a between-runs
hub and as a **succession locket** on the sprite. **Status: discussed only** (the
locket and dry wall are marked *proposed* in LORE.md).

---

## 8. Art direction and game feel

### Flashback (Amiga, 1992) — the palette anchor

- **Taken:** the Titan-jungle levels — teal mist, olive overgrowth swallowing
  tan/grey tech, sparse hot bioluminescent accents.
- **Status: shipped.** `public/themes/swampspace/`, documented in
  `docs/swampspace-theme.md`, which is explicit that this is **inspiration only**:
  prompts plus a palette derived from a dominant-colour study, with no Flashback
  art used as a generation input or reproduced.

### Icewind Dale — the review zoom

Sprite review panels were told to judge frames *"at isometric-RPG zoom (think
Icewind Dale)"* — the standard for "would this read clearly in actual gameplay"
(mindmeld 4308, 4320). **Status: shipped** as a review convention; the surviving
gate is the `judge-sprite-mp4` skill and the VLM check in `scripts/assets/verify.py`.

### Rules established by rejection

- **FX must mean something.**
  > *"I see some weird distorted shaders on the map that seem to serve no purpose
  > - ones that use the backbuffer. These should be used for bullet effects for
  > appropriate mods, not randomly on the ground with no effect"* (2964/529237)

  **Status: rejected** — decorative backbuffer FX with no gameplay meaning.
- **Contextual controls.**
  > *"the on-screen controls say 'spc' 'atk' or 'use'. these are obtuse. I don't
  > know what they are doing. they need to be contextual with the item I have
  > equipped"* (2847/496221) → shipped (#32).
- **Don't cover the game with text.** *"you need to periodically clear those gm
  messages it's obscuring the player"* (2966/531817). Agent annotations are now
  self-expiring.
- **Flippable cover.** *"let's not worry about 'flippable tables'"* (2847/497365)
  — **rejected**, struck out of its ticket on the spot.
- **Helmets and armour in enemy silhouettes** — rejected on the art side;
  "spacer colony" prompt tokens hijacked SDXL into sealed helmets and all faces
  were lost (mindmeld 4300).

### The recurring defect class, which is an art/UI rule as much as a code one

> *"In every case the status display is truthful about intent and false about
> behaviour."* (mindmeld 7431/1613915)

The game reports `pierce=1` on a weapon where pierce provably never runs; the
losing element still appears equipped; lifesteal reports healing it did not earn.
Any fix must make the UI reflect **what will actually execute**, or the
player keeps buying dead mods. PR #78's "quietly dead code" section is the
current inventory of these.

---

## 9. Lore, and how it is allowed to touch the game

`docs/LORE.md` is canon and is the source of record; this section only records
the *constraint* it operates under, because that constraint is what makes lore
cheap here.

> *"User constraint: game is fast, hard, arcadey — new level every couple of
> minutes, you kill everyone you see. Progression fast. Engine is done; the tie
> must cost no engine changes."*

Every lore hook was filtered through **no engine changes, no cutscenes, arcade
pace intact**. Story arrives only in sub-second fragments: a rare pickup carries
one five-word flavour line ("essence of: someone's wedding ring").

**Rejected, and stays rejected:** combination recipes as a voodoo-not-quite
craft / priesthood — the owner finds it *"a bit cliché."* Witch and preacher
survive as **visual archetypes only, not narrative structure** (LORE.md #4).

Also rejected on the art side for the same boundary reason: proposals that
introduced narrative elements not bounded by the prompt laws (mindmeld 4300).

---

## Contested and uncertain

Read this before citing any "he changed his mind" claim, including one in an
older agent's notes.

**A decision counts as reversed only if HE reversed it, in his own words.** An
agent's suggestion, a plan never approved, or an inference drawn from a session
is not a reversal.

### The weapon cull was NOT reversed

A session-notes document written by an agent on 2026-08-12 (mindmeld
7431/1613915, reproduced identically in 7430 and 5831) carries a heading
**"DIRECTION CHANGE — weapons come back (supersedes the cull)"** over this quote:

> *"Let's go back to having weapons then. Maybe they just need to be different.
> Different enough projectile based weapons. The melee weapons couldn't have
> mods, right? Or maybe we have a 'lightsaber' that can"*

**That heading is the agent's label, not a ruling, and it is wrong.** The owner
has since confirmed directly that the cull was never reversed. The evidence on
disk agrees: **PR #53 shipped the cull on 2026-08-20**, eight days *after* that
note, and it is still in force on `main` today
(`src/game/systems/interaction.ts:357`).

Record it as: **the one-weapon cull is the standing decision.** The "weapons come
back" idea is at most `discussed only`, and the quote's status is **uncertain** —
it survives only inside agent digests, not as a retrievable raw message, so
verify it before building on it.

What *is* safe to carry forward from that quote's neighbourhood, because it was
built and shipped independently: **weapons should differ by shape, not by stat
line.** PR #78 gives each weapon `slots` / `castsPerTrigger` / `rechargeOnWrap`,
with the sledgehammer standing in for the "lightsaber" (8 slots, 1 cast, 75-tick
recharge). PR #78 also measured the melee question and got the opposite of the
guess in that quote: mods **do** reach melee today — 9 work, 9 are silently inert,
and `bulk` is worse than nothing.

### Things that look like reversals but are not

- **Ammo removal** was a direct owner decision (*"We should remove the concept of
  ammo"*), not a reversal of anything he had asked for; `INFINITE_AMMO` had been
  `true` all along.
- **Frost going from execute to control** was a bug fix plus his endorsement of
  the replacement mechanic, not a change of mind. PR #79.
- **Pathfinding** was scoped out by an *agent* (mindmeld 4430) and then
  commissioned by him (4448). An agent's scope call being overruled is not the
  owner contradicting himself.
- **The dodge roll** was not reversed either: he rejected a *branch* and then a
  *default binding*, twice, while keeping the mechanic.

### Genuinely demoted by him

- The **voodoo/priesthood** narrative layer — *"a bit cliché"* (LORE.md #4).
  Demoted, and LORE.md says it stays demoted.

---

## What is not in the archive

Searched and not found, so future agents do not re-run the sweep:

- **Teleglitch, Into the Breach, Hotline Miami, Downwell, Spelunky, Brotato as a
  Sporefall reference** — no hits in a full-text mindmeld sweep. (Brotato appears
  only inside the ROUNDS/RoR2 research report at 5009/1322448, as a comparison
  case, never as a direction for this game.)
- **Vampire Survivors** — no hits.
- **Hireable NPCs, or per-class character kits** (the Streets of Rogue
  bartender/scientist/gorilla model). Not proposed anywhere for Sporefall.
- **A mutator system** by that name. The nearest thing on record is the
  **floor modifiers** proposal in PR #74 (bog tide, brownout, hunted).
- **`docs/boss-souls-design.md`** — the Dark Souls boss doc exists in the archive
  (mindmeld 2776/474637) but is not a file in this repo.

Where to look if you want to extend this: mindmeld sessions **2847** (live BLE
play with his nephew — nearly every product and co-op ask), **2964** / **2965** /
**2966** (the coordinator sessions with most of the verbatim asks and
rejections), **6880** / **6920** / **7430** / **7431** (the mod-composition
design night), **5009** / **4969** (the roguelite modifier research), **4430** /
**4435** / **4448** (AI overhaul), **4418** / **4420** (the boring-buildings
investigation), and **59005** / **59006** (the sequenced-mods build).
