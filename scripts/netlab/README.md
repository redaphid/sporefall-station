# netlab

A network-impairment lab for comparing the relay (WebSocket through the
`RoomDO` Durable Object) with WebRTC peer-to-peer. It runs on Linux or WSL2
without root.

## Run it

```sh
# Calibrate. Prints requested and measured RTT and loss for each traffic class.
NETLAB_DIR=/some/scratch/dir node scripts/netlab/calibrate.mjs [--pings 1000] [--json out.json]

# Keep a lab running, then change impairment from another shell.
NETLAB_DIR=/some/scratch/dir node scripts/netlab/lab.mjs up
NETLAB_DIR=/some/scratch/dir node scripts/netlab/lab.mjs ctl relayRttMs=110 udpOneWayLossPct=5
NETLAB_DIR=/some/scratch/dir node scripts/netlab/lab.mjs ctl            # show the current values and `tc -s qdisc`
```

`NETLAB_DIR` holds the generated wrangler config, the wrangler state and
logs, and `ctl.sock`. It defaults to `$TMPDIR/sporefall-netlab`.

## Measure the game

```sh
# Relay vs P2P on real game traffic, every profile, 60 s per run.
NETLAB_DIR=/some/scratch/dir node scripts/netlab/measure.mjs [--seconds 60] [--only hawaii] [--json out.json]
```

`measure.mjs` bundles `bench.ts` with Vite and serves it to both contexts.
The bench runs the real `NetHostSession` and `NetClientSession` on
`RtcTransport` over `WsTransport`, with no renderer, at 30 Hz. The host plays
a generated floor 1 with hostility off. The guest walks a scripted pattern
and taps attack every 9 ticks. Each profile runs once over the relay
(`p2p: false`) and once peer to peer.

It reports these numbers from the guest:

- RTT p50 and p95. The guest pings ten times a second on the game's own
  Ping/Pong. On P2P these ride the unreliable channel; on the relay they ride
  the WebSocket.
- Jitter: the p95 minus the p50 of the gaps between snapshot arrivals. The
  host sends one every 100 ms.
- Corrections per minute: snapshots that moved the guest's predicted avatar by
  0.5 tiles or more (`NetClientSession.predictionCorrections`), which is
  visible rubber-banding.
- Taps lost: attack taps the guest made minus rising attack edges the host ran.

Rolls are left out by default (`NETLAB_SCRIPT=war` puts them back). The
client does not predict a roll, so every roll snaps on any link, clean ones
included, and drowns out the network's share.

Other knobs: `NETLAB_PATHS=relay` or `p2p`, `NETLAB_VERBOSE=1` for page logs.

## What runs where

`enterNetns()` re-executes the calling script under
`unshare --map-root-user --net --pid --fork --mount-proc --kill-child`. Inside
that namespace the script does the following:

- Brings `lo` up. Adds a dummy interface `lan0` at 10.77.0.1/24 with no IPv6
  link-local address, and adds a default route through `lan0`. Chromium
  without media permission gathers ICE only on the default-route address, so
  without that route it gathers no candidates. Traffic to 10.77.0.1 still
  crosses `lo`.
- Runs `wrangler dev` on port 8787 with the repo's Worker. The config is
  generated into `NETLAB_DIR`, so `.wrangler/` is not created in the repo.
  Telemetry is off. The namespace has no internet access.
- Runs a static server on port 8790, which is not impaired. By default it
  serves this directory.
- Runs headless Playwright Chromium with two browser contexts, one for the
  host and one for the guest.

The pid namespace handles cleanup. When the script exits, the kernel kills
every process left in the namespace.

## tc layout on `lo`

```
root prio 1: (4 bands, priomap -> band 0 = 1:1, no impairment)
 ├─ 1:2  netem 20:  RELAY  (TCP with sport or dport = relay port, IPv4 and IPv6)
 └─ 1:3  netem 30:  P2P    (all UDP)
```

Both netem qdiscs use `limit 10000`. The u32 filters choose the band.

## Traversal math

A packet passes through netem once each time it crosses `lo`.

| class | one-way message | round trip |
|---|---|---|
| relay | 2 traversals (page -> relay, relay -> page) | 4 |
| P2P UDP | 1 traversal (page -> page) | 2 |

`profileToImpairment({ relay: { rttMs, lossPct }, udp: { rttMs, lossPct } })`
converts an end-to-end profile to per-traversal values. `rttMs` is the added
round-trip time. `lossPct` is the one-way loss from one end to the other. The
conversion uses these formulas:

- Per-traversal delay = `rttMs / (2 * n)`.
- Per-traversal loss = `1 - (1 - lossPct)^(1/n)`.

`n` is 2 for the relay and 1 for UDP.

## API

```js
import { enterNetns, startLab, profileToImpairment } from './lab.mjs'
await enterNetns()                                   // re-exec into the netns; returns only inside it
const lab = await startLab({ relayPort, staticPort, staticRoot, dir })
const { host, guest } = await lab.openPages(url)     // Playwright Pages, separate contexts
lab.relayWs(room, 'host' | 'client')                 // ws://10.77.0.1:8787/ws/<room>?role=...
await lab.impair(profileToImpairment({ relay: { rttMs: 110 }, udp: { rttMs: 80, lossPct: 5 } }))
lab.spawn('vite', cmd, args, opts)                   // a helper that stop() also kills
await lab.stop()
```

## Known limits

- The impairment is a constant delay and Bernoulli loss. The lab has no
  jitter, no bandwidth cap, no reordering and no burst loss. `netem` can model
  all of these if needed.
- The relay class includes TCP ACKs. Relay loss therefore shows up as TCP
  retransmission stalls in the tail (p95 and p99), not as lost messages.
- Wrangler dev adds about 1.5 ms of RTT before any impairment, compared with
  the P2P path. It also runs a local proxy hop. The real relay is a
  Cloudflare data centre, so the baseline is not the production RTT.
  Calibration reports the added RTT relative to the clean baseline.
- The P2P path is host candidate to host candidate on one machine. It does
  not exercise NAT traversal, STUN or TURN.
- The ICE consent checks and SCTP SACKs of an idle data channel also pass
  through the UDP netem. Per-traversal drop counts in the `tc` output
  therefore include them.
- The first `createOffer` in a fresh Chromium inside the namespace takes
  about 28 s, and later ones take milliseconds. `measure.mjs` makes one
  throwaway offer in each page before the first run and reuses the pages, so
  no measured join pays it. Real browsers with a network do not show this
  (`e2e/ws-p2p.mjs` connects in well under the 3 s ICE deadline).
