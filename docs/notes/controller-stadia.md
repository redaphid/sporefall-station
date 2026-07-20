# Stadia controller — browser ground truth

Captured live via `navigator.getGamepads()` in the running game page
(`localhost:5173/?debug`), 2026-07-19. This is the authoritative browser report
for the user's physical pad — use it to settle the button-mapping, stick-drift,
and bullets-in-8-directions fixes.

## Identity
- **`.id`**: `Unknown Gamepad (STANDARD GAMEPAD Vendor: 18d1 Product: 9400)`
  - Vendor `18d1` = Google; Product `9400` = **Stadia Controller**. Confirmed Stadia pad (not 8BitDo / Xbox).
- **`.mapping`**: `"standard"` — Chrome recognizes it as a W3C **Standard Gamepad**.
  Therefore button/axis indices SHOULD follow the standard layout (see below);
  no vendor remap table needed for this pad in this browser.
- **`.connected`**: true. Appeared at `index 0` (of 4 slots). It was already
  visible without a fresh button press in this session.

## Axes — REST values (sticks centered, untouched)
- `axes.length` = **4**
- Resting values: **`[0, 0, 0, 0]`** — every axis rests at exactly 0.0.

**Implication for the stick-drift / phantom-movement bug:** the pad does NOT
report a resting axis offset (nothing stuck at ±1 or a small bias) in Chrome.
So drift is NOT coming from an axis-at-rest hardware value in the browser report.
If the player drifts with sticks centered, the cause is on our side — e.g. a
deadzone applied wrong, a sign/normalization bug, aim smoothing that never
settles to zero, or intent carried over between ticks — not a raw pad offset.
(Confirm by capturing `axes[]` at the exact moment drift is observed in play.)

Standard-mapping axis convention (expected): `axes[0]` = left stick X,
`axes[1]` = left stick Y, `axes[2]` = right stick X, `axes[3]` = right stick Y.
So move = axes[0]/[1], aim = axes[2]/[3]. These are continuous floats, so the
bullets-fire-in-8-directions symptom is very unlikely to be the pad quantizing
aim — look for aim quantization/snapping in our input or firing code.

## Buttons
- **CONFIRMED live:** fire = **button index 7** (R2 trigger), analog `value` 1.0
  when pulled. Matches the Standard Gamepad layout (R2 = 7). So R2 index is
  standard-correct; no off-by-one on the trigger for this pad.
- Other indices still to confirm as the user plays.
- **TODO (needs live input):** confirm the rest of the physical->index map.
  Standard Gamepad expected indices:
  - 0 A, 1 B, 2 X, 3 Y
  - 4 L1, 5 R1, 6 L2 (trigger, analog value), 7 R2 (trigger, analog value)
  - 8 Select/Back, 9 Start/Menu (Stadia: the "hamburger" ☰ is Start/9, "options"/⋯ is Select/8)
  - 10 L3 (left stick click), 11 R3 (right stick click)
  - 12 Dpad-Up, 13 Down, 14 Left, 15 Right
  - 16 (Stadia "Assistant"/Stadia button, may be extra)
  Stadia also exposes Capture + Assistant buttons which can land at indices 16/17
  and are a common source of off-by-one mapping bugs. Verify R2 fire = index 7
  (analog) and Start = index 9 against live presses before trusting them.

## Method to capture live button/drift ground truth (when user is playing)
Poll in-page: `navigator.getGamepads()[0]`, log any `buttons[i].pressed/value>0`
and any `axes[i]` far from 0. When movement drifts with sticks centered, snapshot
the full `axes[]` + `buttons[]` at that tick and record here.
