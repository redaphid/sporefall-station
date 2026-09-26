# Sprite cast runbook: animating a character

This runbook covers one character, from its curated `s-idle` anchor to a 5-direction walk
(idle, step, walk-0..7) in both theme packs. The recipe is committed data, so every step can be
rerun and every result can be regenerated bit for bit. `frog-settler` is the worked example: it
was the first character through this pipeline, and it is the reference for everything below.

| what | where |
|---|---|
| the tool | `scripts/assets/cast/cast.py` (WSL `python3`) |
| its Windows half | `scripts/assets/cast/engine_runner.py` (run by `cast.py` under the v2a venv) |
| exporter + manifest merge | `scripts/assets/cast/pack.py` |
| one character | `scripts/assets/cast/<char>/`: `recipe.json`, `keyframes/<dir>.{png,json}`, `atlas/<dir>.{png,json}` |
| the engine | `D:\projects\puck-sprites` (`/mnt/d/projects/puck-sprites`, GitHub `redaphid/puck-sprites`). Read its `README.md`. **Never edit it.** |
| scratch | `$CAST_STAGE/<char>/` (default `/mnt/d/tmp/sporefall-cast/<char>/`). It is not committed. |

```
anchor ─sweep─> keyframe candidates ─pick─> keyframes/<d>.png ─walk─> 81 Wan frames
      ─cut─> premat + video2atlas ─cut --pin─> atlas/<d>.png ─export─> both packs + manifests ─gate─> verdict
```

## 1. Infra checks

```sh
python3 scripts/assets/cast/cast.py doctor [CHAR]
```

| check | pass looks like | if it fails |
|---|---|---|
| engine at the pinned commit, clean modulo CRLF | `HEAD ceaedf16...`, recipe pin `ok` | Check out the pinned commit. The local diff in puck-sprites is CRLF-only (`git diff HEAD --ignore-cr-at-eol --stat` is empty). Do not "fix" it by editing. |
| v2a venv | `numpy 2.5.3, Pillow 12.3.0` (as pinned in the recipe) | Restore it from the engine's `requirements.txt`. Drift breaks bit-identity. |
| ComfyUI | `comfyui 0.37.0 os=win32 queue=0` on **8188** | Start the Windows ComfyUI. **Never use 8189**, which is a different workspace. |
| Ollama | `qwen3-vl:8b present` | `ollama pull qwen3-vl:8b` |
| commit charge | `cd /mnt/d/projects/puck-sprites && $V scripts/guard.py` shows it below 156 GB | Wait. A Wan job peaks at 137-155 GB, and `animate.py` aborts over the guard. |

- **One GPU job at a time.** The runner waits until `localhost:8188/queue` is empty before it submits.
- **Ollama models on the GPU can slow Wan about 10x.** `animate.py` prints a note when they are resident. The frog ran at 8.4-11.2 s/it with `qwen3:4b-instruct` and `bge-m3` resident, so measure before you blame Ollama. **Unloading Ollama is the user's call.**

## 2. Two runtimes

| runtime | runs | why |
|---|---|---|
| WSL `python3` | `cast.py`, `pack.py`, `post.to_palette`, `verify.py`, `consistency.py`, `manifest.char_keys` | the repo side |
| `V=/mnt/c/Users/hypnodroid/.venvs/v2a/Scripts/python.exe` with `D:/` paths | `engine_runner.py` (Qwen, Wan, keyframe normaliser) and the engine's `premat.py` and `video2atlas.py` | bit-identical output depends on its pinned numpy and Pillow |

`cast.py` handles the switch. You never call `$V` yourself, except for `guard.py`.

**The engine pin.** Every engine step (sweep, pick, walk, cut, rebuild) first checks that
puck-sprites `HEAD` equals `recipe.engine.commit`, that tracked files are clean modulo CRLF, and
that nothing is untracked. On failure it stops with `ENGINE PIN CHECK FAILED`. This is the check
that `docs/sprite-pipeline-wan.md` §7 asks for: a pipeline that the repo does not pin is folklore.

## 3. The verbs, in order

Every verb is safe to rerun. Finished work carries a key over its inputs (`cast-key.json`, or the
`key` in `gen.json`) and is skipped. Outputs are written to `.partial` paths and renamed when
complete. After a crash, run the same command again.

