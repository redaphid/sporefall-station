# Cast walk runbook: one character, anchor to verified beta

Read `PROTOCOL.md` (same folder) for who does what, then this file, then do one character end to end. Log every step in
`/mnt/d/tmp/cast-walks/PROGRESS.md` (one line each: timestamp | char | what | numbers | paths).
Append one bullet to **Lessons log** at the bottom before you stop.

Worked example: **mycologist** (`/mnt/d/tmp/cast-walks/mycologist/`, runs in
`/mnt/d/tmp/cast-walks/runs/mycologist/`).

## Environment

| what | value |
|---|---|
| worktree | `~/Worktrees/sporefall-station/cast-walks`, branch `art/cast-walk-cycles` (push after every commit; never push to `main`) |
| beta branch | `preview/cast-walks` -> workflow `preview-web.yml` -> `https://sporefall.hypnodroid.com/betas/cast-walks/` |
| ComfyUI | `http://127.0.0.1:8188` (Windows, 4090, 0.37.0). Restart: `cd /mnt/d/tools/comfy && powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\tools\comfy\scripts\start.ps1' -Only default -Background`. Healthy = `spritesheet.py doctor` prints `ok` for qwen/sdxl/video. Never use 8189. |
| outputs | ComfyUI writes to `D:\sync\Comfy\sprite-sheet\<kind>\...`; the CLI copies what it needs into the run dir |
| VLM for gates | private Ollama `127.0.0.1:18436`, model `qwen3-vl:8b-instruct` (the plain `qwen3-vl:8b` tag thinks before every answer and made a gate take an hour; `verify.py` defaults to instruct, one vote), store `D:\tmp\cast-walks\ollama-models`. `localhost:11434` is a python gateway that answers HTTP 500; Aaron's own Ollama (11433) is down and has no qwen3-vl. Check: `curl -s localhost:18436/api/tags`. Restart: `powershell.exe -NoProfile -Command "$env:OLLAMA_HOST='127.0.0.1:18436'; $env:OLLAMA_MODELS='D:\tmp\cast-walks\ollama-models'; $env:OLLAMA_KEEP_ALIVE='2m'; Start-Process -FilePath 'D:\tools\ollama\ollama.exe' -ArgumentList 'serve' -WindowStyle Hidden"` (the call may hang the shell; run it with `run_in_background`). Ports 11434-11436 are taken. |
| node | `/usr/bin/node` is broken: `export PATH=~/.local/node22/bin:$PATH` then `corepack pnpm ...` |
| ffmpeg | `~/.local/bin/ffmpeg`, `~/.local/bin/ffprobe` |
| judge metrics | `/mnt/d/Projects/sporefall-art` (`sprites/judge.py`), imported read-only by `cast_walk.py`. That repo is production: never write there. |
| images for Aaron | `2cb file.png anim.gif` (`~/.local/bin/2cb`) prints `https://2cb.pw/<code>` per file, ~20 s each: put those links in PROGRESS.md and your report. For images in a PR body: `corepack pnpm run review:image <file>` |

## Step 0: design check (timebox ~15 min, at most 1 GPU batch)

Sources, in priority order:
1. **Written intent.** `/mnt/d/Projects/sporefall-art/docs/LORE_CHARACTERS.md` is THE character reference: visual grammar G1-G7 (§2), prompt laws L1-L3 (§3), families A-E (§5), Roster 2 (§8). Also `sprites/roster_lore.py` (every echo has a named junk `core`), `docs/LORE_GROUNDING.md` (tone), this repo's `docs/LORE.md` (only the owner-approved lines ~25-62 are canon; everything under line 64 is "NOT canon" proposals) and `docs/swampspace-theme.md`. In the art repo read with `git show HEAD:docs/LORE.md`: the working copy has rejected, auto-generated "Addition:" paragraphs.
2. **Curated shipped art**: `public/themes/swampspace-hires`, both `CURATION.md`, the locked 34 colours in `scripts/assets/palette.py`.
3. **The generated corpus is NOT a style reference.** Aaron ruled most of it bad.

