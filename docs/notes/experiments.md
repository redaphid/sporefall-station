# Live-world experiments log

Format: hypothesis -> mutation -> observed effect -> restored. Snapshot before any
mutation (`dump`/`backseat.serialize()`), restore after (`load`).

---

## 2026-07-19 — no destructive experiments run yet (user was live-playing)
The user was actively at the controls (Stadia pad, live ticking session) for the
whole window, so per the "keep the user's live play intact" rule I did NOT mutate
the world. A snapshot was taken (`window.__snap`, tick 4744) as a safety net but
NOT reloaded (the world had advanced past it; reloading would rewind their game).

Investigations this session were **read-only** (gamepad polling + entity reads +
source reading):
- Aiming bug analysis -> `aiming.md` (facing tracks aim stick correctly; miss
  cause is the recenter-fallback-to-move-heading, plus ~1-tick facing lag).
- Stunlock analysis -> `stunlock.md` (stunGun electrified 45t vs 24t cooldown =
  infinite lock; definitive from data, live repro queued).
- Stadia controller ground truth -> `controller-stadia.md`.

### Queued destructive experiments (run when the session is idle)
- Stunlock repro + fix test (see stunlock.md steps).
- Aiming: spawn a dummy target line, drive scripted fire along known facings,
  confirm projectile `velAng == facing` in flight; test a "sticky aim" hold.
