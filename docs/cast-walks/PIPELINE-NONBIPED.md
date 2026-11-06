# Pipeline for non-biped bodies and non-walk actions

Aaron (2026-11-05): "Have a subagent come up with a pipeline for non-bipedal characters, and for animations
that aren't just walking." This file is that design. It is grounded in this repo's code at `5f801b3f` and in
the cast-walk run's measurements in `/mnt/d/tmp/cast-walks/PROGRESS.md`. Every rule in `PROTOCOL.md` still
holds: real locomotion (13), frozen gates (14), designs shown before long renders (6), no dense-depth look,
lore and `CRITIC.md` hard rejects.

## The result in one table

| body plan | cast | motion source | status of the route |
|---|---|---|---|
| many legs | mireclaw-stalker, mireclaw-alpha | periodic rig, stick skeleton, Wan 2.2 Fun-Control | proven: stalker seams .07-.14 in all 5 directions |
| quadruped | carapace-brute, gloam-hound | rig + Fun-Control (`rig_quadruped.py`); Wan I2V where a direction already loops | proven on one direction: brute e trot, seam .103 |
| flyer | spore-drone | rig of a limb stroke (power stroke, recovery) + Fun-Control; never a free Wan hover | not run |
| stationary spawner | hive-spire (speed 0) | idle from Wan `pulse` (closed loop); actions as one-shots | idle not run; speed 0 is the only rule-13 exemption |
| pod or crawler | brood-sac | root-leg crawl from a many-leg rig with a wave gait | not run; needs a design Aaron sees first |
| mechanical biped | derelict-bot | biped route (Wan I2V, skeleton fallback) | same as the shipped humanoids |
| biped carrying a load | spore-mortar | biped route; ne and se from the biped skeleton rig | in progress (`58099a6a`) |
| actions on any body | all | rig one-shot clip (anticipation-free strike, hurt, death) + Fun-Control, cut to 3-6 frames | engine changes first; see below |

## What the engine draws today

The renderer already has the states. No theme ships frames for any of them except idle and walk.

| fact | where |
|---|---|
| States: `idle walk attack hurt roll death`. Loops: `idle`, `walk`. The rest are one-shots that hold their last frame. | `src/render/animState.ts` `ANIM_STATES`, `LOOP_STATES` |
| Key grammar: `char.<kind>.<dir>-<state>-<n>`, `<n>` 0-7, contiguous from 0. Five drawn directions, west mirrored. | `animState.ts` `MAX_ANIM_FRAMES`, `docs/themes.md` "Sprite keys" |
| A missing state borrows frame 0 of the next state in its chain: attack to walk to idle, hurt to idle, death to hurt to idle. | `animState.ts` `STATE_FALLBACK` |
| Shipped keys in `swampspace-hires`: idle 105, step 105, walk 360. Attack, hurt, roll and death: 0. | `public/themes/swampspace-hires/manifest.json` |
| Theme cadence override: `"anim": {"walk": 4}`. It is per theme and per state, not per kind. | same manifest; `theme.ts` `resolveAnimTpf` |
| Attack starts when `combat.cooldown` rises between frames, which is the tick the swing lands or the shot fires. | `src/render/sprites.ts` (render-derived attack signal) |
| Hurt starts at `status.hitFlashUntil - 3`. Death plays on a ghost after the entity leaves the snapshot. | `animState.ts` `resolveAnimState`, `sprites.ts` death ghosts |
| Procedural motion always adds a lunge (attack), a decaying shudder (hurt) and a 90-degree topple with fade (death). A drawn loop switches off only the idle and walk cycles. | `src/render/motion.ts` `composeMotion`, `drawnCycle` |
| Locomotion styles by art kind: `spore-drone` and `gloom-lurker` hover, `brood-sac` pulses, `sporeling-mite` waddles. Everything else strides. | `motion.ts` `LOCOMOTION` |

The windows cap how many frames a player sees. `STATE_TICKS` is attack 6, hurt 8 and death 18 ticks at 30
ticks per second. With `DEFAULT_TPF` (attack 2, hurt 3, death 5) the player sees 3 attack frames, 3 hurt
frames and 4 death frames. An 8-frame attack clip shows its first 3 frames and drops the rest.

