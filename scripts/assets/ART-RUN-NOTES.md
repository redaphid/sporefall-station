# Character art run — running notes

**This machine crashes.** Twice on 2026-08-22 (21:53Z and 00:41Z), and both times
every agent died mid-flight with no handoff. This file exists so the next agent
can resume **from this file alone**, without the one who wrote it. Update it as
you go, not at the end.

Last updated: **2026-08-23 ~04:30Z** by Artgate2. **The cast is COMPLETE.**

---

## Decisions already made — do not re-ask him

- **Orange helmet / teal visor. He picked it**, by tap, 2026-08-23T01:40:42Z.
  Option A of three, against an all-teal recolour and against keeping the
  shipped art. **This question already cost a day** because the agent holding
  the answer died before recording it. It is recorded here now.

  Note the framing that reached him was wrong and was corrected: the claim that
  the shipped ranger is "teal suit / orange visor" and the proxy inverts it is
  **false**. The shipped ranger has **1 orange pixel out of 544** — there was no
  orange to invert. The new run *adds* orange as a signature colour, consistently
  (shipped 0.2% orange, new anchor 10.2%, new idle 10.6%, new walk 12.1%), and
  `trace.py` forces it via the "signature-color rescue" toward `#ff9032`.

- **Recipe:** juggernautXL at 768, CFG 3.5, chunky-proportion prompt on bipeds
  only. Chosen over CFG 7 (noisy) and 1024 (thin).

- **Staging only.** Everything lands in `D:\tmp\sprite-stage-0822`. Shipped art
  under `public/themes/swampspace/chars` is untouched and must stay that way
  until he reviews.

## Fixed: white speckle on the walk cycle

Merged to `origin/main` as `24f12d8` (PR #63). Rollback ref:
**`pre-roto-edgebleed-backup`** (a name, not a SHA — a SHA goes stale).

- **Symptom:** 3–15 near-white pixels per frame, all exactly `#f2f6ea`, in
  different places each frame, so they sparkled.
- **Cause:** `prep_white` composites onto pure white; `post_frame` keyed it out
  **geometrically only**. Diffusion paints the background *inward past the
  silhouette*, so those pixels carry Blender alpha 255 and survive the
  `alpha>100` mask. k-centroid then averages a 1–2px white rim into every edge
  pixel and the palette lock snaps it to `#f2f6ea`.
- **Fix:** `GEN_BG` constant + `unmix_bg` (AA rim) + `debleed` (full-res, before
  any resampling). Edge speckle **278 → 0**; silhouette byte-identical 40/40.
- **The first attempt was a no-op** with byte-identical output, caught only by
  measuring. Measure, do not assume.
- **Only the rotoscoped walk path had this.** The cast *idles* measured 0% edge
  speckle — their near-whites are interior highlights. Do not "fix" the idles.
- `temporal_smooth()` was the pre-existing guard for this exact sparkle and it
  **has never fired**: it only repairs a pixel when both temporal neighbours
  match *exactly*, and diffusion re-shades every frame. Still unfixed.

## Two traps that have each cost a run

1. **A sweep launched as a child of the agent session dies with the agent.**
   That is what killed the 2026-08-22 run at 20:38Z — the log ends mid-seed with
   no error, ~90s after the agent went quiet, and `autopost.log` is 0 bytes. It
   was *not* the host crash, which came 4 hours later. **Launch detached**
   (`Start-Process`), never as a child of your turn.

2. **ComfyUI started without `--models-directory` sees ZERO models** and rejects
   every job with HTTP 400 (`Value not in list: ... not in []`). It looks like a
   broken workflow, not a broken launch. **Always start it with
   `D:\tools\comfy\scripts\start.ps1`**, which passes
   `--models-directory D:\comfyshared\ComfyModels`. Verify with
   `/object_info/CheckpointLoaderSimple` — a healthy instance shows ~76
   checkpoints, not 0.

## Where the run is

Resume chain: `D:\tmp\sprite-stage-0822\tools\resume-chain.sh` (detached).
It is **idempotent** — `cast.py` skips anything already in
`cast/data/picks.json`, so re-running never redoes finished work.

Phases, in order: `idles` → `dirs` (the 5 facings) → `steps` → `deliver.py`.

**Live state — read these, do not trust this paragraph:**

| what | where |
|---|---|
| picks so far | `D:\tmp\sprite-stage-0822\cast\picks\` (one PNG per character) |
| authoritative state | `D:\tmp\sprite-stage-0822\cast\data\picks.json` |
| idles log | `cast-idles3.log` |
| facings log | `cast-dirs.log` |
| steps log | `cast-steps.log` |
| chain log | `resume-chain.log` |
| walk frames (fixed) | `D:\tmp\sprite-stage-0822\roto\out\` — 40 files, done |

As of this writing: **12 of 12 idles picked, every character at 8/8 seeds**
(96 candidates, verified per character rather than by total — 96 could have
hidden a gap, and frog-settler and carapace-brute had both previously been
marked done on incomplete 5-of-8 sets).

**One known defect survives:** cinder-husk anchors its feet at row **43**
while the other eleven sit at **45**, so it floats. Regenerate it with the
feet anchored before shipping it.

**Still not generated at all:** the four non-south facings and step frames
for the whole cast. That remains the biggest gap.

## THE RECIPE THAT WORKED — use this, not the narrative

Attempts one and two died. Attempt three finished the whole cast in **289
seconds** of generation. The difference was entirely procedural, so it is
written here as steps rather than as a story:

1. **Check for an orphan run first.** Enumerate by command line, not by the pid
   you remember. Two runs were live earlier tonight; one was an orphan whose
   parent had died hours before and which nobody had noticed.
2. **Unload the VLM, then confirm with `nvidia-smi` that VRAM is actually free.**
   Do not trust the unload call — `ollama` reloaded a model on its own during
   this very check. `qwen3-vl:8b` holds **20.4 of 24 GiB** and drags SDXL from
   0.5 s/step to **775 s/step**, which errors nowhere and reads as a hang.
3. **Generate with the VLM OFF** (`--no-vlm`). Generation must never share the
   card with the thing that judges it.
4. **Gate in a SEPARATE pass, after generation has drained.** This is the whole
   fix for the deadlock, and it costs nothing: gating 12 characters took ~6 min
   on its own.
5. **Launch detached** (`Start-Process`), never as a child of an agent turn.
6. **Let the state file do the resuming.** `cast.py` skips anything already in
   `picks.json` and skips seeds whose `px` file exists, so a re-run costs only
   the missing work. To force a top-up, delete that character's entry.
7. **Watch artefact counts, not the process list.** Progress is files appearing.
   A live process proves nothing — that is exactly how eight minutes of stall
   looked healthy.
8. **Post each character to the thread as it lands**, with the character name as
   the `alt`. A count is not a picture.

## If you are picking this up after a crash

1. `curl -s localhost:8188/system_stats` — if it fails, run
   `D:\tools\comfy\scripts\start.ps1`, then confirm it sees ~76 checkpoints.
2. Re-launch `resume-chain.sh` **detached**. It skips finished work.
3. Tell him in `mt4qiusd-3tptl0`, with images, not prose. He reads on a phone.
4. Do not speak to the Echo (port 12020) at night — it is in his bedroom.
