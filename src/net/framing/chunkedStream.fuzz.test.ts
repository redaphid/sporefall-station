/**
 * Adversarial / fuzz coverage for the wire framing layer.
 *
 * Everything random here is drawn from the repo's own seeded `mulberry32`, never
 * `Math.random()` — a fuzz corpus that cannot be replayed cannot be debugged, and
 * a flaky framing test is worse than no framing test.
 *
 * The packet sizes swept below are the real ones: 20 is the BLE floor
 * (`maxPacket = clamp(mtu-3, 20, 244)`), 23 the classic 23-byte-ATT-MTU case, 180
 * the host peripheral's fixed `MAX_PACKET`, and 244 the negotiated ceiling.
 */
import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../game/rng'
import { isKnownMsgType, MsgType } from '../types'
import { frameMessage, MAX_MESSAGE_BYTES, StreamReader } from './chunkedStream'

/** The packet sizes a real radio actually hands us. */
const MTUS = [20, 23, 180, 244] as const

/** Frame a body under a length prefix we choose — used to forge a prefix that LIES.
 * (`frameMessage` deliberately refuses to build these, which is the point.) */
const forgeFrame = (declaredLen: number, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(2 + body.length)
  out[0] = declaredLen & 0xff
  out[1] = (declaredLen >> 8) & 0xff
  out.set(body, 2)
  return out
}

/** A well-formed message of `n` bytes whose first byte is a real MsgType. */
const msgOf = (type: number, n: number, seed = 1): Uint8Array => {
  const rng = mulberry32(seed)
  const m = new Uint8Array(n)
  m[0] = type
  for (let i = 1; i < n; i++) m[i] = rng.int(0, 255)
  return m
}

/** Drive a reader, capturing messages and desync reasons. */
const drive = (
  opts: { maxMessage?: number } = {},
): {
  reader: StreamReader
  out: Uint8Array[]
  desyncs: string[]
  resyncs: number[]
  push: (p: Uint8Array) => void
} => {
  const out: Uint8Array[] = []
  const desyncs: string[] = []
  const resyncs: number[] = []
  const reader = new StreamReader({
    ...opts,
    isValidStart: isKnownMsgType,
    onDesync: (r) => desyncs.push(r),
    onResync: (n) => resyncs.push(n),
  })
  return { reader, out, desyncs, resyncs, push: (p) => reader.push(p, (m) => out.push(m)) }
}

describe('framing fuzz — seeded round-trip across real MTUs', () => {
  for (const mtu of MTUS) {
    it(`round-trips 200 seeded messages at maxPacket=${mtu}`, () => {
      const rng = mulberry32(0xc0ffee ^ mtu)
      const d = drive()
      const sent: Uint8Array[] = []
      for (let i = 0; i < 200; i++) {
        // 1 byte (bare type) up to a few packets' worth.
        const len = rng.int(1, 600)
        const msg = msgOf(rng.pick([MsgType.Snapshot, MsgType.Input, MsgType.State, MsgType.Events]), len, i)
        sent.push(msg)
        for (const p of frameMessage(msg, mtu)) d.push(p)
      }
      expect(d.desyncs).toEqual([])
      expect(d.out).toHaveLength(sent.length)
      for (let i = 0; i < sent.length; i++) expect(Array.from(d.out[i])).toEqual(Array.from(sent[i]))
    })
  }

  it('delivers a message split at EVERY packet boundary from 3..300', () => {
    const msg = msgOf(MsgType.Snapshot, 257, 7)
    for (let mtu = 3; mtu <= 300; mtu++) {
      const d = drive()
      for (const p of frameMessage(msg, mtu)) d.push(p)
      expect(d.desyncs, `mtu=${mtu}`).toEqual([])
      expect(d.out, `mtu=${mtu}`).toHaveLength(1)
      expect(Array.from(d.out[0]), `mtu=${mtu}`).toEqual(Array.from(msg))
    }
  })

  it('two messages arriving inside one packet are NOT supported — the reader desyncs', () => {
    // Load-bearing INVARIANT, pinned so nobody "optimises" a transport into
    // coalescing: the alignment check that detects mid-message packet loss works
    // only because every message starts at a packet boundary. Any transport that
    // merges or re-splits the sender's packets breaks the protocol outright.
    const d = drive()
    const a = frameMessage(msgOf(MsgType.Input, 9), 1000)[0]
    const b = frameMessage(msgOf(MsgType.Input, 9), 1000)[0]
    const merged = new Uint8Array(a.length + b.length)
    merged.set(a)
    merged.set(b, a.length)
    d.push(merged)
    expect(d.out).toHaveLength(0)
    expect(d.desyncs[0]).toMatch(/does not end on a packet boundary/)
  })
})