### Engine changes the actions need

These are renderer changes unless marked. None is made here.

1. **Per-kind state windows.** Read the one-shot window from the clip: `frames x tpf`, clamped to a
   per-state maximum, in place of the fixed `STATE_TICKS`. A heavy brute strike and a sporeling nip cannot share
   6 ticks. Touches `resolveAnimState` and `animFrame` in `animState.ts`.
2. **A drawn one-shot switches off its procedural twin.** When a pack draws `death`, keep the fade and drop the
   topple. When it draws `attack`, scale the lunge down. Two falls on one body read as a glitch. Extend the
   `drawnCycle` flag in `motion.ts` to one-shots.
3. **Event-driven attack starts.** The lobber never sets `combat.cooldown`; its shell comes from `lob()` in
   `src/game/systems/groups.ts`, which pushes `{type: 'lob', entityId}`. Map the sim events to a state start
   in the renderer's event pass: `lob` to attack (lobber), `hiveSpawn` and `hiveSpread` to attack or a new
   `spawn` state (hive-spire, keyed on `byId`), `aiGoal` with `goal: 'summon'` (mireclaw-alpha), `packRage`
   (gloam-hound howl; it carries `groupId`, so every member starts).
4. **A `wake` one-shot state.** `dormancy.ts` pushes `{type: 'woke', entityId, by}` for brood-sac and
   gloom-lurker. Add `wake` to `ANIM_STATES` (fallback `wake` to `idle`), and draw a dormant idle under the
   existing `idle` key for a dormant entity, or add a `dormant` loop state.
5. **Wind-up needs the sim (sim change).** The attack signal is the tick damage lands, so the renderer cannot
   show anticipation before it. A visible wind-up needs a telegraph field the sim sets before it fires, for
   example `ai.windupUntil`. Until then, attack clips start at the strike.

## One pipeline, one rig per body plan

Every body plan below runs the same five steps. Each step reads files and writes files, skips its work when its
output already exists, and is safe to rerun after a crash.

1. **Keyframe.** One Qwen-Image-Edit still per direction from the shipped s-idle (`spritesheet.video_graph`'s
   keyframe band). The design does not change. A new pose that changes the design is a rule 6 showing.
2. **Rig.** A pure-Python periodic rig writes `joints-NN.json` for one cycle, posed on the keyframe in the Wan
   clip's 848x480 pixels. Frame P equals frame 0 by construction. Files: `rig_biped.py`, `rig_quadruped.py`
   (new), and the Blender `rig_multileg.py --mode skeleton`.
3. **Control.** `skeleton.py` draws the joints as OpenPose-style sticks on black. `--ref` writes
   `overlay-00.png`; look at it before any GPU time.
4. **Render.** `fun_control.py --glob 'skel-*.png'` drives Wan 2.2 Fun-Control A14B with the keyframe as
   `ref_image`. About 2-4 minutes per direction on the 4090. Take `GPU-WAN.lock`, `/free`, release.
5. **Cut, post, gate.** `cast_walk.py assemble --take <dir>=<run>`, `export`, `gate`. The loop finder sees a
   clip that repeats every P frames.

Why the skeleton and not depth: dense depth carried the proxy's tube legs and smooth dome into the art, and
Aaron vetoed that look ("looks terrible", `research/sprite-routes.md` A7). The stick skeleton carries leg phase
and foot placement and nothing of the surface, so the keyframe supplies the look.

### Many legs (mireclaw-stalker, mireclaw-alpha)

| item | rule |
|---|---|
| why not Wan I2V | Wan steps each leg at its own phase. Stalker best seams 1.15-2.70 on 3 takes (09-29); the carapace looped (.27-.32) and the legs did not (.49-1.78). |
| motion source | `rig_multileg.py --mode skeleton`, alternating tetrapod (L1 R2 L3 R4, then the other four), P16 |
| measured | stalker skeleton Fun-Control: s .143, se .100, e .105, ne .071, n .097-.129 (`art/stalker-skeleton-1104`, `3c6ed50f`, `143b3f2a`) |
| loop and timing | P16 in the clip, cut to 8 frames, theme walk tpf 4: one cycle in 32 ticks |
| alpha | Keep the shipped alpha design (Aaron, 11-05: "much worse", design C00001 rejected). Rig its 8 legs on the same gait; the two claws stay raised and sway with the body. |
| gates | 1, 2, 3, 4b, 5, 6, 6b pass on the stalker. 4a fails n only (below). |

