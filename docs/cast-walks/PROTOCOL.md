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
   The branch is `art/cast-walk-cycles`. Never push to `main`.
2. **Delegate everything.** Each character gets a fresh agent, in serial.
3. **Workers fix what they find.** A gate that fails good art, a script bug or
   a wrong default is fixed at its root by whoever finds it. They prove the fix
   (a test, or a before/after run), commit, push, and report the finding in one
   line: symptom, root cause, fix, commit. They don't hold or work around it.
4. **Gates block shipping.** Workers make reasonable changes to the gates
   themselves ("You wrote the gate"). Fix a measurement that is wrong. Never
   loosen a number just to pass.
5. **Deploy each character once it passes** to the beta (`preview/cast-walks`),
   and verify the sha from the live URL.
6. **Show Aaron a redesign before the long render.** Before a redesigned
   character's Wan run, Aaron sees the candidates and can veto the look.
7. **Report every half hour when asked.** Before each report, the coordinator
   queries every running agent and reads the tail of `PROGRESS.md`. It never
   reports from memory.
8. **Finish one character end to end before the next.** Aaron has to see
   the whole path work on the beta (the mycologist first, 2026-09-29). A
   character in progress takes priority over every queued one.
9. **Keep notes in the repo.** A new standing instruction goes into this file
   and is pushed the same turn.

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
