# Sporefall Station — live observation log

Append-only running log from a live-observer agent driving Chrome against the dev
server (`localhost:5173/?debug`). Each pass records wall-clock, `world.tick`, and
what was seen. Read-only observation via `window.sporefall` / `window.world`.

Session start: 2026-07-19, build **267**, solo run, floor 1, seed **2602185732**.

Player entity: id 86, archetype `player`. Input signal observed via:
- `player.intent {x,y}` — movement intent (the stick / WASD vector)
- `player.facing` — aim direction (radians)
- `player.vel {x,y}` — resulting velocity
- `player.combat {weapon, cooldown}` and `playerCtl.activeSlot` / `inventory`
- `player.status {stun, sleep, cloakUntil, hitFlashUntil}`

Mission (seed 2602185732, floor 1): `steal` — "Steal the briefcase from the
apartment", target entity **53**, target building **10**.

Initial schema kinds: door 32, npc 31, pickup 22, player 1.

---

## Pass log

### Pass 0 — tick 0 (session init)
Fresh solo run started by the observer (no human at the controls yet). Player at
(1.5, 1.5), hp 120/120, iframes 90, weapon `pistol` (200 ammo), intent/vel zero,
facing 0. No events yet. Alarm 0.

Level makeup (seed 2602185732, floor 1), from `entities()` by archetype:
- npc/civilian 20, npc/thug 9, npc/cop 2 (factions: civ 20, gang 9, cop 2)
- door 32
- pickups: briefcase 1 (the mission target, id 53 @ (56.5,58)), bandage 4,
  medkit 2, cash 2, knife 2
- weapon mods on the ground: bulk 2, velocity 2, heavy 2, choke 1, frost 1,
  overload 1, shock 1, split 1
- Level bounds roughly x 5.5..61.4, y 3.5..60.5 (~56x57 tiles).

### IMPORTANT observation-harness caveat — sim freezes while tab is hidden
The observer tab runs backgrounded (`document.visibilityState === 'hidden'`),
so `requestAnimationFrame` is throttled and **the sim loop freezes**. It advances
only in bursts when the tab is briefly foregrounded (e.g. when `computer` takes a
screenshot). Consequence: `world.tick` jumps unpredictably between reads
(observed jumps 0 -> 1957 -> 2610), and continuous frame-accurate observation of
a *hidden* tab is not possible. While foregrounded it runs ~30 ticks/s.
`sporefall.tick()` was 0 during the frozen start but matches `world.tick` once the
sim is actually running (no stale-read bug — the 0 was real).
`window.world.byId` is a **Map** (use `.get(id)`, not `[id]`), while the
`sporefall.*` clones are plain objects.

### Pass 1 — tick ~2610-2664 (idle player got swarmed and downed)
With NO input supplied (observer never drove the player), the player left spawn
region and by ~tick 2610 was at (14.2, 8.6) and **downed**: hp 0,
`playerCtl.downed = {bleedTicks: 128, reviveProgress: 0}`, `revivesLeft: 2`,
`gameOver: false`. So Sporefall Station has a downed/bleed-out + revive mechanic that fires
even in solo — with no teammate to revive, a solo down is a slow death unless
self-revive exists. NPC id 1 (a `civ`-faction "skittish" civilian) had gone
`ai.mode: aggro` targeting the player (id 86) with a `stunGun`, and thugs were
nearby. Alarm stayed **0** through the whole beating (combat on the player did
not raise the alarm). Player pistol ammo dropped 200 -> 193 (7 shots) despite the
observer never firing — see bugs note.

### Pass 2 — user takes the controls (Stadia pad), aiming investigation
User began actively playing (Stadia pad, `navigator.getGamepads()[0]`). Player
respawned/regenerated across the session (ids seen: 86 -> 101 -> 87 as the run
reset). Correlated raw gamepad axes with the sim every ~20-30ms during play:
- **Aiming bug isolated** -> `stadia-aim.md`: aim stick reads on the correct axes
  with correct signs, but `hostSession.mergeCmd` gates a pad's aim on MOVE
  magnitude, so **aim is dropped while standing still** (facing frozen) and only
  works while the left stick is deflected. This is the "I miss constantly" cause.
- Fire confirmed = R2 = gamepad button index 7 (value 1.0).
- Projectiles are real `kind:'projectile'` entities spawned along continuous
  `owner.facing`; captured `velAng` == `facing` at spawn (pistol showed a small
  3-value spread pattern -0.009/0.051/0.111 — pellet/mod spread, benign). No
  8-direction quantization in the sim.

### CAVEAT — pulling main mid-session reloads the game
Running `git pull` while the Vite dev server is live triggers HMR / a full page
reload, which **resets the user's run** (world regenerates, player gets a new id,
`window.__snap` is lost). Observed the run reset several times right after pulls.
Recommendation: pull sparingly during live observation, or the user's session
keeps restarting. Balanced this against the "frequently pull main" instruction by
pulling less often once play began.

### Stunlock (source + data, no live mutation) -> `stunlock.md`
User reported chain-stun. Confirmed from `data/items.ts` + `statusFx.ts`: the
`stunGun` applies `electrified` (an immobilize) for 45 ticks on a 24-tick
cooldown; re-hits REFRESH the expiry, so 24 < 45 => a single stunGun enemy locks
the player forever. Did NOT run the destructive repro (user was live-playing;
snapshot/restore would rewind their game).

### Pass 3 — loop cycle (tick 7256, new run)
New run generated (still floor 1, but mission is now "steal the briefcase from the
clinic", building 9 / target 49 — different seed). Player id 88, hp 68 @ (51.7,30),
weapon pistol, no status fx, not stunned. **Alarm = 3** (has risen this run) with
NPCs 13 (down from 31): modes 1 aggro / 3 flee / 7 wander / 2 patrol — civilians
now fleeing the armed player. Refines Pass-1 note: alarm DOES climb once the player
fights/commits crimes; earlier it stayed 0 only because the idle player hadn't
committed any crime — attacks ON the player still don't seem to raise it, the
player's own actions do. Aiming: user idle at capture (sticks centered). No new
anomalies this pass; aiming root cause already confirmed (stadia-aim.md).
