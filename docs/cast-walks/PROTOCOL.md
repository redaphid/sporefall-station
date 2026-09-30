# Cast walks: how the run is organised

Aaron's standing instructions for animating the whole cast. They were given
once, lost in a machine crash on 2026-09-29, and repeated. This file is the
record, so the next crash loses nothing. Read it first after any restart.

Files in this folder:

| file | what | who writes |
|---|---|---|
| `PROTOCOL.md` | this file: who does what, the rules | the coordinator, on Aaron's word |
| `RUNBOOK.md` | one character, anchor to verified beta: environment, steps, gates, locks | anyone who fixes the procedure |
| `QUEUE.md` | the character order and each one's status | the coordinator |
| `PROGRESS.md` | one line per step: `timestamp \| char \| what \| numbers \| paths` | everyone, append only |

`/mnt/d/tmp/cast-walks/{RUNBOOK,QUEUE,PROGRESS}.md` are symlinks to these files.

## Roles

- **Coordinator** (the session Aaron talks to). Delegates everything. It does
  no hands-on character work: it spawns agents, answers their questions, keeps
  `QUEUE.md`, and reports to Aaron.
- **Worker**. One fresh subagent per character, run serially (one GPU). It takes
  its character from anchor to verified beta by `RUNBOOK.md`, then ends with a
  report. It never starts the next character.

## Rules (Aaron, 2026-09-28/29)

1. **Commit and push after every step.** The machine crashes. Unpushed work is lost.
   The branch is `art/cast-walk-cycles`.
2. **Delegate everything.** Each character gets a fresh agent. The GPU is serial (one job at a
   time), the characters are not: start the next character's agent while the previous one is in
   its CPU-only shipping steps (merge, CI, in-game video). Strict serial left the GPU idle ~25 min
   per character on 09-29, and Aaron was "surprised we finished so few characters".
   **Order by risk:** two-legged humanoids first (they loop on take 1-2, ~30 min each); anything
   that hovers, pulses or has many legs is R&D with a hard 1-hour cap, never ahead of humanoids.
   On 09-29 the drone and the stalker ate ~2 h each and shipped nothing.
   **The GPU is never idle** (Aaron, 09-29 09:46: "The GPU should literally never be idle"). Always
   keep one character staged (Step 0 done on CPU, waiting on `GPU-WAN.lock`) behind the one on the
   GPU. The coordinator runs an idle watchdog (util < 15% for 60 s alerts) and answers every alert
   by staging work. A lock holder with no GPU process is released by the coordinator.
3. **Workers fix what they find, except a gate.** A script bug or a wrong
   default is fixed at its root by whoever finds it. They prove the fix (a
   test, or a before/after run), commit, push, and report the finding in one
   line: symptom, root cause, fix, commit. They don't hold or work around it.
   A gate that seems to fail good art is not theirs to fix: rule 14.
4. **Gates block shipping, and workers never change them.** A gate is its
   code, thresholds, prompts, VLM model and per-kind exceptions: everything
   `scripts/assets/gate_hash.py` hashes. A worker whose art fails reports the
   failing gate, numbers and frames, and stops that direction. On 09-29 the
   gates were redefined seven times after our own art failed them
   (`GATE-CHANGES.md` G1-G6 and a rule-11 exception).
5. **Ship each character to `main` once it passes.** Aaron (2026-09-29
   03:05): "You are free to merge straight to main. I want to be able to
   play this in the morning with the new sprites." A finished character is
   merged into `main` (no PR needed) after `pnpm run build`, `pnpm exec
   vitest run` and `pnpm run lint` pass on the merge, then pushed. Verify
   the sha of one of its frames from the live site. The beta
   (`preview/cast-walks`) stays available for looks before a merge.
6. **Show Aaron a redesign before the long render.** Before a redesigned
   character's Wan run, Aaron sees the candidates and can veto the look.
