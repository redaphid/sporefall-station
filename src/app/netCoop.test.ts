import { describe, expect, it } from 'vitest'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { encodeJson, decodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { MsgType, PROTOCOL_VERSION, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * In-memory loopback of the offline peer-to-peer link (what BLE gives us on
 * two phones). Models one host "peripheral" with N connecting "centrals", so we
 * can prove the host/join handshake and input↔snapshot sync — the whole offline
 * netcode — without any radio. The physical two-device test then only has to
 * confirm the transport, not the protocol.
 */
class MockHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    const deliver = (fn: (() => void) | undefined): Promise<void> => Promise.resolve().then(() => fn?.())
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      // Host → a specific central; that central always sees the host as 'host'.
      sendPacket: (peer: PeerId, bytes: Uint8Array) => deliver(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  private deliverToHost(peer: PeerId, bytes: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes }))
  }

  /** A full NetClientSession joining over its own client Transport. */
  addClient(name: string, classId: string, input: InputSource): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) =>
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })),
    )
    const clientTransport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) => this.deliverToHost(peer, bytes),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, classId, input, clientTransport)
    const connect = (): void => {
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
    }
    return { session, connect }
  }

  /** A raw central used to exercise host edge cases with hand-crafted messages. */
  addRawCentral(): { connect: () => void; send: (msg: Uint8Array) => void; received: () => Uint8Array[] } {
    const peer: PeerId = `raw-${this.centrals.size + 1}`
    const reader = new StreamReader()
    const messages: Uint8Array[] = []
    this.centrals.set(peer, (bytes) => reader.push(bytes, (m) => messages.push(m)))
    return {
      connect: () => void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer })),
      send: (msg) => {
        for (const packet of frameMessage(msg, 180)) void this.deliverToHost(peer, packet)
      },
      received: () => messages,
    }
  }
}

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({
  sample: () => ({ ...emptyInput(), ...cmd }),
})

/** Drain the microtask/timer-based send queues between the sessions. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const findMsg = <T>(msgs: Uint8Array[], type: number): T | undefined => {
  const hit = msgs.find((m) => m[0] === type)
  return hit ? decodeJson<T>(hit) : undefined
}

describe('offline co-op (loopback transport)', () => {
  it('completes the join handshake and assigns the client a slot', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(1234, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', 'thief', stubInput())

    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()

    expect(bob.session.slot).toBe(1)
    expect(bob.session.phase).toBe('lobby')
    const lobby = host.lobbyPlayers()
    expect(lobby).toHaveLength(2)
    expect(lobby.map((p) => p.name)).toEqual(['Alice', 'Bob'])
  })

  it('drops both players into the same game and syncs input → snapshot', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(777, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    // Client walks right so its input packets carry a changing sequence.
    const bob = hub.addClient('Bob', 'thief', stubInput({ moveX: 1 }))

    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()

    host.beginGame()
    await flush()

    expect(bob.session.phase).toBe('playing')
    expect(bob.session.slot).toBe(1)

    for (let i = 0; i < 12; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }

    // Host received the client's inputs over the link.
    const peer = host.peersBySlot.get(1)
    expect(peer).toBeDefined()
    expect(peer!.lastInputSeq).toBeGreaterThan(0)

    // Client received host snapshots and now renders its own avatar + the host.
    const view = bob.session.renderView()
    expect(view.self).toBeDefined()
    expect(view.entities.length).toBeGreaterThan(0)
  })

  it('rejects a client whose protocol version does not match', async () => {
    const hub = new MockHub()
    new NetHostSession(1, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION + 99, name: 'Old', classId: 'soldier' }))
    await flush()

    const reject = findMsg<{ reason: string }>(raw.received(), MsgType.Reject)
    expect(reject).toBeDefined()
    expect(reject!.reason).toMatch(/version/i)
  })

  it('drops a fresh late joiner straight into a running game', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(9, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()
    expect(host.started).toBe(true)
    const playersBefore = host.world.entities.filter((e) => e.playerCtl).length

    // A brand-new central (never in the lobby) asks to join mid-run.
    const late = hub.addClient('Late', 'thief', stubInput())
    await late.session.start()
    late.connect()
    await flush()

    // Host welcomed it, spawned a new avatar, and handed it GameStart + Go.
    expect(late.session.slot).toBe(1)
    expect(late.session.phase).toBe('playing')
    expect(host.peersBySlot.get(1)?.entityId).toBeDefined()
    expect(host.world.entities.filter((e) => e.playerCtl).length).toBe(playersBefore + 1)
    expect(host.lobbyPlayers().map((p) => p.name)).toContain('Late')
  })

  it('still enforces the 4-player cap for late joiners in a running game', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(9, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    // Three clients fill slots 1..3 in the lobby (host is slot 0), then start.
    for (const nm of ['Bob', 'Cara', 'Dan']) {
      const c = hub.addClient(nm, 'thief', stubInput())
      await c.session.start()
      c.connect()
      await flush()
    }
    host.beginGame()
    await flush()
    expect(host.lobbyPlayers()).toHaveLength(4)

    // The fifth participant is turned away even mid-run.
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Eve', classId: 'soldier' }))
    await flush()

    const reject = findMsg<{ reason: string }>(raw.received(), MsgType.Reject)
    expect(reject).toBeDefined()
    expect(reject!.reason).toMatch(/full/i)
  })

  it('restarts in place after a game-over, keeping the connection (play again, no reconnect)', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(555, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', 'thief', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()
    expect(bob.session.phase).toBe('playing')

    // Down every player → run over (real game-over).
    for (const e of host.world.entities.filter((p) => p.playerCtl)) {
      e.health!.hp = 0
      e.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    }
    host.tick()
    await flush()
    expect(host.world.gameOver).toBe(true)

    // Play again: rebuild the run in place. Transport + peer are untouched.
    const worldBefore = host.world
    host.restart()
    await flush()

    expect(host.world).not.toBe(worldBefore) // fresh world
    expect(host.world.gameOver).toBe(false)
    expect(host.started).toBe(true)
    const players = host.world.entities.filter((e) => e.playerCtl)
    expect(players).toHaveLength(2) // host + Bob both respawned
    expect(players.every((e) => !e.playerCtl!.downed)).toBe(true)

    // Bob resumed over the SAME connection — never disconnected, no rejoin.
    expect(bob.session.phase).toBe('playing')
    expect(host.peersBySlot.get(1)).toBeDefined()

    // Snapshots resync Bob's fresh world; the game-over clears on his side too.
    for (let i = 0; i < 6; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }
    expect(bob.session.renderView().gameOver).toBe(false)
    expect(bob.session.renderView().self).toBeDefined()
  })

  it('fills all four co-op slots then rejects the fifth player', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(42, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    // Three real clients fill slots 1..3 (host is slot 0).
    for (const nm of ['Bob', 'Cara', 'Dan']) {
      const c = hub.addClient(nm, 'thief', stubInput())
      await c.session.start()
      c.connect()
      await flush()
    }
    expect(host.lobbyPlayers()).toHaveLength(4)

    // The fifth participant overflows the lobby.
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Eve', classId: 'soldier' }))
    await flush()

    const reject = findMsg<{ reason: string }>(raw.received(), MsgType.Reject)
    expect(reject).toBeDefined()
    expect(reject!.reason).toMatch(/full/i)
  })
})