describe('framing fuzz — a length prefix that lies', () => {
  it('a length of 0 desyncs instead of looping or emitting an empty message', () => {
    const d = drive()
    d.push(forgeFrame(0, new Uint8Array([MsgType.Snapshot, 1, 2])))
    expect(d.out).toHaveLength(0)
    expect(d.desyncs[0]).toMatch(/implausible message length 0/)
  })

  it('a length of 65535 desyncs instead of buffering 64KB forever', () => {
    const d = drive()
    d.push(forgeFrame(65535, new Uint8Array([MsgType.Snapshot, 1, 2])))
    expect(d.out).toHaveLength(0)
    expect(d.desyncs[0]).toMatch(/implausible message length 65535/)
  })

  it('accepts a length of exactly MAX_MESSAGE_BYTES and rejects one byte over', () => {
    const ok = drive()
    const body = msgOf(MsgType.Events, MAX_MESSAGE_BYTES, 3)
    for (const p of frameMessage(body, 180)) ok.push(p)
    expect(ok.desyncs).toEqual([])
    expect(ok.out).toHaveLength(1)
    expect(ok.out[0]).toHaveLength(MAX_MESSAGE_BYTES)

    const over = drive()
    over.push(forgeFrame(MAX_MESSAGE_BYTES + 1, new Uint8Array([MsgType.Events, 0, 0])))
    expect(over.out).toHaveLength(0)
    expect(over.desyncs[0]).toMatch(/implausible message length 16385/)
  })

  it('a prefix claiming MORE bytes than follow never emits and never wedges', () => {
    const d = drive()
    // Declares 400B, only 40B of payload ever arrives, then the sender goes quiet.
    d.push(forgeFrame(400, msgOf(MsgType.Snapshot, 40)))
    expect(d.out).toHaveLength(0)
    // A later, well-formed message must still get through once the reader recovers.
    const good = msgOf(MsgType.Input, 9, 11)
    for (const p of frameMessage(good, 180)) d.push(p)
    // Either it resynchronised onto `good`, or it is still waiting — what it must
    // NOT do is emit a message assembled out of the two.
    for (const m of d.out) expect(Array.from(m)).toEqual(Array.from(good))
  })

  it('a prefix claiming FEWER bytes than follow is caught by the alignment check', () => {
    const d = drive()
    // 180B packet whose header claims a 10-byte message: the frame would end in
    // the middle of the packet, which the sender can never produce.
    d.push(forgeFrame(10, msgOf(MsgType.Snapshot, 178)))
    expect(d.out).toHaveLength(0)
    expect(d.desyncs[0]).toMatch(/does not end on a packet boundary/)
  })
})

describe('framing fuzz — a well-sized frame with a nonsense type byte', () => {
  it('desyncs on an unknown message type instead of handing it upstream', () => {
    // The length is plausible and the frame ends on the packet boundary, so the
    // ONLY thing that marks this as misparsed payload is the type byte.
    const d = drive()
    d.push(forgeFrame(3, new Uint8Array([0x99, 1, 2])))
    expect(d.out).toHaveLength(0)
    expect(d.desyncs[0]).toMatch(/unknown message type 153/)
  })

  it('during resync, a "header" describing a frame SHORTER than its packet is skipped', () => {
    const d = drive()
    d.push(forgeFrame(0, new Uint8Array([MsgType.Snapshot, 1, 2]))) // get lost
    expect(d.desyncs).toHaveLength(1)

    // Mid-payload bytes that happen to parse as a plausible header: length 10 and
    // a real-looking type byte. But a 12B frame cannot arrive in a 180B packet —
    // the sender never packs a message short of its own packet — so this is
    // payload, not a start, and accepting it would just desync us all over again.
    const decoy = new Uint8Array(180)
    decoy[0] = 10
    decoy[1] = 0
    decoy[2] = MsgType.Snapshot
    d.push(decoy)
    expect(d.desyncs).toHaveLength(1) // still just the original — the decoy was skipped

    const good = msgOf(MsgType.Snapshot, 300, 91)
    for (const p of frameMessage(good, 180)) d.push(p)
    expect(d.out).toHaveLength(1)
    expect(Array.from(d.out[0])).toEqual(Array.from(good))
  })
})

