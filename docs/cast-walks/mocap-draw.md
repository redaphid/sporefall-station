# Motion-capture draw (R&D, then the shipped player draw, 2026-11-06)

Owner ask: a pistol draw with the fluid feel of Flashback (Amiga), which was rotoscoped from filmed
actors. This note covers the route, the numbers and the verdict against the hand-keyed `rig_action.py`
draw. Branch `rnd/mocap-draw-1106` (from `ship/actions-1106`). Work dir `/mnt/d/tmp/cast-walks/mocap/`.

## Route

| step | tool | what it did |
|---|---|---|
| actor still | `rotoscope/mocap_ref.py still` (Z-Image Turbo, 8 steps, 848x480) | 4 seeds of a man in profile facing right with a hip holster. Picked s23 (holster visible on the near hip). |
| reference motion | `mocap_ref.py video` (Wan 2.2 I2V A14B Q4 + lightx2v 4-step, 81 f @16 fps) | Seeds 3 and 11 both gave a real draw: the elbow goes back to the holster, the gun comes out low, the arm snaps level, the body leans back against it, holds, lowers, holsters. About 2x slow motion. Took about 2.5 min per clip warm. |
| pose | `mocap_ref.py pose` (comfyui_controlnet_aux `DWPreprocessor` + `SavePoseKpsAsJsonFile`, already installed in ComfyUI) | 81/81 frames with a person in both clips. |
| retarget | `rotoscope/mocap_rig.py` | Writes `joints-NN.json` in the same layout as `rig_action.py`. Window 4:78 at `--speed 2` gives 37 capture frames plus 2 lead frames, so P39. Scale 1.07. |
| render | `fun_control.py` with the cast_action settings (Fun-Control A14B, seed 3, shift 8, 4 steps, `describe.txt` + a draw sentence) | 81 frames, about 1.5 min warm. |
| post | `cast_action.py post --props --idle-ends` on `runs/vine-ranger/best-pal` | 96 + 48 px, palette-locked, pistol painted at the fist. |
| compare | `rotoscope/compare_actions.py` | A 4x strip plus 1x/3x GIFs at the engine cadence (67 ms per frame). |

How `mocap_rig.py` retargets: each fit bone is turned by the angle that the actor's matching bone has
turned since the window's first frame. The character keeps its own proportions, and a bone that does not
turn stays at the fit (the shipped idle). The pelvis moves by the actor's displacement times the height
ratio. The ankles are pinned and the knees solved by IK, so the feet do not slide. The drift between the
first and last frame is spread across the window, so the clip opens and closes exactly on the fit. The far
arm follows the torso and ignores the actor's far arm: in profile DWPose put both wrists on the pistol
for the whole aim. `unswap()` fixes left/right label flips by continuity. Before the clip is resampled
in time, a 3-tap median and a Gaussian (sigma 0.8 frames) clean the keypoints.

Keys come from the motion itself:
- **grab:** the hand's furthest reach back before the aim.
- **aim / hold:** the first and last frames within 5% of full reach.
- **home:** the hand back within 0.1 height of its rest position.

The pistol prop is out strictly between grab and home. `picks` spends frames in proportion to the
distance the hand and head travel: the snap gets frames and the held aim gets few. All five keys are
always kept.

Hand travel per rig frame (px at 848x480) traces a real ease curve:
- grab: 6, 19, 23, 22
- snap: 12, 32, 48, 60, 60, 59, 50, 34, 19
- hold: 1-4
- return: 9, 19, 34, 45, 61, 62, 48, 32, 19
- settle: 14, 7, 3

The hand-keyed rig moves between five keys with smoothstep.

## Results (player, `e`, Fun-Control seed 3)

