# Backseat — gameplay / feature ideas (live)

Surfaced while observing the running game. Tagged with the context that sparked
them.

---

## Controller feel
- **Sticky aim** (from the aim bug): when the aim stick recenters, HOLD the last
  aim heading for ~15-20 ticks before falling back to move-direction aim. Makes
  tap-aim-then-fire reliable on a pad.
- **Light aim-assist / magnetism**: bend `facing` a few degrees toward the nearest
  live enemy inside the aim arc when firing. Analog aim at range is hard on a
  stick; this would hugely cut the miss rate the user is feeling.
- **Aim reticle always visible when the stick is deflected** (already there for
  moving; make sure it shows when stationary too, once the mergeCmd fix lands — it
  doubles as the visual proof that stationary aim now works).

## Status effects / combat
- **Diminishing-returns stun** (from stunlock): each re-apply within a window gives
  a fraction of the duration (45, 22, 11, 0...). Turns the stunGun from an
  infinite lock into a strong-but-fair control tool. Generalize to frozen/sleep.
- **Post-status immunity window**: brief immunity after an immobilize expires so
  hits can't chain-lock. Classic and readable.
- **Stun should be escapable by mashing** (co-op flavor): a downed/stunned player
  wiggling the stick shortens it slightly — gives agency, great for the co-op
  "help me!" moment.

## Solo / downed
- **Solo self-revive**: a slow, interruptible self-revive (or one auto-revive per
  floor) so a solo down isn't an instant dead-end while `revivesLeft>0`.
- **Alarm should react to the player being attacked** near witnesses, or at least
  to the player firing — right now a whole fight by the player's spawn left alarm
  at 0. Tie combat noise -> alarm for tension.

## Emergent / build variety
- Lots of weapon MODS spawn on the ground (bulk, velocity, heavy, choke, frost,
  shock, split, overload). Rich build space. Idea: **telegraph mod pickups** with
  a floating icon + a one-line "what it does" the first time, so players learn the
  system. A "mod shrine" that lets you preview-swap would make builds legible.
- Element weapons on NPCs (freezeRay/tranquilizer/flamethrower/stunGun) create
  emergent crowd-control fights — lean into **environmental combos** (electrified
  + wet, burning + oil) for co-op set-pieces (ties into the gameplay-experiments
  skill).
- The `steal the briefcase` mission with a locked exit is a clean heist skeleton —
  idea: **alarm-gated exit** where raising the alarm locks more doors, rewarding
  stealth, punishing the run-and-gun that currently gets you swarmed.