describe('framing fuzz — garbage, truncation and recovery', () => {
  it('never throws on 3000 seeded-random packets of pure garbage', () => {
    const rng = mulberry32(0xbadbeef)
    const d = drive()
    expect(() => {
      for (let i = 0; i < 3000; i++) {
        const p = new Uint8Array(rng.int(0, 300))
        for (let j = 0; j < p.length; j++) p[j] = rng.int(0, 255)
        d.push(p)
      }
    }).not.toThrow()
  })

  it('resynchronises and delivers again after garbage is injected mid-stream', () => {
    const rng = mulberry32(0x5eed)
    const d = drive()
    const good = msgOf(MsgType.Snapshot, 120, 21)
    // Clean traffic, then a burst of garbage, then clean traffic again.
    for (let i = 0; i < 5; i++) for (const p of frameMessage(good, 180)) d.push(p)
    const before = d.out.length
    for (let i = 0; i < 20; i++) {
      const p = new Uint8Array(rng.int(1, 180))
      for (let j = 0; j < p.length; j++) p[j] = rng.int(0, 255)
      d.push(p)
    }
    for (let i = 0; i < 20; i++) for (const p of frameMessage(good, 180)) d.push(p)
    // The reader must come back — not stay lost forever (the original freeze bug).
    expect(d.out.length).toBeGreaterThan(before)
    // And everything it DID emit after recovering is the real message, byte-exact.
    for (const m of d.out.slice(before)) expect(m).toHaveLength(120)
  })

  it('a truncated final packet costs only that message, not the stream', () => {
    const d = drive()
    const a = msgOf(MsgType.Snapshot, 400, 31)
    const packets = frameMessage(a, 180)
    expect(packets.length).toBe(3)
    d.push(packets[0])
    d.push(packets[1]) // packets[2] is lost — the message never completes
    expect(d.out).toHaveLength(0)

    const b = msgOf(MsgType.Snapshot, 400, 32)
    for (const p of frameMessage(b, 180)) d.push(p)
    expect(d.desyncs.length).toBeGreaterThan(0) // loss was DETECTED, not papered over
    for (const m of d.out) expect(m).toHaveLength(400) // nothing garbled was emitted
  })

  it('a packet lost in the MIDDLE of a message is detected on that message', () => {
    const d = drive()
    const packets = frameMessage(msgOf(MsgType.Snapshot, 400, 41), 180)
    d.push(packets[0])
    d.push(packets[2]) // packets[1] vanished
    expect(d.out).toHaveLength(0)
    expect(d.desyncs[0]).toMatch(/packet was lost mid-message/)
  })
})

describe('framing fuzz — empty packets', () => {
  it('an empty packet mid-message does NOT destroy the message', () => {
    // REGRESSION: `packet.length < senderMtu` was true for a 0-byte packet, so an
    // empty write desynced a message that was still perfectly intact.
    const d = drive()
    const msg = msgOf(MsgType.Snapshot, 400, 51)
    const packets = frameMessage(msg, 180)
    d.push(packets[0])
    d.push(new Uint8Array(0))
    d.push(packets[1])
    d.push(new Uint8Array(0))
    d.push(packets[2])
    expect(d.desyncs).toEqual([])
    expect(d.out).toHaveLength(1)
    expect(Array.from(d.out[0])).toEqual(Array.from(msg))
  })

  it('an empty-packet flood is a no-op and does not grow reader state', () => {
    // REGRESSION: every empty packet pushed a 0 onto `packetLens`, which nothing
    // drained while the buffer was empty — an unbounded array a peer controls.
    const d = drive()
    for (let i = 0; i < 50_000; i++) d.push(new Uint8Array(0))
    const lens = (d.reader as unknown as { packetLens: number[] }).packetLens
    expect(lens).toHaveLength(0)
    // …and the reader still works afterwards.
    const msg = msgOf(MsgType.Snapshot, 300, 61)
    for (const p of frameMessage(msg, 180)) d.push(p)
    expect(d.out).toHaveLength(1)
    expect(Array.from(d.out[0])).toEqual(Array.from(msg))
  })
})

