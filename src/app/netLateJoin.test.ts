import { describe, expect, it } from 'vitest'
import { generateLevel } from '../game/levelgen/generate'
import type { Level } from '../game/levelgen/level'
import { nextFloor } from '../game/systems/missions'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { decodeJson, encodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import type { GameStartMsg } from '../net/protocol/messages'
import { MsgType, PROTOCOL_VERSION, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * Late join — joining a run that is ALREADY UNDER WAY, rather than sitting in
 * the lobby before Start. Same loopback hub the other co-op suites use (see
 * netCoop.test.ts): one host "peripheral", N connecting "centrals", no radio.
 *
 * The lobby path and the late-join path share one `GameStart` message but not
 * one set of assumptions — everything here is about the cases where "everybody
 * started together on floor 1" stops being true.
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

  /** A full NetClientSession joining over its own client Transport. */
  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void; peer: PeerId } {
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
    const session = new NetClientSession(name, input, clientTransport)
    const connect = (): void => {
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
    }
    return { session, connect, peer }
  }

  /** A raw central, for reading exactly what the host puts on the wire. */
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const findMsg = <T>(msgs: Uint8Array[], type: number): T | undefined => {
  const hit = msgs.find((m) => m[0] === type)
  return hit ? decodeJson<T>(hit) : undefined
}

/** Levels regenerate bit-exact from seed+floor, so tiles identify the floor. */
const tilesOf = (l: Level): string => `${l.w}x${l.h}:${l.spawn.x},${l.spawn.y}:${l.tiles.join('')}`

const countPlayers = (host: NetHostSession): number => host.world.entities.filter((e) => e.playerCtl).length

/** Start a host, run it to `floor`, and leave it mid-run. */
const hostOnFloor = async (seed: number, floor: number): Promise<{ hub: MockHub; host: NetHostSession }> => {
  const hub = new MockHub()
  const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
  await host.start()
  host.beginGame()
  for (let f = 1; f < floor; f++) nextFloor(host.world)
  expect(host.world.floor).toBe(floor)
  return { hub, host }
}

describe('late join: the joiner lands on the host’s floor', () => {
  it('generates the host’s floor, not floor 1, when joining a run already on floor 3', async () => {
    const seed = 90210
    const { hub } = await hostOnFloor(seed, 3)

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush() // handshake only — the host has NOT ticked, so NO snapshot has been sent

    expect(bob.session.phase).toBe('playing')
    const level = bob.session.renderView().level
    expect(tilesOf(level)).toBe(tilesOf(generateLevel(seed, 3)))
    // Control: floor 1 is a genuinely different map, so the assert above can fail.
    expect(tilesOf(level)).not.toBe(tilesOf(generateLevel(seed, 1)))
  })

  it('reports the host’s floor number immediately, without waiting for a State message', async () => {
    const seed = 5150
    const { hub, host } = await hostOnFloor(seed, 4)

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()

    // renderView().floor drives the HUD. Before any State arrives it must not
    // claim floor 1 while the map underfoot is floor 4.
    expect(bob.session.renderView().floor).toBe(4)
    expect(host.world.floor).toBe(4)
  })

  it('hands the renderer ONE level, not floor 1 followed by a correction', async () => {
    const seed = 31337
    const { hub, host } = await hostOnFloor(seed, 3)

    const bob = hub.addClient('Bob', stubInput())
    const levels: Level[] = []
    bob.session.onLevelChange = (l) => levels.push(l)
    await bob.session.start()
    bob.connect()
    await flush()

    // Then let snapshots flow — the self-heal path must find nothing to heal.
    for (let i = 0; i < 20; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }

    expect(levels).toHaveLength(1)
    expect(tilesOf(levels[0])).toBe(tilesOf(generateLevel(seed, 3)))
  })

  it('puts the floor on the wire in GameStart for a late joiner', async () => {
    const { hub, host } = await hostOnFloor(2024, 5)

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    await flush()

    const start = findMsg<GameStartMsg>(raw.received(), MsgType.GameStart)
    expect(start).toBeDefined()
    expect(start!.floor).toBe(5)
    expect(start!.seed).toBe(host.seed)
  })

  it('reads the floor at the moment the join is handled, even mid floor transition', async () => {
    const { hub, host } = await hostOnFloor(777, 2)

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    // The Hello is in flight (queued as a microtask) when the party takes the
    // stairs. The host must answer with the floor it is on NOW, not the one it
    // was on when the radio packet started arriving.
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    nextFloor(host.world)
    expect(host.world.floor).toBe(3)
    await flush()

    const start = findMsg<GameStartMsg>(raw.received(), MsgType.GameStart)
    expect(start!.floor).toBe(3)
  })

  it('still self-heals when the host changes floor right after GameStart went out', async () => {
    const seed = 4242
    const { hub, host } = await hostOnFloor(seed, 2)

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()
    expect(tilesOf(bob.session.renderView().level)).toBe(tilesOf(generateLevel(seed, 2)))

    // Party moves on the instant the joiner lands. Snapshots must drag them along.
    nextFloor(host.world)
    for (let i = 0; i < 20; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }
    expect(tilesOf(bob.session.renderView().level)).toBe(tilesOf(generateLevel(seed, 3)))
  })

  it('defaults to floor 1 when an older host sends GameStart with no floor field', async () => {
    const hub = new MockHub()
    const seed = 8675309
    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()

    // Hand-built legacy GameStart: no `floor` key at all.
    const legacy = hub as unknown as { centrals: Map<PeerId, (b: Uint8Array) => void> }
    const deliver = legacy.centrals.get('central-1')!
    for (const p of frameMessage(encodeJson(MsgType.Welcome, { slot: 1, token: 't' }), 180)) deliver(p)
    for (const p of frameMessage(encodeJson(MsgType.GameStart, { seed, players: [] }), 180)) deliver(p)
    await flush()

    expect(tilesOf(bob.session.renderView().level)).toBe(tilesOf(generateLevel(seed, 1)))
  })

  it('keeps a normal lobby start on floor 1 for everyone', async () => {
    const hub = new MockHub()
    const seed = 1234
    const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()

    expect(host.world.floor).toBe(1)
    expect(tilesOf(bob.session.renderView().level)).toBe(tilesOf(generateLevel(seed, 1)))
    expect(bob.session.renderView().floor).toBe(1)
  })
})

describe('late join: a finished run is not a joinable run', () => {
  it('does not spawn a joiner into a world whose run is already over', async () => {
    const { hub, host } = await hostOnFloor(2468, 2)
    host.world.gameOver = true
    const before = countPlayers(host)

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()

    expect(countPlayers(host)).toBe(before) // no avatar dropped into the corpse world
    expect(bob.session.phase).not.toBe('playing')
    expect(bob.session.renderView().self).toBeUndefined()
  })

  it('holds the joiner in the lobby rather than bouncing them', async () => {
    const { hub, host } = await hostOnFloor(1357, 1)
    host.world.gameOver = true

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()

    expect(bob.session.phase).toBe('lobby')
    expect(bob.session.slot).toBeGreaterThan(0)
    // The host sees them waiting, so "play again" is an informed choice.
    expect(host.lobbyPlayers().map((p) => p.name)).toContain('Bob')
  })

  it('sends the held joiner a Welcome but no GameStart and no Go while the run is over', async () => {
    const { hub, host } = await hostOnFloor(999, 3)
    host.world.gameOver = true

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    await flush()

    const got = raw.received()
    expect(findMsg(got, MsgType.Welcome)).toBeDefined()
    expect(findMsg(got, MsgType.GameStart)).toBeUndefined()
    expect(findMsg(got, MsgType.Go)).toBeUndefined()
    expect(findMsg(got, MsgType.Reject)).toBeUndefined()
  })

  it('drops the held joiner into the next run when the host plays again', async () => {
    const seed = 24680
    const { hub, host } = await hostOnFloor(seed, 3)
    host.world.gameOver = true

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()
    expect(bob.session.phase).toBe('lobby')

    host.restart()
    await flush()

    expect(host.world.gameOver).toBe(false)
    expect(bob.session.phase).toBe('playing')
    // A restart rebuilds from the seed at floor 1 — the joiner follows it there.
    expect(host.world.floor).toBe(1)
    expect(tilesOf(bob.session.renderView().level)).toBe(tilesOf(generateLevel(seed, 1)))
    expect(countPlayers(host)).toBe(2)
  })

  it('admits a joiner normally when the run is over but the host has already restarted', async () => {
    const seed = 1122
    const { hub, host } = await hostOnFloor(seed, 2)
    host.world.gameOver = true
    host.restart()

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()

    expect(bob.session.phase).toBe('playing')
    expect(countPlayers(host)).toBe(2)
  })

  it('lets a live run keep accepting late joiners (the gate is gameOver, not started)', async () => {
    const { hub, host } = await hostOnFloor(3141, 3)
    expect(host.world.gameOver).toBe(false)
    const before = countPlayers(host)

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()

    expect(bob.session.phase).toBe('playing')
    expect(countPlayers(host)).toBe(before + 1)
  })

  it('does not spawn an avatar when gameOver flips true between the Hello and the flush', async () => {
    const { hub, host } = await hostOnFloor(1618, 2)
    const before = countPlayers(host)

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    // The party wipes while the join packet is in the air.
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    host.world.gameOver = true
    await flush()

    expect(countPlayers(host)).toBe(before)
    expect(findMsg(raw.received(), MsgType.Go)).toBeUndefined()
    // Still welcomed — they wait in the lobby for "play again".
    expect(findMsg(raw.received(), MsgType.Welcome)).toBeDefined()
  })

  it('does not leave a phantom avatar when gameOver flips true and the host then restarts', async () => {
    const { hub, host } = await hostOnFloor(2718, 2)
    host.world.gameOver = true

    const bob = hub.addClient('Bob', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()
    host.restart()
    await flush()

    // Exactly one avatar each: host + Bob. A double-spawn would read as 3.
    expect(countPlayers(host)).toBe(2)
  })
})
