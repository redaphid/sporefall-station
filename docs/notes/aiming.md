# Aiming — live investigation (user reports missing a lot)

> **UPDATE / ROOT CAUSE FOUND — see `stadia-aim.md`.** Further live capture pinned
> the real bug: a gamepad's aim is dropped while the player stands still, because
> `hostSession.mergeCmd` selects the aim vector by MOVE magnitude. Aim works while
> moving, dies when stationary. Findings A/B below were captured before this was
> isolated (A = the "moving" case where aim worked; B's "recenter fallback" idea
> was superseded — the true trigger is stationary, not recenter). Keep the
> continuous-`facing`/no-8-way and over-unity-magnitude findings; they hold.

Captured live from the user's Stadia-controlled session via `navigator.getGamepads()`
+ `world.byId.get(playerId)` polling, 2026-07-19, floor 1, build 267.
Player id 86, weapon pistol.

## How aim/fire actually works (source)
- `src/game/systems/combat.ts` `spawnProjectile` (line ~229): a bullet spawns as
  a real entity `kind:'projectile'` with `angle = owner.facing + angleOffset`,
  `vel = (cos angle, sin angle) * speed`. **Continuous angle** — bullets travel
  exactly along `facing`. No 8-way quantization anywhere in the sim fire path.
- So the "bullets go in 8 directions" symptom is NOT in `facing` or projectile
  spawn (both continuous — see data below). If it's real it must be in the
  RENDERER (e.g. an 8-directional weapon/muzzle sprite) or already fixed. Flagged
  for the render layer, not the sim.

## What the live data shows
### Finding A — facing DOES follow the aim (right) stick when it's deflected
Sampling frames where the right-stick magnitude ~1.0, `facing` tracks the aim
angle, clearly diverging from the move angle. Representative frames (aimMag≈1.0):

| tick | facing | aimAng | moveAng |
|---|---|---|---|
| 6472 | 0.326 | 0.326 | 0.780 |
| 6491 | 0.008 | -0.024 | 0.224 |
| 6499 | -0.239 | -0.239 | 0.031 |
| 6510 | -0.421 | -0.421 | -0.039 |

`facing ≈ aimAng` (within ~0.02-0.04), NOT `moveAng`. So the core twin-stick aim
mapping is correct: right stick aims.

### Finding B — when the aim stick is CENTERED, facing falls back to the MOVE stick
First capture (aim stick at [0,0]): `facing = -1.399` = exactly the move-stick
angle (`atan2(axes[1],axes[0])`), intent = left-stick vector.

This is the likely miss culprit in run-and-gun: the moment the user lets the aim
stick recenter (even briefly), the gun **snaps to the walking direction**. If they
fire a fraction of a second after releasing aim — or fire while relying on the
"aim = where I'm walking" fallback — the bullet leaves along movement heading, not
where the last aim pointed. On a Stadia pad the right stick recenters fast, so
this fallback fires constantly during movement. Feels like "I aimed there but the
shot went where I was running."

### Finding C — facing lags the aim stick by ~1 tick (smoothing)
`facing` trails `aimAng` by roughly one sample as the stick sweeps (e.g. t6476:
aimAng 0.326 but facing still 0.319 from the prior tick; t6481 similar). A small
turn-rate / smoothing on facing. Fast flick shots land slightly behind the target
during a sweep. Minor vs B, but compounds on quick target switches.

### Finding D — Stadia sticks report OVER-UNITY magnitude (up to ~1.1)
Right-stick `hypot(axes[2],axes[3])` read **1.01-1.09**; move stick up to 1.11.
The pad's raw axes exceed the unit circle on diagonals. Angle (atan2) is
unaffected, so aim direction is fine, but any code that uses aim *magnitude* (e.g.
aim deadzone as `mag>threshold`, or scaling) sees >1 and should clamp. Worth a
`Math.min(1, mag)` where magnitude is consumed.

## Hypotheses for "I miss a lot" (ranked)
1. **Aim-fallback-to-move (Finding B)** — biggest. Releasing/recentering the aim
   stick swings the gun to the movement heading; shots during that window miss.
2. **No aim-assist / snap** — pure analog aim at ranged targets is hard; a small
   aim-magnetism toward the nearest enemy within the facing arc would help a lot
   on a controller.
3. **Facing smoothing lag (Finding C)** — flick shots trail by ~1 tick.
4. **No target leading** — pistol projectile speed 14; moving targets need lead;
   AI/player both fire straight at current facing.

## Proposed fixes (for a follow-up branch)
- **Sticky aim**: when the aim stick recenters, HOLD the last aim heading for a
  short window (e.g. 15-20 ticks) instead of instantly snapping facing to the move
  vector. Only fall back to move-direction aim after the hold expires. This
  directly fixes Finding B without removing the "walk = aim" convenience.
- Optional light **aim-assist**: bend `facing` a few degrees toward the nearest
  live enemy inside the aim arc when firing.
- Clamp consumed aim magnitude to 1.0 (Finding D).
- Reduce/remove the facing smoothing when the aim stick is actively deflected
  (Finding C) so held aim is 1:1.

## Still to capture
No projectiles observed yet (user wasn't firing during capture windows;
`kind:'projectile'` entities are short-lived). Need a firing window to record
projectile `velAng` vs `facing` at spawn and confirm bullets == facing in-flight,
and to catch any actual multi-direction spray (shotgun `pellets:5, spread:0.5`
is the only intentional spread weapon).
