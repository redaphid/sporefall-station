# Online multiplayer: census and plan

Status: **measured** on `main` at `b040944` (after #144). The menu entry described
under "What shipped" lands with this doc. Everything under "What's left" is a plan
and not built.

## Census

Four transports implement the `Transport` contract in `src/net/types.ts`. The
session layer (`NetHostSession`, `NetClientSession`) doesn't know which one it
is talking to.

| Transport | Code | Selected by | Reach |
|---|---|---|---|
| BLE host and client (native) | `src/net/transport/bleTransport.ts` | Capacitor build, always | One room, no signal needed |
| Web Bluetooth client | `src/net/transport/webBluetoothTransport.ts` | Join on a desktop or Android browser, from the picker in `openJoinTransport` | Joins a phone host |
| BroadcastChannel | `src/net/transport/broadcastChannelTransport.ts` | `?transport=tabs`, or the picker's dev button | Tabs in one browser |
| WebSocket relay | `src/net/transport/wsTransport.ts`, `wsWire.ts` | `?transport=ws` (and `?room=`), and now **Play online** | Anywhere with a connection |

The WebSocket path dials `/ws/:room` on the same Worker that serves the game.
`src/worker/router.ts` maps the room name to a `RoomDO` Durable Object through
`idFromName`. `roomDO.ts` is a thin adapter over the pure planner in
`roomRelay.ts`. The relay forwards bytes between one host and N clients. It
never inspects or stores them. It uses the Hibernation API and keeps no state
beyond its live sockets. It is bound in `wrangler.jsonc` (`ROOM` / `RoomDO`,
migration `v1`) and is deployed. On 2026-10-04,
`GET https://sporefall.hypnodroid.com/ws/<any>` answered `426 expected
websocket`, which is the DO's own reply. It does not come from the debug hub.
The debug hub (`tools/debug-hub`) is a separate dev-only WebSocket for the
`?debug` verbs.

**Why there was no menu option.** The relay was never wired into the UI. Commit
`73ba513` (2026-07-20) added it "behind `?transport=ws` (BLE/tabs unchanged)".
Nothing gated it or hid it later. The URL parameter was the only way in, and
the room defaulted to `car`, so every user of the parameter shared one room.
The native app could not have used it either. `resolveWsBaseUrl` built
`wss://localhost/ws` inside the Capacitor shell, and the join path never
consulted `?transport` on native.

## Measured: two browser contexts over a local relay

Two contexts ran in one Windows Chrome over CDP against `wrangler dev`. The
guest's socket went through a proxy that adds one-way delay with jitter, cuts
the connection, or holds frames. The harness and proxy are out-of-tree scratch.
`e2e/ws-online-menu.mjs` is the in-tree proof of the menu flow.

| Check | Result |
|---|---|
| Lobby, start, both worlds ticking | Works. Host and guest ticks stay within 10 of each other. |
| Bandwidth, relay to guest, 2 players at rest | 3.4 KB/s, 12.9 frames/s, largest frame 361 B (p50 262 B). Guest to relay: 15 frames/s, 165 B/s. |
| Own-movement prediction, enemies cleared | Visible within 10 to 57 ms at 0, 60, 120 and 250 ms one-way delay. No backward snaps. |
| Own movement in a fight, 120 ms one-way | The predicted avatar moved in snapshot-sized steps with one backward snap. 0.25 tiles took 570 to 590 ms, against 65 to 120 ms at 0 ms. Enemy hits are a likely confound, not yet isolated. |
| Socket killed mid-run | Reconnects in about 2.4 s and reclaims the same avatar (ids unchanged). |
| Socket silently stalled 15 s | **Never noticed.** The phase stays `playing` and the world freezes with no message. It recovers when the frames resume. |
| Host closes the tab | The guest sees "reconnecting…" within 0.3 s, then waits **100 s** for a host that can't return before it says "Connection lost". |
| Second host claims a taken room | The relay answers 409. The page reads "Can't host: ws error before open" and still shows Start. |
| Host migration | None. The host is authoritative and `WsTransport.reconnect` refuses the host role. |
| NAT | Not an issue. Every peer dials out to the Worker over `wss`, so no inbound port or hole punching is needed. |

The snapshot budget was sized for BLE (`SNAPSHOT_ENTITY_CAP = 48`, 10 Hz,
latest-wins lane), and it is far below what the internet path can carry.
`maxPacket` is 64 KiB on the WebSocket, so framing almost never splits a frame.

## Recommendation: keep the WebSocket relay, (a)

The relay in option (a) already exists and is deployed. The work left is
product work around it, not new infrastructure.

- **Reuse.** It speaks the existing wire protocol byte for byte. Snapshots,
  rewind, prediction and rejoin tokens all work over it unchanged (measured
  above).
- **Offline-first is untouched.** BLE stays the default for Host co-op and Join
  co-op. Online is a separate menu entry. Nothing on the BLE path dials out.
- **Cost.** Durable Objects bill incoming WebSocket messages at 20:1, and
  outgoing messages are free. A 2-player run is about 28 incoming messages a
  second, so about 5,000 billed requests an hour. Duration is billed only while
  a handler runs, because the sockets are hibernatable. The free plan's
  100,000 requests a day covers about 20 two-player hours a day. On the paid
  plan the cost is about $0.001 per room-hour beyond the included million
  requests a month (estimate from the published rates and the measured message
  rates).
- **Latency.** Each packet takes two hops, guest to DO and DO to host. The DO
  is placed near whoever creates it first, which is usually the host. The
  overhead against a direct path is likely tens of milliseconds (estimate). The
  game predicts its own movement and interpolates everyone else, so this is
  well inside what it hides (measured at 250 ms one-way with no enemies).
- **Why not WebRTC, (b).** Data channels would cut one hop and could carry
  snapshots unordered. In exchange they need a signalling flow, STUN, and a
  TURN fallback for the 10 to 20 percent of pairs behind symmetric NAT (an
  industry estimate, not measured here). TURN is billed per GB, and the
  failures land on the hardest networks to debug. Revisit only if relay latency
  measures badly between real distant players.

## What shipped with this doc

- **Play online** on the start menu opens `src/ui/onlineMenu.ts`, where the
  player chooses **Host online game** or types a code and presses **Join**.
- `src/app/roomCode.ts` makes 4-character codes from 32 unambiguous characters
  (no I, O, 0 or 1) with `crypto.getRandomValues`. Parsing forgives case,
  spaces and dashes and rejects anything else. A code maps to relay room
  `online-<CODE>`, inside the beta-slug namespace.
- The host lobby shows the code in large type. A guest waiting on a code sees
  "Waiting for the host of CODE…", so a typo is visible.
- `resolveWsBaseUrl` now dials `SITE_ORIGIN` from inside the native shell
  (`src/app/workerOrigin.ts`, shared with `stateShare`), so the APK can reach
  the relay. This is untested on a phone.
- A WebSocket open failure now reads "can't reach the online server", and a
  join whose transport fails to start says so instead of hanging.
- The reconnect banner says "Connection dropped" rather than "Bluetooth
  dropped".
- Joiners without Bluetooth (iPhones, Firefox) are pointed at Play online.

## Reliability (the follow-up PR)

The behaviour below is measured by `e2e/ws-online-reliability.mjs`, which puts
`e2e/ws-fault-proxy.mjs` between the pages and the relay.

- **Link watchdog (online only).** The guest pings the host once a second on
  the data lane (`Ping`/`Pong`, protocol 12) and counts silence from the host's
  last byte (`src/app/linkHealth.ts`). After 2 s of silence the HUD chip reads
  "Weak connection". After 5 s the guest reconnects even though its socket is
  still open. With the socket frozen for 15 s, the chip warned at 2.4 s, the
  guest reconnected at 5.2 s, and play resumed on the same avatar 0.4 s after
  the network came back. Bluetooth keeps its own drop detection and sends no
  pings.
- **Link chip.** A dot and the round trip ("84 ms"). It turns amber over 250 ms
  and reads "Weak connection", "Reconnecting…" or "Disconnected" when those
  apply. The host's chip shows its worst player's round trip, which each guest
  reports in its Ping.
- **Host left.** The relay's `host-` now reaches the session as a `left` drop
  and goes to the HOST LEFT menu from #145, the same menu its Bye uses. A host
  whose network vanished with no Bye and no close frame showed HOST LEFT on the
  guest within 0.5 s. A client that reconnects to a room with no host gets
  an explicit `nohost` frame from the relay and ends on HOST LEFT too. A slow
  or lost frame never ends the run: without `nohost` the guest keeps
  retrying. A host the relay still
  lists but that never answers gives up after 60 s as CONNECTION LOST. No
  online text says Bluetooth: `LINK_COPY` words each message per medium.
- **Room codes.** `hostOnline` (`src/app/onlineSession.ts`) tries up to three
  codes, because a held code and a dropped network fail the same way in the
  browser. Only after every attempt fails does it show the reason with Retry and
  Back to menu. The code and Start appear only once a room is open. A guest
  whose code nobody hosts sees "No game with that code" and Back to menu after
  10 s (`watchForHost`).
- **Relay boundary.** `/ws/:room` refuses names outside
  `^([a-z0-9-]+~)?[A-Za-z0-9-]{1,64}$` with 400. A room admits
  `MAX_PLAYERS` (8) clients and refuses the next with 409. A frame over 64 KiB
  plus the peer-id header closes its sender with 1009. A host that rejects a
  player (version, full lobby, expired rejoin) sends `drop`, and the relay
  closes that socket with 4003. `e2e/ws-relay.mjs` checks each of these against
  the real Durable Object.

- **Sharing online moments.** An online host arms the `?state=` ring like a
  solo run. Its ring records every player's commands, so the guest replays as
  a scripted slot, and the e2e link replayed green with both players. When a
  run-up cannot replay (the host edits its world between ticks, as when a
  dropped guest's body expires), the share goes up as a still and the console
  says why. Guests do not share; they do not own the world.

## What's left

1. **Share link.** Add `?join=CODE` so a host can send a link instead of reading
   the code out.
2. **Host migration** stays out of scope. The host owns the only authoritative
   world. Migration would mean shipping that world to a new host mid-run, which
   is the `?state=` machinery and a separate design.