| take | frames | source clip picks | consistency |
|---|---|---|---|
| hand-keyed (`rig_action.py draw`, P16) | 8 | fc-hand-e-s3: 32,36,38,40,42,43,46,48 (the drowner's e picks) | - |
| mocap, 8-frame cut | 8 | fc-mocap-e-s3: 2,11,17,19,28,33,35,39 | 0 violations |
| mocap, full | 14 | fc-mocap-e-s3: 2,7,11,14,15,17,18,19,28,30,32,33,35,39 | - |

- Zoom (4x, idle at both ends): https://2cb.pw/player-draw-hand-vs-mocap-zoom-ce73a8
- Strip 4x: https://2cb.pw/player-draw-hand-vs-mocap-strip4x-ab03c4
- GIF 1x: https://2cb.pw/player-draw-hand-vs-mocap-1x-3790b9
- GIF 3x: https://2cb.pw/player-draw-hand-vs-mocap-3x-aee7fb
- Reference actor clip (every 3rd frame): https://2cb.pw/mocap-ref-actor-draw-d614bf
- Fun-Control render, all 81 frames: https://2cb.pw/mocap-fc-raw-81f-a195b3

## Verdict (90s sprite-artist read)

Mocap wins on motion. The hand-keyed draw reads as a pose-to-pose switch: hand at the hip, then the arm
is straight out in the next frame, then back. It has no arc, and the body does not react.

The mocap take has the three things Flashback had:
- **Anticipation:** the elbow cocks back and the torso twists toward the camera as the hand reaches the
  holster.
- **Arc and snap:** the gun comes out muzzle-down and swings up to level over three frames.
- **Follow-through and settle:** the lowering mirrors the draw with the muzzle down, and the arm eases
  back to rest.

The braid and vest move with the body. At 1x the twist and the cocked elbow read clearly. The
8-frame cut keeps the grab, the snap and the return, but it loses the cocked-elbow anticipation frame.
The 14-frame clip is the one that feels like Flashback.

Weak spots shared by both takes (the pipeline, not mocap):
- The painted pistol reads as a dark stub in the level aim at 96 px. It reads well pointing down.
- The shipped `e-idle` has brown trousers. Every Fun-Control frame and the shipped `e-walk` have
  blue-grey ones, so the cut into and out of the clip flips the trouser colour.

## Wired on this branch

`char.player.e-draw-0..7` in both packs: the mocap 8-frame cut, `e` only.
- **The game never shows it yet:** `animTracker.ts` starts `draw` on `ai.mode` becoming aggro, and the
  player has no AI. The player needs a trigger, such as on first fire after holstering.
- **14 frames need `MAX_ANIM_FRAMES` raised:** it is 8 in `animState.ts` and is shared by every state.
  The draw window is `'clip'`, so a longer clip plays whole. `PISTOL_DRAW_TICKS` (16) still decides when
  an NPC's first shot fires.

## Making mocap the default route for actions

1. `mocap_ref.py` + `mocap_rig.py` are already the lever. Per action the only manual input is the
   window (`--window a:b`) and `--speed`. Both can be automated from the hand-speed curve: the first
   and last frames above rest jitter.
2. A take library: keep good reference clips plus `kps.json` per action (draw, hurt, fidget, attack)
   under `/mnt/d/tmp/cast-walks/mocap/ref/`. Every humanoid can reuse them without GPU time for the
   reference.
3. Other views: the 2D per-bone turn is exact only for the view the actor was filmed in. For
   s/se/ne/n, film the actor from that view (Wan I2V from a still at that angle), or lift to 3D.
4. Fix the two shared weak spots: draw a stronger pistol prop, and snap the action colours to the
   shipped idle's own trouser colours.
5. Engine: a player draw trigger, and `MAX_ANIM_FRAMES` 16 for one-shot clips.

## Shipped: the player's quickdraw (`feat/player-draw-1106`)

Owner notes this round, 11-06: the draw looked "lazy, not urgent, and limp"; "the mocap weapon draw
sprite also makes the character's face disappear at the end"; the trousers flip from the idle's brown to
blue-grey; the gun must be the Rivet Driver; "the motion can crouch a bit ... or brace against the weapon
recoil".

### Engine

- The player draws when its gun comes up: the render-side edge of `isAiming` (first seen armed, a swap
  to a gun or between guns, a revive, a finished lockpick or draft), at least 30 ticks after it went down.
  A stun, sleep, freeze or shock pauses the edge. A step or a shot ends the clip. No wire change; a co-op
  client runs the same rule on the host's aim verdict. `src/render/animTracker.ts` `trackPlayerDraw`,
  tests in `src/render/playerDraw.test.ts`.
- `MAX_ANIM_FRAMES` is 16. The clip ends IN the aim pose and hands into `aim`.
- Per-frame timing: the manifest's `animTiming` (`"player.draw": [ticks per frame]`), the window is the
  sum. Lookup walks `@<weapon>` then `@<weapon class>` then the generic key (`src/render/weaponVariant.ts`),
  the reserved seam for per-weapon draws, aims and braces (`docs/themes.md` "Weapon variants").

### Route (e)

| step | tool | settings |
|---|---|---|
| reference | `mocap_ref.py video` from the profile still s23, `ship/prompts.py` quickdraw prompt | 4 seeds; ranked by `mocap_pick.py` (frames from the holster to full reach, peak hand speed); s11 won: peak 0.074 body heights a frame vs 0.051 for the R&D take |
| keypoints | `mocap_ref.py pose` | per-run prefix (a reused `clip-sN` prefix read an old run's keypoints) |
| retarget | `mocap_rig.py --end aim --plan quick --ant 4 --plant --dip-max .07 --travel .3 --lean .45` | the actor up to the first full reach lands exactly on `rig_action aim` (the pose the `aim` loop holds); then a one-frame overshoot (hands 3% of height above level), a settle and the braced aim |
| weapon | `aim_keyframe.py paint` (Qwen edit, the Rivet Driver design `weapons/lore/pistol-ref.png` as image 2) | the e aim keyframe holding the Rivet Driver is the Fun-Control reference |
| render | `fun_control.py` seed 3, `ship/moves-draw.txt` | the idle keyframe as the reference draws a plain silver pistol; the Rivet Driver keyframe carries the gun |
| post | `cast_action.py post --no-paint --snap-idle --own-colours --idle-start` | 14 frames, both packs |

Timing (`--plan quick`): rest 1 tick, four anticipation frames 1 tick each (weight drops, knees bend, the
elbow cocks back to the hip), the grab held 2, three snap frames and the reach at 1 tick each, the
overshoot 1, the settle 2 and 3, the braced aim 4: 21 ticks. From the hand leaving the holster to full
reach: 4 ticks (0.13 s) against 10 ticks (0.33 s) for the R&D cut at the uniform 2-tick cadence.

### Lessons (each one fixed at the root, each one a gate)

- **The face did not disappear in the render; the key ate it.** Fun-Control draws the skin lighter than
  the palette's skin, (255,212,179) against (216,168,120). `unmix` reads that as a faint blend of the
  palette skin and the white backdrop, so the backdrop flood crossed the profile face and keyed it out
  (the raw frames show the face in every frame). `cast_action.py post --own-colours` adds the colours the
  video model renders the character in (median cut of the base run's raw idle) to the ghost key's own
  colours. `rotoscope/action_checks.py face` gates every frame: under 60% of the idle's skin in the head
  box, or the skin on the other side of the head, fails a face view; skin appearing fails a back view.
  `post --face-strict` exits non-zero. `--pin-head` (default) also keeps the skeleton's head on the torso:
  a nodding head is never the reason a face goes.
- **Trouser drift:** `action_checks.py snap` (and `post --snap-idle`) learns a colour map from the clip's
  rest frame against the shipped idle, pixel by pixel after registration, above and below the belt, and
  maps unseen shades into the idle's band family by luminance. Proven on the R&D take: blue-grey to brown
  in every frame. Limit: it learns from the rest frame, so a take whose rest frame already matches and that
  drifts later (seed 11) is not fixed; pick another seed or learn from a second frame.
- **Generated actors lunge and kneel into a quickdraw** whatever the prompt says. `--plant` keeps the feet,
  `--dip-max` caps the drop (front views .035: a 2D knee bend reads as a sideways knee), `--lean` keeps a
  share of the torso pitch and the limbs keep their angle to the torso.
- **Front and back views** reach toward or away from the camera: `mocap_pick.py` finds grab and reach from
  the wrist's distance from the hip plus its height; pass them as `mocap_rig.py --keys grab:reach`.

### Library

`/mnt/d/tmp/cast-walks/mocap/library/draw/<view>/`: the actor stills, the Wan clips (`clip-sN/`), the
DWPose keypoints (`clip-sN-kps.json`) and drawn poses, and `urgency.json` (mocap_pick's ranking). Any
humanoid retargets them with its own `fit-<view>.json` and no GPU for the reference.