Rules that bite: G1 heirloom gear, re-tailored, quilted liners, stitches, old patches ("the newest thing anyone owns is fifty years old"). G2 tech is bubble plumbing: cages, glass jars, petcocks, coil, hose. G3 muted frame (teal mist, olive, tan/grey decayed tech, yellowed station white, charcoal, bone); essence glow is the ONLY saturated colour, ONE hot accent, one hue. §8.1 amends G3: it rules the lit scene, not costumes, so a costume may carry its trade's colours (hazard paint, sodium orange) inside the locked palette; one muted scheme on every costume is what collapsed roster 1 onto one teal suit. G4 essence stains skin teal. G6/G7 echoes are translucent bubble clusters around ONE opaque junk core. Families: B fauna eat bubbles, inflating bladders; C spore-warped colonists still on shift; D drowned machinery, "purpose without a purpose", one status LED. **Test: "Could this exist in any other swamp?"** The green bog-mutant brute is a "fantasy ogre that happens to be damp" (the Hulk one): a known redesign.

**Not steampunk.** G1/G2 mean salvaged, utilitarian colony gear: worn industrial and lab kit, rubber, canvas, quilted liners, faded safety paint. Brass is a small accent at most. No gears, cogs, clockwork, goggles, filigree, ornate Victoriana, polished copper. Negative prompt always includes: `steampunk, gears, cogs, clockwork, victorian, ornate, filigree`.

**Lore check** (Aaron 09-29: "draw more from the lore"; his dated words are in `PROTOCOL.md` rule 10). A design passes all five before any candidate goes to Aaron. Log answers 1 and 2 in PROGRESS.md and put them in the caption he sees.
1. **Family and hook.** Name the family (§5 A-E) and one line on what only this character does in the colony. Canon uses four of the queue as family anchors (§6): mycologist and bog-mutant for C, derelict-bot for D, spore-drone for E. §5C is written against the green hulk: the warp is asymmetric and partial, it respects the gear it eats, and the person stays legible inside it. The other fourteen have no canon entry: take the role from the archetype's comment in `src/game/data/npcs.ts` and choose the family yourself.
2. **"Could this exist in any other swamp?"** The answer is no, and the reason reads in the outline at 96 px (L3), not only in the name.
3. **Not the archetype id.** `thug`, `cop`, `gangster` and `shopkeeper` are Streets of Rogue leftovers, not briefs (Aaron: "not lore-appropriate names"). `generate.py` briefs `thug` as "a huge hulking swamp mutant brute": that is the Hulk.
4. **No stock weapon in the sprite.** No bat, knife or pistol; the renderer draws the held weapon (`src/render/weaponArt.ts`). A beast holds nothing and bites or claws (Aaron: "dogs shouldn't have knives").
5. **Prompt laws.** Describe shapes, materials and colours; never name a familiar creature or object you do not want drawn literally (L2). Never write "silhouette" in a prompt (LORE_GROUNDING: it renders a black figure). It stays a drawing, never a photo (§8.3). Echoes follow G6, G7 and L1.

Procedure:
1. Read the character's lore entry (lore check 1). Look at its current anchor (below).
2. Passes the lore check? Keep it, log one line, move on. Generic, off-lore, or a known IP (Hulk, Predator, stock orc)? Redesign.
3. Redesign: one lore-grounded prompt (outline shapes, materials, palette colours, one distinctive hook; readable at 96 px; clear primary/secondary shapes; limited palette). ONE batch of 4-8 candidates with a proven still route: juggernautXL (`spritesheet.py ... --method sdxl` graph or `generate.py`), or Qwen-Image for a clean 3/4 front on white. Pick one that passes the lore check; save `old-vs-new.png` in `/mnt/d/tmp/cast-walks/<char>/`; one-line reason in PROGRESS.md; `2cb` it.
4. None clearly better? Keep the old one and say so.
5. Archive the old anchor (never delete): `/mnt/d/tmp/cast-walks/archive/<char>/anchor-<date>/`.
6. The chosen anchor is the colour/style reference for the gates. Record a redesign in the CURATION.md lineage entry.

