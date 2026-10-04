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

  Superseded for the owner's case: everyone plays in one place, mostly on one
  wifi network, and the relay sits on the mainland. See "Peer to peer over
  WebRTC" below.

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
  the data lane (`Ping`/`Pong`, protocol 8) and counts silence from the host's
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

## Peer to peer over WebRTC

The owner plays with his nephews in Hawaii, everyone in one house or hotel,
mostly on one wifi network and some on cellular. The relay cannot be near
them. Honolulu (HNL) cannot host a Durable Object, and a room created from
there is placed in San Jose ([where.durableobjects.live](https://where.durableobjects.live/colo/HNL)).
Every relayed packet then crosses the Pacific twice: about 100 to 110 ms
added round trip for players who sit in the same room (inferred from the
~50 ms HNL to San Jose ping on [WonderNetwork](https://wondernetwork.com/pings/Honolulu/San%20Jose)).
A `locationHint` cannot help. No hint covers Hawaii, and `wnam` can place the
room in Dallas, which is further. Room codes are fresh per game, so a room is
never pinned to where it was first used.

So online play is now peer to peer where it can be, with the relay as the
fallback (`src/net/transport/rtcTransport.ts`, #155).

- **Topology.** Host star, up to 8 players. Each guest opens one
  RTCPeerConnection to the host. The relay still announces who is in the room
  and carries the offer, answer and ICE candidates, behind a one-byte lane tag
  on its binary frames.
- **Two data channels.** `ctl` is reliable and ordered: the framed stream for
  Hello/Welcome/Reject, LobbyState, GameStart/Go, Bye, Events, Inventory,
  State and edge inputs. `fast` is unordered with `maxRetransmits: 0`: one
  whole message per datagram for snapshots, input bundles and Ping/Pong. A
  message over `MAX_DATAGRAM` (1100 B) goes on `ctl` rather than splitting.
- **Redundant input.** Every Input message carries the newest four records
  (`INPUT_REDUNDANCY`). The host folds each record once by its seq
  (`src/app/inputGate.ts`), so a lost datagram costs nothing unless four in a
  row go. Taps with no held state (roll, throw, hotbar, mod swap, draft pick)
  also go on `ctl`.
- **The LAN first.** ICE ranks host candidates first, so two devices on one
  wifi network connect directly, with no STUN mapping and no internet
  hairpin. STUN is `stun.cloudflare.com:3478`, for players on different
  networks. There is no TURN.
- **Fallback.** A link that has not opened within 3 s puts that peer on the
  relay. This covers symmetric NAT, hotel wifi with client isolation (host
  candidates fail and the router does not hairpin), and a browser without
  WebRTC. A link that closes, fails ICE, or goes 2 s without a byte moves that
  peer to the relay mid-run. Heartbeats keep an idle link's clock fed. The
  session does not drop: the peer keeps its slot and avatar, the host resends
  its inventory, and both sides stop using the link. `?p2p=0` keeps every peer
  on the relay.
- **What the player sees.** The link chip reads "P2P 42 ms" or "Relay 88 ms".
  `sporefall.session()` reports `link.path`, the ICE candidate types per link
  (`pairs`), and the guest's `predictionCorrections`.
- **Bluetooth still needs no internet.** An all-Android group can play over
  Bluetooth with no network at all, which is the zero-lag option. iPhones
  cannot do Web Bluetooth, so a mixed group plays online.

### Prerequisites fixed first

- The host's single input gate dropped a reliable roll that arrived after a
  later unreliable input. Held state and edges are now gated apart: held state
  takes only a newer seq, and edges fire once per record seq inside a 256-seq
  window (`netInputGate.test.ts`).
- "Play again" resets the client's newest-snapshot tick, so a late snapshot
  from the previous run applied and froze the new one. Snapshots and GameStart
  now carry the host's run epoch, and the client drops a snapshot from another
  run (`netSnapshotEpoch.test.ts`).

### Measured

`scripts/netlab/measure.mjs` runs the real host and guest sessions in two
Chromium contexts inside a network namespace, with `netem` delaying and
dropping relay traffic and P2P traffic separately (`scripts/netlab/README.md`).
Each row is 60 s of a scripted guest walking and tapping attack. The relay row
is the game before this change, apart from the input bundles. Added RTT and
loss are end to end; loss is one way. The Hawaii row puts the relay across
the Pacific (+110 ms, 1.5% loss) and P2P on a clean LAN.

| profile | path | RTT p50 / p95 (ms) | jitter (ms) | snapshot gap p95 (ms) | corrections / min | taps lost |
|---|---|---|---|---|---|---|
| clean | relay | 4.2 / 6.4 | 2.6 | 102.3 | 20 | 0 of 216 |
| clean | p2p | 2.8 / 3.9 | 1.5 | 101.3 | 2.9 | 0 of 216 |
| +80 ms | relay | 85.7 / 87.6 | 2 | 102 | 36.2 | 0 of 217 |
| +80 ms | p2p | 83.7 / 85.2 | 1.6 | 101.4 | 57.1 | 0 of 216 |
| +80 ms, 2% loss | relay | 85.5 / 136.8 | 8 | 105.4 | 65.7 | 0 of 217 |
| +80 ms, 2% loss | p2p | 83.4 / 86.7 | 2.6 | 102.8 | 49.5 | 0 of 217 |
| +80 ms, 5% loss | relay | 88.3 / 501.7 | 52.6 | 152.4 | 137.1 | 9 of 214 |
| +80 ms, 5% loss | p2p | 83.7 / 86.7 | 2.1 | 199 | 40 | 0 of 217 |
| Hawaii (relay +110 ms, 1.5% loss; LAN P2P) | relay | 116 / 187 | 51.9 | 137.9 | 69.5 | 0 of 217 |
| Hawaii (relay +110 ms, 1.5% loss; LAN P2P) | p2p | 2.6 / 3.7 | 1.4 | 101.7 | 20 | 0 of 216 |

- **Round trip and jitter.** With the same added delay on both paths, P2P
  matches the relay's median and keeps its p95 and jitter flat under loss. On
  the relay a lost TCP segment stalls everything behind it until it is resent
  (p95 502 ms at 5% loss). Jitter is the p95 minus the p50 of each snapshot's
  lateness against its host tick. A lost P2P snapshot shows up instead as a
  200 ms gap (snapshot gap p95).
- **Hawaii.** On one wifi network P2P takes the round trip from about 120 ms
  to a few milliseconds.
- **Taps.** No attack tap was lost on P2P at any loss rate. At 5% loss the
  relay lost 9 of 214: a TCP stall delivers several taps inside one host
  tick, and they merge into one attack.
- **Rubber-banding is noisy.** Two runs of the same row differ by up to
  40 corrections a minute, so read only large differences.
  Corrections grow with latency on both paths. Walking alone produces none on
  a clean link. A likely cause (inferred, not proven) is that the host repeats
  the last input while the next is late, and the guest then replays that
  input again on top. Rolls are not predicted at all and snap on any link;
  the bench leaves them out.

### TURN, if wanted later

Without TURN, two peers whose NATs both refuse hole punching play over the
relay: most often a guest on a cellular carrier's NAT reaching a host on
another network, or a hotel network that isolates clients and does not
hairpin. On one house wifi network none of this applies. Cloudflare Realtime
TURN costs $0.05 per GB after 1,000 GB free each month
([pricing](https://developers.cloudflare.com/realtime/turn/faq/)). A guest
receives about 3.6 KB/s, about 13 MB an hour, so the free tier covers tens of
thousands of guest-hours a month. Adding it needs a TURN key and a Worker
route that mints short-lived credentials for `iceServers`.

## What's left

1. **Share link.** Add `?join=CODE` so a host can send a link instead of reading
   the code out.
2. **Host migration** stays out of scope. The host owns the only authoritative
   world. Migration would mean shipping that world to a new host mid-run, which
   is the `?state=` machinery and a separate design.
