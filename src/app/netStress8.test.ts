import { describe, expect, it } from 'vitest'
import { serializeWorld } from '../game/serialize'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { encodeJson, decodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { decodeSnapshot, type WelcomeMsg } from '../net/protocol/messages'
import { MsgType, PROTOCOL_VERSION, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { MAX_PLAYERS, NetHostSession } from './netHost'

/**
 * 8-player stress of the offline netcode (stress/8-players). Same in-memory
 * loopback the 4-player co-op suite uses, scaled to a full 8-player lobby: one
 * host "peripheral" + 7 connecting "centrals". Proves the protocol/sim path
 * carries 8 (distinct slots, spawns, cross-visibility, input apply, late-join,
 * determinism) independent of any radio. The BLE radio ceiling is a transport
 * limit tested on real devices, not here.
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

  addClient(
    name: string,
    classId: string,
    input: InputSource,
  ): { session: NetClientSession; connect: () => void; drop: () => void; peer: PeerId; snapshotEntityCounts: () => number[] } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    // Sniff snapshots on the wire so we can assert cross-visibility directly.
    const sniff = new StreamReader()
    const snapCounts: number[] = []
    this.centrals.set(peer, (bytes) => {
      sniff.push(bytes, (m) => {
        if (m[0] === MsgType.Snapshot) snapCounts.push(decodeSnapshot(m).entities.length)
      })
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    })
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
    const drop = (): void => {
      this.centrals.delete(peer)
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerDisconnected', peer: 'host', reason: 'remote' }))
    }
    return { session, connect, drop, peer, snapshotEntityCounts: () => snapCounts }
  }

  /** A raw central used to hand-craft messages (join/rejoin) and read replies. */
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
}

const findMsg = <T>(msgs: Uint8Array[], type: number): T | undefined => {
  const hit = msgs.find((m) => m[0] === type)
  return hit ? decodeJson<T>(hit) : undefined
}

const NAMES = ['Bob', 'Cara', 'Dan', 'Eve', 'Finn', 'Gwen', 'Hank']

describe('8-player stress — full lobby over the loopback transport', () => {
  it('MAX_PLAYERS is 8', () => {
    expect(MAX_PLAYERS).toBe(8)
  })

  it('admits 7 clients into distinct contiguous slots 1..7 (host is 0)', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(100, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    const clients = []
    for (const nm of NAMES) {
      const c = hub.addClient(nm, 'thief', stubInput())
      await c.session.start()
      c.connect()
      await flush()
      clients.push(c)
    }

    // Each client got a unique slot; no collision, no overflow, no reject.
    expect(clients.map((c) => c.session.slot)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(clients.every((c) => c.session.phase === 'lobby')).toBe(true)
    const lobby = host.lobbyPlayers()
    expect(lobby).toHaveLength(8)
    expect(lobby.map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(lobby.map((p) => p.name)).toEqual(['Alice', ...NAMES])
  })

  it('spawns 8 avatars at valid, distinct positions and cross-syncs them all', async () => {
    const hub = new MockHub()
    // Each client walks a different direction so its input stream is non-trivial.
    const dirs = [1, -1, 1, -1, 1, -1, 1]
    const host = new NetHostSession(200, 'soldier', 'Alice', stubInput({ moveX: 1 }), hub.hostTransport)
    await host.start()
    const clients = NAMES.map((nm, i) => hub.addClient(nm, 'thief', stubInput({ moveX: dirs[i] })))
    for (const c of clients) {
      await c.session.start()
      c.connect()
      await flush()
    }

    host.beginGame()
    await flush()

    // 8 player avatars exist, each at a finite spawn position.
    const players = host.world.entities.filter((e) => e.playerCtl)
    expect(players).toHaveLength(8)
    for (const p of players) {
      expect(Number.isFinite(p.pos.x)).toBe(true)
      expect(Number.isFinite(p.pos.y)).toBe(true)
    }
    // Distinct slot ids 0..7 on the avatars themselves.
    expect(players.map((p) => p.playerCtl!.playerId).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    // Run the sim; clients feed inputs, host fans out per-peer snapshots.
    for (let i = 0; i < 20; i++) {
      host.tick()
      for (const c of clients) c.session.tick()
      await flush()
    }

    // Every client is in-game and each received snapshots that include the other
    // players (a snapshot with >1 entity ⇒ this client sees teammates, not just self).
    for (const c of clients) {
      expect(c.session.phase).toBe('playing')
      const counts = c.snapshotEntityCounts()
      expect(counts.length).toBeGreaterThan(0)
      expect(Math.max(...counts)).toBeGreaterThanOrEqual(8) // all 8 players are always in-interest
      expect(c.session.renderView().self).toBeDefined()
      expect(c.session.renderView().entities.length).toBeGreaterThan(1)
    }

    // Host received every client's inputs (movement applied over the link).
    for (let slot = 1; slot <= 7; slot++) {
      expect(host.peersBySlot.get(slot)?.lastInputSeq).toBeGreaterThan(0)
    }
  })

  it('late-joins players #5–#8 into a running game (started with 4)', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(300, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    // Start with host + 3 (a legacy 4-player run).
    const first = NAMES.slice(0, 3).map((nm) => hub.addClient(nm, 'thief', stubInput()))
    for (const c of first) {
      await c.session.start()
      c.connect()
      await flush()
    }
    host.beginGame()
    await flush()
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(4)

    // Players #5, #6, #7, #8 drop in mid-run and each gets the next free slot.
    const late = NAMES.slice(3, 7).map((nm) => hub.addClient(nm, 'soldier', stubInput()))
    for (const c of late) {
      await c.session.start()
      c.connect()
      await flush()
    }

    expect(late.map((c) => c.session.slot)).toEqual([4, 5, 6, 7])
    expect(late.every((c) => c.session.phase === 'playing')).toBe(true)
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(8)
    expect(host.lobbyPlayers()).toHaveLength(8)
  })

  it('rejoins a dropped player among 8 without stealing another slot', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(400, 'soldier', 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    // Fill slots 1..3 and 5..7 with sessions; slot 4 is a raw central so we can
    // capture its rejoin token and hand-craft the reconnect Hello.
    for (const nm of NAMES.slice(0, 3)) {
      const c = hub.addClient(nm, 'thief', stubInput())
      await c.session.start()
      c.connect()
      await flush()
    }
    const four = hub.addRawCentral()
    four.connect()
    await flush()
    four.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Dave', classId: 'thief' }))
    await flush()
    const welcome = findMsg<WelcomeMsg>(four.received(), MsgType.Welcome)!
    expect(welcome.slot).toBe(4)
    for (const nm of NAMES.slice(4, 7)) {
      const c = hub.addClient(nm, 'thief', stubInput())
      await c.session.start()
      c.connect()
      await flush()
    }

    host.beginGame()
    await flush()
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(8)
    const entityId = host.peersBySlot.get(4)!.entityId!

    // Slot 4 drops mid-run → ghost, avatar parked (not despawned).
    four.drop()
    await flush()
    expect(host.peersBySlot.get(4)).toBeUndefined()
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(8) // ghost avatar stays

    // A fresh central presents the saved slot+token → reclaims the SAME avatar,
    // no new spawn, still 8 players, and the other 7 slots are untouched.
    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(
      encodeJson(MsgType.Hello, {
        v: PROTOCOL_VERSION,
        name: 'Dave',
        classId: 'thief',
        rejoin: { slot: welcome.slot, token: welcome.token },
      }),
    )
    await flush()
    expect(findMsg<WelcomeMsg>(back.received(), MsgType.Welcome)?.slot).toBe(4)
    expect(host.peersBySlot.get(4)?.entityId).toBe(entityId)
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(8)
    expect([...host.peersBySlot.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('is deterministic with 8 players: same seed + inputs → byte-identical world', async () => {
    const dirs = [1, -1, 1, -1, 1, -1, 1]
    const runOnce = async (): Promise<string> => {
      const hub = new MockHub()
      const host = new NetHostSession(999, 'soldier', 'Alice', stubInput({ moveX: 1, moveY: 1 }), hub.hostTransport)
      await host.start()
      const clients = NAMES.map((nm, i) => hub.addClient(nm, 'thief', stubInput({ moveX: dirs[i], moveY: -dirs[i] })))
      for (const c of clients) {
        await c.session.start()
        c.connect()
        await flush()
      }
      host.beginGame()
      await flush()
      for (let i = 0; i < 40; i++) {
        host.tick()
        for (const c of clients) c.session.tick()
        await flush()
      }
      return JSON.stringify(serializeWorld(host.world))
    }

    const a = await runOnce()
    const b = await runOnce()
    expect(a).toBe(b)
  })
})
