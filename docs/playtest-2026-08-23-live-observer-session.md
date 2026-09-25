# Observer session — seed 3317396125, attached at tick 746

- Date: 2026-08-22 · branch served: feat/playtest-observations (== origin/main @ 6e52cad ancestry)
- Mode: solo run · Floor 1 · mission `steal` — "Extract the specimen canister from the med-bay"
- mission.targetEntityId=222, targetBuilding=7, objectiveDoorId=259
- Player #262: pistol, hp 120/120, $0, pos (1.48, 3.13) top-left map edge, idle at attach
- World counts: 27 npc, 30 pickup, 164 interactable, 39 door, 1 player, 261 total

### tick 746 (baseline)
intent: (0,0) idle, not firing, hp 120/120
screen: full-floor zoomed-out view; 6 large rooms visible; objective arrow "76m" bottom-right;
player sprite tiny at top-left edge. Player likely still orienting.

Objective geometry: canister #222 at (55.5,56.5) bottom-right, behind LOCKED objective
door #259 (lockLevel 1) at (55.5,52.5). Gang patrols + squad at y54-59; vermin nearby.
Player spawned top-left (1.5,3.1) → diagonal-opposite corner run, ~76m.

### tick ~2390-2810  (floor 1 · steal · alarm 0)
intent: player#262 pushing S (0.10,0.99) along west edge x≈1.1, y 3→48. NOT firing.
motion: vel 0 in this frame but pos has advanced steadily — moving fine overall.
hp: 112/120, lastHurtTick 2810, hitFlash active — took 8 dmg from EXPLOSION at
(5.67,21.50) r=1.8 (event ring). Cause unknown from notes — hazard? mine? Watch for tell.
events: many doorToggles (NPCs), npc#28 scavenged a cash pickup (aiGoal wander→scavenge→wander).
threat: none aggroed on player. cops patrol N (y1-5), gang patrols S (y54-59). civ#24 fleeing near player (0.4,56.3).
signal: DAMAGE with unclear source — explosion hit player mid-route with no visible
attacker in notes; check readability of hazard tells.
signal: route = wall-hug along map edge; corridors between buildings may be the de-facto
highway (no content out there?). Watch if player keeps to dead space.

### tick ~2810-5225  (floor 1 · steal · alarm 0→1)  THE RAMPAGE
Player abandoned the objective route (was y48, arrow said 54m) and swept NORTH killing:
- civ#27 (FLEEING when killed, 2x14 pistol), vermin#55, civ#1 (traded hits, took 2x14),
  civ#26, skittish civs#5+#6 (both mid-flee/battle flip-flop). NPC count 27→21.
- aiGoal churn: civs flip battle→flee→wander fast; #24 went battle→pursue→flee→wander
  in seconds after taking one hit. Civs "battle" a player who's massacring their friends?