**Where anchors live.** Use the in-game design, not `scripts/assets/anchors/` (that holds an older July design for most of the cast: the mycologist there is a dark-green hooded coat, the game shows a cream hazmat suit). The shipped hires sprites came from the August r2 cast run; its 768 px matted RGBA anchors are in `D:\tmp\sprite-stage-0822\cast\anchors\<kind>-s-idle.png` (bog-mutant, brood-sac, carapace-brute, cinder-husk, derelict-bot, frog-settler, mireclaw-stalker, mycologist, spore-drone, sporeling-mite, vine-ranger). Confirm it matches `public/themes/swampspace-hires/chars/<kind>-s-idle.png` by eye. Kinds without one (bellwether, blast-diver, bog-mender, drowned-diver, gloam-hound, gloom-lurker, hive-spire, mireclaw-alpha, spore-mortar): use the shipped hires `s-idle` (96 px; `prep_input` upscales it NEAREST) or the Step 0 redesign. Copy the chosen input to `runs/<char>/input-anchor.png` and log its sha256.

## Step 1: video route (the frog's), all 5 directions

```sh
cd ~/Worktrees/sporefall-station/cast-walks
python3 scripts/assets/spritesheet.py doctor   # once per session
setsid nohup python3 -u scripts/assets/spritesheet.py /mnt/d/tmp/cast-walks/runs/<char>/input-anchor.png \
  --method video --name <char> --kind <char> --out /mnt/d/tmp/cast-walks/runs/<char>/take1 \
  --describe "<one line: what it is, colours, gear>" > /mnt/d/tmp/cast-walks/runs/<char>/take1.log 2>&1 < /dev/null & disown
```

- Launch detached (`setsid nohup ... & disown`): a job that is a child of your turn dies with it.
- Five directions take 10-20 min on the 4090 (per direction 95-440 s). Wait with ONE blocking call:
  `until tr '\r' '\n' < LOG | grep -q -E "→|rror|Traceback"; do sleep 30; done; tr '\r' '\n' < LOG | grep -E "loop of|rror|→"` (Bash, long `timeout`).
- It prints each direction's loop: `period`, `start`, `seam`, `candidates`. The CLI picks the loop itself (the shortest full stride, `--period 12:64`). Do not hand-tune periods.
- Retake one direction: add `--dirs n --seeds 11 --out .../take2-n`. **Max 3 takes per direction**, then park it and record why.
- The describe goes into each direction's keyframe and Wan prompt. Face parts in it (eyes, lamps, fangs) draw a face on the back views, and leaving them out redraws the front without one (spore-drone, mireclaw-stalker). Pass the face in `--describe` (s/se/e) and a face-free `--describe-back` (ne/n). Look at every keyframe.
- Non-walkers (hive-spire speed 0; brood-sac and gloom-lurker dormant until woken): still run the full set with `--motion pulse` and note it. Fliers (spore-drone) take `--motion hover`: the keyframe floats and Wan bobs it, limbs trailing. A `--describe` alone cannot change the motion, because the Wan motion sentence (`MOTIONS` in spritesheet.py) comes after it in the prompt; the default `walk` asks for full strides. The game requests walk from displacement only (`src/render/sprites.ts:288`); hive-spire never enters walk.

## Step 2: assemble, export, gate

```sh
python3 scripts/assets/cast_walk.py assemble /mnt/d/tmp/cast-walks/runs/<char>/take1/video-s3 --kind <char> \
  [--take n=/mnt/d/tmp/cast-walks/runs/<char>/take2-n/video-s11] --out /mnt/d/tmp/cast-walks/runs/<char>/best
#   -> best (loops re-found) and best-pal (every frame snapped to its s-idle's colours)
# archive what export replaces (never delete):
A=/mnt/d/tmp/cast-walks/archive/<char>/pre-walk; for p in swampspace-hires swampspace; do mkdir -p $A/$p; cp public/themes/$p/chars/<char>-* $A/$p/; done
python3 scripts/assets/cast_walk.py export /mnt/d/tmp/cast-walks/runs/<char>/best-pal --kind <char>
python3 scripts/assets/consistency.py --write-spec <char>=s-idle   # re-anchor on the NEW s-idle; tolerances unchanged
timeout 3000 python3 -u scripts/assets/cast_walk.py gate /mnt/d/tmp/cast-walks/runs/<char>/best-pal --kind <char> \
  > /mnt/d/tmp/cast-walks/<char>/gate.log 2>&1; cat /mnt/d/tmp/cast-walks/<char>/gate.log
python3 scripts/assets/cast_walk.py sheet x --kind <char>   # contact sheet + GIF beside the frog, 96 px
```

