# Protocol resilience: what the wire can do to heal itself

Design exploration against `origin/main` @ `c189558`. Read-only analysis; no production code
changed. Every number below is either **[measured]** (I ran it, command given in the appendix),
**[repo]** (measured previously by this repo's own tests, cited to the commit), or
**[computed]** (arithmetic from the wire format, shown so you can check it).

---

## The short version

Three findings, in priority order.

1. **The join handshake cannot recover from a single lost packet, and that is the biggest
   real failure on the link.** [measured] At 10% packet loss **1 join in 4 fails permanently**;
   at 30%, half do. The client sits in `connecting` or `starting` forever with the host
   healthy and simulating beside it. Fix costs **0 bytes** when nothing is wrong.
2. **The JSON cold path is where the wasted bytes are, and binarising it costs no resilience
   at all.** [measured] `StateMsg` is 355 B at 2 Hz for two players (~831 B at eight), of which
   **125 B is punctuation** and **44 B is a mission string that never changes**; a binary form
   is **~56 B** [computed] — one BLE packet instead of five. And **84.1% of all Events bytes are
   `hit` events**, at ~76 B of JSON each where 8 B of binary would do. Together that is
   **~2.7 KB/s per peer, ~31% of the measured 8.0–8.9 KB/s budget** [repo], for **zero** loss of
   self-healing. This is a bigger win than any FEC scheme could ever return, and it pushes in
   the right direction: less offered load means less loss.
3. **The client-side input-sequence u16 wrap is still open and fires at 36.4 minutes.**
   [measured] I reproduced it: the pending-input backlog goes from 4 to the 60-entry cap
   and stays pinned, so `reconcile()` replays ~2.0 s (~9 tiles) of movement on *every*
   snapshot, forever. Host side was fixed; client side was not, and no test covers it.

And the two verdicts you asked for:

- **gRPC: no.** [computed] Protobuf would cost **~21 B/entity against your 10 B** — it is
  **2.1× larger**, not smaller, because tag bytes and varints lose to a fixed-layout struct
  at this size. Details in §4.
- **Parity/FEC: no, nowhere.** [measured] The framing layer already loses **less than one
  message per dropped packet** (0.64–0.85), so there is no cascade to protect against; lost
  snapshots are repaired by the next one **100 ms** later, with a worst observed staleness of
  **400 ms at 5% loss**; and the link is oversubscribed, so the +33% packets FEC costs would
  drop more snapshots to backpressure than it recovers. Details in §3.

---

## 1. What is already self-healing — do not spend effort here

This codebase has done the hard parts. Four mechanisms are working and measured:

**Full-state snapshots.** Every snapshot is a complete keyframe, not a delta. A lost snapshot
is superseded 100 ms later and the client is exactly correct again with no action from anyone.
[measured] At 5% packet loss, **90.5%** of snapshot intervals had **zero** missed snapshots and
the worst gap in a 30 s run was 3 missed (**400 ms**). At 2% loss the worst was 2 (**300 ms**).
This is the single most valuable resilience property in the protocol. Anything that trades it
away (delta encoding) must earn its keep loudly.

**Framing resync.** `chunkedStream.ts` detects a mid-message packet loss four ways (implausible
length, message not ending on a packet boundary, short packet mid-message, unknown type byte)
and discards whole packets until one parses as a start. [measured] It works better than
break-even: across 2–30% loss, **0.64–0.85 messages lost per dropped packet**, with only
**23 packets discarded during resync out of 240 dropped** at 30% loss. There is no cascade.
This was `882e946` (0/200 → 200/200 recovered) and hardened again by `53149ed` (19 mutations,
no survivors). Leave it alone.

**The two-lane send queue.** `RELIABLE_BURST = 4` fixed the starvation where [repo] **0
snapshots were delivered across 60 ticks** of sustained reliable traffic (`b487204`,
`6330634`, pinned by `netScale.test.ts`). Interleaving costs the reliable lane nothing it was
promised. Leave it alone.

**Replay and ordering guards.** `isNewerTick` does proper RFC 1982 serial comparison on the u32
snapshot tick; `changeFloor` is monotonic; duplicate snapshots are rejected. A stale snapshot
used to yank the avatar [repo] **5.56 tiles**. Solved.

**One correction to the brief's numbers.** Snapshots are **not** typically 490 B. [measured] In
a live two-player run they average **184 B and 1.42 packets** (~17.3 entities). 490 B is the
`SNAPSHOT_ENTITY_CAP = 48` worst case — real, but it is the ceiling on a crowded floor, not the
common case. Both numbers matter and I use each where it applies.

---

## 2. What actually gets lost — the measurement that decides everything

30 s of real `NetHostSession` ↔ `NetClientSession` over the 180-byte BLE link model, tallying
host→client messages at send time and at the client's byte stream. [measured]

| loss | Snapshot lost | Events lost | State lost | desyncs | msgs lost / dropped packet |
|---|---|---|---|---|---|
| 0%  | 0.0%  | 0.0%  | 0.0%  | 0  | — |
| 2%  | 4.6%  | 3.8%  | 4.7%  | 4  | 0.82 |
| 5%  | 12.0% | 5.6%  | 9.3%  | 11 | 0.85 |
| 10% | 16.4% | 18.2% | 23.3% | 21 | 0.74 |
| 30% | 45.2% | 39.5% | 53.5% | 47 | 0.64 |

Measured wire sizes, host→client: Snapshot **184 B avg / 1.42 pkts**, State **355 B / 2.00 pkts**,
Events **104 B avg / 1.02 pkts**, Inventory **86 B**, GameStart **118 B**, LobbyState **76 B**,
Go **46 B**, Welcome **32 B**.

Three things fall out of this table.

**(a) Losing a snapshot costs almost nothing.** It is superseded in 100 ms. The gap
distribution at 5% loss is 0-missed 90.5%, 1-missed 6.3%, 2-missed 2.1%, 3-missed 1.1%. Nobody
sees a 400 ms interpolation stretch on a 10 Hz stream that is already smoothed at `SMOOTH=0.45`.

**(b) Losing an Events message also costs almost nothing — verify this, then stop worrying.**
`RenderView.events` is consumed only by `renderer.ts` (sound, haptics, distortion FX),
`pickModel.ts` and `screens.ts`. It is presentation. The one structural event, `floorChange`, is
*redundantly carried* by `snapshot.floor` and `StateMsg.floor`, both guarded by the monotonic
`changeFloor`. So the durable facts already ride the periodic state and heal themselves; the
lane that looks like "lose one and lose it forever" mostly is not. **Do confirm this per event
type before relying on it** — the check is "if this event never arrived, would the world still
be right in one second?" Today the answer is yes for everything I traced.

**(c) The reliable lane is not reliable, and that is where the real damage is.** "Reliable"
here means only *the SendQueue never drops it*. The BLE notification underneath is
unacknowledged, there is no ack and no retransmit, and at 10% loss **23.3% of State messages
never arrive**. For the periodic ones that is fine — another comes in 500 ms. For the
**one-shot admission messages it is fatal**, which is §3.

---

## 3. Parity / FEC: the honest answer is no, and here is the arithmetic

**Where it would be spent.** The only lane big enough to matter is snapshots (3 packets at the
48-entity cap). A 3+1 XOR parity packet recovers any single lost packet.

[computed] With per-packet loss `p`, a 3-packet snapshot is lost with probability
`1-(1-p)³`; with one parity packet it fails only if ≥2 of 4 are lost,
`1-(1-p)⁴-4p(1-p)³`:

| p | lost without FEC | lost with 3+1 XOR | packet cost |
|---|---|---|---|
| 2%  | 5.9%  | 0.23% | +33% |
| 5%  | 14.3% | 1.40% | +33% |
| 10% | 27.1% | 5.23% | +33% |

Those recovery numbers look good, and the idea is still wrong here, for three reasons that
compound:

1. **You are buying something you do not want.** [measured] The thing FEC prevents is at most
   ~400 ms of stale world at 5% loss, occurring in 1.1% of intervals, on a stream that is
   *already* interpolated. You would be paying 33% more packets, permanently, on 61% [repo] of
   the byte budget, to remove an artefact nobody can see.
2. **On an oversubscribed link, offered load *is* the loss mechanism.** [repo] The measured
   8-player aggregate is **56–63 KB/s**, which this repo's own test says is above what one
   Android peripheral serving 7 centrals can carry. Adding 33% to the dominant lane increases
   queueing in the BLE stack, which increases `SendQueue` snapshot-slot overwrites — the queue
   dropping snapshots *itself*, before the radio is involved. FEC would very plausibly lose
   more snapshots than it recovers, and you cannot currently see this happening because
   **`SendQueue.overwrites` is incremented and read only by `netScale.test.ts` — nothing in
   production reads it.**
3. **There is no cascade to protect against.** The premise of FEC on a framed stream is that
   one lost packet costs many messages. [measured] It costs **0.64–0.85**. `chunkedStream`
   already solved this in-band, for free.

**Is there anywhere it pays?** The one candidate is the admission triple
(Welcome 32 B + GameStart 118 B + Go 46 B = 196 B), where a single loss is permanent. But ARQ
beats FEC there outright: FEC costs +100% on those bytes *always*, while a re-ask costs
**0 bytes when healthy** and one 50 ms round trip when not. So: no FEC, anywhere.

**The constructive version of your instinct.** What you actually want from "self-healing" is
*redundancy by inclusion, not by parity* — and this protocol already does it in the right
place: `floor` rides every snapshot and every State message rather than depending on the
`floorChange` event surviving. That is the pattern to extend when you add a new durable fact:
**put it in the periodic state, not only in a one-shot event.** It costs a byte or two per
message and recovers with certainty, where parity costs 33% and recovers with probability.

---

## 4. gRPC: a dead end, in one paragraph

gRPC is HTTP/2 plus protobuf. Neither half helps. **Protobuf is bigger than what you have:**
[computed] the same entity record encodes as id (tag 1 + varint 2), archetype (1+1), flags
(1+1), x (1+3), y (1+3), facing (1+1), hp (1+1) = 19 B, plus 2 B of embedded-message header in
a repeated field = **~21 B against your 10 B**, so a 48-entity snapshot goes 490 B → ~1018 B,
3 packets → 6. Protobuf pays a tag byte per field and a varint that is *longer* than a fixed
u16 for scaled coordinates; a hand-rolled fixed-layout struct wins at this size and always
will. **HTTP/2 is worse than useless here:** 9 B of frame header plus 5 B of gRPC length
prefix per message on a 180-byte MTU, and there is no HTTP/2 stack available over a GATT
characteristic — `grpc-web` needs fetch/XHR, `@grpc/grpc-js` needs Node's http2. You would
write a custom transport shim, which is precisely what `bleTransport.ts` + `chunkedStream.ts`
already are, only now carrying ~250 KB (protobufjs) to ~1 MB (grpc-js) of runtime into a PWA
that phones download over the air. The real answer to "can we use less bandwidth" is §5.

---

## 5. Where the bytes actually are, and what each option really costs

[repo] 8-player budget per peer: Snapshot ~4.9 KB/s (61%), State ~1.65 KB/s (21%), Events
~1.4 KB/s (17%); 53 packets/s per peer at the 180 B MTU.

| Option | Byte effect | Recovery cost | Complexity |
|---|---|---|---|
| **Binary `StateMsg` + mission text on change** | 355 B → **~56 B** at 8 players [computed]; **−1.5 KB/s and −8 pkt/s per peer** | **none** — same cadence, still periodic full state | medium; protocol version bump |
| **Binary `hit` event + drop `aiGoal`** | Events lane **−84%** [measured] ≈ **−1.2 KB/s per peer** | **none** — cosmetic lane, see §2(b) | low |
| **Quantise position to 12 bits/axis** | 10 → **9 B/entity**, −10% of the snapshot lane | **none** — still full state; max error 1/16 tile, invisible under `SMOOTH=0.45` | low; version bump |
| **Delta vs last acked + keyframe** | **184 B → 51 B, −72%** [measured] | **high — this is the one that trades away self-healing** | high |
| **protobuf / gRPC** | 10 → ~21 B/entity, **+110%** | worse | high |

**On `StateMsg`, the specifics.** [measured] 355 B for two players decomposes as: huds **157 B**
(**79 B per player**), JSON keys and punctuation **125 B**, `missionText` **44 B**
(`"Purge the Mireclaw Alpha in the cargo hold"` — resent twice a second, unchanged, for the
whole floor), and ~29 B of everything else. At 8 players the huds term alone is ~632 B. A
binary form — floor u8, alarm u8, a flags byte for missionComplete/gameOver/alert/mode,
revivesLeft u8, missionTargetId u16, then 6 B per player (cash u16, weapon index u8,
abilityCd u8, bandages u8, flags u8) — is **7 + 48 = 55 B plus the type byte** [computed], and
`missionText` becomes a change-only reliable message exactly like `InventoryMsg` already is.
**One packet instead of five.** On BLE, connection-event slots bind before bytes do, so
dropping 8 packets/s per peer out of a measured 53 is worth more than the byte figure suggests.

**On the Events lane, the specifics.** [measured] Over 900 ticks (30 s of sim), 79 `EventsMsg`
carried 82 events totalling 6070 B of bodies: **`hit` 67 events / 5107 B / 84.1%**, `aiGoal`
7 / 515 B / 8.5%, `doorToggle` 6 / 294 B / 4.8%, `shatter` 1 / 78 B, `death` 1 / 76 B. A single
hit is `{"type":"hit","x":43.5,"y":26.5,"targetId":17,"amount":…}` — **~76 B of JSON for four
numbers**, where type u8 + x u16 + y u16 + targetId u16 + amount u8 is **8 B**. Binarising just
`hit` and dropping `aiGoal` (emitted for AI legibility; consumed by nothing outside `ai.ts`,
`behaviors.ts`, `infection.ts`, `mireclaw.ts` — no renderer, HUD or client path reads it) takes
the lane from 6070 B to ~984 B, **−84%**. [repo] Events are ~1.4 KB/s per peer on a busy floor,
so this is ~1.2 KB/s per peer. It is also the lane that [repo] `6330634` measured firing on
**40.3% of ticks (~12 Hz) at ~167 B each ≈ 2.0 KB/s per peer** during combat — i.e. the exact
traffic that starved the snapshot lane to **zero** before `RELIABLE_BURST` was added. Making it
84% smaller attacks that starvation at the source rather than rationing around it.

**On delta encoding — read this before you reach for it.** [measured] **79.6% of entity records
are byte-identical to the previous snapshot** (3012 of 3782 over 218 snapshots), because a room
full of tables and chairs does not move. A delta snapshot of 10 B header + 6 B present-bitmap +
~3.5 changed × 10 B is **51 B against 184 B, 72% smaller**. That is the biggest byte win
available and it is also **the one option that cuts directly against what you are asking for**:
the moment a snapshot is a delta, a client that misses one is *wrong until the next keyframe*,
and you must then build the ack, the keyframe cadence and the gap-detection machinery in §6
just to get back to where you are today for free. **Do options 1–3 first.** They give you
roughly 25–30% of the budget with zero recovery cost. Only if that is still not enough should
delta encoding be on the table, and then only *after* §6 lands, because §6 is its prerequisite.

---

## 6. Protocol-level recovery: what to build, costed

### 6.1 Re-answer a duplicate `Hello` (do this first)

**The failure.** `netHost.ts` guards re-admission with `if (p.slot >= 0) return`. That guard is
correct and must stay — the comment above it documents real attacks it closes. But it means a
client whose `Welcome` was lost can never get another one: the host has already admitted it, so
the retry is silently discarded. `netClient.onConnected` sends `Hello` exactly once per
transport connect. So **a single lost packet in the admission triple is permanent**:

- lost `Welcome` → client stuck in `connecting` forever
- lost `GameStart` → stuck in `lobby`
- lost `Go` → stuck in `starting`

[measured] Join reliability, 16 independent joins per loss level, with the host still
simulating for 4 extra seconds to give the client every chance to dig itself out:

| loss | reached `playing` | failed | how |
|---|---|---|---|
| 0%  | 16/16 | 0%  | — |
| 2%  | 15/16 | 6%  | Hello lost ×1 |
| 5%  | 14/16 | 13% | Hello lost ×2 |
| 10% | 12/16 | **25%** | Hello lost ×1, stuck in `starting` ×3 |
| 20% | 11/16 | 31% | stuck in `starting` ×4, Hello lost ×1 |
| 30% | 8/16  | **50%** | Hello lost ×7, stuck in `starting` ×1 |

**None of them recovered.** This is the worst failure class in the protocol: silent, permanent,
and it happens at the moment a friend is standing next to you trying to join.

**The fix.** Make the admission *idempotently re-answerable*. On a `Hello` from a peer that
already holds a slot, do **not** re-admit (keep the guard's protections) — instead re-send that
peer's current `Welcome` + `GameStart` + `Go` for the slot it already has. Pair it with a
client-side retry: if no `Welcome` within ~1 s, or no `Go` within ~2 s of `GameStart`, re-send
`Hello`. Back off, cap the attempts.

**Cost.** **0 bytes** in the healthy case. 196 B when a client actually re-asks. ~20 lines
across `netHost.handleMessage` and `netClient`. No protocol version bump — `Hello` already
exists and the client already knows all three replies.

**Proof.** `e2e/net-recovery-probes.mts --probe a` (written, in this branch) must go to 16/16 at
every loss level up to 30%. It currently reports the table above, so it is already a red test
you can watch go green.

### 6.2 A client watchdog on host silence

**The failure.** The client has no notion of "the host has gone quiet". `phase` changes only on
transport events, so when the link is up but nothing is arriving — the [repo] issue #34 case
(`lastAckedSeq 82 then frozen, 0 entities, 0 streamDesyncs, 181 packets` while the host was at
seq 1160), a paused host app, a phone that slept — the player stares at a frozen world with no
indication and no action available.

**The fix.** Track the wall-clock time of the last *any* message. The host already sends
`StateMsg` at 2 Hz to every peer, so **you already have a heartbeat — nothing is timing it**.
After ~1.5 s of total silence while `phase === 'playing'`, surface it in the mission-text line
(the `reconnecting` string already proves that path works) and re-send `Hello`, which §6.1 has
just made a resync request. After ~10 s, treat it as a drop and enter the existing reconnect
loop.

**Cost.** **0 bytes.** It is pure client-side timing over messages already on the wire. The
"heartbeat" and "liveness distinguishable from a stalled host" items in your brief are the same
item, and they are already paid for.

**Proof.** `net-conditions.mts --only out-of-range-3s` already blackholes the link with both
ends believing they are connected; assert the client reports the stall within 2 s and recovers
without a reconnect. Extend the blackhole to 20 s to separate "stall" from "drop".

### 6.3 Free gap detection, and read the backpressure counter you already have

**The fix.** Snapshots are emitted on `world.tick % 3 === 0`, so consecutive snapshot ticks
differ by exactly `SNAPSHOT_INTERVAL_TICKS`. The client already keeps `lastSnapTick`. Therefore
`missed = (tick - lastSnapTick) / 3 - 1` is an exact count of lost snapshots for
**zero bytes** — no sequence field needed, the tick *is* the sequence number. Expose it next to
the existing `streamDesyncs` counter, and expose `SendQueue.overwrites` on the host, which is
already computed and today read only by a test.

**What it buys.** It turns invisible degradation into a number, which is what you need before
you can honestly evaluate anything in §5 on real phones rather than in a model. It also gives
the §6.2 watchdog a better trigger than wall-clock silence alone, and it distinguishes *radio
loss* (gaps, no overwrites) from *oversubscription* (overwrites climbing) — which are opposite
problems with opposite fixes.

**Cost.** 0 bytes, ~15 lines. **Proof.** Run `net-loss-accounting.mts` at a known loss rate; the
client's reported missed-snapshot count must match the harness's dropped-packet accounting.

### 6.4 Fix the client-side input-sequence wrap

**The failure.** `encodeInput` masks `cmd.seq & 0xffff`, and the host handles the wrap correctly
(`cmd.seq > p.lastInputSeq || p.lastInputSeq - cmd.seq > 30000`, pinned by `netCoop.test.ts`).
But `netClient.inputSeq` is **never masked**, while `lastAckedSeq` comes off the wire as u16 and
can never exceed 65535. So the prune
`pendingInputs.filter(p => p.seq > this.lastAckedSeq)` stops pruning forever once the counter
passes 2^16 — at 30 Hz, **36.4 minutes** into a session.

[measured] I reproduced it on `origin/main`: backlog **4 → pinned at the 60 cap**, so
`reconcile()` replays **60 inputs (~2.0 s, ~9 tiles) on every snapshot**, ten times a second,
for the rest of the run. The avatar rubber-bands permanently.

**The fix.** Compare with serial arithmetic, exactly as `isNewerTick` already does for the u32
snapshot tick — the pattern is in the file, it just was not applied here. Or mask the client's
counter to u16 and compare with the same wrap tolerance the host uses.

**Cost.** **0 bytes**, a few lines. **Proof.** `net-recovery-probes.mts --probe b` (written,
in this branch) reports the pinned backlog today; it must report ~4 after the fix. It is a
ready-made red test.

### 6.5 Idempotent event application — not needed *yet*, and that is worth knowing

Events carry no sequence number, and a duplicate would double-apply. Today that is fine: the
framing resync **discards**, it never duplicates, and there is no retransmission anywhere. But
**the moment you add ARQ to any lane (§6.1 is a mild form), replays become possible**, so the
rule to adopt now is: an event must be safe to apply twice. `floorChange` already is
(`changeFloor` is monotonic). `EventsMsg` already carries a `tick`, which is enough to dedup
against if you ever need it. **Cost: 0 bytes today.** Just do not add a retransmit without
checking this first.

### 6.6 Guard the render loop — the easier half is not the half that is broken

Your brief says it exactly right, so I want to be concrete: `src/main.ts:792–867` is
`const frame = (now) => { ...; requestAnimationFrame(frame) }`, with the reschedule as the
**last statement** and **no try/catch anywhere in the body**. One throw out of `session.tick()`,
`renderer.draw()`, `hud.update()`, `screens.update()` — any of them — and rAF is never
rescheduled. Rendering ends permanently and nothing in the repo restarts it; there is no
watchdog anywhere on any branch. The message handlers on both host and client were hardened
with try/catch (`611ebda`, after the #57 follow-up), so the *protocol* survives a hostile
packet — and then the *renderer* dies to an unrelated bug and the player sees exactly the same
thing: a frozen screen.

**The fix.** Wrap the frame body; always reschedule in a `finally`; count consecutive throws and
surface a message rather than spinning silently. **Cost: 0 bytes, ~10 lines.** This is not a
protocol change, which is precisely why it is on this list — a protocol that recovers from
packet loss but not from a client exception has solved the easier half.

---

## 7. Priority list

| # | Change | Buys | Bytes | Complexity | Proof |
|---|---|---|---|---|---|
| 1 | Re-answer duplicate `Hello`; client re-asks (§6.1) | 25% of joins at 10% loss stop failing permanently | 0 steady, 196 B on retry | low | `--probe a` 12/16 → 16/16 |
| 2 | Guard the render loop (§6.6) | One exception stops killing the session | 0 | low | throw on purpose in `frame`; loop must survive |
| 3 | Fix client input-seq wrap (§6.4) | No permanent rubber-band at 36.4 min | 0 | trivial | `--probe b` backlog 60 → ~4 |
| 4 | Silence watchdog + gap counter + expose `overwrites` (§6.2, §6.3) | Frozen worlds become visible and self-requesting | 0 | low | blackhole profile; counter vs harness |
| 5 | Binary `hit` event, drop `aiGoal` (§5) | Events lane −84%; attacks the starvation source | −1.2 KB/s | low + version bump | `net-loss-accounting.mts` before/after |
| 6 | Binary `StateMsg` + mission text on change (§5) | ~1.5 KB/s and ~8 pkt/s per peer | −1.5 KB/s | medium + version bump | `net-loss-accounting.mts` before/after |
| 7 | 12-bit position quantisation (§5) | −10% of the snapshot lane | −1 B/entity | low + version bump | `net-conditions.mts` full matrix stays green |
| 8 | Delta encoding + keyframes (§5) | −72% of the snapshot lane | −133 B/snapshot | **high** | only after 1–7; needs §6.3 first |
| — | ~~FEC / parity~~ | nothing measurable | +33% | — | rejected, §3 |
| — | ~~gRPC / protobuf~~ | negative | +110% | — | rejected, §4 |

Items 1–4 are **zero bytes** and fix permanent, silent, player-visible failures. Items 5–6 are
the real bandwidth answer and together return ~31% of the budget at no cost to recovery. Item 8
is the only thing that trades self-healing for size, and it should be last, not first.

---

## Appendix: reproducing the measurements

Two analysis tools were added on this branch (`docs/protocol-resilience`). They are measurement
instruments, not gates — delete them if you would rather not carry them.

```bash
# Per-message-type loss accounting, wire sizes, desync collateral, snapshot gap distribution
npx tsx e2e/net-loss-accounting.mts --loss 0,2,5,10,30 --seconds 30

# A) join reliability sweep  B) input-seq wrap  C) delta-encoding headroom
npx tsx e2e/net-recovery-probes.mts --probe abc

# The existing harness, unchanged — and prove it can go red
npx tsx e2e/net-conditions.mts
npx tsx e2e/net-conditions.mts --self-test
```

**Measured here:** all per-type loss and wire sizes, the 0.64–0.85 amplification, snapshot gap
distributions, join failure rates, the seq-wrap backlog, the 79.6% unchanged-record figure, the
`StateMsg` byte decomposition, and the per-event-type share of the Events lane.
**From repo history (cited):** the 8-player 56–63 KB/s budget and lane split, 53 packets/s per
peer, the 0-snapshots-in-60-ticks starvation, issue #34 field data.
**Computed, not measured:** protobuf sizing, FEC probabilities, the 56 B binary `StateMsg`.
Everything computed is shown as arithmetic so it can be checked or disagreed with.

**One caveat on the model.** The link model is a single host↔client pair. It reproduces MTU,
pacing, latency, jitter, loss and ordering faithfully, but it does **not** reproduce contention
between 7 centrals on one Android peripheral's radio. Every conclusion here about
*oversubscription* leans on the repo's own 8-player measurements, not mine. The join-reliability
and seq-wrap findings do not depend on that at all.
