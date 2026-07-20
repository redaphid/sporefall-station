# Stadia aim bug — ROOT CAUSE FOUND (aim ignored while standing still)

Live-diagnosed 2026-07-19, build 267+ (main pulled mid-session), user on a Stadia
pad. TL;DR: **the Stadia aim axes are read CORRECTLY (no sign flip, no swap, no
wrong index). The real bug is in `hostSession.mergeCmd`: a gamepad's aim is only
applied while the LEFT (move) stick is deflected. Standing still, aim is dropped
and the gun stays pointed where it last was** — so lining up a stationary shot
does nothing and the player "misses constantly."

## Controller identity (ground truth)
`navigator.getGamepads()[0]`: `id = "Unknown Gamepad (STANDARD GAMEPAD Vendor:
18d1 Product: 9400)"` (Google / Stadia), `mapping = "standard"`, 4 axes,
`axes` rest at `[0,0,0,0]`. Fire = button **7** (R2, analog value 1.0) confirmed
live. Right-stick magnitude reads slightly over-unity (~1.0-1.11) on deflection.

## The diagnostic tables (raw axes -> computed facing)

### A. While MOVING (left stick deflected): aim tracks correctly
`facing` = `atan2(aimY,aimX)`; recovered the computed aim angle from the player's
`facing`. Across 13 sampled directions, facing ≈ raw right-stick angle:

| raw right-stick angle | facing | move mag |
|---|---|---|
| -2.93 | -2.93 | 1.07 |
| -2.79 | -2.82 | 1.05 |
|  0.05 |  0.06 | 1.09 |
|  0.77 |  0.77 | 1.07 |
|  0.82 |  0.82 | 1.10 |
|  2.86 |  2.74 | 1.00 |
|  2.95 |  2.90 | 1.00 |

No inversion, no swap, no wrong index. (A few mid-sweep samples lag by ~1 tick.)

### B. While STATIONARY (move stick centered): aim is DEAD
Move mag ~0, right stick fully deflected (~1.1). `facing` frozen, 0/12 frames
followed the aim:

| raw right-stick angle | facing | move mag | aim mag | follows? |
|---|---|---|---|---|
| -1.82 | 1.78 | 0.00 | 1.03 | NO |
| -1.90 | 1.79 | 0.00 | 1.06 | NO |
| -2.04 | 1.79 | 0.00 | 1.11 | NO |
| -2.05 | 1.79 | 0.00 | 1.11 | NO |

Facing is stuck at whatever it was last set to (1.79). The aim stick, though fully
deflected, has zero effect. This is the bug the user feels.

## Which of (a)-(e)? NONE of the axis/sign hypotheses.
Not (a) aimX sign, not (b) aimY sign, not (c) X/Y swap, not (d) wrong axis index,
not (e) quadrant/deadzone. Table A proves the axes/signs are right. The break is
gated on **movement**, which points at the input MERGE, not the pad profile.

## Root cause — exact code path
1. `src/input/readPad.ts` reads the Stadia pad on `aimAxes: [2,3]` (STANDARD
   profile, `padProfile.ts`) — correct; aimX/aimY = raw right stick.
2. `src/input/gamepadCoop.ts:130` `selectAim(move, aim)` correctly returns the aim
   stick when its magnitude > `AIM_DEADZONE` (0.15). So the pad's `cmd.aimX/aimY`
   carry the true aim even when stationary. Good so far.
3. `src/app/hostSession.ts`:
   - line 91: `this.inputs.set(0, this.localInput.sample())` — slot 0 gets the
     LOCAL keyboard/touch cmd first (all-zero when idle).
   - line 98: the pad's cmd for slot 0 is folded in as
     `mergeCmd(existing_local, padCmd)`.
   - line 20 **`mergeCmd`**:
     ```ts
     const useB = Math.hypot(b.moveX, b.moveY) > Math.hypot(a.moveX, a.moveY)
     ...
     aimX: useB ? b.aimX : a.aimX,   // <-- AIM chosen by MOVE magnitude
     aimY: useB ? b.aimY : a.aimY,
     ```
   When stationary, `padCmd.move = 0` is NOT greater than the idle local cmd's
   `0`, so `useB = false` and the merge takes the LOCAL (keyboard/touch) aim,
   which is `0` -> `cmd.aimX/aimY = 0` -> `movement.ts:115` `if(hypot(aim)>0.01)`
   is false -> **facing untouched**. Move the left stick and `useB` flips true, so
   the pad's aim is taken and aiming springs back to life. Exactly the A vs B split.

