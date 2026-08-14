/**
 * A malicious or simply broken client must not be able to take the host down.
 *
 * The host is the sole simulator: if a peer can make it throw, hang, or nudge
 * world state, every other player in the run pays for it. These tests stream
 * hostile bytes straight at `NetHostSession` and assert the world it produces is
 * BYTE-IDENTICAL to the world it would have produced with no attacker present.
 *
 * Seeded `mulberry32` throughout — a fuzz corpus that cannot be replayed cannot
 * be debugged.
 */
import { describe, expect, it } from 'vitest'
import { NetHostSession } from './netHost'
import { serializeWorld } from '../game/serialize'
import { mulberry32 } from '../game/rng'
import { emptyInput } from '../game/types'
import type { InputSource } from '../input/input'
import { encodeJson } from '../net/framing/codec'
import { frameMessage, MAX_MESSAGE_BYTES, StreamReader } from '../net/framing/chunkedStream'
import { encodeInput, encodeSnapshot } from '../net/protocol/messages'
import { isKnownMsgType, MsgType, PROTOCOL_VERSION, type PeerId, type Transport, type TransportEvent } from '../net/types'

const stubInput: InputSource = { sample: () => ({ ...emptyInput() }) }

const makeHostTransport = (): {
  transport: Transport
  connect: (peer: PeerId) => void
  disconnect: (peer: PeerId) => void
  inject: (peer: PeerId, bytes: Uint8Array) => void
  sentTo: (peer: PeerId) => Uint8Array[]
} => {
  let handler: ((e: TransportEvent) => void) | undefined
  const peers = new Set<PeerId>()
  const sent = new Map<PeerId, Uint8Array[]>()
  const transport: Transport = {
    role: 'host',
    maxPacket: 180,
    start: async () => {},
    stop: async () => {},
    sendPacket: async (peer, bytes) => {
      const list = sent.get(peer) ?? []
      list.push(bytes)
      sent.set(peer, list)
    },
    on: (h) => {
      handler = h
      return () => {}
    },
    peers: () => [...peers],
  }
  return {
    transport,
    connect: (peer) => {
      peers.add(peer)
      handler?.({ type: 'peerConnected', peer })
    },
    disconnect: (peer) => {
      peers.delete(peer)
      handler?.({ type: 'peerDisconnected', peer, reason: 'remote' })
    },
    inject: (peer, bytes) => handler?.({ type: 'data', peer, bytes }),
    sentTo: (peer) => sent.get(peer) ?? [],
  }
}

const startedHost = (seed = 4242): ReturnType<typeof makeHostTransport> & { host: NetHostSession } => {
  const t = makeHostTransport()
  const host = new NetHostSession(seed, 'Host', stubInput, t.transport)
  host.beginGame()
  return { ...t, host }
}

/** Every hand-crafted hostile message we know how to build. */
const hostileMessages = (): Uint8Array[] => [
  new Uint8Array([]), // nothing at all
  new Uint8Array([MsgType.Input]), // type byte only — decodeInput reads past the end
  new Uint8Array([MsgType.Input, 0, 0]), // truncated mid-header
  new Uint8Array([MsgType.Input, 255, 255, 255, 255, 255, 255, 255, 255]), // every field maxed
  new Uint8Array([MsgType.Input, 0, 0, 0, 0, 0, 0, 0, 0]), // every field zeroed
  new Uint8Array([MsgType.Snapshot, 0, 0, 0, 0, 0, 0, 0, 0, 255]), // client sending the host a snapshot
  new Uint8Array([MsgType.Hello]), // JSON type with an empty body
  new Uint8Array([MsgType.Hello, 0x7b, 0xff, 0xfe]), // JSON type with garbage body
  encodeJson(MsgType.Hello, { v: 999, name: 'x' }), // wrong protocol version
  encodeJson(MsgType.Hello, null), // valid JSON, wrong shape
  encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'x'.repeat(4000) }), // absurd name
  encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'x', rejoin: { slot: -5, token: 'nope' } }),
  encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'x', rejoin: { slot: 9999, token: 'nope' } }),
  encodeJson(MsgType.Ready, {}),
  encodeJson(MsgType.Go, { startTick: -1, entityIds: { 0: 999999 } }), // host→client message, sent backwards
  encodeJson(MsgType.State, { gameOver: true }), // a client trying to declare the run over
  encodeJson(MsgType.Inventory, { slot: 0, inventory: null, activeSlot: -99, weapon: 42 }),
  new Uint8Array([0x00, 1, 2, 3]), // reserved type 0
  new Uint8Array([0xff, 1, 2, 3]), // type 255
]

