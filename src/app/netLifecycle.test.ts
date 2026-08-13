import { describe, expect, it } from 'vitest'
import { generateLevel } from '../game/levelgen/generate'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { decodeJson, encodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { encodeInput, type GoMsg, type WelcomeMsg } from '../net/protocol/messages'
import { MsgType, PROTOCOL_VERSION, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { MAX_PLAYERS, NetHostSession } from './netHost'

/**
 * Connection-lifecycle harness: one host "peripheral" and N centrals over an
 * in-memory loopback, like netCoop.test.ts — but this hub can also RE-LINK a
 * central that dropped (the same client session coming back on a fresh link)
 * and can re-point the host transport at a BRAND-NEW NetHostSession, which is
 * what a host app restart looks like from the client's side of the radio.
 */
class MockHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()
  private n = 0

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

  private toHost(peer: PeerId, bytes: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes }))
  }

  /** A full NetClientSession. `relink` models the radio coming back after a drop. */
  addClient(
    name: string,
    input: InputSource,
    opts: { reconnectable?: boolean } = {},
  ): { session: NetClientSession; connect: () => void; drop: () => void; relink: () => void; peer: PeerId } {
    const peer: PeerId = `central-${++this.n}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    const wire = (bytes: Uint8Array): void =>
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    this.centrals.set(peer, wire)
    const clientTransport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) => this.toHost(peer, bytes),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => (this.centrals.has(peer) ? ['host'] : []),
      // Only a reconnect-capable transport puts the client into `reconnecting`;
      // without one a drop is terminal (see NetClientSession.onDisconnected).
      ...(opts.reconnectable === false ? {} : { reconnect: async () => {} }),
    }
    const session = new NetClientSession(name, input, clientTransport)
    const connect = (): void => {
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
    }
    const drop = (): void => {
      this.centrals.delete(peer)
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerDisconnected', peer: 'host', reason: 'remote' }))
    }
    const relink = (): void => {
      this.centrals.set(peer, wire)
      connect()
    }
    return { session, connect, drop, relink, peer }
  }

  /** A raw central: hand-crafted messages, so we can drive host edge cases exactly. */
  addRawCentral(): {
    connect: () => void
    send: (msg: Uint8Array) => void
    received: () => Uint8Array[]
    drop: () => void
    peer: PeerId
  } {
    const peer: PeerId = `raw-${++this.n}`
    const reader = new StreamReader()
    const messages: Uint8Array[] = []
    this.centrals.set(peer, (bytes) => reader.push(bytes, (m) => messages.push(m)))
    return {
      connect: () => void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer })),
      send: (msg) => {
        for (const packet of frameMessage(msg, 180)) void this.toHost(peer, packet)
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

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const findMsg = <T>(msgs: Uint8Array[], type: number): T | undefined => {
  const hit = msgs.find((m) => m[0] === type)
  return hit ? decodeJson<T>(hit) : undefined
}

const REJOIN_GRACE_TICKS = 90 * 30
const noEdges = { attack: false, interact: false, special: false }
type Seat = Awaited<ReturnType<typeof joinRaw>>
const playerIds = (h: NetHostSession): number[] => h.world.entities.filter((e) => e.playerCtl).map((e) => e.playerCtl!.playerId)
const playerCount = (h: NetHostSession): number => h.world.entities.filter((e) => e.playerCtl).length

/** Connect a raw central and complete a pre-start Hello. */
const joinRaw = async (
  hub: MockHub,
  name: string,
): Promise<{ raw: ReturnType<MockHub['addRawCentral']>; welcome: WelcomeMsg }> => {
  const raw = hub.addRawCentral()
  raw.connect()
  await flush()
  raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name }))
  await flush()
  return { raw, welcome: findMsg<WelcomeMsg>(raw.received(), MsgType.Welcome)! }
}

/** Join pre-start, begin the run, then drop mid-game so the slot becomes a ghost. */
const seedGhost = async (
  hub: MockHub,
  host: NetHostSession,
  name = 'Bob',
): Promise<{ slot: number; token: string; entityId: number }> => {
  const { raw, welcome } = await joinRaw(hub, name)
  host.beginGame()
  await flush()
  const entityId = host.peersBySlot.get(welcome.slot)!.entityId!
  raw.drop()
  await flush()
  return { slot: welcome.slot, token: welcome.token, entityId }
}

/**
 * Down every player a human is actually driving (an admitted slot, 0..MAX_SLOT)
 * so missionSystem's run-over check can fire. Deliberately does NOT touch a
 * phantom slot -1 avatar: nobody can down what nobody can drive, which is
 * exactly why such an avatar wedges the game-over.
 */
const wipeParty = (host: NetHostSession): void => {
  for (const e of host.world.entities) {
    if (!e.playerCtl || e.playerCtl.playerId < 0) continue
    e.health!.hp = 0
    e.playerCtl.downed = { bleedTicks: 900, reviveProgress: 0 }
  }
}

describe('connection lifecycle — a peer that never finished its handshake', () => {
  it('does not spawn a phantom avatar for a peer that connected but never said Hello', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(1, 'Alice', stubInput(), hub.hostTransport)
    await host.start()

    // The link is up but the Hello has not landed yet — a completely ordinary
    // BLE race: the central connects and the host presses Start a beat later.
    const silent = hub.addRawCentral()
    silent.connect()
    await flush()
    expect(host.lobbyPlayers()).toHaveLength(1) // correctly NOT in the lobby

    host.beginGame()
    await flush()

    // Only the host has an avatar. A slot -1 avatar here is a player nobody can
    // drive, invisible in the lobby, and present in every snapshot.
    expect(playerIds(host)).toEqual([0])
    expect(playerIds(host)).not.toContain(-1)
  })

  it('still ends the run on a co-op wipe when a half-joined peer is connected', async () => {
    // The real damage from a phantom slot -1 avatar: missionSystem's run-over
    // check needs EVERY player down/dead. A phantom nobody can down never goes
    // down, so the wipe screen never comes and the party lies on the floor
    // forever — with no visible cause anywhere in the lobby or the HUD.
    const hub = new MockHub()
    const host = new NetHostSession(2, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    await joinRaw(hub, 'Bob') // a real, fully admitted teammate

    const silent = hub.addRawCentral() // connects, never completes the handshake
    silent.connect()
    await flush()

    host.beginGame()
    await flush()
    wipeParty(host)
    host.tick()

    expect(host.world.gameOver).toBe(true)
  })

  it('control: the same wipe with no half-joined peer ends the run', async () => {
    // Proves the assertion above is actually sensitive to the phantom, not to
    // some unrelated reason the wipe would fail.
    const hub = new MockHub()
    const host = new NetHostSession(2, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    await joinRaw(hub, 'Bob')
    host.beginGame()
    await flush()
    wipeParty(host)
    host.tick()
    expect(host.world.gameOver).toBe(true)
  })

  it('gives a late Hello from that same peer exactly one avatar', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(3, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const silent = hub.addRawCentral()
    silent.connect()
    await flush()
    host.beginGame()
    await flush()

    silent.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Slow' }))
    await flush()

    // Host + the now-admitted peer. Not three: the pre-Hello spawn must not
    // leave a zombie behind once the real join lands.
    expect(playerIds(host).sort((a, b) => a - b)).toEqual([0, 1])
    expect(host.peersBySlot.get(1)?.entityId).toBeDefined()
  })

  it('leaves no ghost and frees the slot when a peer drops before the game starts', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(4, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { raw } = await joinRaw(hub, 'Bob')
    expect([...host.peersBySlot.keys()]).toEqual([1])

    raw.drop() // pre-start drop: nothing to park, no grace window
    await flush()
    expect([...host.peersBySlot.keys()]).toEqual([])
    expect(host.lobbyPlayers()).toHaveLength(1)

    host.beginGame()
    await flush()
    expect(playerIds(host)).toEqual([0])

    // The freed slot is reissued to the next joiner rather than being held.
    const { welcome } = await joinRaw(hub, 'Cara')
    expect(welcome.slot).toBe(1)
  })

  it('does not park a ghost for a peer that dropped between Welcome and GameStart', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(5, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { raw } = await joinRaw(hub, 'Bob')
    raw.drop()
    await flush()
    host.beginGame()
    await flush()

    // Nothing reserved the slot, so a fresh late joiner takes slot 1 outright.
    const { welcome } = await joinRaw(hub, 'Newbie')
    expect(welcome.slot).toBe(1)
    expect(playerCount(host)).toBe(2)
  })

  it('ghosts a late joiner that drops immediately after its Welcome+Go', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(6, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()

    const late = hub.addRawCentral()
    late.connect()
    await flush()
    late.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    await flush()
    const welcome = findMsg<WelcomeMsg>(late.received(), MsgType.Welcome)!
    const entityId = host.peersBySlot.get(welcome.slot)!.entityId!

    late.drop() // the link dies the instant it starts playing
    await flush()
    expect(host.peersBySlot.get(welcome.slot)).toBeUndefined()

    // Its avatar is parked, not deleted, and the slot is reclaimable by token.
    expect(host.world.byId.get(entityId)?.dead).toBeFalsy()
    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(
      encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late', rejoin: { slot: welcome.slot, token: welcome.token } }),
    )
    await flush()
    expect(host.peersBySlot.get(welcome.slot)?.entityId).toBe(entityId)
  })
})

describe('connection lifecycle — ghost expiry at the 90s boundary', () => {
  it('still accepts a rejoin on the LAST tick of the grace window', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(10, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)

    for (let i = 0; i < REJOIN_GRACE_TICKS - 1; i++) host.tick()

    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()

    expect(findMsg<WelcomeMsg>(back.received(), MsgType.Welcome)?.slot).toBe(slot)
    expect(host.peersBySlot.get(slot)?.entityId).toBe(entityId)
    expect(host.world.byId.get(entityId)?.dead).toBeFalsy()
  })

  it('expires the ghost on the very next tick and refuses the rejoin', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(11, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)

    for (let i = 0; i < REJOIN_GRACE_TICKS; i++) host.tick()
    expect(host.world.byId.get(entityId)?.dead).toBe(true)

    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()

    expect(findMsg<WelcomeMsg>(back.received(), MsgType.Welcome)).toBeUndefined()
    expect(findMsg<{ reason: string }>(back.received(), MsgType.Reject)?.reason).toMatch(/rejoin|expired|window/i)
  })

  it('sweeps the expired avatar out of the world one tick later', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(12, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { entityId } = await seedGhost(hub, host)
    for (let i = 0; i < REJOIN_GRACE_TICKS; i++) host.tick()
    expect(host.world.byId.get(entityId)).toBeDefined() // flagged dead, not yet swept
    host.tick()
    expect(host.world.byId.get(entityId)).toBeUndefined()
  })

  it('frees the expired slot for a brand-new joiner', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(13, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot } = await seedGhost(hub, host)

    // While the ghost holds slot 1 a newcomer is pushed to slot 2...
    const during = await joinRaw(hub, 'During')
    expect(during.welcome.slot).toBe(2)

    for (let i = 0; i <= REJOIN_GRACE_TICKS; i++) host.tick()

    // ...and once it expires, slot 1 is handed out again.
    const after = await joinRaw(hub, 'After')
    expect(after.welcome.slot).toBe(slot)
  })
})

describe('connection lifecycle — rejoin tokens (forged, stale, duplicated)', () => {
  it('lets exactly ONE of two peers racing the same token win the slot', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(20, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)
    const before = playerCount(host)

    const x = hub.addRawCentral()
    const y = hub.addRawCentral()
    x.connect()
    y.connect()
    await flush()
    const hello = encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } })
    x.send(hello)
    y.send(hello)
    await flush()

    const welcomes = [x, y].filter((c) => findMsg<WelcomeMsg>(c.received(), MsgType.Welcome) !== undefined)
    const rejects = [x, y].filter((c) => findMsg<{ reason: string }>(c.received(), MsgType.Reject) !== undefined)
    expect(welcomes).toHaveLength(1)
    expect(rejects).toHaveLength(1)
    // One avatar, one slot owner — the loser must not get a second body.
    expect(playerCount(host)).toBe(before)
    expect(host.peersBySlot.get(slot)?.entityId).toBe(entityId)
  })

  it('refuses every malformed rejoin payload and keeps the ghost reclaimable', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(21, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)
    const before = playerCount(host)

    const payloads: unknown[] = [
      { slot },                                  // no token at all
      { slot, token: '' },                       // empty token
      { slot, token: null },                     // null token
      { slot, token: { forged: true } },         // object token
      { slot, token: `${token}x` },              // near-miss token
      { slot: String(slot), token },             // string slot (Map is keyed by number)
      { slot: 99, token },                       // slot past MAX_SLOT
      { slot: -1, token },                       // negative slot
    ]
    for (const rejoin of payloads) {
      const z = hub.addRawCentral()
      z.connect()
      await flush()
      z.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Imposter', rejoin }))
      await flush()
      expect(findMsg<WelcomeMsg>(z.received(), MsgType.Welcome), `payload ${JSON.stringify(rejoin)}`).toBeUndefined()
      expect(findMsg<{ reason: string }>(z.received(), MsgType.Reject), `payload ${JSON.stringify(rejoin)}`).toBeDefined()
      z.drop()
      await flush()
    }
    // No forged attempt spawned a body or displaced the parked avatar.
    expect(playerCount(host)).toBe(before)

    const good = hub.addRawCentral()
    good.connect()
    await flush()
    good.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()
    expect(host.peersBySlot.get(slot)?.entityId).toBe(entityId)
  })

  it('refuses a token minted by a PREVIOUS run of the same host', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(22, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token } = await seedGhost(hub, host)

    host.restart() // "play again" wipes the ghost table with the old world
    await flush()

    const stale = hub.addRawCentral()
    stale.connect()
    await flush()
    stale.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()
    expect(findMsg<{ reason: string }>(stale.received(), MsgType.Reject)).toBeDefined()
    expect(findMsg<WelcomeMsg>(stale.received(), MsgType.Welcome)).toBeUndefined()
  })

  it('ignores a second Hello carrying a rejoin block from an already-admitted peer', async () => {
    // netCoop.test.ts covers duplicate Hellos WITHOUT a rejoin block. The guard
    // is `p.slot >= 0 && !hello.rejoin`, so ANY rejoin field walks straight past
    // it: the peer is re-slotted and its old peersBySlot entry is orphaned —
    // a slot that can never be issued again and a lobby that disagrees with it.
    const hub = new MockHub()
    const host = new NetHostSession(23, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { raw } = await joinRaw(hub, 'Bob')
    expect([...host.peersBySlot.keys()]).toEqual([1])

    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot: 1, token: 'anything' } }))
    await flush()

    expect([...host.peersBySlot.keys()]).toEqual([1])
    expect(host.peersBySlot.get(1)?.slot).toBe(1)
    expect(host.lobbyPlayers().map((p) => p.slot)).toEqual([0, 1])
    expect(raw.received().filter((m) => m[0] === MsgType.Welcome)).toHaveLength(1)
  })

  it('will not let a live player take over another player’s ghost with a leaked token', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(24, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const a = await joinRaw(hub, 'A')
    const b = await joinRaw(hub, 'B')
    host.beginGame()
    await flush()
    const bEntity = host.peersBySlot.get(b.welcome.slot)!.entityId!
    a.raw.drop() // A's seat becomes a ghost
    await flush()

    // B is alive at its own slot and presents A's token.
    b.raw.send(
      encodeJson(MsgType.Hello, {
        v: PROTOCOL_VERSION,
        name: 'B',
        rejoin: { slot: a.welcome.slot, token: a.welcome.token },
      }),
    )
    await flush()

    // B keeps exactly its own seat; no peer occupies two slots, and B's avatar
    // is not abandoned in the world with nobody driving it.
    expect(host.peersBySlot.get(b.welcome.slot)?.entityId).toBe(bEntity)
    expect([...host.peersBySlot.keys()]).toEqual([b.welcome.slot])
    expect(host.lobbyPlayers().map((p) => p.name).sort()).toEqual(['Alice', 'B'])

    // A can still come home.
    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(
      encodeJson(MsgType.Hello, {
        v: PROTOCOL_VERSION,
        name: 'A',
        rejoin: { slot: a.welcome.slot, token: a.welcome.token },
      }),
    )
    await flush()
    expect(findMsg<WelcomeMsg>(back.received(), MsgType.Welcome)?.slot).toBe(a.welcome.slot)
  })

  it('does not leak a peersBySlot entry when a re-slotted peer finally disconnects', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(25, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { raw } = await joinRaw(hub, 'Bob')
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot: 1, token: 'x' } }))
    await flush()
    raw.drop()
    await flush()
    expect([...host.peersBySlot.keys()]).toEqual([])
  })
})

describe('connection lifecycle — a ghost whose avatar died while its owner was away', () => {
  it('does not hand back an entity that no longer exists', async () => {
    // The parked avatar is stunned, NOT invulnerable, so a patrol can finish it
    // off during the 90s window. The reclaim path never checks: it replies Go
    // with entityIds pointing at a swept entity, and the client sits in `playing`
    // forever with no avatar, no movement and nothing on screen explaining why.
    const hub = new MockHub()
    const host = new NetHostSession(30, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)

    host.world.byId.get(entityId)!.dead = true
    host.tick() // sweepDead removes it from byId
    expect(host.world.byId.get(entityId)).toBeUndefined()

    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()

    const go = findMsg<GoMsg>(back.received(), MsgType.Go)
    // Either the host refuses the reclaim, or it hands back a LIVE entity —
    // never a Go that points at a corpse.
    if (go) {
      const handed = go.entityIds[slot]
      expect(host.world.byId.get(handed)).toBeDefined()
    } else {
      expect(findMsg<{ reason: string }>(back.received(), MsgType.Reject)).toBeDefined()
    }
  })

  it('lets that player back in as a fresh joiner afterwards', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(31, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)
    host.world.byId.get(entityId)!.dead = true
    host.tick()

    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()
    back.drop()
    await flush()

    // A plain Hello gets a working body, so the run is not lost to the player —
    // and the dead ghost must have released its seat rather than reserving a
    // slot nobody can ever claim for the rest of the grace window.
    const fresh = hub.addRawCentral()
    fresh.connect()
    await flush()
    fresh.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob' }))
    await flush()
    const welcome = findMsg<WelcomeMsg>(fresh.received(), MsgType.Welcome)
    expect(welcome).toBeDefined()
    expect(welcome!.slot).toBe(slot)
    const go = findMsg<GoMsg>(fresh.received(), MsgType.Go)!
    expect(host.world.byId.get(go.entityIds[welcome!.slot])).toBeDefined()
  })
})

describe('connection lifecycle — reconnect storms', () => {
  it('reclaims the SAME slot and avatar across ten rapid token reconnects', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(40, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const ghost = await seedGhost(hub, host)
    const { slot, entityId } = ghost
    let token = ghost.token // the host re-issues it on every reclaim
    const players = playerCount(host)

    for (let round = 0; round < 10; round++) {
      const back = hub.addRawCentral()
      back.connect()
      await flush()
      back.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Flaky', rejoin: { slot, token } }))
      await flush()
      const welcome = findMsg<WelcomeMsg>(back.received(), MsgType.Welcome)
      expect(welcome, `round ${round}`).toBeDefined()
      expect(welcome!.slot, `round ${round}`).toBe(slot)
      expect(host.peersBySlot.get(slot)!.entityId, `round ${round}`).toBe(entityId)
      // No PeerState, slot or avatar leaks across the churn.
      expect([...host.peersBySlot.keys()], `round ${round}`).toEqual([slot])
      expect(playerCount(host), `round ${round}`).toBe(players)
      token = welcome!.token // the host re-issues the ghost's token unchanged
      back.drop()
      await flush()
      host.tick()
    }
    expect(playerCount(host)).toBe(players)
    expect(host.world.byId.get(entityId)).toBeDefined() // same body survived the churn
  })

  it('DOCUMENTED DEFECT: a token-less reconnect storm eats the whole lobby', async () => {
    // Rejoin tokens are minted with Math.random() and held ONLY in client memory
    // (netClient.ts), so an app restart — or any client that never got its
    // Welcome — loses the token. The host then has no way to recognise the
    // returning player: every cycle is a FRESH late-join that burns a new slot
    // and spawns a new avatar, while the previous ghost still reserves the old
    // slot for 90 seconds. One flaky phone can therefore consume all eight seats
    // by itself inside the grace window and then lock its own owner out.
    // This test pins the current behaviour so a fix is a visible, deliberate change.
    const hub = new MockHub()
    const host = new NetHostSession(41, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()

    const slotsIssued: number[] = []
    let rejected = 0
    for (let round = 0; round < 9; round++) {
      const raw = hub.addRawCentral()
      raw.connect()
      await flush()
      raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Flaky' })) // token lost
      await flush()
      const welcome = findMsg<WelcomeMsg>(raw.received(), MsgType.Welcome)
      if (welcome) slotsIssued.push(welcome.slot)
      if (findMsg<{ reason: string }>(raw.received(), MsgType.Reject)) rejected++
      raw.drop()
      await flush()
      host.tick()
    }

    expect(slotsIssued).toEqual([1, 2, 3, 4, 5, 6, 7]) // a new seat every single time
    expect(rejected).toBe(2) // the 8th and 9th attempts are turned away
    expect(playerCount(host)).toBe(MAX_PLAYERS) // seven abandoned bodies + the host
  })

  it('DOCUMENTED DEFECT: those abandoned bodies keep the run from ever ending', async () => {
    // Consequence of the above during a real playtest: the party wipes, but the
    // seven un-driven avatars parked at spawn are stunned rather than downed, so
    // missionSystem's run-over check never fires and nobody gets the game-over.
    const hub = new MockHub()
    const host = new NetHostSession(42, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()
    for (let round = 0; round < 3; round++) {
      const raw = hub.addRawCentral()
      raw.connect()
      await flush()
      raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Flaky' }))
      await flush()
      raw.drop()
      await flush()
      host.tick()
    }
    // Down only the players a human is actually driving (the host).
    const alive = host.world.entities.filter((e) => e.playerCtl && e.playerCtl.playerId === 0)
    for (const e of alive) {
      e.health!.hp = 0
      e.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    }
    host.tick()
    expect(host.world.gameOver).toBe(false)
  })
})

describe('connection lifecycle — capacity while ghosts hold seats', () => {
  it('turns away the ninth player while a ghost still reserves a slot', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(50, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const seats: Seat[] = []
    for (let i = 1; i <= MAX_PLAYERS - 1; i++) seats.push(await joinRaw(hub, `P${i}`))
    host.beginGame()
    await flush()
    expect(host.lobbyPlayers()).toHaveLength(MAX_PLAYERS)

    seats[0].raw.drop() // slot 1 ghosts: a body is free but the seat is reserved
    await flush()

    const ninth = hub.addRawCentral()
    ninth.connect()
    await flush()
    ninth.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Ninth' }))
    await flush()

    expect(findMsg<{ reason: string }>(ninth.received(), MsgType.Reject)?.reason).toMatch(/full/i)
    expect(findMsg<WelcomeMsg>(ninth.received(), MsgType.Welcome)).toBeUndefined()
    // And the ghost's owner is still the one who gets that seat back.
    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(
      encodeJson(MsgType.Hello, {
        v: PROTOCOL_VERSION,
        name: 'P1',
        rejoin: { slot: seats[0].welcome.slot, token: seats[0].welcome.token },
      }),
    )
    await flush()
    expect(findMsg<WelcomeMsg>(back.received(), MsgType.Welcome)?.slot).toBe(seats[0].welcome.slot)
  })

  it('reseats all seven ghosts reclaiming at once onto their original avatars', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(51, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const seats: Seat[] = []
    for (let i = 1; i <= MAX_PLAYERS - 1; i++) seats.push(await joinRaw(hub, `P${i}`))
    host.beginGame()
    await flush()

    const entityIds = seats.map((s) => host.peersBySlot.get(s.welcome.slot)!.entityId!)
    const players = playerCount(host)
    for (const s of seats) {
      s.raw.drop()
      await flush()
    }
    expect([...host.peersBySlot.keys()]).toEqual([])

    // Everyone's radio comes back in the same beat.
    const backs = seats.map(() => hub.addRawCentral())
    for (const b of backs) b.connect()
    await flush()
    backs.forEach((b, i) =>
      b.send(
        encodeJson(MsgType.Hello, {
          v: PROTOCOL_VERSION,
          name: `P${i + 1}`,
          rejoin: { slot: seats[i].welcome.slot, token: seats[i].welcome.token },
        }),
      ),
    )
    await flush()

    expect(backs.map((b) => findMsg<WelcomeMsg>(b.received(), MsgType.Welcome)?.slot)).toEqual(
      seats.map((s) => s.welcome.slot),
    )
    // Same bodies, no duplicates, every seat filled exactly once.
    expect(seats.map((s) => host.peersBySlot.get(s.welcome.slot)!.entityId)).toEqual(entityIds)
    expect(playerCount(host)).toBe(players)
    expect(host.lobbyPlayers()).toHaveLength(MAX_PLAYERS)
  })
})

describe('connection lifecycle — a legitimate reclaim keeps the player whole', () => {
  it('preserves inventory and cash, clears the park stun, and spawns no second body', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(60, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)
    const avatar = host.world.byId.get(entityId)!
    avatar.loadout!.inventory.push({ itemId: 'briefcase', qty: 1 })
    avatar.playerCtl!.cash = 777
    const inventoryBefore = JSON.stringify(avatar.loadout!.inventory)
    const players = playerCount(host)

    for (let i = 0; i < 30; i++) host.tick() // a second of downtime
    expect(host.world.byId.get(entityId)!.status!.stun).toBeGreaterThan(0) // parked

    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()

    const after = host.world.byId.get(entityId)!
    expect(JSON.stringify(after.loadout!.inventory)).toBe(inventoryBefore)
    expect(after.playerCtl!.cash).toBe(777)
    expect(after.status!.stun).toBe(0) // playable again, not frozen for 90s
    expect(playerCount(host)).toBe(players)
    expect(host.lobbyPlayers()).toHaveLength(2)
  })

  it('keeps driving the reclaimed avatar with the returning peer’s input', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(61, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const { slot, token, entityId } = await seedGhost(hub, host)

    const back = hub.addRawCentral()
    back.connect()
    await flush()
    back.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot, token } }))
    await flush()

    const startX = host.world.byId.get(entityId)!.pos.x
    for (let seq = 1; seq <= 20; seq++) {
      back.send(encodeInput({ ...emptyInput(), seq, moveX: 1 }, noEdges))
      await flush()
      host.tick()
    }
    expect(host.world.byId.get(entityId)!.pos.x).toBeGreaterThan(startX)
  })
})

describe('connection lifecycle — the host restarts or vanishes', () => {
  it('does not leave a reconnecting client on the previous run’s map', async () => {
    // The brutal one: the host app restarts (new NetHostSession, NEW SEED) while
    // a client is in `reconnecting`. The client's GameStart handler skips the
    // rebuild whenever it is reconnecting, so it keeps the OLD seed's level and
    // walks into walls the host is not simulating — no error, no warning, and
    // nothing in the HUD that would let a playtester diagnose it.
    const hub = new MockHub()
    const seedA = 111
    const seedB = 999
    const host1 = new NetHostSession(seedA, 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', stubInput())
    await host1.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host1.beginGame()
    await flush()
    for (let i = 0; i < 4; i++) {
      host1.tick()
      bob.session.tick()
      await flush()
    }
    expect(bob.session.phase).toBe('playing')

    bob.drop()
    await flush()
    expect(bob.session.phase).toBe('reconnecting')

    const host2 = new NetHostSession(seedB, 'Alice', stubInput(), hub.hostTransport)
    await host2.start()
    bob.relink()
    await flush()
    host2.beginGame()
    await flush()
    for (let i = 0; i < 6; i++) {
      host2.tick()
      bob.session.tick()
      await flush()
    }

    expect(bob.session.phase).toBe('playing')
    const level = bob.session.renderView().level
    const expected = generateLevel(seedB, 1)
    expect(level.w).toBe(expected.w)
    expect(level.h).toBe(expected.h)
    expect([...level.tiles]).toEqual([...expected.tiles])
    expect(bob.session.renderView().self).toBeDefined()
  })

  it('control: a client that stays connected across a host re-seed follows the new map', async () => {
    // Proves the level comparison above is sensitive — the same assertion passes
    // on the path that already works, so a failure means the reconnect path.
    const hub = new MockHub()
    const host = new NetHostSession(70, 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()
    host.restart(31337)
    await flush()
    for (let i = 0; i < 4; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }
    const expected = generateLevel(31337, 1)
    expect([...bob.session.renderView().level.tiles]).toEqual([...expected.tiles])
  })

  it('tells a returning client the truth when the host re-seeded while it was away', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(71, 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()
    for (let i = 0; i < 4; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }
    bob.drop()
    await flush()

    host.restart(4242) // "New Seed" while Bob is off the air
    await flush()
    bob.relink()
    await flush()

    // Bob's ghost died with the old world, so the host refuses the reclaim. What
    // matters is that Bob LEARNS that, instead of sitting in `reconnecting`.
    expect(bob.session.phase).toBe('rejected')
    expect(bob.session.rejectReason).not.toBe('')
  })

  it('surfaces a lost host instead of hanging silently (reconnect-capable link)', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(72, 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', stubInput())
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()
    for (let i = 0; i < 4; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }

    bob.drop() // the host's phone walked out of range / was killed
    await flush()
    expect(bob.session.phase).toBe('reconnecting')
    expect(bob.session.renderView().missionText).toMatch(/reconnect/i)
  })

  it('surfaces a lost host on a link that cannot reconnect', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(73, 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', stubInput(), { reconnectable: false })
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()
    for (let i = 0; i < 4; i++) {
      host.tick()
      bob.session.tick()
      await flush()
    }

    bob.drop()
    await flush()
    expect(bob.session.phase).toBe('ended')
    expect(bob.session.renderView().missionText).toMatch(/lost/i)
  })
})