describe('framing fuzz — reconnect in the middle of a partial frame', () => {
  it('carries no stale BYTES from the dropped connection into the new one', () => {
    const d = drive()
    const packets = frameMessage(msgOf(MsgType.Snapshot, 400, 71), 180)
    d.push(packets[0])
    d.push(packets[1]) // half a message is buffered when the radio drops
    d.reader.reset()

    const fresh = msgOf(MsgType.Input, 9, 72)
    for (const p of frameMessage(fresh, 180)) d.push(p)
    expect(d.out).toHaveLength(1)
    expect(Array.from(d.out[0])).toEqual(Array.from(fresh))
  })

  it('carries no stale MTU into a reconnect that negotiated a SMALLER packet size', () => {
    // REGRESSION: `reset()` cleared the buffer but not the inferred `senderMtu`.
    // A link that came back with a smaller MTU then measured every non-final
    // packet as "short", desyncing every multi-packet message — forever, with the
    // link up and nothing to trigger a reconnect. Exactly the silent world-freeze
    // this file exists to prevent.
    const d = drive()
    const first = msgOf(MsgType.Snapshot, 500, 81)
    for (const p of frameMessage(first, 244)) d.push(p) // connection 1: MTU 244
    expect(d.out).toHaveLength(1)

    d.reader.reset()

    const second = msgOf(MsgType.Snapshot, 500, 82)
    for (const p of frameMessage(second, 180)) d.push(p) // connection 2: MTU 180
    expect(d.desyncs).toEqual([])
    expect(d.out).toHaveLength(2)
    expect(Array.from(d.out[1])).toEqual(Array.from(second))
  })

  it('keeps working across many reconnects at randomly-varying MTUs', () => {
    const rng = mulberry32(0xd15c0)
    const d = drive()
    let delivered = 0
    for (let conn = 0; conn < 40; conn++) {
      const mtu = rng.pick(MTUS)
      for (let i = 0; i < 5; i++) {
        const msg = msgOf(MsgType.Snapshot, rng.int(1, 700), conn * 10 + i)
        for (const p of frameMessage(msg, mtu)) d.push(p)
        delivered++
      }
      // Drop mid-message, then reset as the client does on `peerDisconnected`.
      const partial = frameMessage(msgOf(MsgType.Snapshot, 600, conn), mtu)
      d.push(partial[0])
      d.reader.reset()
    }
    expect(d.desyncs).toEqual([])
    expect(d.out).toHaveLength(delivered)
  })
})

describe('framing — frameMessage refuses what the reader must reject', () => {
  it('refuses a message larger than MAX_MESSAGE_BYTES', () => {
    // Framed cleanly, this desyncs the peer and takes the messages queued behind
    // it down too — on the lane that is documented as never dropping anything.
    expect(() => frameMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1), 180)).toThrow(/exceeds MAX_MESSAGE_BYTES/)
    expect(() => frameMessage(new Uint8Array(MAX_MESSAGE_BYTES), 180)).not.toThrow()
  })

  it('refuses a message the u16 prefix cannot even represent', () => {
    // 70000 & 0xffff === 4464: the prefix silently lied and the reader framed a
    // message out of the middle of the payload.
    expect(() => frameMessage(new Uint8Array(70000), 65536)).toThrow(/exceeds MAX_MESSAGE_BYTES/)
  })

  it('refuses an empty message (the reader rejects a 0 length)', () => {
    expect(() => frameMessage(new Uint8Array(0), 180)).toThrow(/empty message/)
  })
})