describe('hostile peer — the host survives hand-crafted messages', () => {
  it('never throws on any hand-crafted hostile message', () => {
    for (const [i, msg] of hostileMessages().entries()) {
      const h = startedHost()
      h.connect('evil')
      expect(() => {
        // Hand-framed: `frameMessage` refuses an empty body, and a real attacker
        // is not obliged to use our framer anyway.
        const framed = new Uint8Array(2 + msg.length)
        framed[0] = msg.length & 0xff
        framed[1] = (msg.length >> 8) & 0xff
        framed.set(msg, 2)
        for (let off = 0; off < framed.length; off += 180) h.inject('evil', framed.subarray(off, off + 180))
        h.host.tick()
      }, `hostile message #${i}`).not.toThrow()
    }
  })

  it('rejects a wrong-version Hello without admitting the peer to the lobby', () => {
    const h = startedHost()
    h.connect('evil')
    for (const p of frameMessage(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION + 1, name: 'evil' }), 180)) {
      h.inject('evil', p)
    }
    expect(h.host.lobbyPlayers().map((p) => p.name)).toEqual(['Host'])
  })

  it('refuses a rejoin whose token is GUESSED, so a peer cannot steal an avatar', () => {
    // A real ghost has to exist for this to mean anything: a genuine player joins,
    // gets an avatar, then drops mid-game. Their slot is held open for 90s — and
    // the ONLY thing protecting it is the rejoin token.
    const t = makeHostTransport()
    const host = new NetHostSession(2024, 'Host', stubInput, t.transport)
    t.connect('victim')
    for (const p of frameMessage(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Victim' }), 180)) {
      t.inject('victim', p)
    }
    host.beginGame()
    const victimSlot = host.lobbyPlayers().find((p) => p.name === 'Victim')?.slot
    expect(victimSlot).toBe(1)
    const victimEntity = host.peersBySlot.get(1)?.entityId
    expect(victimEntity).toBeDefined()

    t.disconnect('victim') // radio drop — the avatar is now a ghost
    expect(host.peersBySlot.has(1)).toBe(false)

    // The attacker knows the slot (it is in every LobbyState) but guesses the token.
    t.connect('thief')
    for (const guess of ['', 'token', '0', 'null', 'undefined', 'a'.repeat(32)]) {
      for (const p of frameMessage(
        encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Thief', rejoin: { slot: 1, token: guess } }),
        180,
      )) {
        t.inject('thief', p)
      }
    }
    // Not one guess may hand over the victim's slot or their avatar.
    expect(host.peersBySlot.has(1)).toBe(false)
    expect(host.lobbyPlayers().map((p) => p.name)).not.toContain('Thief')
  })

  it('counts a desync for a well-formed frame carrying an unknown type byte', () => {
    // The host wires `isValidStart: isKnownMsgType` into its reader. Without it a
    // frame whose length and alignment are plausible but whose type byte is
    // nonsense is handed upstream and silently ignored, so the stream is never
    // recognised as misparsed and the real resynchronisation is delayed.
    const h = startedHost()
    h.connect('evil')
    const framed = new Uint8Array([3, 0, 0x99, 1, 2]) // len 3, type 0x99, ends on the packet boundary
    h.inject('evil', framed)
    expect(h.host.streamDesyncs).toBe(1)
  })

  it('refuses a forged rejoin for a slot that never dropped', () => {
    const h = startedHost()
    h.connect('evil')
    for (const p of frameMessage(
      encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'evil', rejoin: { slot: 0, token: 'guessed' } }),
      180,
    )) {
      h.inject('evil', p)
    }
    // No ghost exists for slot 0 (the host owns it), so the rejoin must fail and
    // the peer must not end up holding the host's own avatar.
    expect(h.host.peersBySlot.has(0)).toBe(false)
  })
})

