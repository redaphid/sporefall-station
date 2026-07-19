# Local multiplayer controllers

Robust local co-op over the **web Gamepad API** (`navigator.getGamepads()` +
`gamepadconnected` / `gamepaddisconnected`). No native / BLE. Multiple pads =
multiple local players on one shared screen.

## Pieces (one concept per file, all unit-tested)

| File | Job |
| --- | --- |
| `src/input/padProfile.ts` | Resolve a pad's `id` + `mapping` to a button/axis profile. |
| `src/input/readPad.ts` | Read one pad snapshot -> `{ moveX, moveY, attack, interact, special, pause }`. |
| `src/input/padAssign.ts` | Pure press-to-join + hotplug reducer (pad index -> player slot). |
| `src/input/gamepadCoop.ts` | Stateful manager: owns all pads, edge detection, per-player `InputCmd`s. |
| `src/input/controllersOverlay.ts` | Debug overlay (`?pads=1` or **F9**). |
| `src/app/hostSession.ts` | Spawns joined players and routes each pad to its ECS entity. |

## Player model

- **Player 0** = keyboard (+ touch) **and** the first joined pad, merged. The
  first pad shares player 0 so the camera target stays under the primary human.
- **Extra pads** press-to-join as players 1, 2, 3 (fresh ECS entities spawned at
  the level spawn point).
- Each pad's `InputCmd` is keyed by player id and consumed by the existing
  movement / combat / interaction systems — no system changes needed.

## Join & hotplug: ANY input joins, and the joining input is inert

- An unassigned connected pad joins on **any input**: any mapped button
  (face/bumper/trigger/Start/Back/stick-click/d-pad), **or a firm, sustained
  stick push** — raw magnitude > 0.5 for 3 consecutive polls on a *trusted*
  stick pair that has been seen resting in the deadzone at least once
  ("neutral proof"; rules + rationale in `src/input/padJoin.ts`). Neutral
  proof is what keeps an analog trigger misread as a stick axis — which rests
  at −1, i.e. "fully deflected", once touched — from ghost-joining, and drift
  (±0.3) sits below both the deadzone-neutral test and the join threshold.
- **The joining input is spent on joining.** It produces zero gameplay actions
  on the joining sample *and for as long as it stays physically held* — a
  fresh press after release acts normally. Level-triggered actions
  (attack, special) made "inert for one sample" insufficient: a human's join
  press is still held on the next poll, so joining with X used to throw a
  grenade. `gamepadCoop.ts` masks every button held at the join until release.
- Disconnect mid-game frees the slot and emits a leave event; the sim never
  crashes on `null` holes in the `getGamepads()` array.
- A survivor keeps its slot across a reshuffle; a fresh pad reuses a freed slot.

### What the browser gates before we ever see the pad

Browsers hide gamepads from `navigator.getGamepads()` until the user first
interacts with one — a fingerprinting protection, out of our hands. Per MDN,
the surfacing interaction for an already-connected pad is when the user
"presses a button or moves an axis" (Chromium has historically required a
button press); Firefox additionally requires the interaction to happen while
the page is visible. So the very first physical press on a just-connected pad
may be consumed by the browser purely to expose the pad to the page. Our
guarantee starts at exposure: whatever input arrives first — button or stick —
joins the pad cleanly and stays inert until released. While a pad is exposed
but unjoined, the app shows a "Controller detected — press any button or move
a stick to join" toast (`createPadHint` in `src/main.ts`).

### Feel

- Sticks use a **radial deadzone with rescale** (`readPad.ts`): output
  magnitude ramps smoothly from 0 at the 0.28 rim to 1 at full tilt, direction
  preserved (no per-axis clipping, so no axis-snapped diagonals, no jump at
  the rim, and out-of-spec drivers clamp to magnitude 1).
- A deflected **right stick draws an aim reticle** ahead of that pad's player
  (`padAimReticles` in `src/input/aim.ts`, drawn by the renderer): distance
  eases with stick tilt, so twin-stick aim is visibly live and pointing where
  the player thinks. Movement-fallback aim shows no reticle on purpose.

## Normalisation across controller types

Movement is read from **all** sources at once — left stick (deadzone 0.28),
standard d-pad buttons 12–15, and a hat axis — so a pad moves no matter which
its firmware mode populates. Actions map by profile, never by a single vendor's
raw index.

| Profile | When | Notes |
| --- | --- | --- |
| `standard` | `mapping === 'standard'` | Precise W3C indices. Xbox, PlayStation, and 8bitdo in **X-input** all land here. |
| `canonical` | `mapping === ''`, exactly 4 axes | Chromium-on-Android's canonical shape — W3C indices the browser won't vouch for. Trusted, including right-stick aim on axes 2/3. |
| `raw` | `mapping === ''`, any other axis count | Genuinely unmapped (desktop Linux/evdev). W3C button order as a documented best guess, defensive movement axes, **no aim stick** (axes 2/3 could be resting triggers). Check live indices with `?pads=1`/F9. |

## 8bitdo Zero 2 (the tiny keychain pad)

Physical inputs: **D-pad, A, B, X, Y, L, R, Select, Start** — 8 buttons + d-pad,
**no analog sticks**. Enough buttons for every SoR action; the real problem is
its mapping changes per Bluetooth power-on mode.

### Recommended: X-input mode (`Start` + `X` at power-on)

Reports `mapping: "standard"`, so the precise `standard` profile applies:

| Action | Button |
| --- | --- |
| Move | D-pad (standard buttons 12–15) |
| Attack | **A** (0), also R (5/7) |
| Interact | **B** (1) |
| Special / ability | **X** (2) / Y (3) |
| Pause | **Start** (9) |
| Join | any face button or Start |

This is the fully-playable, verified-by-spec scheme. Prefer it.

### Fallback: non-standard modes (dinput / Switch, `mapping: ""`)

Indices vary by firmware, and the d-pad may report as buttons **or** as a hat on
`axes[9]` (8 directions encoded across −1..1, rest value out of that band). The
`zero2` profile handles this with a permissive best guess:

- Move: hat axis 9 (decoded) **and** stick **and** d-pad buttons — combined.
- Attack `[0, 1]`, Interact `[2, 3]`, Special `[4, 5]`, Pause `[8, 9, 10, 11]`.
- Join: any of buttons 0–5.

> ⚠️ **NEEDS REAL-DEVICE CHECK.** The non-standard indices above are a documented
> best guess — the Zero 2's dinput/Switch button order could not be confirmed
> headlessly. To verify on hardware: pair the pad, open the game with `?pads=1`
> (or press **F9**), and read the live indices in the controllers overlay. If the
> semantic labels are off, adjust `permissive()` in `padProfile.ts`. Movement is
> already robust because all three movement sources are combined; only the
> attack/interact/special split may need a tweak.

## Proof

- Unit tests (mocked `getGamepads` snapshots incl. a Zero-2-shaped pad):
  `src/input/*.test.ts`, `src/app/hostSession.test.ts`.
- Overlay screenshot with an injected non-standard Zero 2 (join + hat-axis
  "up-left" + attack rendered as `P1  8BitDo Zero 2 gamepad  [LU A]`):
  `scripts/test/controllers-overlay-shot.mjs`.
