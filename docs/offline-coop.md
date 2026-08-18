# Offline co-op over Bluetooth (no internet, no server)

Play Sporefall Station together on two (or more) Android phones with **no
Wi-Fi, no cell signal, and no server** — perfect for a car, a plane, a
basement, or anywhere off the grid. The phones talk **directly to each other
over Bluetooth**.

> This is the offline peer-to-peer mode. It is separate from the server "join a
> co-op room" path — that one needs the internet. This guide is only about the
> two-phones-in-a-car, no-internet mode.

---

## What you need

- **2 or more Android phones**, each with the game app installed
  (`app-debug.apk`). The protocol seats up to **8** players (the host plus 7) —
  see "Range and limits" for what a real radio will actually hold.
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
4. On each joining phone, **tap the host phone in the list**. It is listed by
   the host phone's own Bluetooth name (e.g. "Pixel 8 Pro"), or as
   `Host ABCD` when that name isn't broadcast — *not* by the player's name, and
   there is no `Spore` prefix. If several phones are listed and you can't tell
   which is which, the host's is the one that appeared when they tapped Host.
   Say **Allow** to any Bluetooth question that pops up.
5. The joining phones now show **"Connected — waiting for host to start."**
6. Back on the **Host** phone, everyone shows up in the list. Tap
   **"Start game."**
7. You're all in the **same city**, each driving your own character. Go cause
   some trouble together!

---

## Step by step (with the pop-ups explained)

### On the phone that HOSTS

1. Open the game.
2. On the **Solo / Host / Join** screen, tap **Host co-op**
   ("Others join your game").
3. The **first time**, Android asks for permission to use **Nearby devices /
   Bluetooth**. Tap **Allow**. (The game can't be found by friends without
   it — it only uses Bluetooth to find the other phones, never your location.)
4. You'll see a **HOSTING** screen that says *"Waiting for players…"* Leave this
   screen up — the app now holds the screen awake by itself while it is in
   front, so you don't have to keep tapping it. Your phone is now broadcasting
   the game. Joiners will see it under **your phone's Bluetooth name** (or
   `Host ABCD`); the game deliberately does not put your player name on the air,
   because the advertisement has no room for it. Your name reaches the others
   once they connect, in the lobby list.
5. As friends join, their names appear in the list.
6. When everyone's in, tap the green **Start game** button.

### On each phone that JOINS

1. Open the game.
2. On the **Solo / Host / Join** screen, tap **Join co-op**
   ("Find a nearby host").
3. The **first time**, Android asks for **Nearby devices / Bluetooth**
   permission. Tap **Allow**.
4. A **NEARBY GAMES** screen appears and scans over Bluetooth. Within a few
   seconds the host's phone shows up as a button, labelled with **its Bluetooth
   name** (e.g. "Pixel 8 Pro") or as **`Host ABCD`** if it doesn't broadcast one.
   Only phones running this game are ever listed — the scan filters on the
   game's service ID, so anything in the list is joinable.
5. **Tap the host's button.** If Android asks to pair or connect, say **Allow /
   Pair**.
6. You'll see **LOBBY → "Connected — waiting for host to start."** Now just wait
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
- **Players:** the protocol seats **8** (the host plus 7) and refuses further
  joins with "lobby full". How many phones one host radio will really hold at
  once is a property of that phone's Bluetooth chipset, not of the game, and it
  has **not** been measured on hardware — every extra central also shares the
  same small pipe. If you are demoing, keep it small and add phones one at a
  time so you can see where it stops being smooth.
- **Keep the host phone awake.** The app holds the screen on while it is in the
  foreground, so it will not sleep on its own mid-game. It does **not** keep
  simulating if you switch apps or lock the phone manually: the whole game loop
  runs on the browser's animation frames, which the system stops delivering the
  moment the game is no longer on screen. Leave the host in the game.
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

