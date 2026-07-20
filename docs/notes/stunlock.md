# Stunlock — user reports being chain-stunned, can't act

Investigated from live source + the `data/items.ts` numbers, 2026-07-19, build 267.
NOTE: the destructive snapshot/restore reproduction was deliberately NOT run
because the user was actively playing a live session at investigation time —
mutating/reloading the world would have rewound their game. Analysis below is
definitive from the data; a live repro is queued for a quiet moment.

## The mechanic (source)
- `src/game/data/items.ts`:
  - **`stunGun`**: `cooldownTicks: 24`, `onHit: { status: 'electrified', ticks: 45 }`.
  - `sledgehammer`: `onHit: { status: 'stun', ticks: 20 }`, `cooldownTicks: 28`.
- `src/game/systems/statusFx.ts`:
  - `electrified` is an **immobilize** status: `isImmobilized(e)` returns true for
    `frozen` OR `electrified` — "a body that can neither move nor act." Movement
    (`movement.ts:88`), AI (`ai.ts:37`) and combat (`combat.ts:363`) all gate on it.
  - `addStatus` (line 17): `fx[kind] = { until: w.tick + durationTicks }` — a hit
    **REFRESHES** the expiry to `tick + 45` every time. No stacking cap, no
    diminishing returns, no post-effect immunity.
  - Unlike legacy `stun`/`sleep`, `electrified` does **not** wake-on-damage, so
    shooting the victim doesn't shorten it.

## The lock (definitive math)
A single stunGun attacker:
- fires every **24** ticks (cooldown), each hit sets electrified expiry to now+**45**.
- 24 < 45 ⇒ the next hit lands **21 ticks before** the current electrified would
  expire, refreshing it. The victim's electrified `until` keeps ratcheting forward
  and **never reaches `world.tick`** → `statusFxSystem` never clears it.
- Result: **the player gets ZERO free ticks — an infinite, hard stunlock from one
  stunGun enemy** (worse with several). This is the reported bug.

Contrast: `sledgehammer` stun is 20t on a 28t cooldown ⇒ an 8-tick free window each
swing, so melee stun is escapable. Only the stunGun's cooldown<duration inverts.

## Where stunGuns come from
`src/game/populate.ts`: `stunGun` is in the NPC weapon pools (`ELEMENT_WEAPONS`,
the ranged pool) — so ordinary thugs/cops can roll it. Observed live: NPC id 1, a
`civ`-faction "skittish" civilian, was carrying a `stunGun` and had gone aggro on
the player. So even civilians can chain-lock.

## Proposed fixes (follow-up branch — ranked)
1. **Make cooldown > duration** for stunGun: e.g. `ticks: 45 -> 18`, or
   `cooldownTicks: 24 -> 55`. Cheapest, removes the infinite lock, keeps the
   weapon meaningful (still a strong control tool).
2. **Post-status immunity window**: when `electrified` (or any immobilize) expires,
   grant N ticks (e.g. 30) during which the same status can't re-apply — classic
   fighting-game "stun decay." Generalizes to frozen too. Add to `applyStatus`/
   `addStatus`: track `lastEndedTick[kind]` and refuse re-apply within the window.
3. **Diminishing returns / stacking cap**: each successive re-apply within a short
   window applies a fraction of the duration (45, 22, 11, 0...). Feels fair.
4. At minimum: `electrified` should **not refresh to full** on re-hit — take the
   max of remaining vs a reduced re-apply, or ignore re-apply while already active.

## Live repro to run when the session is idle (snapshot-protected)
1. `dump` snapshot. 2. Heal player, spawn a stunGun thug adjacent w/ LOS.
3. `step` ~150 ticks sampling `player.fx.electrified.until - world.tick` (never
   drops to <=0) and `player.intent`-vs-`pos` (never moves). 4. Apply fix #1 in a
   scratch build or via `set` on the weapon, repeat, confirm free windows appear.
5. `load` snapshot to restore. Log to experiments.md.