7. **Report every half hour as an executive briefing with proof.** Before
   each report, the coordinator queries every running agent for a 1-4 line
   status and reads the tail of `PROGRESS.md`. It never reports from memory.
   Aaron (2026-09-29 04:15): "roll those in to an executive briefing, with
   proof of work and deployments. I don't trust you with these things." So
   every shipped claim carries proof the coordinator checked itself: the
   commit sha on `origin/main`, the deploy run id, the live build number,
   and a frame's sha from the live site matching the commit. Anything it
   did not verify is labelled "claimed, unverified". Each briefing also
   attaches the newest images and video (contact sheets, walk GIFs, in-game
   captures) with SendUserFile: "Showing the images during your report
   serves as grounding and proof" (Aaron, 04:25). Workers save every visual
   they make under `/mnt/d/tmp/cast-walks/<char>/` so the coordinator can
   attach it.
8. **Finish one character end to end before the next.** Aaron has to see
   the whole path work on the beta (the mycologist first, 2026-09-29). A
   character in progress takes priority over every queued one.
11. **The full cast gets animated for testing; weak designs go last** (Aaron, 2026-09-29 ~10:05:
   "Have a separate agent, one with the role of an incredibly experienced, talented and critical
   pixel art artist critique each character. And queue the bad ones up at the end of the queue so we
   still end up with the full cast animated for testing"). A critic agent grades every character
   A-F (`/mnt/d/tmp/cast-walks/critique/`), briefed by `CRITIC.md` (aesthetic priority; any
   lore-sensible character that can fill the role will do). QUEUE.md order: A/B first, C/D/F last. Weak designs are
   still animated (for testing), then redesigned. There is **no** standing "least-bad loop"
   exception. The stalker's shipped I2V takes ("Let's use what we have for now") were Aaron's one
   explicit call for that character. The coordinator widened it into a blanket rule, which let a
   pulse loop stand in for a walk; Aaron called that reward hacking (09-29), and it is withdrawn. A
   body that can't loop is redesigned (rule 13). Gates change only as rule 14 says.
12. **Never use the old player sprite as a style anchor** (Aaron: "Using the original player
   character as the anchor is a bad idea. It's not a great image."). The r2 cast converged on its
   teal suit via IPAdapter 0.3 + one shared LOOK suffix + shared seeds
   (`/mnt/d/tmp/cast-walks/research/art-docs-2026-09-29.md`). New designs: anchor off, each character
   its own build, palette and seed, drawing-medium words, photo negatives.
13. **Every character that moves gets a real locomotion cycle** (Aaron, 2026-09-29 16:1x: "I'm
   concerned you are reward hacking. I asked for walking animations. If they are not bipedal, find
   an actual way for them to move, changing the character if necessary"). Every archetype with
   speed > 0 in `src/game/data/npcs.ts` (all but hivespire) gets frames where the body visibly
   travels through a gait: walk, prowl, crawl, scuttle, slither, hop, or wing-beat flight. A
   breathing/pulse/hover-bob loop is NOT a substitute. If the design can't produce a gait that
   moves, change the character (the critic picks one that can). Passing a gate with an exception
   is not the goal; the character moving convincingly in game is. Stationary (speed 0) only:
   hive-spire.
14. **Gate changes are deliberate, reasoned and signed off** (Aaron, 2026-09-29 ~17:00: "find a way
   to prevent gate bypassing like this. If we have to change them, it should be deliberate and
   reasoned. We should explore other solutions to generating sprites that we came up with in
   sporefall-art before cheap fixes"). Until Aaron signs off, gate code, thresholds and per-kind
   exceptions are frozen, and this narrows rules 3-4. A worker who thinks a gate is wrong writes
   the case (symptom, measurement, evidence, proposed change) and stops. The coordinator takes it to
   Aaron. When a take fails, try a better route first: a new take, a different motion or pose
   source, or the sporefall-art/cyber-puck methods (`/mnt/d/tmp/cast-walks/research/sprite-routes.md`).
   An approved change is recorded in `GATE-CHANGES.md`: one entry per gate version, holding its
   hash, the evidence that the old rule was wrong (art the old rule misjudged, not "our art failed
   it"), old vs new on the shipped cast, the negative controls, and `Approved-by: Aaron "<his
   words>" (<date>)`. A per-kind exception is its own entry naming that one kind. This is enforced:
   `cast_walk.py gate` refuses to run, and `pnpm exec vitest run` fails
   (`src/render/castGateLedger.test.ts`), when the gate's hash is not the ledger's head.
9. **Keep notes in the repo.** A new standing instruction goes into this file
   and is pushed the same turn.
10. **Design on-lore.** Every character design and every redesign prompt
    follows the lore canon. The canon is the art repo's
    `docs/LORE_CHARACTERS.md` (G1-G7, L1-L3, families A-E, Roster 2 §8),
    its `sprites/roster_lore.py` and `docs/LORE_GROUNDING.md` (tone, not
    committed there), and this repo's `docs/LORE.md` lines 25-62.
    `/mnt/d/Projects/sporefall-art` is production: read it, never write it.
    `RUNBOOK.md` Step 0 has the summary and the lore check that every design
    passes before Aaron sees it. Aaron's words:
    - 2026-09-25: "Make that brute character not look like the hulk"
      (that is bog-mutant, not carapace-brute).
    - 2026-09-29 00:04: "There are a lot of low quality character art in
      there. Fell free to replace them. One of them is clearly "The Hulk",
      for example. Have the agents are draw more from the lore, and good
      concept art. But don't take forever finding great ones."
    - 2026-09-29 00:09: "Read the copy for this pr:
      https://github.com/redaphid/sporefall-station/pull/133" (its
      `docs/design/setting-fit.md` ranks the sources Step 0 uses).
    - 2026-09-29 00:48: "Not a 'bat', etc. Also dogs shouldn't have knives"
      (said of weapons; it binds the cast too).
    - 2026-09-29 00:50: "Don't make it too steampunk" (Step 0, "Not steampunk").
    - 2026-09-29 00:51: "\"thug, cop, shopkeeper\" are not lore-appropriate
      names"
    - 2026-09-29 02:33, after the crash: "Remember the lore stuff as well"

## After a crash

**Auto-resume (since 2026-09-29, Aaron: "set up Windows to restart this session if it crashes").**
At Windows login, `Startup\claude-crash-resume.cmd` checks `D:\tmp\claude-resume\active`. If it
exists, it shows a 15-minute countdown window (Aaron: "in case I want to shut it down"; close the
window or delete the marker to cancel, press a key to start now), re-checks the marker, then opens Windows Terminal -> WSL `survivor` -> `~/.local/bin/claude-crash-resume`, which runs
`claude --resume <SESSION> --remote-control --permission-mode auto` with a prompt pointing at the steps
below. The marker holds `SESSION=`, `CWD=`, `EXPIRES=` (epoch). An expired marker is deleted, not
resumed. The coordinator writes the marker when a run starts and deletes it when the run ends.
Subagents, crons and monitors die with the crash; the resumed coordinator re-creates them.
It needs a Windows login: if the box boots to a password screen it waits until Aaron logs in.

0. **Check git first:** `find .git/objects -type f -empty` in `~/Projects/sporefall-station`; move any
   empty objects aside and `git fetch` to restore them (crashes on 09-29 left 21 and 11). Save WIP
   only with `/mnt/d/tmp/cast-walks/crash-save.sh <tag>`, which refuses to commit files the crash
   truncated to 0 bytes (09-29 crash 5 zeroed 119 files and a blind save pushed them).
1. Read this file, then `QUEUE.md` and the tail of `PROGRESS.md`. Then read
   `git log origin/art/cast-walk-cycles -10` and `git status` in
   `~/Worktrees/sporefall-station/cast-walks`.
2. Commit and push any uncommitted work in the worktree as `wip(...)`.
3. Restart ComfyUI and the private Ollama (`RUNBOOK.md` Environment). Delete
   stale `*.lock` files in `/mnt/d/tmp/cast-walks/`, because their owners died
   with the crash.
4. Spawn a fresh worker for the character marked in progress in `QUEUE.md`.
   Point it at its run dir and the last `PROGRESS.md` line.