**"The screen says `Can't host: …` or `Can't join: …`."**
- Good — that line is the phone telling you exactly what went wrong, and it is
  worth reading out loud before changing anything. `Bluetooth is off — turn it
  on and try again` means precisely that. `Permission denied: …` means the
  Nearby-devices prompt was declined (see Permissions above).
  `couldn't connect to the host — the host did not answer` means the host phone
  never completed the handshake: move closer, make sure it is still on the
  HOSTING screen, and try again.
- These messages replace the old failure mode, which was a screen that simply
  never changed. If a phone ever sits on a blank or frozen screen with no
  message, that is a bug worth reporting — not a phone you should keep waiting on.

**"It found the host but won't connect / drops right away."**
- Move closer. Thick walls and distance break the link.
- Have the host tap back out and **Host co-op** again to restart advertising.
- A refused connection now gives up after about **10 seconds** with a message
  rather than hanging indefinitely, so wait for the error before retrying.

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

**Keeping the host alive.** The simulation runs entirely inside
`requestAnimationFrame` (`src/main.ts`), so it advances only while the game is
actually on screen. `MainActivity` therefore sets
`FLAG_KEEP_SCREEN_ON`, which stops the display timeout from freezing the
authoritative world for every player at once.

We deliberately did **not** add a foreground service. It would be the only way
to keep ticking while backgrounded, but it needs a Service class, a notification
channel, `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CONNECTED_DEVICE`
permissions and a manifest entry — a native change we cannot verify without a
device. Note that the plugin's `startForegroundService()` is **not** a shortcut:
its Android implementation is an empty method that calls `call.resolve()`
without starting anything, so it succeeds while doing nothing. The honest
current limitation is: **the host must stay in the app, screen on.**