`export` writes 50 frames to each pack (96 px `swampspace-hires`, content 92; 48 px `swampspace`, content 46; feet on canvas-2, the frog's numbers) and sets 50 manifest keys for every archetype already pointing at `chars/<kind>-*`, keeping the file's own indent and key order.

**Gates (`scripts/assets/cast-gate-spec.json`, one command, exit 0 only on all-PASS). They BLOCK shipping.**

| # | gate | threshold |
|---|---|---|
| 1 | loop seam per direction | <= 0.5; n <= 1.0 (`seam_max_dir`, Aaron 2026-09-29) |
| 2 | colour drift vs s-idle | <= 1% of pixels in colours > 40 RGB from every s-idle colour (frog 0.5%, ranger 0.9%) |
| 3 | `consistency.py <kind> --check` | the per-character silhouette spec |
| 4 | `verify.py` per frame: the view against its own s-idle/n-idle (`VIEWS_OK`: e side, n/ne never front, s/se never back) and **ne/n no face**; `--pairs`, `--same` | all ok, on the hi-res pack |
| 5 | judge-sprite-mp4 identity/sharpness/coverage per loop; `boil` (motion-compensated residual / contrast, 16 frames per stride) in place of flicker; head drift | `sprites.judge.GATES`; boil <= 0.3, head_drift <= 0.14 (the frog's shipped loops) |
| 6 | `verify.py --style` vs the frog: rendering only, not colour | all ok |
| 6b | pixels off the locked 34 colours (`palette.py`) | 0 |

The controls every gate must still catch: `python3 scripts/assets/cast_gate_selftest.py` (0 wrong, ~3 min). Run it after any gate change. The full gate takes ~3-4 min.

A failure means a retake (max 3 per direction). **A gate that fails on good art, or any tooling bug, is a finding you FIX (Aaron, 09-29):** take WORKTREE.lock, fix the measurement or script at its root, prove it (test or before/after run), commit + push, and report the finding to the coordinator in one line (symptom, root cause, fix, commit). Never loosen a numeric threshold just to pass.

## Step 3: ship

1. Look at ONE contact sheet (`/mnt/d/tmp/cast-walks/<char>/contact-96-vs-frog-settler.png`). `2cb` it and the GIF.
2. Lineage entry in BOTH `public/themes/swampspace/CURATION.md` and `public/themes/swampspace-hires/CURATION.md` (copy the mycologist's shape: input + sha, takes, loops/seams, colour lock, gate table, parked directions).
3. Release note: `src/ui/releaseNotes/<date>-<char>-walks.ts` (`export default '<one line>'`).
4. Checks: `export PATH=~/.local/node22/bin:$PATH; corepack pnpm exec vitest run src/render/themeManifestSync.test.ts` (the beta workflow runs this and fails the deploy on it).
5. Commit (`art(<char>): ...`) the 100 PNGs, both manifests, `consistency-spec.json`, both CURATION.md, the release note. `git push origin art/cast-walk-cycles`.
6. Deploy: `git push -f origin art/cast-walk-cycles:preview/cast-walks`. Wait: `gh run list --workflow preview-web.yml --branch preview/cast-walks -L 1 --json status,conclusion,headSha` until `completed`/`success` and `headSha` = your HEAD.
7. Verify from the target: `curl -s https://sporefall.hypnodroid.com/betas/cast-walks/themes/swampspace-hires/chars/<char>-e-walk-3.png | sha256sum` equals `sha256sum public/themes/swampspace-hires/chars/<char>-e-walk-3.png`. Log the beta URL, the sha, and the live character list in PROGRESS.md.

## In-game video (Step 3 proof)

Headless Chromium on this box has no GL context (ANGLE `xcb_connect failed`; `--use-angle=swiftshader` closes the page), so record through the headed Windows Chrome already listening on `127.0.0.1:9222`, against a local preview of the build, never the live site:

```sh
export PATH=~/.local/bin:~/.local/node22/bin:$PATH
corepack pnpm exec vite build && (corepack pnpm exec vite preview --port 4917 --strictPort --host 127.0.0.1 &)
BASE_URL=http://127.0.0.1:4917 E2E_CDP=http://127.0.0.1:9222 E2E_OUT=/mnt/d/tmp/cast-walks/<char>/ingame node e2e/feature-<arch>-walk.mjs
```

Template: `e2e/feature-scientist-walk.mjs` on branch `e2e/scientist-walk` (3920a39): 8 of the archetype on a ring, each pacing one compass sector, NPC brains off, speed halved so each leg reads. Look at a still yourself before sending; `2cb` the MP4, a 4 s GIF and a still; save them under `/mnt/d/tmp/cast-walks/<char>/ingame/`. It opens a visible context in Aaron's Chrome while it records.

## Every image carries its flow

- The CLI sends the editor graph as `extra_data.extra_pnginfo.workflow`, so ComfyUI's keyframe PNG and walk MP4 embed `workflow` + `prompt`; they are kept untouched as `raw/<dir>-keyframe-comfy.png` and `raw/<dir>-walk-comfy.mp4`.
- Every post-processed frame in a run, `sheet.png` and the contact sheet get tEXt `prompt` + `workflow` from the run's `flow-<dir>.json`; `repack --to` and `assemble` carry the flows along. The run dirs keep these embedded copies.
- Shipped frames carry their flow too. Each sprite is its own ~26 KB Worker asset, far under the 25 MiB per-file cap; deploy-web's `scripts/check-dist-sizes.mjs` fails on any file in `dist/` over 24 MiB (the OTA zip is the one to watch). `export` also copies each direction's flow to `scripts/assets/flows/cast/<kind>/<dir>.json` (editor graph, drag it into ComfyUI) and `<dir>_api.json` (API prompt), the same pair as the run's `flow-<dir>*.json`, as a backup; `sheet` embeds the flow from there. Frames that lost their text chunks: `python3 scripts/assets/cast_walk.py embed --kind <kind>` writes the pair back as tEXt `prompt` + `workflow` right after IHDR, byte for byte what export shipped.
- Check one of each: a frame `python3 -c "import json;from PIL import Image;print(len(json.loads(Image.open('F.png').info['workflow'])['nodes']))"`; shipped flow `python3 -c "import json;print(len(json.load(open('scripts/assets/flows/cast/K/D.json'))['nodes']))"`; MP4 `~/.local/bin/ffprobe -v error -show_entries format_tags=workflow -of json F.mp4`.

## Gotchas already fixed (commit on `art/cast-walk-cycles`)

| symptom | cause / fix |
|---|---|
| Wan dies: `cutlass_fp16_linear: K mismatch` | missing `ModelComputeDtype bf16` on the GGUF experts (af4acc4) |
| a crashed run leaves 4 prompts on the GPU | CLI now cancels its queued prompts on error/^C (fc96837) |
| Qwen used `qwen_image_2.1_vae_bf16` | VAE detection keeps `qwen_image_vae` (78ac714) |
| editor flows had `null` widgets / lost SaveVideo format | comfy_ui reads 0.37 defaults and dynamic combos (fa8354e) |
| `flows` said "server not reachable" with it up | only real network errors mean offline (aea6512) |
| loops of 2-3 strides (double-speed legs) | 32-frame floor was the frog's gait; now the shortest full stride (68be9f2) |
| `repack --to` rewrote the source run | fixed; `--to` output is repackable (04a6167) |
| visor green in s, cyan in e | `--palette-from` s-idle; assemble does it (50f09da, d118218) |
| `verify.py` printed ok with Ollama down | fails closed: `no VLM answer` (9c518ef) |
| a gate run hung 20+ min | qwen3-vl rambled 7000 tokens; `num_predict 256` (1f0fa8c) |
| a drag-in didn't rebuild the graph | flows embedded everywhere (7fa5255) |
| deploy failed: APK 27 MiB > 25 MiB asset cap | deploy-web drops an APK over 24 MiB (it moves to external hosting); `check-dist-sizes.mjs` fails on any other file over 24 MiB. Frames keep their flows: a brief strip (5f528c4) was undone by `embed` |

Other traps: a clip can turn around late (mycologist n from ~frame 56); the loop search usually avoids it but check the n row. Each direction's keyframe is an independent edit of the input, so colour can drift per direction (gate 2 + palette lock). `anim.walk: 4` plays 8 frames in 32 ticks: one stride per loop is right.

## Token thrift

- One blocking shell call per wait (poll every 30-60 s inside it, long `timeout`), never repeated short checks.
- `grep`/`tail`/`cut -c1-200` everything; never dump JSON or full logs.
- Look at ONE contact sheet per character, not per direction.
- Do not re-read big files (spritesheet.py is 1300 lines; this runbook is enough).

## Lessons log

- **09-29 bog-mutant Step 0** (stopped after batch 1): cloning the r2 raw's embedded graph (`info['prompt']`) and swapping text + seed is the fastest proven still route, but its IPAdapter style ref is the vine-ranger at 0.3, so keep the r2 negatives (`helmet, visor, orange cap, teal suit`): I dropped them and all 6 came back as the player ranger. Put the distinctive hook in the first ~40 words. `2cb` could print a dead link as "exists"; fixed to re-fetch and sha-match every link.
- **09-29 mycologist** (gates): the first full gate failed 4a, 5 and 6 on art that is right. Before changing a gate, run it on the approved frog; it failed gate 5 too, which proved the gate wrong in one step. Two traps in the VLM: `qwen3-vl:8b` is the thinking tag and ignores `think: false` (use `-instruct`), and at temperature 0 extra votes repeat one read. A negative control must be checked by eye first: my first two style negatives were pixel art, and the VLM was right to pass them.
- **09-29 mycologist** (first through): the r2 hazmat design passed Step 0. n failed the 0.5 seam on all three takes (0.79 / 0.56 / 0.91) until Aaron set n to 1.0. The colour gate caught a per-direction visor hue change the silhouette spec cannot see; the s-idle palette lock fixes it but dulls a glow that only the walk frames had.

- **09-29 spore-drone** (parked after 7 takes, 3 motions): a hover clip from Wan (Q4, 4-step) does not loop. Free-swinging limbs never repeat (se 1.087/1.177/2.159, e 1.059/0.662/0.759 vs 0.5); a ping-pong cut is worse (best 1.16-1.91, the limbs never rest when the body turns); a rigid-body bob keeps no steady rhythm (s .914, se .757); first = last frame (`closed`, now hover/pulse's default) did not come home (s 1.302, se 1.529, e 2.201). Next non-walker: measure `closed` against a forward take before trusting it. The describe goes into every direction's keyframe: "lamps under the dome's rim" put the face on the back views (ne/n), and "lamps on the FRONT only" redrew s with two big round eyes; use one describe for s/se/e and a back-view one for ne/n, and look at every keyframe. Fixed on the way: `--motion` (the walk sentence overrode any describe), backdrop pockets a limb encloses (the palette lock hid them from every gate), `assemble --take` repeated flags were last-wins, SIGTERM now cancels a detached run's prompts.

- **09-29 vine-ranger** (player redesign, first through on take1 plus one s retake): prompt weight alone could not place a small prop. Batch 1 ignored the caged jar, and weighting it in batch 2 drew lanterns and cages in place of heads. img2img from the best still, with the braid, jar and patches painted in as crude colour blocks (denoise .50), kept the face and added them. Gate 3 assumed a side view keeps the front's mass: a slim figure in true profile keeps about 60% of it (fed84b6). Release GPU-WAN.lock the moment the last GPU or VLM step ends, not at hand-back (the coordinator had to delete mine), and `/free` ComfyUI after Wan takes, or the VLM gate runs while ComfyUI still holds about 10 GB. `pkill -f <pattern>` inside a Bash call matches that call's own shell and kills it; use the pid from `ss -ltnp` instead.
- **09-29 mireclaw-stalker** (parked, 3 takes on se, 2 on s/e/ne): Wan does not give a many-legged walker a repeating gait. Eight legs step at independent phases, so no loop point exists anywhere in the clip. Best single-frame seam: se 1.51/1.32/1.56, ne 2.00/1.15. The legs fail (.49-1.78) while the carapace loops (s .32, e .27). Before a last take, scan the whole clip for the best reachable seam (`/mnt/d/tmp/cast-walks/mireclaw-stalker/tools/loopscan.py`, `partscan.py` split body/legs): if no (P, s) gets under the gate, a retake on the same premise is wasted. A gait sentence did not help: "steady even rhythm" made every view worse, and a two-group "scuttle" gait made se worse (2.70), so it was removed. Wan does not take gait instructions for many legs. The unpark path is the rotoscope rig (QUEUE.md). A face-free describe redrew s as a faceless dome, which is why `--describe-back` exists (5116d1a).

- **09-29 drowned-diver** (first through on take1 in all five directions, gates 9/9 on the first run, anchor to live in about 30 min): a shipped anchor that fails only lore check 4 (it held a rifle the renderer also draws) is a cleanup, not a redesign. Qwen-Image-Edit removed just the rifle from the NEAREST-upscaled s-idle (4 of 4 seeds clean). Sampling each ~9 px block back onto the 96 px grid and snapping to the s-idle's own colours kept 95% of pixels exact, so the input stays a true 96 px sprite (`/mnt/d/tmp/cast-walks/runs/drowned-diver/step0/ungun.py`, `to96.py`). A hard suit with a tank on the back gives ne/n a strong faceless read from `--describe-back` alone. `git pull`/`push` over ssh twice failed with `Permission denied (publickey)` and worked on an immediate retry: retry once before diagnosing.
- **09-29 blast-diver** (gates 9/9 on the second gate run; se take3, n take3, ne take2): a back view the describe leaves unspecified gets invented gear, and gear centred like a chest piece reads as a front. Qwen drew twin slim tanks on n (the e view had drawn one tank), and the VLM called n FRONT in both reference orders, even passing an n frame as s. Name the back gear in `--describe-back` to match what the side view draws (here one upright tank with hoses into the helmet): n/ne then read back, 0/50. Before calling a 4a failure a misread, re-ask with the references swapped and compare a shipped character's n: an answer that survives both is the art. Gate 4b same counted a front-only saturated visor against every back view; fixed in the prompt (7046bba) with cross-character back negatives. Two traps: `pkill -f <pattern>` killed its own shell again (exit 144), so kill by pid; and same-date release notes sort reverse-alphabetically with 4 shown, so an early-alphabet slug can miss the menu.

## Locks (added 09-29 after the crash; coordinator + one worker share one worktree and one GPU)

- `/mnt/d/tmp/cast-walks/WORKTREE.lock`: whoever's name is in it owns `~/Worktrees/sporefall-station/cast-walks` (export, spec, CURATION, commit, deploy). Absent = free. Take it by writing `<you> | <char> | <time>`; delete it when your commit is pushed. Never edit the worktree while someone else holds it.
- `/mnt/d/tmp/cast-walks/GPU-WAN.lock`: held by anyone running a Wan video run or a VLM gate. Absent = free. SDXL/Qwen still batches (Step 0) may run while it is held.
- **Prefer your own worktree** (09-29: one worker held the shared worktree 50 min and blocked two ships):
  `git -C ~/Projects/sporefall-station worktree add --detach ~/Worktrees/sporefall-station/<kind>-art origin/art/cast-walk-cycles`,
  export/commit there, `git push origin HEAD:art/cast-walk-cycles` (fetch + rebase if rejected). The shared
  cast-walks worktree and WORKTREE.lock are only for work that must happen there; never hold it across a GPU wait.
- **The watchdog auto-releases a stale GPU lock**: `/mnt/d/tmp/cast-walks/gpu-watchdog.sh` (the coordinator runs it) deletes `GPU-WAN.lock` when the GPU has been under 15% for 60 s, ComfyUI is empty and no gate process runs. Release the lock yourself the moment your GPU step ends; do CPU work (assemble, export, loopscan) without it.
- **Wait for the GPU lock, report, then launch as a separate call**, so a coordinator hold can reach you
  before a render starts (09-29: a hold arrived 6 s after a combined wait+launch).
- Wait on a lock with one blocking call: `while [ -e LOCK ]; do sleep 30; done` (long `timeout`).
- Commit and push after EVERY step that changes the worktree (the machine crashes).
