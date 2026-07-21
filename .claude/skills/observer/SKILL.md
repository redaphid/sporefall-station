---
name: observer
description: >-
  Attach read-only to a LIVE game a human is playing, sample world state and
  player intent on a loop, take tick-stamped notes, and turn recurring frictions
  and opportunities into concrete gameplay-improvement ideas filed as GitHub
  issues for review. Use when asked to "watch me play", observe/spectate live
  gameplay, keep a play journal, or mine a session for design ideas and tickets.
---

# Observer — watch live play, mine it for design ideas, ticket them

A spectator loop over a **live, human-driven game**. You attach, sample the world
and the player's intent every few seconds, write tick-stamped notes, periodically
reflect the notes into gameplay-improvement hypotheses, and file the good ones as
GitHub issues the human can triage. Pairs with [`ecs-debug`](../ecs-debug/SKILL.md)
(attach/inspect) and [`gameplay-experiments`](../gameplay-experiments/SKILL.md)
(the systems vocabulary and how to prove an idea later).

## Golden rule: READ ONLY

You are a spectator of a game a human is actively playing. **Never mutate the
world and never advance it yourself.** The host is authoritative and the sim is
deterministic — a stray `set`/`step`/`load` desyncs or corrupts the human's run.

- **Allowed verbs only:** `games`, `state`, `entities`, `get`, `events`, `schema`,
  `dump` (snapshot for your notes). Chrome `screenshot` is allowed (read-only).
- **Forbidden here:** `set`, `set_field`, `spawn`, `kill`, `teleport`, `step`/`tick`,
  `load`/`restore_world`, `annotate` — anything that writes to or steps the world.
  If you want to *test* an idea, do it later in a separate scratch game
  (`gameplay-experiments`), never in the human's session.

## 1. Attach to the human's live game

Ensure the hub is up (see `ecs-debug`: hub 7810, MCP 7811). The human's browser
tab must be on `…/?debug` so it registers on the hub. Then find *their* game — the
one that is **live and ticking**, not the headless harness:

```sh
npx tsx tools/debug-cli/cli.ts games
#   g1  g1  tick=-     live tick:n/a   ...   ← headless harness: IGNORE
#   g2  g2  tick=1442  live ticking    ...   ← the human's browser game: TARGET
```

Pick the ticking browser game and pin it as `TARGET` for every verb: `--game g2 <verb>`.
On reconnect the id can change — re-run `games` and re-select the ticking, non-harness
game rather than trusting a stale id. If nothing is ticking, wait and re-poll; say so.

## 1b. Keep the served build current with `main` (every loop)

