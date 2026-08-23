# Character art run — running notes

**This machine crashes.** Twice on 2026-08-22 (21:53Z and 00:41Z), and both times
every agent died mid-flight with no handoff. This file exists so the next agent
can resume **from this file alone**, without the one who wrote it. Update it as
you go, not at the end.

Last updated: **2026-08-23 ~02:00Z** by Artgate2.

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

As of this writing: **6 of 12 idles picked** (vine-ranger, spore-drone,
bog-mutant, mycologist, derelict-bot, frog-settler), mireclaw-stalker rendering.
**Facings and step frames have not started and do not exist** — that is still
the biggest gap, since every non-player currently reuses its front sprite for
all five directions.

## If you are picking this up after a crash

1. `curl -s localhost:8188/system_stats` — if it fails, run
   `D:\tools\comfy\scripts\start.ps1`, then confirm it sees ~76 checkpoints.
2. Re-launch `resume-chain.sh` **detached**. It skips finished work.
3. Tell him in `mt4qiusd-3tptl0`, with images, not prose. He reads on a phone.
4. Do not speak to the Echo (port 12020) at night — it is in his bedroom.