### Quadruped (carapace-brute, gloam-hound)

| item | rule |
|---|---|
| why the rig first | Free Wan is a coin toss on four legs. Gloam-hound take 1 (`trot`) looped s .329, ne .425, n .595 and missed se .711, e 1.252 (PROGRESS 19:38). The rig looped brute e at .103 on the first take and .101 on the second. |
| motion source | `rig_quadruped.py --gait trot`: diagonal pairs (near-fore with far-hind), duty 0.5, body dip twice a cycle. `--gait walk` is the four-beat walk for a heavy body (duty 0.7, not yet run). Keyframes come from `keyframe_probe.py`. |
| posture | The rig's fit is the target posture, not a trace. A level spine and legs under the shoulders and hips make a runner. A crouch on the keyframe and a straight leg in the rig fight each other; set the rig to the keyframe's posture unless Aaron asked for a new pose. |
| loop and timing | P16, half stride 40 px and lift 28 px at 848x480 (brute e). Cut to 8 frames at theme walk tpf 4. |
| gates | No gate has misjudged a quadruped yet. |

### Flyer (spore-drone)

| item | rule |
|---|---|
| why not Wan | 7 takes, 3 motions, parked (QUEUE 05:40): free limbs never repeat (se 1.09-2.16); a rigid bob keeps no rhythm (se .757); first = last frame did not come home (s 1.30, e 2.20). |
| rule 13 | A bob is not flight. The drone has a dome and four hanging arms and no wings, so its gait is a swim stroke: the arms sweep back together (power stroke, 40% of the cycle) and reach forward folded (recovery, 60%). The dome pitches forward 5-8 degrees and rises 6-10 px on the power stroke. |
| motion source | A periodic rig of that stroke (four 3-joint arms on a dome axis), skeleton control, Fun-Control. The rig is `rig_multileg.py` with legs that never touch ground; or a 60-line pure-Python rig like `rig_quadruped.py`. |
| engine | Keep `hover` in `LOCOMOTION`. A drawn walk loop sets `drawnCycle`, which already switches off the procedural float for walk; the float stays on for idle. |
| gates | Gate 3 checks the foot line on canvas-2. A flyer's lowest pixel is an arm tip, so the check holds if every frame keeps the arm tips on that line in export. Not measured. |

### Stationary spawner (hive-spire)

| item | rule |
|---|---|
| locomotion | Speed 0 (`npcs.ts` `hivespire`). The renderer never requests walk. The only rule-13 exemption. |
| idle | Wan `--motion pulse` (closed loop, first = last frame), measured against a forward take before trusting it (RUNBOOK lessons, spore-drone). |
| actions | lash (attack, from `fireWeapon` when a body is in reach), bud (`hiveSpawn`), spread (`hiveSpread`). Each needs engine change 3. |
| motion source for actions | A one-shot rig is overkill for a rigid spire. Use the rigid-parts route: cut the s-idle into 2-3 layers (base, shaft, crown) and keyframe them in Python (squash 6%, crown opens, a bud swells and drops). |
| gates | The walk gates do not apply to an idle-only kind. Gate scope for idle-only kinds is a rule 14 question for Aaron, not a worker's call. |

### Pod or crawler (brood-sac)

| item | rule |
|---|---|
| rule 13 | Speed 3.0 once woken. A pulse is not locomotion (PROTOCOL 13: "hatch legs / crawl / roll"). |
| design | The sac already stands on a root mat. Make the roots its legs: six to eight root-tendrils that reach, plant and drag the sac forward in a wave from back to front. That is a design change (pose and limbs), so Aaron sees it first (rule 6). |
| motion source | `rig_multileg.py --mode skeleton` with a metachronal wave (each leg 1/N of a cycle behind the next) in place of the tetrapod gait, body rocking 3-4 degrees with each wave. |
| actions | `wake` (the sac splits and the roots unfold): engine change 4. |

