# The r2 cast run — what it cost and what it taught

A record of the character-art regeneration of **2026-08-22/23**, written for the
next person who runs one. `sprite-generation.md` is the manual: how the pipeline
works when it works. This is the other half — **what went wrong**, what the
failures looked like from the inside, and which of our checks turned out to be
lying.

**Provenance matters here, so it is marked.** Sections tagged *observed* were
measured during the write-up and the numbers are reproducible. Sections tagged
*reconstructed* come from the run log of agents that died before I picked this
up; I did not re-derive them, and they should be treated as claims.

---

## Why the run happened

The shipped cast read badly at 48px. The player was **21px wide on a 48px
canvas** with thighs about 4–5px, while squat enemies like bog-mutant were ~40px
and read fine. *(observed — both figures re-measured.)*

## What actually won — the bake-off

*(reconstructed)* Arms tried, in order: the old recipe as control; the new
chunky-proportions prompt on the same SD1.5 model; the new prompt on the pack's
SDXL base at 768; then juggernautXL. Then CFG 7 vs 3.5, and 1024 vs 768.

**Winner: juggernautXL @ 768, CFG 3.5.** CFG 7 came out noisy and 1024 came out
*thinner*, not sharper.

Two things worth carrying forward:

- **The thinness was never the checkpoint.** It was geometry: `post.sprite()`
  fits the figure's **longest axis** into 46px, so a standing human — roughly
  twice as tall as wide — spends its whole budget on height and collapses to
  ~21px across. Squat creatures were always fine. Changing models would never
  have fixed that; changing the prompt's *proportions* did.
- **juggernautXL beating anything-xl here matches the prop sweep's earlier 8/8
  vs 1/8 result.** Characters had simply never been moved over. If you are
  choosing a checkpoint for this repo, that is now two independent findings
  pointing the same way.

## The white speckle, in full

*(observed — this is the best-documented bug of the run.)*

**Symptom:** the player's walk cycle sparkled. 3–15 near-white pixels per frame,
all exactly `#f2f6ea`, in **different places each frame**, so they flickered
rather than sat still.

**The chain:**

1. `prep_white` composites the transparent Blender frame onto **pure white**.
2. Diffusion does not respect the silhouette — it paints that white **inward,
   past the geometric edge**.
3. `post_frame` masks with a **hard `alpha > 100`** threshold from the Blender
   alpha. The contaminated pixels have alpha **255**, so they are kept at full
   opacity, white and all.
4. k-centroid collapses ~16×16 source pixels into one 48px pixel, averaging that
   white rim into **every edge pixel** of the sprite.
5. The palette lock snaps the result to its nearest entry: `#f2f6ea`.

**The measurement that proved it** — on `walk-s-0`, near-white pixels:

| region | near-white |
|---|---|
| within 1px of the silhouette edge | **47.9%** |
| deeper than 12px inside | **1.0%** |

Background bleed lives on the boundary. Highlights do not. That single contrast
is what turned "some white pixels" into a diagnosis.

**The fix:** a `GEN_BG` constant used by both the compositor and the un-mixer so
they can never drift apart; `unmix_bg` to algebraically invert the composite on
the antialiased rim; and `debleed` — the load-bearing half — which evicts
near-`GEN_BG` pixels within 14px of the edge **at full resolution, before any
resampling**. Result: **edge speckle 278 → 0**, silhouette **byte-identical in
40/40 frames**.

**Why it has to happen before the downscale:** after k-centroid, the white is
already inside the average. Anything you do then is cosmetic retouching of a
number that is already wrong.

**What the rim restriction buys:** the character's own dark outline is far from
`GEN_BG`, so it is always a *donor* and never a *target*. An erode-and-reflood
would have eaten it.

### The most reusable lesson in the whole episode

**The first fix was a no-op.** It was correct-looking, well-commented, and
produced **byte-identical output**. It only addressed the antialiased rim, where
coverage is fractional — but the dominant contamination sits in pixels with
coverage **1**, which no amount of coverage algebra can touch.

It was caught **only because the output was measured before it was believed.**
Nothing about reading the diff would have revealed it.

## Checks that lied

Three separate times this run, a check produced a confident, well-formed,
**wrong** answer. None of them errored.

**1. `consistency.py` silently ignores `--chars`.** *(observed)* It **hardcodes**
its chars directory (line 42) and **strips every `--` flag** (line 274). Pass
`--chars /some/other/dir` and it cheerfully re-checks the shipped art and reports
**"0 violations"** about sprites it never opened. It told me the new art passed.
It had not looked at the new art. It was caught by handing it a sprite shrunk to
**60%** and watching it still report clean. **Run it from inside the checkout you
mean to test.**

**2. A too-tight threshold read as "clean".** *(observed)* An early speckle scan
used `r,g,b all > 235`. The speckle colour is `(242, 246, 234)` — blue channel
**234**. The scan returned **zero** on frames that were visibly sparkling.

**3. `temporal_smooth()` has never fired.** *(observed)* It exists specifically
to "kill single-frame color sparkle", it ran on every frame of this run, and it
did nothing: it only repairs a pixel when **both** temporal neighbours match
*exactly*, and diffusion re-shades every frame, so they never do. **The guard for
this exact bug was already in the file and was decorative.** Still unfixed.

## The run that died and looked alive

