import { describe, expect, it } from 'vitest'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { encodeJson, decodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { encodeInput, type WelcomeMsg } from '../net/protocol/messages'
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
  addClient(
    name: string,
    classId: string,
    input: InputSource,
  ): { session: NetClientSession; connect: () => void; drop: () => void; peer: PeerId } {
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
    // Model a radio drop: both ends see the link fall away.
    const drop = (): void => {
      this.centrals.delete(peer)
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerDisconnected', peer: 'host', reason: 'remote' }))
    }
    return { session, connect, drop, peer }
  }

  /** A raw central used to exercise host edge cases with hand-crafted messages. */
  addRawCentral(): {
    connect: () => void
    send: (msg: Uint8Array) => void
    received: () => Uint8Array[]
    drop: () => void
    peer: PeerId
  } {
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
      drop: () => {
        this.centrals.delete(peer)
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
      },
      peer,
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

  it('threads the run difficulty (mode) to a joined client so co-op agrees on the rules', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(4242, 'soldier', 'Alice', stubInput(), hub.hostTransport, 'casual')
    const bob = hub.addClient('Bob', 'thief', stubInput())

    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()

    expect(host.world.mode).toBe('casual')
    // GameStart carried mode → client surfaces it in its render view.
    expect(bob.session.renderView().mode).toBe('casual')

    // The periodic State message keeps the shared revive count visible to clients.
    for (let i = 0; i < 20; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }
    expect(bob.session.renderView().revivesLeft).toBe(host.world.revivesLeft)
  })

  it('defaults an unspecified host mode to normal (stakes on)', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(4243, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    expect(host.world.mode).toBe('normal')
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

const noEdges = { attack: false, interact: false, special: false }
const REJOIN_GRACE_TICKS = 90 * 30

describe('offline co-op — adversarial host (malformed / hostile input)', () => {
  it('survives a hostile non-JSON Hello and keeps serving other peers', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(1, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    const evil = hub.addRawCentral()
    evil.connect()
    await flush()
    // Type byte claims Hello; the body is bytes JSON.parse will choke on.
    evil.send(new Uint8Array([MsgType.Hello, 0x7b, 0xff, 0xfe, 0x00, 0x21]))
    await flush()

    // Host neither crashed nor admitted the peer, and sent no Welcome.
    expect(host.lobbyPlayers()).toHaveLength(1)
    expect(findMsg<WelcomeMsg>(evil.received(), MsgType.Welcome)).toBeUndefined()

    // A well-formed client still joins afterward — the host is alive.
    const bob = hub.addClient('Bob', 'thief', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()
    expect(bob.session.slot).toBe(1)
  })

  it('survives a truncated Input packet and keeps ticking', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(2, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', 'thief', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()

    const evil = hub.addRawCentral()
    evil.connect()
    await flush()
    evil.send(new Uint8Array([MsgType.Input])) // header byte only — decode reads past the end
    await flush()

    expect(() => host.tick()).not.toThrow()
    expect(bob.session.phase).toBe('playing')
  })

  it('admits a Hello missing name/classId and spawns a default avatar', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(3, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION })) // no name, no classId
    await flush()

    expect(findMsg<WelcomeMsg>(raw.received(), MsgType.Welcome)?.slot).toBe(1)
    expect(() => host.beginGame()).not.toThrow()
    await flush()
    expect(host.peersBySlot.get(1)?.entityId).toBeDefined()
  })

  it('rejects a Hello with a missing/zero protocol version', async () => {
    const hub = new MockHub()
    new NetHostSession(4, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { name: 'NoVer', classId: 'soldier' })) // v undefined
    await flush()
    expect(findMsg<{ reason: string }>(raw.received(), MsgType.Reject)?.reason).toMatch(/version/i)
  })

  it('ignores duplicate pre-start Hellos (join spam) instead of reassigning the slot', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(5, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    for (let i = 0; i < 5; i++) {
      raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Spammer', classId: 'thief' }))
      await flush()
    }

    // Exactly one slot, one Welcome, and no leaked peersBySlot entry.
    expect(raw.received().filter((m) => m[0] === MsgType.Welcome)).toHaveLength(1)
    expect(host.lobbyPlayers()).toHaveLength(2)
    expect([...host.peersBySlot.keys()]).toEqual([1])
  })

  it('ignores a duplicate late-join Hello instead of spawning a second avatar', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(6, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()
    const before = host.world.entities.filter((e) => e.playerCtl).length

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late', classId: 'thief' }))
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late', classId: 'thief' }))
    await flush()

    expect(host.world.entities.filter((e) => e.playerCtl).length).toBe(before + 1) // only one new avatar
    expect([...host.peersBySlot.keys()]).toEqual([1])
    expect(raw.received().filter((m) => m[0] === MsgType.Welcome)).toHaveLength(1)
  })

  it('accepts a wrapped input seq and rejects stale reordered packets', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(7, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Seq', classId: 'thief' }))
    await flush()

    const p = host.peersBySlot.get(1)!
    const sendSeq = async (seq: number): Promise<void> => {
      raw.send(encodeInput({ ...emptyInput(), seq }, noEdges))
      await flush()
    }
    await sendSeq(65000)
    expect(p.lastInputSeq).toBe(65000)
    await sendSeq(65535)
    expect(p.lastInputSeq).toBe(65535)
    await sendSeq(10) // u16 wrap 65535 -> 10: accepted
    expect(p.lastInputSeq).toBe(10)
    await sendSeq(5) // old/reordered: rejected, latest wins
    expect(p.lastInputSeq).toBe(10)
  })
})

