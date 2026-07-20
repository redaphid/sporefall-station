# Sporefall — "The Living Seal" & "Credentials & Power": behavioural proof

Real sim systems, driven deterministically (seed + inputs only). Reproduce with
`pnpm exec tsx scripts/test/sporefall-proof.mts`.

## B — Overgrown hatch, cleared by FIRE (a molotov on the bog)
tick 0: hatch is overgrown(hp 4); player presses E…
  → sealDenied (a bare hand can't part the bog)
tick 0: player lobs a molotov onto the hatch cell — it catches fire.
tick 19: fire eroded the growth → hatch is OPEN.

## B — Overgrown hatch, BREACHED (fast but it ruptures a spore-sac)
tick 0: hatch is overgrown(hp 8), alarm=0. A grenade goes off at the hatch…
  → hatch OPEN; alarm=1; spores at the breach = true.

## A — Keycard biolock (access is a sub-objective: go get the card)
tick 0: biolock is SEALED; player presses E with no card…
  → sealDenied
tick 0: player now HOLDS keycard.north; presses E…
  → sealOpen(keycard); biolock is OPEN.

## A — Power biolock (cut the wing — a systemic trade-off, not a time-tax)
tick 0: biolock is SEALED; wing powered (powerCut={}), alarm=0.
  → hacked the generator: powerCut={"north":true}, alarm=1 (the station notices).
tick 0: sealSystem read the outage → biolock is shut; player walks through.
  → biolock is OPEN.

## Determinism
Every draw above is a `w.rng.fork(<label>)` / `w.tick` function of the seed; the
new `World.powerCut` field round-trips through serialize.ts (omitted when fully
powered). Snapshot of the power-biolock world after the cut:

```json
{
  "north": true
}
```