| # | command | does | output |
|---|---|---|---|
| 1 | `cast.py init CHAR --who "a stocky green frog villager wearing a brown hooded cloak and a scarf"` | Writes `recipe.json`: the engine pin (current HEAD, ComfyUI version, both runtimes) and prompt templates marked `TODO`. The archetype must already be in `generate.CHARS`. | `cast/<char>/recipe.json` |
| 2 | edit `recipe.json` | Rewrite every `TODO` prompt for this character. Verbs refuse to run while a prompt contains `TODO`. | |
| 3 | `cast.py sweep CHAR s --seeds 3 11 12` | Makes Qwen-Image-Edit 2511 keyframe candidates from `keyframes.dirs.s` (prompt, `p1`/`p2`) with graph K3-front, then writes a contact sheet. About 5-30 s per seed. | `stage/sweep/s/s<seed>/{raw,<char>-s-white,...-alpha}.png`, `contact.png` |
| 4 | `cast.py pick CHAR s 12` | Normalises the `-alpha.png` to 540 px of content on a 1280x720 white canvas. Commits the result plus its provenance (seed, prompt, inputs, Qwen graph), and records the pick in the recipe. | `keyframes/s.png`, `keyframes/s.json` |
| 5 | repeat 3-4 for `se`, `e` and `n` (inputs `s`/`s`), then for `ne` (inputs **`n`/`n`**) | | |
| 6 | `cast.py walk CHAR` | Makes one Wan 2.2 I2V clip per direction (graph `L`, seed 3, 81 frames, 848x480) from the committed keyframe. The first clip takes about 200 s cold, the rest 65-235 s. Prints each clip's pixel digest. | `stage/clips/<d>/walkL-s3/frames/` |
| 7 | `cast.py cut CHAR` | Runs `premat.py --shrink 1` (a border-connected white matte), then `video2atlas.py` with the shared and per-direction args. Prints the loop start, period and seam. | `stage/atlas/<d>/{atlas,contact}.png`, `preview_x4.gif`, `report.json` |
| 8 | look, then `cast.py cut CHAR --pin` | Commits each row and records its loop and clip digest in the recipe. | `atlas/<d>.png`, `atlas/<d>.json` |
| 9 | `cast.py export CHAR` | CPU only. Cuts each row into 10 frames per direction for `swampspace-hires` (96 px, content 92) and `swampspace` (48 px, content 46). Sets the `char.<arch>.*` manifest keys surgically. `--check` compares without writing. | `public/themes/*/chars/<char>-*`, both `manifest.json` |
| 10 | `cast.py gate CHAR` | Runs `consistency.py <char> --check`, a qwen3-vl facing check on every frame, and identity checks against `s-idle`. | verdict and `stage/gate-vlm.json` |
| 11 | `cast.py rebuild CHAR --check` | Regenerates walk, cut and export from the committed recipe into `stage/rebuild/<key>/`, then compares: the clip digests with the recipe, the rows with `atlas/`, and the PNGs with the packs. Takes about 10-15 min on the GPU. | MATCH or MISMATCH per direction |
| - | `cast.py status CHAR` / `cast.py selftest` | Shows what is pinned per direction. `selftest` runs the CPU tests (13, about 2 s). | |

Real output (frog, `cut`):

```
s: loop start 24 period 45 seam 0.422 (cells from frames [24, 30, 35, 41, 46, 52, 58, 63])
ne: loop start 19 period 54 seam 0.429 (cells from frames [19, 26, 33, 39, 46, 53, 59, 66])
```

**Adopting a run made elsewhere** (this is how the frog came in):
`pick CHAR DIR SEED --from <candidate dir> --p1 REF --p2 REF` takes an existing Qwen candidate
directory, and `cut CHAR --clips <root> --pin` cuts from `<root>/<d>/walkL-s3/frames`. REF is
`anchor`, a direction, or `file:PATH`.

## 4. Where the art judgement sits

Everything else is mechanical. These four decisions are yours, and you make them by eye at full
size, never from a metric alone.

| decision | look at | accept when |
|---|---|---|
| **prompts** (step 2) | the anchor, `scripts/assets/anchors/<char>-s-idle.png` | Every phrase describes this character. The walk prompt names what should move (legs, cloak), and the back views say that no face shows. |
| **keyframe look** (step 4) | `contact.png`, then each `-white.png` at full size | It is the same design as the anchor. It faces the right way (e/se/ne face **right**) and stands upright with both feet visible. The margins are wide and nothing touches an edge. |
| **loop choice** (step 8) | `stage/atlas/<d>/preview_x4.gif`, `contact.png`, and the `loop_curve` in `report.json` | The period is a **full** stride: the same foot leads at both ends. A seam under 1.0 means the seam is smoother than an ordinary frame step. |
| **gate failures** (step 10) | the failing frame | Report it verbatim. **Do not regenerate art to make a gate pass.** A gate that fails on good art is a finding. |

## 5. Traps the frog run paid for