/** Join a raw central pre-start, begin the game, then drop it into a ghost slot. */
const seedGhost = async (
  hub: MockHub,
  host: NetHostSession,
): Promise<{ slot: number; token: string; entityId: number }> => {
  const a = hub.addRawCentral()
  a.connect()
  await flush()
  a.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', classId: 'thief' }))
  await flush()
  const welcome = findMsg<WelcomeMsg>(a.received(), MsgType.Welcome)!
  host.beginGame()
  await flush()
  const entityId = host.peersBySlot.get(welcome.slot)!.entityId!
  a.drop() // mid-game drop -> ghost
  await flush()
  return { slot: welcome.slot, token: welcome.token, entityId }
}

describe('offline co-op — ghost slots & rejoin', () => {
  it('reclaims the same avatar on rejoin with the correct token', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(10, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)
    expect(host.peersBySlot.get(slot)).toBeUndefined()
    const playersBefore = host.world.entities.filter((e) => e.playerCtl).length

    const b = hub.addRawCentral()
    b.connect()
    await flush()
    b.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', classId: 'thief', rejoin: { slot, token } }))
    await flush()

    expect(findMsg<WelcomeMsg>(b.received(), MsgType.Welcome)?.slot).toBe(slot)
    // Same avatar handed back; no extra player spawned.
    expect(host.peersBySlot.get(slot)?.entityId).toBe(entityId)
    expect(host.world.entities.filter((e) => e.playerCtl).length).toBe(playersBefore)
  })

  it('rejects a rejoin with the wrong token but keeps the ghost reclaimable', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(11, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)

    const bad = hub.addRawCentral()
    bad.connect()
    await flush()
    bad.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Imposter', classId: 'thief', rejoin: { slot, token: 'not-the-token' } }))
    await flush()
    expect(findMsg<{ reason: string }>(bad.received(), MsgType.Reject)?.reason).toMatch(/rejoin|expired|window/i)

    // The rightful owner can still reclaim it.
    const good = hub.addRawCentral()
    good.connect()
    await flush()
    good.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', classId: 'thief', rejoin: { slot, token } }))
    await flush()
    expect(findMsg<WelcomeMsg>(good.received(), MsgType.Welcome)?.slot).toBe(slot)
    expect(host.peersBySlot.get(slot)?.entityId).toBe(entityId)
  })

  it('bleeds out the avatar and rejects a rejoin after the grace window expires', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(12, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)

    // Fast-forward past the 90s grace window; one tick runs expireGhosts.
    host.world.tick += REJOIN_GRACE_TICKS + 1
    host.tick()
    await flush()
    expect(host.world.byId.get(entityId)?.dead).toBe(true)

    const late = hub.addRawCentral()
    late.connect()
    await flush()
    late.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', classId: 'thief', rejoin: { slot, token } }))
    await flush()
    expect(findMsg<{ reason: string }>(late.received(), MsgType.Reject)?.reason).toMatch(/rejoin|expired|window/i)
  })

  it('does not let a fresh late-joiner steal a ghost slot', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(13, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token } = await seedGhost(hub, host) // ghost holds slot 1

    // A brand-new player joining mid-run must NOT take the reserved ghost slot.
    const newbie = hub.addClient('Newbie', 'soldier', stubInput())
    await newbie.session.start()
    newbie.connect()
    await flush()
    expect(newbie.session.slot).toBe(2)

    // And the ghost is still reclaimable at slot 1.
    const b = hub.addRawCentral()
    b.connect()
    await flush()
    b.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', classId: 'thief', rejoin: { slot, token } }))
    await flush()
    expect(findMsg<WelcomeMsg>(b.received(), MsgType.Welcome)?.slot).toBe(1)
  })
})