*(observed)* The first cast sweep stopped at **20:38Z**. Its log ends mid-seed on
frog-settler with **no error and no traceback** — a clean stop, which is what a
kill looks like. It died ~90 seconds after the agent driving it went quiet,
because **the sweep was a child process of the agent session**. The host crash
came four hours *later* and had nothing to do with it.

The agent had promised the pipeline would "post its own finished sheets".
`autopost.log` was **0 bytes**.

So four hours read as progress and were nothing at all.

**Launch long work detached** (`Start-Process`), never as a child of the turn
that started it. And a progress reporter must be **verified to have reported**,
not merely started — see below.

## The relay poster that recorded success without posting

*(observed)* The replacement progress-poster marked two sprites as posted that
**never reached the thread**. `relay.py` splits its `path:alt` argument on the
**first colon**, so a Windows path (`D:/tmp/...`) parses as a file named `D` and
the upload dies — and the `|| true` wrapped around it swallowed the error.

Two changes: pass paths **relative** to the working directory (no drive letter),
and **only record a post as done if it actually succeeded**. The second is the
real fix; the first version would have gone quiet again and looked fine doing it.

## ComfyUI without `--models-directory` sees nothing

*(observed)* Started by hand from the workspace root, ComfyUI finds **zero**
models and rejects every job with `HTTP 400` —
`Value not in list: ckpt_name: '...' not in []`. It reads like a broken
workflow. It is a broken **launch**.

Models live at `D:\comfyshared\ComfyModels`, passed via `--models-directory`.
**Use `D:\tools\comfy\scripts\start.ps1`**, which does it correctly. Verify with
`/object_info/CheckpointLoaderSimple`: a healthy instance lists **~76**
checkpoints, not 0.

## The 48px reality

- **A limb is 1–2 pixels.** Fine articulation does not survive the downscale; it
  turns to mush, and frame-to-frame jitter reads to the consistency harness as
  the character *changing*, which is a gate failure rather than an animation.
- This is the argument for **moving the whole sprite** (hover bob, pulse) for
  small or non-bipedal creatures rather than animating limbs they barely have.
- **`foot_y` is not a matter of taste.** Every character's feet must sit on the
  canvas floor; a 2px drift makes that character bob against every other sprite
  in the scene. cinder-husk came out of this run with exactly that defect.

## The colour question, and why it was ambiguous

He was asked to settle an "orange helmet / teal visor **inversion**" — framed as
the new art inverting a shipped "teal suit / orange visor" design.

**That premise was false.** *(observed)* The shipped ranger has **1 orange pixel
out of 544**. There was no orange visor to invert. What actually happened is that
the new recipe **introduces** orange as a signature colour, consistently across
anchor, idle and walk (0.2% → ~10–12%), partly because `trace.py` actively forces
cap pixels toward `#ff9032` in its "signature-color rescue".

**He chose to keep the orange** (2026-08-23T01:40Z), shown all three options as
images and picking by tap.

The lesson is not about colour. **A question built on an unverified premise
wastes the answer**, and this one had already survived one agent's death still
unanswered. Check the premise before you escalate the question — one `Counter()`
over the sprite's pixels would have caught it at any point.

## The stall that ended the run: the gate starved the generator

*(observed, and the single most important thing in this file.)*

The second sweep stopped dead — 77 frames flat for about eight minutes,
gloom-lurker stuck at 3 of 8. **ComfyUI was never wedged.** It was **VRAM
starved**:

- ollama `qwen3-vl:8b` was holding **20.4 GiB of the 24 GiB card**
- SDXL sampling collapsed from **~0.5 s/step to ~775 s/step**

It was working the whole time — roughly **1500x too slow to look alive**. Every
liveness check said "running", because it *was* running.

**The design problem, stated plainly: the VLM that GATES sprite quality starves
the SDXL generation it is gating.** They cannot share 24 GiB concurrently.
Anyone resuming this must **sequence them** — unload the VLM before generating,
or run curation as a separate pass after generation finishes. Running both at
once does not degrade gracefully; it stops, while continuing to look busy.

Two smaller notes from the same wind-down:

- **Two sweeps were running, not one.** One was an **orphan** whose parent had
  died at 18:51 and which kept going unnoticed. When you kill a run, enumerate
  by command line and kill every match — do not assume the pid you started is
  the only one.
- A queued job for `carapace-brute-s880000` was **wasted work**: that character
  had already been picked. The resume logic skips finished characters at the
  *pick* level, not the *queue* level.

**Generalising the lesson, because it is the same shape as everything else in
this file: "the process is alive" is not "the work is progressing."** A liveness
check that cannot distinguish those two will report health right up until you
look at the output directory and find nothing new for eight minutes. Watch the
artefact count, not the process list.

## If you are starting a run

1. `start.ps1`, then confirm ComfyUI sees ~76 checkpoints.
2. Launch the sweep **detached**. Confirm it is *generating*, not just *running*
   — look for real scores in the log, not just an alive process.
3. Confirm your progress reporter has actually posted something.
4. Gate from **inside** the checkout under test, and **prove the gate can fail**
   before trusting a pass.
5. Measure before and after every fix. A fix you did not measure is a hypothesis.
6. **Do not run the VLM gate concurrently with generation.** 24 GiB does not fit
   both, and the failure mode is a silent 1500x slowdown, not an error.
7. Track progress by **artefacts produced**, never by "the process is still up".