**Radio failure handling.** Every BLE await that can hang has a deadline
(`src/net/transport/withTimeout.ts`) because the plugin's
`onConnectionStateChange` resolves a pending connect only on `STATE_CONNECTED` —
it never rejects on failure and never reads the GATT `status`, so a refused
connect otherwise waits forever. Connect gets 10s, MTU 5s, and the
`deviceDisconnected` event can fail an in-flight connect early. When MTU
negotiation fails the client falls back to a **20-byte** payload (the ATT floor
of 23 minus the 3-byte header), not to the post-negotiation 180 — writing 180
onto an unnegotiated link is silently truncated by the stack and corrupts the
framing permanently. See the `KNOWN GAP` note on `BleHostTransport.maxPacket`
for the still-unfixed mirror image of this on the host side.

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
pnpm test
```

That transport is perfect, though — no latency, no loss, no fragmentation. For
the link a car actually provides, use the harness below.

#### `e2e/net-conditions.mts` — co-op under an adverse link

**The most complete co-op test in the repo, and nothing runs it automatically.**
There is no `package.json` script for it and no CI job; it is referenced nowhere
but its own header. Run it by hand before you trust a netcode change.

It drives the real `NetHostSession` and `NetClientSession` against each other in a
single Node process through a modelled BLE link:

- **180-byte packets** (`bleTransport`'s `MAX_PACKET`), so every snapshot bigger
  than that fragments and exercises `chunkedStream`'s reassembly — the path that
  ships on two phones.
- **One packet in flight.** The model awaits `sendPacket`, so transmit pacing is
  real backpressure rather than a simulated number.
- **Latency, jitter, per-packet loss, throughput, and range dropouts**, all seeded
  from `mulberry32` so a condition set is reproducible.
- **Ordered delivery by default**, because a single BLE connection (ATT/L2CAP on
  one link) never reorders. Per-direction FIFOs drained by one timer — plain
  `setTimeout` is not enough, since Node buckets timers and can fire two packets
  out of order.

> **`e2e/ws-multiplayer.mjs` is not a substitute.** It pushes whole messages
> through a 64 KB WebSocket, so it never fragments and never touches the
> reassembly path. Different transport, different failure modes.

**Per profile it asserts:** the join handshake completes and the client reaches
`playing`; *identity* — every entity the client renders exists on the host with
the same archetype (the `ARCHETYPES`-index desync class); *coverage* — entities
well inside the client's interest box actually arrive; *position* — shared
entities agree within a latency-scaled tolerance; *globals* —
floor/missionComplete/gameOver/alert converge; *liveness* — the client keeps
applying snapshots and no `StreamReader` wedges. It also reports any archetype the
host spawned that is missing from the wire registry (those arrive as `player`).

**The 20 profiles:** `pristine`, `ble-typical`, `high-latency-200ms`,
`heavy-jitter`, `loss-2pct`, `loss-10pct`, `loss-30pct`, `congested-slow-link`;
60-second soaks (`soak-clean-60s`, `soak-loss-1pct-60s`, `soak-loss-5pct-60s`)
that ask the campfire question — *does a lossy radio freeze the joining player's
screen for good within a few minutes?*; controls that separate "loss wedges the
stream" from artefacts of the model itself (`ctl-reordering-clean-60s`,
`ctl-ordered-clean-60s`, `ctl-ordered-loss1-60s`, three `ctl-immortal-*` runs that
remove the death/game-over path, and `ctl-immortal-nojitter-60s`); and event
profiles `out-of-range-3s`, `hard-drop-rejoin-same-id`,
`hard-drop-rejoin-new-id`.

```bash
npx tsx e2e/net-conditions.mts --self-test         # prove it can fail (see below)
npx tsx e2e/net-conditions.mts --only ble-typical  # one profile
npx tsx e2e/net-conditions.mts                     # all 20, ~11 min of link time
npx tsx e2e/net-conditions.mts --allow COVERAGE    # drop a code from the exit gate
```

**It can prove itself, which is the point.** `--self-test` corrupts the archetype
byte of every snapshot entity record while leaving the Hello/Welcome/GameStart
handshake intact — so the run still joins and plays, and any failure has to come
from the world comparator rather than a dead connection. Then it **inverts the
exit gate**: if no profile fails under a deliberately broken wire, it exits
non-zero with *"the harness stayed green with a deliberately corrupted wire… treat
every green result as meaningless."* A green run you have never seen go red is not
evidence.

`--allow <CODE,…>` removes divergence codes from the exit gate only — they are
still printed. Suppressing a finding from the gate must never hide it.

Exit codes: `0` pass, `1` a profile failed (or the self-test failed to fail),
`2` bad arguments or a harness crash.

### Manual two-device test (needs two real phones)

A real BLE link can't be exercised headlessly, so verify the transport itself on
hardware:

1. `pnpm run build:apk` then `pnpm run install:apk` (with a phone on `adb`).
   Install the resulting `android/app/build/outputs/apk/debug/app-debug.apk` on
   a **second** phone too (e.g. `adb install -r`, or copy the APK over).

   > Needs a **JDK 21+ and the Android SDK** locally. The primary Windows dev
   > machine has neither — the committed Gradle wrapper makes `gradlew.bat` look
   > runnable, but there is nothing behind it. If you can't build, take the APK
   > from the `android-apk` workflow artifact or
   > `https://sporefall.hypnodroid.com/download` instead.
2. Turn Bluetooth on for both. Disconnect from Wi-Fi/data on both to prove it's
   truly offline.
3. Phone A: character → **Host co-op** → Allow Bluetooth → "Waiting for
   players…".
4. Phone B: character → **Join co-op** → Allow Bluetooth → tap Phone A in the
   Nearby Games list (listed by its Bluetooth name, or `Host ABCD`) → wait in
   the lobby.
5. Phone A: **Start game.** Confirm both phones show the same city and each
   moves its own character; verify the other player's avatar moves on your
   screen.
6. Drop test: walk Phone B ~15 m away until it disconnects, then return —
   confirm it reconnects within ~90 s and resumes the same character.