### Actions on any body: attack, hurt, death, lob

The motion source is the same rig, posed through a one-shot, then rendered as a loop so Fun-Control and the loop
finder still work. Build the action as a closed cycle that starts and ends on the idle pose (idle, strike,
recover, idle), render P16, and cut the frames after the loop is found. The clip's first frame then matches the
idle, so the cut between walk and attack does not jump.

| action | frames shipped | content per frame (contact-first, because the attack signal is the tick of contact) | tpf to show all |
|---|---|---|---|
| melee attack | 4 | strike extreme with a 1-2 px smear, follow-through, recoil, settle | 1-2 (engine change 1 for 2) |
| ranged or lob | 4 | recoil at release (body back 2-3 px, muzzle or pod up), hold, return, settle | 1-2 |
| hurt | 3 | snap away from the hit (head and body 2-3 px back), hold, return | 2-3 |
| death | 6 | buckle, legs give, body down, flat, flat with the colour knocked one value down, last frame held | 3 (engine change 2) |
| wake or spawn | 6 | closed, crack, open, rise, settle, idle | 3 (engine change 4) |

Reading at 96 px:

- Move the silhouette, not the interior. A frame that changes only shading inside the outline vanishes at
  96 px. The strike frame must change the bounding box by 4 px or more.
- One extreme pose per action, held two ticks. The eye reads the extreme and fills in the rest.
- Keep the s-idle palette (gate 6b). A white hit flash comes from the engine (`hitFlashUntil`), so hurt frames
  carry no flash of their own.
- Mirror-safe: draw e, se and ne facing right, as the walk does.

Gates for actions: none exist. The walk gates assume a loop (gate 1) and a gait (gate 5 boil). Before any action
ships, the coordinator takes a gate scope proposal for one-shots to Aaron (rule 14). Until then, an action clip
is gated by colour (2, 6b), silhouette height (3) and identity (4b same, 6 style), which run per frame.

## Gate 4a and symmetric rear views

Gate 4a asks the VLM whether each frame shows front, back or side, against the character's own s-idle and
n-idle, and it requires ne and n to show no face. The case:
`/mnt/d/tmp/cast-walks/gate-case-stalker-n-2026-11-05.md`.

- Symptom: on the stalker's n view, 3-6 of 10 n frames read `toward-viewer` or `na`. The rest of the same loop
  passes. Five runs: asm3 3 fails, asm4 3, asm5 5, asm6 (rear-mark keyframe, small spinnerets) 6, asm7
  (broad chevrons, `5f36bc79`) 2.
- The verdict follows the leg phase: byte-identical frames get the same verdict, and adjacent frames of one
  loop get opposite ones.
- Every other gated character passes 4a on n (bellwether, cinder-husk, gloom-lurker, sporeling-mite on G7).
  Each has a hood, cloak, tank or pack on its back. None is a radially symmetric dome on eight legs.

What the case lacks for a rule 14 entry: a control on accepted art. GATE-CHANGES rule 2 says "our new character
fails it" is not evidence. The evidence that would be: run 4a on a known-good many-legged back view (approved
art, not ours) and show the same phase-following scatter. No such art exists in the cast. No gate change is
proposed here.

How art avoids the failure, in order of cost:

1. Give the back a cue no front has: a tail, a spike, a raised crest that ends in a point at the rear, a pale
   mark on the abdomen tip. Make it at least 6 px at 96 px and outside the leg cloud, so leg phase cannot hide
   it. On the stalker, small pale spinnerets (kf-n4 seed 3) still failed 6 of 10 n frames. Broad chevrons
   (seed 1004) cut the fails to 2 of 10, but the n frames came out .237-.254 heavier than the s-idle, and gate 3
   fails mass above .22. Add the cue inside the existing silhouette, not as new mass.
2. Tilt the body: the abdomen higher than the head on n, so the rear fills the top of the silhouette.
3. Design every new symmetric body with a front-back asymmetry at Step 0 (rule 6 showing). The alpha's raised
   claws give its n view a cue the stalker's does not have.

## Proof: carapace-brute trot from a rig

