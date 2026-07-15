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

## Press-to-join & hotplug

- An unassigned connected pad that presses **any** join button claims the lowest
  free player slot.
- Disconnect mid-game frees the slot and emits a leave event; the sim never
  crashes on `null` holes in the `getGamepads()` array.
- A survivor keeps its slot across a reshuffle; a fresh pad reuses a freed slot.

## Normalisation across controller types

Movement is read from **all** sources at once — left stick (deadzone 0.28),
standard d-pad buttons 12–15, and a hat axis — so a pad moves no matter which
its firmware mode populates. Actions map by profile, never by a single vendor's
raw index.

| Profile | When | Notes |
| --- | --- | --- |
| `standard` | `mapping === 'standard'` | Precise W3C indices. Xbox, PlayStation, and 8bitdo in **X-input** all land here. |
| `zero2` | non-standard id matching `/8bitdo|zero/i` | Permissive face-button sets + hat axis 9. |
| `generic` | any other non-standard pad | Same permissive shape. |

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
