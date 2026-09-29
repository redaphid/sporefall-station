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
2. **Delegate everything.** Each character gets a fresh agent, in serial.
3. **Workers fix what they find.** A gate that fails good art, a script bug or
   a wrong default is fixed at its root by whoever finds it. They prove the fix
   (a test, or a before/after run), commit, push, and report the finding in one
   line: symptom, root cause, fix, commit. They don't hold or work around it.
4. **Gates block shipping.** Workers make reasonable changes to the gates
   themselves ("You wrote the gate"). Fix a measurement that is wrong. Never
   loosen a number just to pass.
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

1. Read this file, then `QUEUE.md` and the tail of `PROGRESS.md`. Then read
   `git log origin/art/cast-walk-cycles -10` and `git status` in
   `~/Worktrees/sporefall-station/cast-walks`.
2. Commit and push any uncommitted work in the worktree as `wip(...)`.
3. Restart ComfyUI and the private Ollama (`RUNBOOK.md` Environment). Delete
   stale `*.lock` files in `/mnt/d/tmp/cast-walks/`, because their owners died
   with the crash.
4. Spawn a fresh worker for the character marked in progress in `QUEUE.md`.
   Point it at its run dir and the last `PROGRESS.md` line.
