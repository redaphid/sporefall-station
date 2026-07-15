# Offline co-op over Bluetooth (no internet, no server)

Play Streets of Rogue-ish together on two (or more) Android phones with **no
Wi-Fi, no cell signal, and no server** — perfect for a car, a plane, a
basement, or anywhere off the grid. The phones talk **directly to each other
over Bluetooth**.

> This is the offline peer-to-peer mode. It is separate from the server "join a
> co-op room" path — that one needs the internet. This guide is only about the
> two-phones-in-a-car, no-internet mode.

---

## What you need

- **2 to 4 Android phones**, each with the game app installed
  (`app-debug.apk`).
- Bluetooth turned **on** on every phone.
- The phones within about **10 metres (30 feet)** of each other — closer is
  better and more stable.
- That's it. No internet, no accounts, no cables.

---

## Quick start (the 60-second version)

1. Everyone: turn **Bluetooth ON**.
2. **One** phone is the **Host**. Open the game → pick a character → tap
   **"Host co-op"**. It's now waiting for friends.
3. Every **other** phone: open the game → pick a character → tap
   **"Join co-op"**. After a moment you'll see a list of **nearby games**.
4. On each joining phone, **tap the host's name** (it looks like
   `SoR <name>`). Say **Allow** to any Bluetooth question that pops up.
5. The joining phones now show **"Connected — waiting for host to start."**
6. Back on the **Host** phone, everyone shows up in the list. Tap
   **"Start game."**
7. You're all in the **same city**, each driving your own character. Go cause
   some trouble together!

---

## Step by step (with the pop-ups explained)

### On the phone that HOSTS

1. Open the game.
2. Choose your character/class.
3. On the **Solo / Host / Join** screen, tap **Host co-op**
   ("Others join your game").
4. The **first time**, Android asks for permission to use **Nearby devices /
   Bluetooth**. Tap **Allow**. (The game can't be found by friends without
   it — it only uses Bluetooth to find the other phones, never your location.)
5. You'll see a **HOSTING** screen that says *"Waiting for players…"* Leave this
   screen up and keep the phone **awake** (screen on). Your phone is now
   broadcasting a game called **`SoR <your name>`**.
6. As friends join, their names appear in the list.
7. When everyone's in, tap the green **Start game** button.

### On each phone that JOINS

1. Open the game.
2. Choose your character/class.
3. On the **Solo / Host / Join** screen, tap **Join co-op**
   ("Find a nearby host").
4. The **first time**, Android asks for **Nearby devices / Bluetooth**
   permission. Tap **Allow**.
5. A **NEARBY GAMES** screen appears and scans over Bluetooth. Within a few
   seconds the host's game (**`SoR <name>`**) shows up as a button.
6. **Tap the host's button.** If Android asks to pair or connect, say **Allow /
   Pair**.
7. You'll see **LOBBY → "Connected — waiting for host to start."** Now just wait
   for the host to press Start. When they do, you drop straight into the game.

---

## Permissions you'll be asked for (and why)

On the first Host or Join, Android shows a **"Nearby devices"** prompt. Tap
**Allow**. Under the hood the app needs:

| Permission | Why |
| --- | --- |
| Bluetooth (scan / advertise / connect) | To find nearby phones and send game moves back and forth. |
| Location (older phones, Android 11 and below only) | Old Android tied Bluetooth scanning to this. The game does **not** track where you are. |

If you accidentally tapped **Deny**, fix it in **Settings → Apps → (the game) →
Permissions → Nearby devices → Allow**, then reopen the game.

---

## Range and limits

- **Distance:** stay within ~10 m / 30 ft. Through a car it's easy; across a
  house, less reliable.
- **Players:** the host plus up to **3** friends (4 total).
- **Keep the host phone awake.** If the host locks its screen, Bluetooth can go
  quiet and friends may drop.
- **Speed:** Bluetooth is a small pipe, so the game sends compact moves rather
  than full pictures. It's tuned for this and feels smooth; expect a tiny bit of
  rubber-banding on other players if someone walks far from the pack.
- **If someone drops** (walked out of range, phone slept): the game holds their
  character for about **90 seconds** and quietly tries to reconnect. Get back in
  range and they pop right back in where they were.

---

## Troubleshooting

**"I don't see any nearby games."**
- Is Bluetooth **on** on both phones?
- Is the host actually on the **HOSTING / "Waiting for players…"** screen with
  the **screen on**?
- Move the phones closer together and wait 5–10 seconds; scanning is
  continuous.
- Make sure you tapped **Allow** on the Nearby-devices prompt (see Permissions
  above).
- Fully close and reopen the game on the joining phone, then tap Join again.

**"It found the host but won't connect / drops right away."**
- Move closer. Thick walls and distance break the link.
- Have the host tap back out and **Host co-op** again to restart advertising.