The pad shares slot 0 with the always-present local input source (keyboard in the
browser, touch on the phone), so this fires for EVERY solo gamepad player — it is
not Stadia-specific, though the Stadia user hit it. Movement (left stick) is NOT
affected: move fields are also chosen by `useB`, which is the move comparison, so
move works; only aim is mis-gated.

## Proposed fix (precise, minimal)
Decouple aim selection from move magnitude in `hostSession.mergeCmd` — pick each
vector by its OWN magnitude:
```ts
const mergeCmd = (a: InputCmd, b: InputCmd): InputCmd => {
  const useBmove = Math.hypot(b.moveX, b.moveY) > Math.hypot(a.moveX, a.moveY)
  const useBaim  = Math.hypot(b.aimX,  b.aimY)  > Math.hypot(a.aimX,  a.aimY)
  return {
    seq: a.seq,
    moveX: useBmove ? b.moveX : a.moveX,
    moveY: useBmove ? b.moveY : a.moveY,
    aimX:  useBaim  ? b.aimX  : a.aimX,
    aimY:  useBaim  ? b.aimY  : a.aimY,
    attack: a.attack || b.attack,
    interact: a.interact || b.interact,
    special: a.special || b.special,
    hotbar: b.hotbar >= 0 ? b.hotbar : a.hotbar,
    throwItem: a.throwItem || b.throwItem,
    roll: a.roll || b.roll,
  }
}
```
Now a stationary pad's deflected aim (mag ~1.1) beats the idle local input's zero
aim and reaches `facing`. Generalizes to all pads; not pad-gated. Add a regression
test: merge(localIdle, padAimOnly) must yield the pad's aim.

Secondary (independent) polish, from the same captures:
- Clamp consumed aim magnitude to 1.0 (Stadia reports >1 on diagonals; angle is
  fine, but any magnitude consumer should `Math.min(1, mag)`).
- ~1-tick facing lag on fast sweeps (minor smoothing) — see `aiming.md`.

## "It's sometimes INVERTED" — same bug, not a sign flip
The user reports aim occasionally feels inverted. Tested directly by classifying
every aim-active frame as match / Y-flip (`facing≈-raw`) / X-flip (`facing≈π-raw`)
/ 180 (`facing≈raw+π`):

- **Both sticks active (aim guaranteed live): 381/381 frames MATCH. Zero flips of
  any kind.** A true wiring inversion would corrupt these too — it doesn't.
- The only "flip"-looking frames occur when the move stick is centered or barely
  deflected: there, `facing` is FROZEN at a stale heading (bug above) while the aim
  stick sweeps elsewhere. When the stale heading happens to be roughly opposite the
  new aim (common — players reverse to shoot back the way they came), the gun looks
  "inverted/backwards." It snaps correct the instant they move.

So the inverted feel is the SAME stationary-freeze bug wearing a different mask,
NOT an axis sign/index inversion. **The `mergeCmd` fix resolves both symptoms.**
No pad-gated sign correction is needed (and would be wrong — it'd break the 381
correct frames). If any true inversion is still reported AFTER the mergeCmd fix,
re-run this classifier while moving; expect it to stay 100% match.

## User confirmed the trigger
The user independently confirmed: "Maybe it happens when I'm not moving with the
left stick, but I'm still aiming?" — exactly the reproduced condition (move stick
centered, aim stick deflected => facing frozen). This nails the diagnosis.

## Movement stick — unaffected
Left-stick movement worked throughout (intent tracked the move stick; player
walked in the pushed direction). No drift observed at rest (axes rest at 0).
