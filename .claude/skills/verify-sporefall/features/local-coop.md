# Same-machine co-op

A host opens a lobby, friends join, and the host starts the game. Every instance then plays the same floor. A friend who joins late lands on the floor the host is on. In the browser, `?transport=tabs` (BroadcastChannel) stands in for the phone-to-phone BLE link and uses the same session and protocol code.

## Sub-features

- `lobby`: the host lobby lists players under `#players`.
- `join`: a `?mode=join` page appears in the host lobby.
- `start`: `Start game` on the host puts both worlds past tick 60 with entities.
- `late-join`: a third page joining after the host reached floor 3 lands on floor 3.

## How to get to it (user POV)

- On the start menu, choose Host co-op on one device and Join co-op on another.
- For the dev path, open `/?mode=host&transport=tabs&room=camp&seed=424242&name=Host` and `/?mode=join&transport=tabs&room=camp&name=Friend` in the same browser.

## Driving it with Playwright

Preconditions: doctor green. Both pages must share one browser context, because BroadcastChannel does not cross contexts. `drive.mjs` drives one page, so use `node e2e/offline-coop.mjs` (set `OFFLINE_PORT`), or Lane A with two claude-in-chrome tabs. Both tabs must tick for real (BroadcastChannel carries live frames), so put each in its own Chrome window so neither is a background tab.

- **Lane A.** Open the host URL in tab 0 and the join URL in tab 1. Wait until the host's `document.querySelectorAll('#players > div').length >= 2`, click `Start game` in tab 0, and then check `window.world.tick > 60` in both tabs. Screenshot both.
- **Scripted.** `pnpm run build && node e2e/offline-coop.mjs`. It serves `dist/` itself on `OFFLINE_PORT` (default 8123), blocks all external network, and records the late-join page to mp4.

Real BLE between two phones is out of reach for this skill. Say so when a change touches `src/net/transport/bleTransport.ts`.

## Gotchas

- Tabs in different Lane A windows or profiles cannot see each other.
- The client world is the predicted view. `sporefall.session()` flags it.