**"We were playing and my friend froze / disappeared."**
- They probably went out of range or their screen slept. Get back close; the
  game auto-reconnects within ~90 seconds and restores their character.

**"The Start button did nothing."**
- Only the **host** has a Start button. Joiners just wait — the game starts for
  them automatically when the host taps Start.

---

## For developers: how this works

**Transport chosen: raw Bluetooth Low Energy (BLE) via
`@capgo/capacitor-bluetooth-low-energy`**, using its **peripheral (GATT server)
role**. We verified against the plugin's API that it supports peripheral mode on
Android (`initialize({ mode: 'peripheral' })`, `addGattService`,
`startAdvertising`, `notifyGattCharacteristicChanged`) — so one phone can be
*discoverable* and others connect to it with no server in the middle. That is
exactly the offline topology we need, and the plugin is already a project
dependency, so no new native module or plugin was required. (Google Nearby
Connections would also work and offers more bandwidth, but it would mean adding
and wiring a separate community Capacitor plugin; raw BLE via the plugin we
already ship does the job, and our sync is bandwidth-light by design.)

**Topology.** The **host is the BLE peripheral**: it advertises a game service
(`BLE_SERVICE_UUID`) and runs the authoritative simulation. Each **joiner is a
BLE central**: it scans for that service, connects, writes its inputs to one
characteristic (`C2H`), and receives state via notifications on another
(`H2C`).

**Sync model.** The simulation is a **deterministic fixed-tick ECS**, so we run
a lean host-authoritative loop rather than full lockstep:
- Joiners send only their **input commands** (~15 Hz, quantized to ~9 bytes).
- The host applies all inputs, ticks the world, and fans out compact
  **snapshots** (~10 bytes/entity, interest-limited to a radius around each
  player) plus periodic HUD/mission state.
- Joiners **predict their own avatar** with the shared movement code and
  **reconcile** against host snapshots; other players are eased toward their
  snapshot positions.
- Determinism means each phone generates the identical city from the shared
  **seed**, so only positions and events cross the wire, not the map.

This is more drop-tolerant than pure lockstep (a lagging phone can't stall
everyone) and includes a **90-second rejoin grace** with automatic reconnect —
important because BLE links flicker in a moving car.

Key files:
- `src/net/transport/bleTransport.ts` — `BleHostTransport` (peripheral) and
  `BleClientTransport` (central).
- `src/net/types.ts` — the `Transport` interface, UUIDs, message types.
- `src/app/netHost.ts` / `src/app/netClient.ts` — host/join state machines,
  snapshot fan-out, prediction/reconcile, rejoin.
- `src/net/channel/sendQueue.ts` + `src/net/framing/chunkedStream.ts` —
  per-peer send pacing and message framing over the BLE byte stream.
- `src/ui/menu.ts` — Solo/Host/Join picker, nearby-host list, lobby.
- `src/app/session.ts` (`createSession`) — wires the BLE transport in on native
  Android; keeps the web/BroadcastChannel and Web-Bluetooth paths for dev.

**Permissions.** `@capgo/capacitor-bluetooth-low-energy` merges the required
entries into the app manifest automatically — confirmed present in the merged
manifest: `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`,
`ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`, and the `bluetooth_le` feature.
Runtime prompts are requested via `BluetoothLowEnergy.requestPermissions()` at
the start of both transports (first Host/Join tap).

### Automated tests

`src/app/netCoop.test.ts` proves the offline netcode end-to-end over an
**in-memory loopback transport** (a mock of the two-phone BLE link): the
join handshake and slot assignment, both players landing in the same game with
inputs flowing host-ward and snapshots flowing back, plus the three rejection
paths (version mismatch, join-after-start, lobby full). Run with:

```bash
npm test
```

### Manual two-device test (needs two real phones)

A real BLE link can't be exercised headlessly, so verify the transport itself on
hardware:

1. `npm run build:apk` then `npm run install:apk` (with a phone on `adb`).
   Install the resulting `android/app/build/outputs/apk/debug/app-debug.apk` on
   a **second** phone too (e.g. `adb install -r`, or copy the APK over).
2. Turn Bluetooth on for both. Disconnect from Wi-Fi/data on both to prove it's
   truly offline.
3. Phone A: character → **Host co-op** → Allow Bluetooth → "Waiting for
   players…".
4. Phone B: character → **Join co-op** → Allow Bluetooth → tap **`SoR …`** in
   the Nearby Games list → wait in the lobby.
5. Phone A: **Start game.** Confirm both phones show the same city and each
   moves its own character; verify the other player's avatar moves on your
   screen.
6. Drop test: walk Phone B ~15 m away until it disconnects, then return —
   confirm it reconnects within ~90 s and resumes the same character.