The riskiest claim in this design is that a hand-posed quadruped rig, drawn as sticks, makes Fun-Control draw a
four-legged gait on an existing design, and that the clip loops. One direction (e) was run once, on 2026-11-05.
Gloam-hound was the first target; the coordinator moved it back to its own worker, so the proof uses
carapace-brute, which no worker had started.

| step | what ran | result |
|---|---|---|
| keyframe | `keyframe_probe.py` on the shipped `carapace-brute-s-idle.png`, pose "standing on all four legs ... back level", seeds 3, 11, 23, 1004 | 4 of 4 on-model side views; seed 3 picked (shell over head and shoulders, flank plate, four separate legs, tail) |
| rig | `rig_quadruped.py examples/quadruped-fit-carapace-brute-e.json --period 16 --stride 40 --lift 28 --gait trot` | 16 skeleton frames; `overlay-00.png` lines up with the keyframe's legs |
| render | `fun_control.py --glob 'skel-*.png'`, the motion sentence in `examples/moves-quadruped-trot.txt`, seeds 3 and 11 | 81 frames each; GPU 20:29-20:35, about 6 minutes for both |
| post | `spritesheet.py repack --period 12:64 --size 96 --content 92 --palette-from carapace-brute-s-idle.png` | loop P16, seam .103 (seed 3) and .101 (seed 11), against the gate 1 limit of .5 |

Measured on seed 3 (`loop_measure.py`, `gait_measure.py`):

| number | seed 3 | gate 5 limit or reference |
|---|---|---|
| seam at the pick, whole frame | .103 | gate 1: .5 |
| seam, legs only | .110 | stalker on free Wan: .49-1.78 |
| identity drift | .058 | .12 |
| head drift | .030 | .14 |
| boil | .197 | .3 |
| sharpness | 835 | 60 minimum |
| coverage jitter | .030 | .1 |
| foot lift (first harmonic) | 4.8 px | shipped sporeling-mite e: 4.74 px |
| leg phase coherence `phase_R` | .063 | near 0 = legs in different phases (a gait); sporeling-mite waddle .763 |

By eye, frame by frame at 5x: each foreleg lifts, folds and reaches forward in turn (frames 0-1 one side, 4-5
the other), the hind legs swap behind them, the shell and plate keep their shape, and the head stays steady.

Links: [3x GIF](https://2cb.pw/carapace-brute-trot-3x-6d1bff),
[96 px GIF](https://2cb.pw/carapace-brute-trot-96-8fef94),
[3x with the floor scrolling under it](https://2cb.pw/carapace-brute-trot-travel-3x-6f0303),
[8 frames at 3x](https://2cb.pw/carapace-brute-trot-frames-3x-15420b),
[rig overlay and skeleton](https://2cb.pw/carapace-brute-trot-rig-3e67e8).
Files: `/mnt/d/tmp/cast-walks/pipeline-1105/` (`kf/`, `rig/`, `fc-brute-e-s3/post/`).

Shortfalls of the proof:

- White backdrop shows through the gaps between the legs in 4 of 8 frames (13-46 white pixels a frame).
  `spritesheet.pocket_px` returns 0 for this kind, because its anchor is more than `POCKET_PALE` (1%) pale from
  the bone shell. The GIFs clear white below row 60 (`tools/gifs.py` `unpocket`); `export` would not. Fix at
  the root before a ship: key pockets only in the leg band, or measure the pale share without the shell.
- The hind legs are dark and stocky, so their swap reads less than the forelegs' at 96 px.
- One direction. s, se, ne and n need their own fits; ne and n also need the rear-view rules above.
- Not exported, not gated. Gates 2, 3, 4, 6 and 6b did not run.

## What this design did not verify

- The flyer stroke, the brood-sac root crawl and the hive-spire rigid-parts actions. No GPU ran for them.
- Any action clip. The frame counts and the cadence table come from `animState.ts`, not from a render.
- The engine changes. They are read from the code; none is written or tested.
- Whether gate 3's foot line holds for a flyer, and whether gate 4a misjudges any body plan other than the
  many-legged n view.
- Gloam-hound's crouch. The coordinator withdrew it ("the gait complaint was about a humanoid").
- The `rig_quadruped.py --gait walk` four-beat gait. Only the trot ran.