| trap | rule |
|---|---|
| NE took three tries. A rear-quarter keyframe derived from the front view gave a clip that turned around, or a featureless sack. | Derive `ne` from the working **rear** view: `p1 = p2 = "n"`. The walk prompt adds "He never turns around ...". |
| The loop search prefers a half period, because swapped legs share a silhouette. A repeated half stride reads as a limp. | Cut a **full** stride with `--min-period` (30 for s/se/e/n, 40 for the frog's ne). Check that the printed period is about 38-54 frames, not about 19-27. |
| The engine mirrors e/se/ne to draw the west half (`src/render/anim.ts` `DRAWN`). | Keep designs close to bilaterally symmetric. A one-sided detail swaps sides when the character turns west. |
| A chroma key punches holes in pale regions, such as a cream chest or a light cloak. | Use premat's border-connected white matte (`--shrink 1`, the recipe default) and never a key. `export` inpaints the few backdrop-white specks that survive (frog: 0-355 px per row). |
| The silhouette spec was measured on a character that no longer existed (the bare-headed frog). | When the design changes, **re-anchor** `consistency-spec.json` with `consistency.py --write-spec <char>=<frame>`, choosing the frame whose build sits on the median of the pose frames (frog: `se-idle`). Never loosen tolerances. |
| AnythingXL composes busy anime scenes. | For any SDXL step (an anchor redraw, for example), use **juggernautXL, never AnythingXL**. Where cyber-puck docs and Sporefall docs disagree, cyber-puck wins. |
| Art written only to the base pack is shadowed: the game loads `swampspace-hires`. | Export always writes **both** packs: `swampspace-hires` is the pack the game loads, and `swampspace` is the pack the silhouette harness reads. `export` refuses a recipe that skips the game's default pack. |
| ComfyUI's upload names a file by its basename, so two agents that upload `s.png` overwrite each other's input. | `cast.py` uploads content-addressed copies (`<char>-<ref>-<sha>.png`). Do not upload by hand. |
| Wan frames embed their prompt, timestamped prefix included, in the PNG, so file hashes never match between runs. | Clip digests are over pixels (`frames_digest`). |

## 6. `recipe.json`

| key | holds |
|---|---|
| `engine` | `repo`, `remote`, `commit` (the pin), `comfyui`, `runtime.v2a` and `runtime.wsl` package versions |
| `anchor` | `file` (repo-relative) and `height` (560): the anchor is placed on the 1280x720 white Qwen input |
| `keyframes` | `graph` (`workflows/qwen/K3-front.json`), `height` (540), and `dirs.<d>`: `seed`, `p1`, `p2` (`"anchor"`, a direction, or `{"file": path}`), `prompt`, `sha256` of the committed PNG |
| `walk` | `graph` (`L`), `seed` (3), and `dirs.<d>`: `prompt` (the full text, exactly as it sits in the clip graph), `frames` (81), `frames_sha256` (the pixel digest of the clip that the pinned row was cut from) |
| `cut` | `premat` (`["--shrink","1"]`), shared `args`, and `dirs.<d>`: `args` (`--min-period`) and `loop` (`start`, `period`, `seam`) |
| `export` | `idle` and `step` (walk indices 0 and 4), `despeck`, and `packs` (pack, px, content, resample) |

The frog's pins are s 24+45 (seam 0.42), se 28+38 (0.48), e 27+48 (0.16), ne 19+54 (0.43) and
n 26+45 (0.37).

## 7. Before you open the PR

- [ ] `cast.py export CHAR --check`: all 100 PNGs byte-identical and 0 manifest changes after your export.
- [ ] `cast.py rebuild CHAR --check`: every clip, row and PNG matches. Paste the output into the PR.
- [ ] `cast.py gate CHAR`: paste the output verbatim, failures included.
- [ ] `cast.py selftest`, then `pnpm run build`, `pnpm exec vitest run` and `pnpm run lint`.
- [ ] Commit `cast/<char>/`, both packs' `chars/<char>-*`, both manifests, `consistency-spec.json` if you re-anchored it, and a lineage entry in both `public/themes/*/CURATION.md`.
- [ ] Add a release note (`src/ui/releaseNotes/`), because a new walk is player-visible.

## 8. Re-pinning the engine

Move `recipe.engine.commit` only on purpose. After a re-pin, run `rebuild --check`. When
everything matches, the new engine reproduces the shipped art and the re-pin is safe. When
something mismatches, the recipe no longer describes the shipped art, so either keep the old
pin, or re-cut and re-export and treat the result as new art that needs review. The same
applies to a ComfyUI upgrade (`engine.comfyui`) and to venv drift. `CAST_ALLOW_DRIFT=1`
exists only to make a deliberate new sample.
