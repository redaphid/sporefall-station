# aim / aimwalk art: resume note (wound down 2026-11-06 17:15)

Branch `art/aim-1106` (worktree ~/Worktrees/sporefall-station/aim-art-1106), engine `feat/aim-anims-1106` merged in.
Gun = the roster's **Rivet Driver** (ref `/mnt/d/tmp/cast-walks/weapons/lore/pistol-ref-onwhite.png`). Owner rule: no
hand-drawn guns in frames; the gun comes from generation (block proxy only in the Qwen paint-over).

Route (tools on the branch, `scripts/assets/rotoscope/`): `rig_action.py aim|aimwalk` (two-handed grip; se/ne yaw +-26 so the
barrel is 45 deg on screen; aimwalk = rig_biped P24 stride 55) -> `aim_keyframe.py paint` (rivet-driver block proxy painted
over the walk keyframe, Qwen-Image-Edit + ref as image 2 -> aim keyframe) -> `fun_control.py` (ref = aim keyframe, skeleton
control) -> `cast_action.py post --no-paint --palette-add rivet sprites [--breathe]` -> `aim_pick.py` -> `aim_sheet.py`.
Batch scripts: `aim-batch/` (copies of /mnt/d/tmp/cast-walks/aim/*.sh). Run GPU only via `scripts/gpu/gpu-run`.

## State per character / facing
| | s | se | e | ne | n |
|---|---|---|---|---|---|
| player kf (Qwen) | s3/s11/s23 good | s23 picked (gun points right, ok) | good | s23 picked | BAD: hands up (prompt fixed c8bb06fb, not rerun) |
| player FC | aim + aimwalk t1 s3 | aim + aimwalk t1 s3 | aim + aimwalk t1 s3 | not rendered (killed) | not rendered |
| player post | aim (40,40 +breathe), aimwalk 27..48 step 3 (seam .008) -> `player/stage` | - | - | - | - |
| drowner kf | s11 picked, good | s3 picked | s3 good | s11 ok | idle-like (rerun with new prompt) |
| drowner FC | - | - | - | - | - |

Nothing exported to the packs yet; no manifest keys, CURATION, release note, preview or in-game clip yet.

## Open issues (seen at 4x on `player/sheets/player-s-aim-aimwalk-4x-crop.png`)
- The Rivet Driver's pale-green charge cylinder snaps to orange/red: add the green to the palette (e.g. the weapon's glow
  colour or a locked-34 green) via `--palette-add`, then re-post.
- Player trousers come back with mottled brown blotches vs the shipped dark trousers (style drift from the FC render);
  check the legs boil in the GIF; consider snapping to the s-idle palette only (no rivet colours) below the belt.
- se/ne keyframes hold the gun pointing right rather than at 45 deg; check the FC frames by eye.

## Next commands
```sh
A=/mnt/d/tmp/cast-walks/aim
# 1. GPU (one batch): n keyframes with the fixed prompt + FC for the missing views
~/Projects/sporefall-station/scripts/gpu/gpu-run --label "aim: n kf + FC rest" -- bash -c \
  "$A/n-batch.sh && $A/fc.sh 'player ne pick 3 t1' 'drowner s pick 3 t1' 'drowner se pick 3 t1' 'drowner e pick 3 t1' 'drowner ne pick 3 t1'"
# 2. CPU per view: post aim, scan aimwalk, pick, post aimwalk, stage, sheet
$A/post.sh player se aim $A/player/fc-t1-aim-se-s3 40,40 $A/player/post-aim-se --breathe
$A/post.sh player se scan $A/player/fc-t1-aimwalk-se-s3 $(seq -s, 9 80) $A/player/scan-se
python3 scripts/assets/rotoscope/aim_pick.py $A/player/scan-se --kind vine-ranger --dir se --period 24 --first 9
# 3. export: cast_action.py export <post dir> --kind vine-ranger --state aim|aimwalk (both packs, keys char.player.*)
```