The human plays the build Vite serves out of the **dev-server worktree** (repo
root, branch `main`). Fixes land on `main` continuously (feat/* → merged → `main`);
if the served tree lags, **already-fixed bugs reappear in the live game** (e.g. the
aiming regression). So on **every** loop iteration, before sampling, fast-forward the
served tree to the latest `main` so Vite HMR reloads the running game with the newest code:

```sh
git -C <dev-server-worktree> fetch origin main --quiet
git -C <dev-server-worktree> merge --ff-only origin/main   # safe: refuses if not a clean FF
```

- Use **`--ff-only`** — it never rewrites history and refuses (rather than clobbers)
  if local uncommitted work would conflict. Never `reset --hard` the served tree; the
  human is playing on it.
- Confirm what's live: `git -C <worktree> rev-parse --short HEAD`. When a merge pulls
  in a fix, note it in the run log ("aim fix `abc1234` now live") and, if the human
  reported that bug, tell them it should be resolved after the reload.
- If the FF is refused (local commits/dirty tree diverged from `main`), **don't force
  it** — report the divergence and keep observing the current build.
- If observation shows a bug that `main` is *supposed* to have fixed but hasn't
  (a genuine regression, like aiming breaking again), that's a top-priority issue to
  file — cite the tick evidence and the served HEAD commit.

## 2. The observation vocabulary — what to sample

Each sample, read (all `--game $TARGET`):

- **`state`** — `tick, seed, floor, alarm, gameOver, mission{template,description,
  complete,exitUnlocked,targetEntityId}`, per-kind `counts`. This is your clock and
  objective tracker.
- **`events`** — the sim event ring (deaths, hits, pickups, explosions, door/alarm).
  Diff against last sample; these are the moments.
- **The player(s)** — the human's own intent lives here. Find them:
  `entities` then filter `kind=='player'` (co-op has several). Per player capture:
  - `intent {x,y}` — **the raw movement intent the human is feeding in this tick.**
  - `vel {x,y}` + `pos`/`prevPos` — what actually happened (intent vs. motion).
  - `facing`, `combat {weapon,cooldown}` — aim + whether they're firing.
  - `health {hp,max,iframes}`, `status {stun,sleep,hitFlash,cloak}` — pressure.
  - inventory/mods if present (use `schema` to discover fields you don't know).
- **The pressure around them** — nearby `npc`s: `ai {mode,goal,faction,behavior,
  waypoint,sightRange}` (are cops aggroed? civilians fleeing?), and threats in
  line-of-sight. `schema` enumerates any component you haven't seen.
- **A screenshot** every few samples (Chrome `screenshot` on the game tab) for the
  spatial read notes can't capture: where the player is stuck, what's off-screen,
  crowding, dead space, unreadable threats.

## 3. The loop & the note format

Cadence: sample every **~3–5 s wall-clock** (a live browser game runs ~30 ticks/s,
so that's ~90–150 ticks apart). Append every sample to a durable log —
`.observer/session-<seed>-<startTick>.md` in the repo root (create `.observer/` and
add it to `.gitignore`; it's a scratch journal, not a deliverable).

Timestamp with the sim **`tick`** (never `Date.now()`). One terse block per sample:

```
### tick 1985  (floor 1 · mission steal · alarm 0)
intent: player#7 moving SW (-0.26,0.54), NOT firing, hp 25/25
motion: vel≈0 despite intent → looks WALL-STUCK against room edge (pos 8.35,14.65)
events since 1860: pickup(ammo) x1; hit(cop#41→player#7, 4dmg)
threat: cop#41 ai.mode=chase goal=attack, 3 tiles NE, in sight
signal: DAMAGE-SPIKE + STUCK — took a hit while pinned on geometry
```

Log raw evidence with ticks — later reflection and issues must cite it.

## 4. Derived signals — the analysis lens

From the deltas between samples, flag (each becomes idea fuel):

- **Pacing / dead time** — long spans with no events, no objective progress, low
  intent magnitude → boredom / wandering / unclear goal.
- **Difficulty & balance** — damage taken vs dealt, deaths, near-misses (hp dips
  then recovers), alarm→cop-swarm spikes, unfair off-screen hits.
- **Feedback & readability** — did the player react to a threat *after* it hurt
  them (didn't see it coming)? Did a mechanic fire with no on-screen tell?
- **Control / feel** — `intent` nonzero but `vel≈0` (stuck on geometry / bad
  collision), or facing/aim fighting movement → twin-stick friction.
- **Navigation friction** — backtracking, re-entering rooms, pathing to a locked
  door, hunting for the objective → map/legibility problems.
- **Emergent delight** — chain reactions, element combos, clever routes the player
  found → things to *lean into*, not just fix.

## 5. Reflect — notes → ideas

Every ~N samples (or on a floor change / death), synthesize the log into a few
**gameplay-improvement hypotheses**. Prefer patterns seen ≥2–3 times over one-offs.
Each idea, structured:

- **Observation** — what recurred, with ≥2 tick-cited examples from the log.
- **Interpretation** — the likely design cause (name the system in
  `src/game/systems/` if you can: missions, doors/locks, alarm/cops, stealth/AI,
  elements, inventory).
- **Proposal** — the smallest change that would help (a knob, a tell, a layout
  rule, a new affordance).
- **Expected effect** — what player behavior should change.
- **How to verify** — a deterministic check: a fixture + `e2e/` recording, a unit
  test asserting the new behavior, or a metric to watch next session
  (`gameplay-experiments` shows how to prove it in a scratch game).
- **Effort / risk** — quick knob vs. new system; note determinism impact.

## 6. File GitHub issues (for the human to review)

The point of the loop is a review queue. Be a good citizen: **dedupe and cap.**

1. Ensure the label exists once: `gh label create observer --color 5319e7 --description "Auto-filed live-play observations" 2>/dev/null || true`.
2. Dedupe: `gh issue list --label observer --state open --limit 100` — if an open
   issue already covers the theme, add a comment with the new tick-cited evidence
   instead of opening a duplicate.
3. Create the genuinely new ones (cap **≤5 high-signal issues per session** — quality
   over volume; note in the run summary anything you held back):

```sh
gh issue create \
  --title "[observer] Player gets wall-stuck on room edges during chase" \
  --label observer,gameplay \
  --body "$(cat <<'EOF'
**Observation** (seed 2689870660, floor 1)
- tick 1985: intent SW but vel≈0, pinned on room edge while cop#41 landed a hit.
- tick 2140: same pattern, NE corner — 1.5s of zero motion under fire.

**Interpretation** — collision/steering lets movement intent zero out against
wall geometry; reads as unresponsive during the moments that matter most (chases).

**Proposal** — wall-slide: project blocked intent along the surface tangent so the
player slides instead of dead-stopping.

**Expected effect** — fewer cheap hits taken while pinned; twin-stick feels
responsive under pressure.

**Verify** — fixture with a player driven into a wall at 45°; assert |vel|>0 and
position advances along the wall (deterministic e2e still + unit test).

**Effort** — small (movement resolve tweak); watch determinism.
EOF
)"
```

Keep titles specific and prefixed `[observer]` so they're trivial to triage or
bulk-close. Report every issue URL in the run summary; the human reviews and
decides — you only propose.

## 7. Loop control & robustness

- **Stop conditions:** `state.gameOver==true` (write one final reflection on the
  death, then a session wrap-up), the human closes the tab / game leaves the hub,
  a max wall-clock or max-iterations you were given, or the user says stop.
- **Disconnect:** if verbs start failing or the target vanishes, re-run `games`,
  re-select the ticking game, and resume — don't crash the loop.
- **Never spam:** issues only after reflection, always deduped and capped. Everything
  else lands in the `.observer/` journal.
- **Wrap-up:** end with the journal path, a bullet digest of what you saw, and the
  list of issue URLs filed (and any ideas deferred for lack of evidence).

## Constraints

Read-only on the live game; no `Date.now()`/`Math.random()` in anything you'd add
under `src/game`; ideas are **tickets**, not inline hacks (prove them later in a
scratch game via `gameplay-experiments`). Toolchain is **pnpm** on node 25.
