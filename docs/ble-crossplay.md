# BLE crossplay: laptop Chrome joins a phone host

Chrome on desktop supports Web Bluetooth in the **central** role only, so the
topology is fixed: the **phone hosts** (BLE peripheral via the Capacitor app)
and the **laptop browser joins** as a client over
`WebBluetoothClientTransport` (`src/net/transport/webBluetoothTransport.ts`).

## Laptop prerequisites (Chrome on Linux)

- Some Linux Chrome builds ship Web Bluetooth behind a flag: open
  `chrome://flags/#enable-web-bluetooth`, set it to **Enabled**, relaunch.
- Web Bluetooth only runs in a secure context: **localhost or HTTPS**.
  - Playing on the laptop itself: `pnpm run dev` and open
    `http://localhost:5173` — localhost counts as secure, nothing else needed.
  - `vite preview --host` served to *another* machine over plain HTTP will
    **not** work — Chrome disables Web Bluetooth there. For the car use-case
    the player uses the laptop that runs the dev server, so localhost is fine.
- BlueZ must be running with a working adapter (`bluetoothctl show`).

## Join steps

1. **Phone** (the Capacitor app): **Host co-op**. It advertises
   as `Spore <name>`.
2. **Laptop**: open `http://localhost:5173`, **Join co-op** →
   **Bluetooth (phone host)**.
3. Chrome opens its own device chooser — pick the `Spore <name>` entry and hit
   Pair/Connect. (The chooser is Chrome UI; the in-game scan list is only used
   on native Android.)
4. The lobby shows "Connecting over Bluetooth…" then the player list; the
   phone starts the game.

`Same-computer tabs (dev)` in the same picker keeps the BroadcastChannel dev
flow; `?transport=tabs` in the URL skips the picker entirely (used by
`scripts/test/mp-smoke.ts`).

## Notes / limits

- Web Bluetooth never exposes the negotiated MTU, so the transport caps
  packets at 180 bytes (the same floor the native client falls back to).
- If Chrome's chooser shows nothing: check the flag, check the page is
  localhost/HTTPS, and confirm the phone is actually advertising (host lobby
  open, screen on).