- modPickup: SHOCK mod for pistol (entity 41) — HUD shows mod badge. First build moment.
- EMERGENT: shot a barrel at (26.5,10.8) → 40dmg explosion killed 3 interactables (#77,
  #86, #87) AND doorBreach'd door#229 — explosives open doors! Also hit player for 40.
- cash drops looted: $71 total. NPC#28 also scavenges cash (world feels alive).
- alarm 0→1 (civ murders?). Cops #29/#30 patrol NE near player. No visible response yet.
- Recurring env explosions r=1.8 around (5,18-21) — periodic, not player-caused. Sacs?
- hp: took 40+14+14+8+7 across the spree, regenned to 120/120 by tick 5225. regenCalm
  makes damage evaporate between fights — pressure resets to zero.
signal: DELIGHT — barrel-breach of a door; player experimenting with sandbox.
signal: BALANCE — full passive regen between fights removes attrition entirely.
signal: CONSEQUENCE-GAP — murdered 6 civs incl. fleeing ones; alarm ticked to 1 but
nothing pushed back. Cops nearby did not respond. Murder feels free.
signal: AI-READABILITY — skittish civs briefly "battle" then flee; looks indecisive.

### tick ~5225-8485  (floor 1 · steal · alarm 1)  RAMPAGE II + first cop kill
- Player paused at ~7900 to study pistol card: Tesla Rounds + Hot Loads, dmg 14,
  1.7/s, bullet speed 14→18.2, "electrified on hit". Pause menu: Resume/New Seed/
  Run it back/Share state. Player is engaging with the build system.
- Resumed → cop#29 flipped patrol→battle on player. Civ#11 ran ALERT to guard#30 and
  fired `alerted` event (#11 told #29 about player). Player killed cop#29 (5x14),
  killed snitch#11, killed brave civ#10, took 2+2+8. modPickup: VELOCITY (mod #47).
- npc 21→18. Cash $71. Player then moved SE to (33.6,37.4) — closing on objective
  (arrow 29m at pause). hp 108.
- SYSTEM READ (relationships.ts): alarm++ ONLY when a cop witnesses the crime within
  LOS_RANGE=10. Kill-the-witness genuinely suppresses escalation. commitCrime sets
  crimeUntilTick (wanted 15s). Cops engage at alarm>=2 (behaviors.ts:124);
  raiseFloorAggro (boss-door breach / mission) jumps alarm to 3 + floor-wide aggro.
- SYSTEM READ (regen.ts): rest-heal by design — 2.5s perfectly still, then ~10hp/s.
signal: EMERGENT-DELIGHT — witness elimination works as a stealth-crime mechanic; the
player did it (accidentally?) with zero UI acknowledgement. No tell that it worked.
signal: CONSEQUENCE-GAP — 9 kills incl. a cop → alarm 1. Cop density so low that the
crime system rarely fires. Murder-hobo path is dominant and unpressured.

### tick 8485 (long pause)
Player paused on the pistol card for several minutes. Sim frozen (tick pinned across
4+ samples). Good moment — they're reading the build. Meanwhile, system reads:

- MISSION ARC (missions.ts:355-451): stage 1 `maybeTriggerGateBreach` — unlocking the
  objective door by ANY means → alarm=3 + EVERY door on the floor pops open. Stage 2
  `raiseStationAlert` on completeMission — floor-wide manhunt: all NPCs hostile, PA
  re-broadcasts player pos every ALERT_BROADCAST_TICKS, floor-sized pursuit leash,
  ALERT_BATTLE_MULT presses fights. The finale has real teeth; the mid-game is slack
  by design (build-up), but observed slack may be flatter than intended.
- The `alerted` event (civ reaches a guard) aggroes THAT cop but does NOT raise
  w.alarm — station alarm only rises via cop LOS witness (relationships.ts:117),
  sealed-door breach (combat.ts:359), alarm objects (objects.ts:64), gate breach.

## Reflection #1 (mid-session) — hypotheses forming
1. WITNESS-SILENCE HAS NO TELL: killing the snitch/cop witness genuinely suppresses
   escalation, but the game never acknowledges it. The player's best emergent play
   was invisible. Idea: a small on-screen tell (e.g. event + HUD blip "witness down —
   alert died with them") + civs who SAW the murder of a witness get panic behavior.
2. MURDER IS CHEAP MID-GAME: 10+ kills incl. a cop, alarm 1, zero pressure. Ideas:
   (a) successful `alerted` handoff also bumps w.alarm (a snitch that REACHES a cop
   = station knows), (b) cops investigate corpses they walk into (corpse-discovery
   → investigate + alarm bump). Both use existing stimulus/goal machinery.
3. DEAD-TIME ON THE WALK: y3→y48 wall-hug with a single mystery explosion. The
   inter-building corridors are empty dead space; route content or ambient threat?
4. UNATTRIBUTED EXPLOSIONS: r=1.8 explosions at (5.67,21.5)/(4.98,18.58) with no
   actor nearby; player ate 8 dmg from one. What are they? Check spore.ts/sacs.
   If a hazard has no windup tell, that's a readability fix.
5. REST-REGEN + LOW PRESSURE = free reset. Fine once pressure exists; revisit after
   fixing 2.

### Session interruption (~tick 10.7k-14.6k)
Claude Code process restarted; hub + Vite + sampler died. Game tab survived (sim
lives client-side) and auto-reconnected once the hub came back — same run intact.
~4000 ticks unobserved: npc 18→16 in the gap (2 more kills, incl. presumably
security#30 fight at hp 80). Telemetry restored at tick 14797, alarm still 1.

## Player directive #2 (recorded + implemented in skills)
- **Communicate via the game UI so the player knows I'm watching.** Updated
  `.claude/skills/observer/SKILL.md`: annotations (`annotate`/`clearAnnotations`)
  are now the sanctioned exception to read-only (inert presentation data) and the
  PRIMARY channel to the player — presence banner on attach, self-expiring
  heartbeat, pins/labels on notable moments, 1-line reflection summaries. Added a
  pointer in `ecs-debug/SKILL.md`. Sampler now refreshes an on-screen heartbeat.

### tick 19994-22994 — THE FINALE (reconstructed from sampler)
- 19994→20646: player CAMPED at (43.3,31.7) for ~650 ticks (~22s) resting 73→120 hp
  before the assault. Optimal pre-finale play = stand still doing nothing. PACING.
- ~21400: grenade assault on objective area — explosion, 2x doorBreach, deaths.
  (burnDoused events in the brawl — fire in play.)
- ~22100: pickup + missionComplete + stationAlert. ALARM 3, exit unlocked, manhunt
  cascade (8+ aiGoal flips in one ring window). npc 11→8. hp 66. Also `doorBlocked`.
- 22994: hp back to 120 MID-MANHUNT, pos (1.5,1.5) — fought across the whole map,
  killed 3 hunters en route. Sampler gap swallowed the actual ending: next sample is
  a NEW WORLD (seed 3618049866, floor 1, assassinate template, 41 npcs). Whether
  the run ended in death at the launch bay or victory→restart is UNOBSERVED.
signal: MANHUNT WORKS — alarm 3 flipped the floor hostile and the escape had real
fights. But the player still out-regenned it mid-chase (hp 66→120 while hunted —
hunters lost the trail? worth watching next run).
signal: PRE-FINALE REGEN CAMP — 22s of nothing as correct play. Candidate: regen
gets less generous (or pressure arrives) when you loiter near the objective; or
keep it — a deliberate "breath before the plunge" has charm. Needs a 2nd data point.

### NEW RUN — seed 3618049866, floor 1, "Purge the Mireclaw Alpha in the operations
deck" (assassinate template, objective #227, door #267, 41 npcs — denser floor)
- Annotation channel VERIFIED live: banner rendered but collided with the mission
  banner (default text pos = top-center). Fixed: heartbeat now at screen x16,y44,
  every sample, ttl+1000 (gapless). Skill updated with all findings.
- Stale-banner hazard hit: my "manhunt on - run!" banner posted into the NEW world
  during the reset — cleared. Skill now mandates seed-compare each sample.

## Change implemented live: desktop-readable annotations (player request)
Player: "I need that font to be much larger for my desktop... it's also behind the
floor objective." Root causes: 13px hardcoded font (calibrated for phones) and the
bannerless-text default anchor at y=24 = the mission banner's own strip.
- `src/ui/annotationLayout.ts`: new pure `annotationScale(viewportW)` = clamp(vw/760,
  1, 2) — 1× at phone widths, 2× at >=1520px. 4 new unit tests (23 pass).
- `src/ui/overlay.ts`: setText scales font/line-height/max-width together before
  measuring; bannerless default anchor moved below the mission banner and scales.
- Verified live at 1508px viewport: 2x banner, clear of the mission line.
- BONUS FINDING: a full Vite reload mid-run RESTORED the run (mid-run persistence
  works across reloads — mission/cash/mods intact). No world re-injection needed.

### tick ~11.7k-14.9k (unobserved during the fix): alarm 1→2, npc 30→12,
interactables 150→126. The player is razing the floor; security now hostile on
sight (alarm>=2 gate). Cash $49. Boss still alive; purple beast visible on screen
near ops deck — Alpha may be roaming. 17 annotations in world (heartbeat stack —
prune behavior worth a look if it grows unbounded).

### Run 2 finale + FLOOR 2 (seed 3618049866)
- EVENT watcher: mission-complete t18100 — Mireclaw Alpha killed. (Whether the
  player found the fire weakness: unobserved — check events for burn on boss later.)
- Player SURVIVED the escape: state at t20699 = same seed, floor 2, steal template
  ("habitation module"), 78→59 npc, alarm 0. First observed full loop:
  objective → manhunt → launch bay → next floor. Fresh murder-hobo opening #3.
- Alarm resets to 0 per floor (missions.ts:574 presumably at floor init).

### Floor 2 DEATH (inferred) + run 3 opens
- Watcher: hp-low 36 at t22244 on floor 2. Next sample: NEW seed 3922481883,
  floor 1, tick 292 → the floor-2 run ended between beats. Death INFERRED, not
  observed (single-shot watcher was disarmed after hp-low). First run loss of
  the session. Floor 2 killed them where floor 1 didn't — difficulty does ramp.
- Run 3 first 10 SECONDS: crime committed, civs #1+#2 both ran `alert` to
  security #3, security pursued+battled, player took 4x8 dmg. The
  alert/snitch behavior is common and legible in data — but is it legible ON
  SCREEN? (Does the player know why security suddenly aggroed?) Candidate tell:
  a "!" or alert line/ping when an NPC successfully alerts security on you.
- Mission variety note: assassinate template twice in 3 runs, both Mireclaw
  Alpha, different rooms (operations deck / commissary).

### Run 3 (3922481883) ended UNOBSERVED (fast death?); Run 4 (1462899485)
- Run 3 lasted ~2-4 min max; ended between watcher re-arms. Session pace: runs
  are getting shorter and more aggressive.
- Run 4, steal/operations deck. t3919 alarm 0→3 = GATE BREACH ~2 min in
  (explosive path). Build: pistol + frost+splinter+bounce+EXPLOSIVE+shock (5
  mods) — every shot detonates r=1.6; event ring is wall-to-wall explosions;
  scenery entities dying en masse. t4818: 15/30 npc alive, $126, hp 69.
- DESIGN NOTE: mod RNG is successfully producing run identity (shock/velocity
  run vs pierce/lifesteal run vs this demolition run). Lean into this: the
  murder-hobo problem may partly be that mods only drop from kills/rooms —
  the incentive IS the rampage. Objective play needs a competing reward stream.

### Run 4 reaches floor 2 (cargo hold Alpha)
- Full loop again: gate breach t3919 → canister → manhunt survived → floor 2 at
  ~t19k. Second floor-2 of the session. 68 npc.
- Build snowball: TEN mods on the pistol now (splinterShot x2, frost, bounce,
  explosive, shock, bulk, lifesteal, rapid, heavy, velocity). $214. The mod
  economy compounds hard across floors — run identity is strong; balance ceiling
  worth watching (does floor 2+ scale to match a 10-mod god-gun? their hp says
  yes: 35/120 on arrival).
- NEW floor-2 archetype in play: "stalker" (faction neutral, aggro/battle) —
  hunted the player at 35hp on arrival. Enemy variety ramps with floors.

### Run 4: floor-2 Alpha killed (t35338) → FLOOR 3
- The Alpha died to the 12-mod homing/explosive pistol; player never used fire
  (its scripted weakness) across two Alpha kills — resistances are invisible and
  irrelevant when raw DPS compounds this hard. Either surface resistances (inspect
  card shows them?) or make them matter more.
- KEY FINDING — THE EMPTY CLIMAX: by boss time the floor had 3 NPCs total. The
  gate-breach/manhunt finale — the game's designed pressure spike — had NOBODY
  left to hunt the player. Pre-clearing the floor (the dominant murder-hobo
  strategy) deletes the climax. Fix directions: (a) manhunt REINFORCEMENTS
  (station wakes something — spore broods, security drop-in) scaled to how empty
  the floor is, (b) objective-directed reward stream so full-clear isn't the
  obvious line. Pairs with the mod-economy finding.
- Floor 3 reached (~t35.9k): 56 npc, alarm 0, hp 72, $323, same god-pistol.
  New-to-observer archetypes this run: stalker, sporeling, "gangster" (rename
  list). A stalker was observed FLEEING the player on floor 3.

### Runs 5-6 rapid-fire
- Run 5 (2602197177): commissary Alpha. Player hit 13hp in a SPORELING SWARM +
  Alpha fight (best combat of the session — hive 'drawn' behavior produced a
  genuine arena moment), recovered, killed Alpha, escaped manhunt → floor 2 →
  DIED within seconds of arrival.
- FINDING — F2 ARRIVAL IS A DEATH TRAP: 3 floor-2 arrivals, 2 deaths + 1
  near-death, all within the first minute. Player lands wounded from the
  manhunt sprint into a denser floor (stalkers, swarms) with no beat to breathe.
  Candidate: a safe airlock room at floor entry, or arrival heal/grace.
- FINDING — MISSION POOL REPETITION: 6 runs → "Purge the Mireclaw Alpha" x4
  (commissary x2, operations deck, cargo hold), steal x2. Template/venue pool
  reads small fast. More templates or venue-flavored twists would help.
- Run 6 (3458439304) underway: commissary Alpha AGAIN (coincidence proves the
  point).

### Run 6 breaks the curse
- Survived F2 arrival (first time in 4 tries), CLEARED floor 2, reached floor 3
  (t38337): steal, 63 npc, hp 64, $126, 7 mods. Ties session depth record.

## PR-prep checklist (do before opening the PR)
- [ ] RENAME release notes to the merge date (now past midnight → 2026-08-23):
      2026-08-22-pad-zoom-settings.ts and 2026-08-22-homing-rework.ts (CLAUDE.md:
      date = merge date or the note sorts below newer ones and never shows).
- [ ] Decide on the agent's repair edit to 2026-08-23-hovering-enemies.ts
      (shortened an over-length pre-existing note that was failing the suite —
      justified, but flag in the PR body).
- [ ] Distill this journal into a committed docs/ playtest report for the PR.
- [ ] Session-end: file capped observer GitHub issues for the design findings
      (murder-hobo economy, empty climax, F2 arrival trap, mission pool
      repetition, witness-silence tell, alert-snitch visibility, AI flicker,
      resistance surfacing) — dedupe against open [observer] issues first.

## Delivered: homing mod rework (background agent, gates green)
- ROOT CAUSE (agent-verified): old homeToward steered at the GLOBALLY NEAREST
  body with health — no LOS, no cone, no hostility check; bullets curved through
  walls (the exact complaint), chased FURNITURE (crates have health), and NPC
  homing rounds chased their own allies (players were excluded outright).
- NEW: LOS-gated raycast steering (walls/closed doors block; LOS break freezes
  heading), 10-tile forward cone, smallest-angular-deviation acquisition
  ("bullets go where you aim"), hostility-aware prey (co-op-safe, no auto-crime
  vs neutral civs, cop/gang matrix honored for NPC rounds), turn cap unchanged,
  STATELESS — zero new serialized fields, vanilla shots byte-identical.
- 17 adversarial tests (homing.test.ts), full suite 3504 green over the combined
  tree, lint+build clean, deterministic e2e demo video:
  e2e/output/feature-homing-rework.mp4 (sent to player). Release note added.
- New homing-demo scenario in scenarios.ts; mods.ts blurb updated.

## Player directives #4 + #5 (mid-session)
- #4: "The homing mod sucks — it mostly curves bullets into walls. Rework it
  completely in a subagent." → homing-rework agent spawned (src/game only,
  disjoint from the zoom/settings agent's files). Brief: LOS-gated steering,
  cone acquisition, capped turn rate, deterministic + adversarial tests + e2e
  video. In flight.
- #5: "I need messages FROM YOU in the game UI — I don't want to keep looking
  at the terminal." → built .observer/say.ps1 (message → stacked banners);
  skill updated: ALL substantive observer messages mirror in-game from now on.

## Delivered: controller-first zoom + settings (background agent, gates green)
- zoomPersist.ts (localStorage, ?zoom= wins), padZoomFactor + padZoom.ts poller
  (hold-to-zoom, capture-inert), zoomIn/zoomOut remappable (default unbound;
  v1 schema kept via backfill — old stored remaps SURVIVE, downgrade-safe),
  Settings = 4th start-menu entry, pad-navigable panel (focus ring, selects
  cycle on A, Close row), gear stays touch-only mid-game (deliberate: face
  buttons belong to combat). Release note added. 3487 tests / lint / build
  green per agent. NOTE: agent also shortened pre-existing over-length release
  note 2026-08-23-hovering-enemies.ts (was failing the suite before our work) —
  flag in PR.
- Player steps (relayed in-game): start menu → Settings → bind Zoom in/out →
  hold to zoom → persists across restarts.

## Player directive #3 (mid-session): controller-only reality + delegation
- Player has NO keyboard/mouse at the couch — CONTROLLER IS THE ONLY INPUT.
  Every UI/feature must be pad-first. (Font size ask was the same theme.)
- Player asked: use mindmeld to learn the relay project's coordinator pattern
  (keep the user-facing session free; delegate to background subagents).
  Mindmeld MCP timed out twice → read relay-queue/COORDINATOR.md directly.
  Applied: spawned ONE background implementation agent (serialize on shared
  files) for: zoom persistence, remappable pad zoom actions (default unbound,
  schema-compat trap flagged), Settings entry in start menu + pad-navigable
  settings panel, release note. Full scouting handed over as claims-to-verify.
  Coordinator-me stays on observation + conversation.

## Player directive (recorded mid-session, do not implement yet)
- **Re-fiction the character vocabulary: there are no "cops", "thugs", etc. anymore.**
  The station fiction has moved on from the Streets-of-Rogue-style street-crime cast.
  Code + docs + my own notes still say cop/gang/civ (`faction` values in
  `src/game/entity.ts`, `relationships.ts` matrix, NPC archetypes, and any
  player-facing strings). Idea on record: rename the player-facing language (and
  eventually the internal vocabulary) to station-appropriate roles — e.g. security/
  wardens, scavengers/raiders, crew/civilians — keeping the mechanical matrix
  (law faction, hostile-on-sight faction, neutral bystanders) intact. Observer notes
  from here on should prefer fiction-neutral terms: "security", "raiders", "crew".