describe('hostile peer — the host survives a seeded garbage flood', () => {
  it('never throws on 5000 seeded-random packets', () => {
    const h = startedHost()
    h.connect('evil')
    const rng = mulberry32(0xdeadbeef)
    expect(() => {
      for (let i = 0; i < 5000; i++) {
        const p = new Uint8Array(rng.int(0, 200))
        for (let j = 0; j < p.length; j++) p[j] = rng.int(0, 255)
        h.inject('evil', p)
        if (i % 100 === 0) h.host.tick()
      }
    }).not.toThrow()
  })

  it('a garbage flood does not perturb world state by a single byte', () => {
    // The strongest form of "cannot corrupt the host": run the same seed twice,
    // once clean and once under attack, and demand identical serialized worlds.
    const clean = startedHost(777)
    for (let i = 0; i < 120; i++) clean.host.tick()
    const expected = JSON.stringify(serializeWorld(clean.host.world))

    const attacked = startedHost(777)
    attacked.connect('evil')
    const rng = mulberry32(0x5ca1ab1e)
    for (let i = 0; i < 120; i++) {
      for (let k = 0; k < 8; k++) {
        const p = new Uint8Array(rng.int(0, 200))
        for (let j = 0; j < p.length; j++) p[j] = rng.int(0, 255)
        attacked.inject('evil', p)
      }
      attacked.host.tick()
    }
    expect(JSON.stringify(serializeWorld(attacked.host.world))).toBe(expected)
  })

  it('WELL-FRAMED hostile messages reach the handler and still cannot perturb the world', () => {
    // The raw-garbage flood above is filtered out by the framing layer before it
    // ever reaches `handleMessage` — which is worth knowing, but means it does not
    // exercise the decoders at all. This corpus is correctly framed and carries a
    // REAL MsgType byte, so every message lands on the host's message handler.
    const corpus: Uint8Array[] = []
    const rng = mulberry32(0x0badf00d)
    const types = [MsgType.Input, MsgType.Snapshot, MsgType.Hello, MsgType.State, MsgType.Events, MsgType.Inventory, MsgType.Go, MsgType.Ready]
    for (let i = 0; i < 800; i++) {
      const body = new Uint8Array(rng.int(1, 120))
      body[0] = rng.pick(types)
      for (let j = 1; j < body.length; j++) body[j] = rng.int(0, 255)
      corpus.push(body)
    }

    // NON-VACUITY: prove this corpus actually gets through the framing layer,
    // rather than silently proving nothing the way raw garbage would.
    let delivered = 0
    const probe = new StreamReader({ isValidStart: isKnownMsgType })
    for (const m of corpus) for (const p of frameMessage(m, 180)) probe.push(p, () => delivered++)
    expect(delivered).toBe(corpus.length)

    const clean = startedHost(555)
    for (let i = 0; i < 100; i++) clean.host.tick()
    const expected = JSON.stringify(serializeWorld(clean.host.world))

    const attacked = startedHost(555)
    attacked.connect('evil')
    let k = 0
    for (let i = 0; i < 100; i++) {
      for (let n = 0; n < 8 && k < corpus.length; n++, k++) {
        for (const p of frameMessage(corpus[k], 180)) attacked.inject('evil', p)
      }
      attacked.host.tick()
    }
    expect(JSON.stringify(serializeWorld(attacked.host.world))).toBe(expected)
  })

  it('an UNAUTHENTICATED peer\'s input never reaches the simulation', () => {
    // A peer that connected but never completed a valid Hello still carries
    // slot -1, and `tick()` folds its command into the input map under that key.
    // No avatar has playerId -1, so the sim never reads it — pinned here because
    // the only thing standing between an unauthenticated peer and the sim is that
    // slot numbers start at 0.
    const clean = startedHost(1234)
    for (let i = 0; i < 60; i++) clean.host.tick()
    const expected = JSON.stringify(serializeWorld(clean.host.world))

    const attacked = startedHost(1234)
    attacked.connect('evil') // NOTE: no Hello — never admitted to the lobby
    for (let i = 0; i < 60; i++) {
      for (const p of frameMessage(
        encodeInput(
          { ...emptyInput(), seq: i + 1, moveX: 1, moveY: 1, attack: true, interact: true, special: true },
          { attack: true, interact: true, special: true, roll: true, throwItem: true },
        ),
        180,
      )) {
        attacked.inject('evil', p)
      }
      attacked.host.tick()
    }
    expect(attacked.host.lobbyPlayers().map((p) => p.name)).toEqual(['Host'])
    expect(JSON.stringify(serializeWorld(attacked.host.world))).toBe(expected)
  })

  it('an empty-packet flood neither throws nor perturbs the world', () => {
    const clean = startedHost(31337)
    for (let i = 0; i < 60; i++) clean.host.tick()
    const expected = JSON.stringify(serializeWorld(clean.host.world))

    const attacked = startedHost(31337)
    attacked.connect('evil')
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < 500; k++) attacked.inject('evil', new Uint8Array(0))
      attacked.host.tick()
    }
    expect(JSON.stringify(serializeWorld(attacked.host.world))).toBe(expected)
  })

  it('an oversized frame from a peer is contained and does not wedge the host', () => {
    const h = startedHost()
    h.connect('evil')
    // A frame declaring more than MAX_MESSAGE_BYTES: the reader must reject the
    // length rather than buffer toward it.
    const framed = new Uint8Array(2 + 300)
    framed[0] = (MAX_MESSAGE_BYTES + 1) & 0xff
    framed[1] = ((MAX_MESSAGE_BYTES + 1) >> 8) & 0xff
    framed[2] = MsgType.Input
    expect(() => {
      for (let off = 0; off < framed.length; off += 180) h.inject('evil', framed.subarray(off, off + 180))
    }).not.toThrow()
    expect(h.host.streamDesyncs).toBeGreaterThan(0)
  })
})