describe('offline co-op — restart (play again) adversarial', () => {
  it('restarts mid-game (before any game-over) without touching the transport', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(20, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', 'thief', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()
    for (let i = 0; i < 5; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }
    expect(host.world.gameOver).toBe(false) // restarting mid-run, not at game-over

    const phases: string[] = []
    bob.session.onPhaseChange = (ph) => phases.push(ph)
    const bobPeer = host.peersBySlot.get(1)
    const peersBefore = hub.hostTransport.peers()
    const worldBefore = host.world

    host.restart()
    await flush()

    expect(host.world).not.toBe(worldBefore)
    expect(host.started).toBe(true)
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(2)
    // Transport + peer set untouched: same PeerState object, same peer list, no drop.
    expect(host.peersBySlot.get(1)).toBe(bobPeer)
    expect(hub.hostTransport.peers()).toEqual(peersBefore)
    expect(bob.session.phase).toBe('playing')
    expect(phases).not.toContain('reconnecting')
    expect(phases).not.toContain('ended')
  })

  it('restarts solo (no peers) and can restart again', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(21, 'soldier', 'Solo', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()

    expect(() => host.restart()).not.toThrow()
    await flush()
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(1)
    expect(host.started).toBe(true)

    host.restart()
    await flush()
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(1)
  })

  it('restarts with three connected peers — all resume, slots preserved', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(22, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const clients = []
    for (const nm of ['Bob', 'Cara', 'Dan']) {
      const c = hub.addClient(nm, 'thief', stubInput())
      await c.session.start()
      c.connect()
      await flush()
      clients.push(c)
    }
    host.beginGame()
    await flush()
    for (let i = 0; i < 4; i++) {
      host.tick()
      for (const c of clients) c.session.tick()
      await flush()
    }
    expect(clients.every((c) => c.session.phase === 'playing')).toBe(true)

    const statesBefore = [1, 2, 3].map((s) => host.peersBySlot.get(s))
    host.restart()
    await flush()

    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(4)
    // Slots map to the same PeerState objects; every avatar respawned fresh.
    expect([1, 2, 3].map((s) => host.peersBySlot.get(s))).toEqual(statesBefore)
    expect([1, 2, 3].every((s) => host.peersBySlot.get(s)!.entityId !== undefined)).toBe(true)

    for (let i = 0; i < 6; i++) {
      host.tick()
      for (const c of clients) c.session.tick()
      await flush()
    }
    clients.forEach((c, i) => {
      expect(c.session.phase).toBe('playing')
      expect(c.session.slot).toBe(i + 1)
      expect(c.session.renderView().self).toBeDefined()
    })
  })

  it('restarts twice in a row without duplicating avatars', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(23, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', 'thief', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()

    host.restart()
    await flush()
    host.restart()
    await flush()

    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(2)
    expect([...host.peersBySlot.keys()]).toEqual([1])
    expect(bob.session.phase).toBe('playing')
  })

  it('does not respawn a peer that dropped during the ended run', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(24, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', 'thief', stubInput())
    const cara = hub.addClient('Cara', 'soldier', stubInput())
    await host.start()
    for (const c of [bob, cara]) {
      await c.session.start()
      c.connect()
      await flush()
    }
    host.beginGame()
    await flush()

    // Real game-over: down every player.
    for (const e of host.world.entities.filter((p) => p.playerCtl)) {
      e.health!.hp = 0
      e.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    }
    host.tick()
    await flush()
    expect(host.world.gameOver).toBe(true)

    // Cara leaves before the host presses play-again.
    cara.drop()
    await flush()

    host.restart()
    await flush()

    // Only host + Bob respawn; Cara's slot stays empty.
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(2)
    expect(host.peersBySlot.get(1)).toBeDefined()
    expect(host.peersBySlot.get(2)).toBeUndefined()
    expect(bob.session.phase).toBe('playing')
  })

  it('accepts a fresh late-joiner after a restart', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(25, 'soldier', 'Solo', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()
    host.restart()
    await flush()

    const late = hub.addClient('Late', 'thief', stubInput())
    await late.session.start()
    late.connect()
    await flush()

    expect(late.session.slot).toBe(1)
    expect(late.session.phase).toBe('playing')
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(2)
  })
})
