# Sporefall Station — bugs & anomalies observed (live)

Corroborating observations from live play. Details in the topical notes.

---

## 1. Gamepad aim ignored while standing still (HIGH) -> `stadia-aim.md`
Reproducible live: move stick centered + aim stick fully deflected => `facing`
frozen (0/12 frames followed aim). While moving, aim tracks perfectly. Root cause:
`src/app/hostSession.ts` `mergeCmd` selects the aim vector by MOVE magnitude, so a
stationary pad loses to the idle local input's zero aim. Fix: select aim by aim
magnitude. This is the user's "I miss constantly." Not a Stadia axis/sign bug —
axes read correctly (mapping `standard`, aimAxes [2,3]).

## 2. StunGun infinite stunlock (HIGH) -> `stunlock.md`
`stunGun`: `electrified` 45 ticks on a 24-tick cooldown; re-hits refresh the
expiry. 24 < 45 => one stunGun enemy chain-locks the player with zero free ticks.
No stack cap / diminishing returns / post-stun immunity. Even civilians can roll a
stunGun.

## 3. Idle/solo player swarmed and downed fast; alarm stays 0 (MED)
An unattended player was pursued and downed by ~tick 2600. Notably the **alarm
level stayed 0** through a sustained beating ON the player — attacks against the
player don't raise the city alarm. Downed state: `playerCtl.downed
{bleedTicks,reviveProgress}`, `revivesLeft:2`, `gameOver:false`. Solo has no
teammate to revive, so a down is a slow bleed-out (is self-revive intended?).

## 4. Aim magnitude reads over-unity (LOW)
Stadia sticks report `hypot(axes) up to ~1.11` on diagonals. Angle unaffected;
clamp to 1.0 wherever aim magnitude is consumed (reticle distance, any scaling).

## 5. Facing lags aim by ~1 tick on fast sweeps (LOW)
Minor smoothing; flick shots land slightly behind during a stick sweep.

## 6. "Skittish" civilian turned aggressor with a stunGun (LOW / behavior)
NPC id 1, faction `civ`, behavior `skittish`, went `ai.mode:aggro` and attacked
the player with a stunGun. Skittish civilians fleeing is expected; a skittish civ
actively hunting + stun-locking the player reads odd. Worth checking the
behavior/goal selection (`ai.ts`) for civ + ranged-stun weapon.

## 7. (Dev workflow, not a game bug) pulling main mid-session resets the run
`git pull` -> Vite HMR/full reload -> world regenerates, player id changes. See
observation-log caveat.