describe('hostile peer — one bad peer does not starve a good one', () => {
  it('a legitimate client still completes its handshake while a peer floods garbage', () => {
    const h = startedHost()
    h.connect('evil')
    h.connect('good')

    const rng = mulberry32(0xf00d)
    for (let i = 0; i < 500; i++) {
      const p = new Uint8Array(rng.int(0, 200))
      for (let j = 0; j < p.length; j++) p[j] = rng.int(0, 255)
      h.inject('evil', p)
    }

    for (const p of frameMessage(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob' }), 180)) {
      h.inject('good', p)
    }
    expect(h.host.lobbyPlayers().map((p) => p.name)).toContain('Bob')

    // …and its inputs still land after the flood.
    const seq = 5
    for (const p of frameMessage(
      encodeInput({ ...emptyInput(), seq, moveX: 1 }, { attack: false, interact: false, special: false }),
      180,
    )) {
      h.inject('good', p)
    }
    expect(() => h.host.tick()).not.toThrow()
  })

  it('a peer that desyncs mid-message recovers without a reconnect', () => {
    const h = startedHost()
    h.connect('good')
    for (const p of frameMessage(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob' }), 180)) {
      h.inject('good', p)
    }

    // Drop a packet out of the middle of a multi-packet message.
    const big = encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'B'.repeat(400) })
    const packets = frameMessage(big, 180)
    expect(packets.length).toBeGreaterThan(2)
    h.inject('good', packets[0])
    h.inject('good', packets[2]) // packets[1] lost
    expect(h.host.streamDesyncs).toBeGreaterThan(0)

    // The link never dropped; the reader must resynchronise in-band on the next
    // message. This is the freeze-forever bug chunkedStream.ts exists to prevent.
    const before = h.host.lobbyPlayers().length
    for (const p of frameMessage(encodeInput({ ...emptyInput(), seq: 9 }, { attack: false, interact: false, special: false }), 180)) {
      h.inject('good', p)
    }
    expect(() => h.host.tick()).not.toThrow()
    expect(h.host.lobbyPlayers().length).toBe(before)
  })
})

describe('hostile peer — a client cannot spoof the host-authored snapshot', () => {
  it('a Snapshot arriving from a client is ignored, not applied', () => {
    const h = startedHost(99)
    const before = h.host.world.entities.length
    h.connect('evil')
    const spoof = encodeSnapshot({
      tick: 999999,
      floor: 9,
      alarm: 255,
      lastInputSeq: 0,
      entities: Array.from({ length: 48 }, (_, i) => ({
        id: 50000 + i, archetype: 'boss', x: 5, y: 5, facing: 0, hpPct: 1, flags: 0,
      })),
    })
    for (const p of frameMessage(spoof, 180)) h.inject('evil', p)
    h.host.tick()
    // The host is the sole simulator: it has no code path that ingests a snapshot,
    // so no entity may appear and the floor/alarm must be untouched.
    expect(h.host.world.entities.length).toBe(before)
    expect(h.host.world.floor).toBe(1)
    expect(h.host.world.tick).toBe(1)
  })
})
