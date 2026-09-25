# A sprite pipeline that keeps running — design

**Status: design only. Nothing here has been run.**

Every requirement below is traceable to something that actually failed on
2026-08-22/23; the post-mortem is `art-run-r2-journey.md`. The point is not to
add ceremony — it is that a run which takes hours, on a shared GPU, driven by
agents that die, needs to be **resumable, observable, and testable without a
GPU**. Tonight's run was none of those.

## What went wrong, and the requirement each one implies

| # | Failure | Requirement |
|---|---|---|
| 1 | Sweep was a child of the agent session; agent died, sweep died, **cleanly, mid-seed** | **R1** Run must outlive its launcher |
| 2 | Two sweeps ran at once; one an **orphan** whose parent died at 18:51 | **R2** At most one owner, enforced |
| 3 | `qwen3-vl` held 20.4/24 GiB; SDXL went **0.5 s/step → 775 s/step** | **R3** Generation and gating never hold VRAM together |
| 4 | Everything reported "running" through an 8-minute stall | **R4** Progress measured by artefacts, never liveness |
| 5 | Only `s-idle` finished; shipping it alone is a **regression** | **R5** Completeness is a gate, not a judgement call |
| 6 | `autopost.log` 0 bytes — the reporter never ran | **R6** A reporter must prove it reported |
| 7 | `consistency.py` gated art it never opened; first bug-fix was a **byte-identical no-op** | **R7** Every check must be shown to fail |

## Shape

One **plan**, one **state file**, one **owner**, three **phases**, and a
**supervisor** that watches output rather than processes.

```
plan.json      immutable: every job the run intends to produce
run-state.json append-only: what has actually been produced
               (the ONLY source of truth for resume)
run.lock       owner pid + heartbeat  (R2)
```

A **job** is the unit of work and of resume:

```
{ kind: "spore-drone", dir: "s", frame: "idle", seed: 880004 }
```

Jobs are **content-addressed by those four fields**, so "have we done this?" is
a lookup, never a guess. Tonight's resume skipped finished *characters* but still
queued an already-picked one — that is the bug this removes.

## The testable seam

The orchestrator must be a **pure state machine over an injected backend**. This
is the single most important decision in the document, because it is what makes
the whole thing testable with no GPU, no ComfyUI and no models:

```python
class Backend(Protocol):
    def submit(self, job: Job) -> JobId: ...
    def poll(self, id: JobId) -> Literal["queued", "running", "done", "failed"]: ...
    def fetch(self, id: JobId) -> Path: ...
    def vram_free_mib(self) -> int: ...

class Gate(Protocol):
    def score(self, image: Path, kind: str) -> float: ...
```

`ComfyBackend` talks to :8188. `FakeBackend` returns canned results on a
deterministic schedule. **Every rule below is then a unit test** — stall
detection, resume, VRAM arbitration, completeness — none of which needs a card.

That is the difference between "we believe it resumes" and "resume is covered by
a test that fails when we break it."

## The rules, each with its test

**R1 — outlive the launcher.** Started detached (`Start-Process`), never as a
child of an agent turn. *Test:* the runner writes `run-state.json` transitions;
kill the parent, assert transitions continue.

**R2 — one owner.** `run.lock` holds pid + monotonic heartbeat. Startup: if the
lock exists and its pid is alive **and** its heartbeat is fresh, **refuse to
start**. If the pid is dead or the heartbeat is stale, take the lock and log the
takeover. *Test:* a stale lock is reclaimed; a live one blocks. This is precisely
the orphan case — the orphan held no lock and nothing noticed.

**R3 — VRAM is exclusive, and gating is a separate pass.** Generation and VLM
scoring must never overlap. Two mechanisms, belt and braces:

- **Phase separation.** Generate the whole sweep, *then* gate it. Curation does
  not need to be interleaved; it was only interleaved for latency.
- **An explicit arbiter.** Before scoring, `unload_vlm()`; before generating,
  assert `vram_free_mib() > FLOOR`. Refuse rather than crawl.

*Test:* `FakeBackend` reports low free VRAM → the runner **refuses and reports**,
rather than submitting a job that would take 775 s/step. **Degrading into a
1500x slowdown is the failure mode; refusing loudly is the fix.**

**R4 — progress is artefacts, not processes.** The supervisor tracks *count of
new output files* per interval. Stall = `no new artefact for STALL_SECS` while
the phase claims to be running. On stall: capture VRAM, queue depth and the last
log line, then **report it** — do not silently retry.

*Test:* `FakeBackend` stops producing while still reporting `running`; assert a
stall is raised within the window. This test is the whole of failure #4, and
tonight nothing would have caught it — every check said "alive" because it was.

**R5 — completeness gates shipping.** A phase's output is **shippable** only when
its whole matrix is present. Concretely: **`s-idle` alone is not shippable** —
measured, a 26px idle next to a 21px step is a ~30% mass jump every step.

```
shippable(kind) ⇔ ∀ dir ∈ DIRS, ∀ frame ∈ FRAMES : produced(kind, dir, frame)
```

*Test:* a kind with 1 of 10 frames is **not** shippable; with 10 of 10 it is.
Note this rule alone would have prevented tonight's near-miss without anyone
having to notice it.

**R6 — the reporter proves it reported.** A post is recorded as done **only after
the transport returns success**, and the run refuses to start if a smoke post
fails. Tonight's poster marked two sprites posted that never arrived, because the
error was swallowed by `|| true`.

*Test:* transport raises → the item stays unposted and is retried.

**R7 — every check ships with its own mutant.** No check enters the pipeline
without a paired test that **breaks the thing on purpose and asserts red**.
Tonight three checks lied: a hardcoded chars dir gating the wrong art, a
threshold too tight to see `(242,246,234)`, and `temporal_smooth()` — written for
exactly the sparkle we hit — that has **never fired**.

*Test:* for each gate, a known-bad fixture that must fail it. A gate with no
red-fixture is treated as **not implemented**.

## Phases

```
generate → (unload VLM) → gate → curate → assemble → verify → publish
```

- **generate** — GPU exclusive. Writes raws. Idempotent per job.
- **gate** — VRAM exclusive, VLM loaded, *no generation in flight* (R3).
- **curate** — pure. Ranks scored candidates. **No GPU, fully unit-testable.**
- **assemble** — downscale, palette, `debleed`. Pure; already fixed this week.
- **verify** — consistency harness **from inside the checkout under test** (R7),
  plus completeness (R5).
- **publish** — only what `verify` passed.

Each phase is `f(state) -> state'`, so resume is "load state, run the first
incomplete phase" and needs no special-casing.

## Two smaller things worth fixing while in here

- **`consistency.py` must accept a `--chars` path** instead of hardcoding one and
  silently discarding unknown `--` flags. Today it answers confidently about a
  directory you did not ask about.
- **`temporal_smooth()`** either gets a tolerance so it can actually fire, or is
  deleted. A guard that has never fired is worse than no guard: it occupies the
  space where a working one would go.

## What this explicitly does not do

- No new scheduler, queue service or daemon. A lockfile and a state file are
  enough for one machine and one GPU, and they can be inspected with `cat` at
  3am.
- No retry-until-it-works. Tonight's failures were **starvation and silence**,
  not flakiness; automatic retry would have hidden all of them for longer.

## Suggested order

1. `run-state.json` + resume + `FakeBackend` (unlocks every other test)
2. R5 completeness gate — cheapest, and prevents the regression we nearly shipped
3. R4 stall detection — turns tonight's 8 silent minutes into an alert
4. R3 VRAM arbitration — the actual root cause
5. R2 lockfile, R6 reporter, R7 mutants alongside each gate
