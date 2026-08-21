import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../game/entity'
import { addEntity } from '../game/world'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { encodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { decodeSnapshot, encodeSnapshot, type WireSnapshot } from '../net/protocol/messages'
import { isKnownMsgType, MsgType, PROTOCOL_VERSION, SNAPSHOT_INTERVAL_TICKS, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { MAX_PLAYERS, NetHostSession, SNAPSHOT_ENTITY_CAP } from './netHost'

/**
 * SCALE, BACKPRESSURE AND INTEREST MANAGEMENT at a full 8-player load.
 *
 * The 4-player co-op suite and `netStress8` prove the protocol *carries* eight
 * players on an idle loopback. This suite attacks the two things that only bite
 * once the world is CROWDED and the link is SLOW:
 *
 *  1. Interest management — the host ships each peer only what is near it, under
 *     a hard 48-entity cap. A cap that can evict a PLAYER is a game-breaker: the
 *     client's own avatar vanishes from its own screen.
 *  2. Backpressure — the SendQueue has a reliable FIFO and a capacity-1 snapshot
 *     slot. Under a link far slower than the host produces, snapshots must
 *     degrade (latest-wins) while reliable control traffic survives intact.
 *
 * Everything here is deterministic: no real clocks, no random jitter. The slow
 * link is a manually-pumped transport that hands out exactly as many packets as
 * the test tells it to.
 */

// --- test harness ----------------------------------------------------------

interface Central {
  peer: PeerId
  /** Every message the host sent this peer, in delivery order. */
  received: Uint8Array[]
  snapshots: WireSnapshot[]
  bytes: number
  packets: number
}

/**
 * Loopback hub with per-peer byte accounting and an optional MANUALLY PUMPED
 * slow link. With `throttle` on, `sendPacket` parks its promise until the test
 * calls `release(n)`, so "the radio is slower than the sim" is expressed as an
 * exact packet budget rather than a timer race.
 */
class ScaleHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  readonly centrals = new Map<PeerId, Central>()
  private clientHandlers = new Map<PeerId, (e: TransportEvent) => void>()
  private parked: { peer: PeerId; bytes: Uint8Array; go: () => void }[] = []
  throttle = false
  /** Packets the host handed the transport but that the "radio" never carried. */
  undelivered = (): number => this.parked.length

  constructor(readonly maxPacket = 180) {
    this.hostTransport = {
      role: 'host',
      maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer: PeerId, bytes: Uint8Array) => this.send(peer, bytes),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  private send(peer: PeerId, bytes: Uint8Array): Promise<void> {
    if (!this.throttle) {
      this.deliver(peer, bytes)
      return Promise.resolve()
    }
    // Copy: SendQueue hands out subarray views of a buffer it may reuse.
    const copy = bytes.slice()
    return new Promise<void>((go) => this.parked.push({ peer, bytes: copy, go }))
  }

  private deliver(peer: PeerId, bytes: Uint8Array): void {
    const c = this.centrals.get(peer)
    if (!c) return
    c.bytes += bytes.length
    c.packets++
    const reader = this.readers.get(peer)!
    reader.push(bytes, (m) => {
      c.received.push(m.slice())
      if (m[0] === MsgType.Snapshot) c.snapshots.push(decodeSnapshot(m))
    })
    const h = this.clientHandlers.get(peer)
    if (h) void Promise.resolve().then(() => h({ type: 'data', peer: 'host', bytes }))
  }

  private readers = new Map<PeerId, StreamReader>()

  /** Let exactly `n` parked packets through (FIFO across peers). */
  async release(n: number): Promise<number> {
    let sent = 0
    while (sent < n && this.parked.length > 0) {
      const p = this.parked.shift()!
      this.deliver(p.peer, p.bytes)
      p.go()
      sent++
      // Let the peer's pump enqueue its next packet before we count the budget.
      await Promise.resolve()
      await Promise.resolve()
    }
    return sent
  }

  /** Drain everything currently parked (and whatever that unblocks). */
  async releaseAll(limit = 100000): Promise<void> {
    let spins = 0
    while (this.parked.length > 0 && spins < limit) {
      spins += await this.release(64)
      await flush()
    }
  }

  addCentral(peer: PeerId): Central {
    const c: Central = { peer, received: [], snapshots: [], bytes: 0, packets: 0 }
    this.centrals.set(peer, c)
    this.readers.set(peer, new StreamReader({ isValidStart: isKnownMsgType }))
    return c
  }

  connectRaw(peer: PeerId): Central {
    const c = this.addCentral(peer)
    this.hostHandler?.({ type: 'peerConnected', peer })
    return c
  }

  /** Push a client→host message through the framing, as a real central would. */
  fromCentral(peer: PeerId, msg: Uint8Array): void {
    for (const pk of frameMessage(msg, this.maxPacket)) this.hostHandler?.({ type: 'data', peer, bytes: pk })
  }

  dropCentral(peer: PeerId): void {
    this.centrals.delete(peer)
    this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' })
  }

  /** A real NetClientSession wired to this hub (for end-to-end client asserts). */
  attachClient(peer: PeerId, name: string, input: InputSource): NetClientSession {
    const c = this.addCentral(peer)
    void c
    const clientTransport: Transport = {
      role: 'client',
      maxPacket: this.maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) =>
        Promise.resolve().then(() => void this.hostHandler?.({ type: 'data', peer, bytes })),
      on: (h) => {
        this.clientHandlers.set(peer, h)
        return () => {}
      },
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, clientTransport)
    this.hostHandler?.({ type: 'peerConnected', peer })
    this.clientHandlers.get(peer)?.({ type: 'peerConnected', peer: 'host' })
    return session
  }
}

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * A started 8-player run: host (slot 0) + 7 raw centrals admitted via Hello.
 * Raw centrals keep the host path honest (real Hello/Welcome/GameStart/Go) while
 * letting us read the exact bytes the host puts on each peer's wire.
 */
const start8 = async (
  seed: number,
  hub = new ScaleHub(),
  hostInput: InputSource = stubInput(),
): Promise<{ hub: ScaleHub; host: NetHostSession; centrals: Central[] }> => {
  const host = new NetHostSession(seed, 'Alice', hostInput, hub.hostTransport)
  await host.start()
  const centrals: Central[] = []
  for (let i = 1; i <= MAX_PLAYERS - 1; i++) {
    const peer = `c${i}`
    centrals.push(hub.connectRaw(peer))
    hub.fromCentral(peer, encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: `P${i}` }))
  }
  await flush()
  host.beginGame()
  await flush()
  return { hub, host, centrals }
}

const clearWire = (centrals: Central[]): void => {
  for (const c of centrals) {
    c.received.length = 0
    c.snapshots.length = 0
    c.bytes = 0
    c.packets = 0
  }
}

const playersOf = (host: NetHostSession): Entity[] => host.world.entities.filter((e) => e.playerCtl !== undefined)

/** Park all 8 avatars on one tile so every peer shares one interest window. */
const huddleAt = (host: NetHostSession, x: number, y: number): Entity[] => {
  const ps = playersOf(host)
  ps.forEach((p, i) => {
    p.pos.x = x + (i % 3) * 0.4
    p.pos.y = y + Math.floor(i / 3) * 0.4
  })
  return ps
}

/**
 * Turn the floor genuinely BUSY: hostile station, NPCs dragged onto the party.
 * The point is to drive the REAL event path rather than hand-injecting reliable
 * traffic — measured, this produces sim events on ~40% of ticks (~12Hz), each
 * ~167B, which is ~2KB/s of RELIABLE data per peer before a single snapshot.
 */
const makeBusy = (host: NetHostSession): void => {
  const anchor = playersOf(host)[0]
  host.world.hostile = true
  let n = 0
  for (const e of host.world.entities) {
    if (e.ai && n < 40) {
      e.pos.x = anchor.pos.x + (n % 7) - 3
      e.pos.y = anchor.pos.y + Math.floor(n / 7) - 3
      n++
    }
  }
}

/** Run `n` host ticks, letting the (unthrottled) loopback settle each time. */
const tickHost = async (host: NetHostSession, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    host.tick()
    await flush()
  }
}

/**
 * Crowd the interest window with `n` inert props placed BEFORE the players in
 * `world.entities` — which is exactly how a real floor is laid out, because
 * `beginGame` runs `populateWorld` first and spawns avatars afterwards.
 */
const crowdBeforePlayers = (host: NetHostSession, n: number, cx: number, cy: number, spread = 6): Entity[] => {
  const props: Entity[] = []
  for (let i = 0; i < n; i++) {
    const e = makeEntity('interactable', 'crate', cx + ((i % 13) - 6) * (spread / 13), cy + ((i % 7) - 3) * (spread / 7), 0.4)
    addEntity(host.world, e)
    props.push(e)
  }
  // Re-order so the props precede every player avatar, matching a real floor.
  const players = new Set(playersOf(host).map((e) => e.id))
  const rest = host.world.entities.filter((e) => !players.has(e.id))
  const avatars = host.world.entities.filter((e) => players.has(e.id))
  host.world.entities.length = 0
  host.world.entities.push(...rest, ...avatars)
  return props
}

// --- 1. the entity cap must never evict a player ---------------------------

describe('interest cap — players are unconditionally included', () => {
  it('ships all 8 players even when 80+ props crowd the interest window', async () => {
    // Seed 1 floor 1 has rooms holding 80+ props inside one 14-tile window; the
    // avatars spawn LAST in `world.entities`, so an array-order cap never
    // reaches them. This is a live-play state, not a synthetic one.
    const { host, centrals } = await start8(1)
    const players = huddleAt(host, 18, 18)
    const playerIds = new Set(players.map((p) => p.id))
    const inWindow = host.world.entities.filter(
      (e) => !e.dead && !e.playerCtl && Math.abs(e.pos.x - 18) < 14 && Math.abs(e.pos.y - 18) < 14,
    )
    expect(inWindow.length).toBeGreaterThan(SNAPSHOT_ENTITY_CAP) // the cap really is oversubscribed

    clearWire(centrals)
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 2)

    for (const c of centrals) {
      expect(c.snapshots.length).toBeGreaterThan(0)
      for (const snap of c.snapshots) {
        const seen = snap.entities.filter((e) => playerIds.has(e.id)).map((e) => e.id)
        expect(new Set(seen).size).toBe(MAX_PLAYERS)
      }
    }
  })

  it("a peer's OWN avatar is in every snapshot it receives (the cap cannot hide you from yourself)", async () => {
    const { host, centrals } = await start8(1)
    huddleAt(host, 18, 18)
    const ownId = new Map<PeerId, number>()
    for (let slot = 1; slot <= MAX_PLAYERS - 1; slot++) ownId.set(`c${slot}`, host.peersBySlot.get(slot)!.entityId!)

    clearWire(centrals)
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 3)

    for (const c of centrals) {
      const mine = ownId.get(c.peer)!
      expect(c.snapshots.length).toBeGreaterThan(0)
      for (const snap of c.snapshots) expect(snap.entities.some((e) => e.id === mine)).toBe(true)
    }
  })

  it('holds the cap exactly at 48 while still carrying every player', async () => {
    const { host, centrals } = await start8(1)
    huddleAt(host, 18, 18)
    clearWire(centrals)
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 2)
    for (const c of centrals) {
      for (const snap of c.snapshots) {
        expect(snap.entities.length).toBeLessThanOrEqual(SNAPSHOT_ENTITY_CAP)
        expect(snap.entities.filter((e) => e.archetype === 'player')).toHaveLength(MAX_PLAYERS)
      }
    }
  })

  it('survives the cap boundary: 47, 48 and 49 in-window props all keep 8 players', async () => {
    for (const n of [SNAPSHOT_ENTITY_CAP - 1, SNAPSHOT_ENTITY_CAP, SNAPSHOT_ENTITY_CAP + 1]) {
      // A bare arena: clear the generated floor so `n` is the exact prop count.
      const { host, centrals } = await start8(7)
      const avatars = playersOf(host)
      host.world.entities.length = 0
      host.world.byId.clear()
      for (const a of avatars) {
        host.world.entities.push(a)
        host.world.byId.set(a.id, a)
      }
      huddleAt(host, 30, 30)
      crowdBeforePlayers(host, n, 30, 30)
      clearWire(centrals)
      await tickHost(host, SNAPSHOT_INTERVAL_TICKS)
      for (const c of centrals) {
        const snap = c.snapshots.at(-1)!
        expect(snap, `n=${n} peer=${c.peer}`).toBeDefined()
        expect(snap.entities.filter((e) => e.archetype === 'player').length, `n=${n} peer=${c.peer}`).toBe(MAX_PLAYERS)
        expect(snap.entities.length, `n=${n} peer=${c.peer}`).toBeLessThanOrEqual(SNAPSHOT_ENTITY_CAP)
      }
    }
  })
})

// --- 2. what the cap drops, and how stably ---------------------------------

describe('interest cap — selection quality and stability', () => {
  it('keeps the NEAREST in-window entity when oversubscribed (a point-blank threat is never dropped for distant props)', async () => {
    const { host, centrals } = await start8(7)
    const avatars = playersOf(host)
    host.world.entities.length = 0
    host.world.byId.clear()
    for (const a of avatars) {
      host.world.entities.push(a)
      host.world.byId.set(a.id, a)
    }
    huddleAt(host, 30, 30)
    // 90 props scattered at 8..13 tiles — inside the window, far from the party.
    const far: Entity[] = []
    for (let i = 0; i < 90; i++) {
      const ang = (i / 90) * Math.PI * 2
      const e = makeEntity('interactable', 'crate', 30 + Math.cos(ang) * (8 + (i % 5)), 30 + Math.sin(ang) * (8 + (i % 5)), 0.4)
      addEntity(host.world, e)
      far.push(e)
    }
    // The thing that matters: a thug standing on top of the party.
    const thug = makeEntity('npc', 'thug', 30.3, 30.3, 0.35)
    thug.health = { hp: 40, max: 40, iframes: 0 }
    addEntity(host.world, thug)
    // Real floor order: everything the level made comes before the avatars.
    const ids = new Set(avatars.map((a) => a.id))
    const props = host.world.entities.filter((e) => !ids.has(e.id))
    host.world.entities.length = 0
    host.world.entities.push(...props, ...avatars)

    clearWire(centrals)
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS)

    for (const c of centrals) {
      const snap = c.snapshots.at(-1)!
      expect(snap.entities.some((e) => e.id === thug.id), `${c.peer} lost the point-blank thug`).toBe(true)
    }
  })

  it('is deterministic: two identical hosts put byte-identical snapshots on the wire', async () => {
    const run = async (): Promise<string> => {
      const { host, centrals } = await start8(1)
      huddleAt(host, 18, 18)
      clearWire(centrals)
      await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 3)
      return JSON.stringify(centrals.map((c) => c.snapshots))
    }
    expect(await run()).toBe(await run())
  })

  it('does not churn the selected set frame to frame while the world is static (no sprite pop-in/pop-out)', async () => {
    const { host, centrals } = await start8(1)
    huddleAt(host, 18, 18)
    // Freeze the world: only the host's snapshot selection may vary.
    for (const e of host.world.entities) {
      e.vel.x = 0
      e.vel.y = 0
      e.ai = undefined
    }
    clearWire(centrals)
    const frozen = host.world.entities.map((e) => ({ e, x: e.pos.x, y: e.pos.y }))
    for (let i = 0; i < SNAPSHOT_INTERVAL_TICKS * 5; i++) {
      for (const f of frozen) {
        f.e.pos.x = f.x
        f.e.pos.y = f.y
      }
      host.tick()
      await flush()
    }
    const c = centrals[0]
    expect(c.snapshots.length).toBeGreaterThanOrEqual(4)
    const sets = c.snapshots.map((s) => s.entities.map((e) => e.id).sort((a, b) => a - b).join(','))
    for (const s of sets) expect(s).toBe(sets[0])
  })
})

// --- 3. interest boundary crossings on the CLIENT --------------------------

describe('interest boundary — the client must not keep ghosts', () => {
  const bootClient = async (
    seed: number,
  ): Promise<{ hub: ScaleHub; host: NetHostSession; client: NetClientSession; central: Central }> => {
    const hub = new ScaleHub()
    const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const client = hub.attachClient('c1', 'Bob', stubInput())
    await flush()
    host.beginGame()
    await flush()
    return { hub, host, client, central: hub.centrals.get('c1')! }
  }

  const clientHas = (client: NetClientSession, id: number): boolean =>
    client.renderView().entities.some((e) => e.id === id)

  it('removes an entity from the client when it leaves the 14-tile window', async () => {
    const { host, client } = await bootClient(7)
    const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
    const mover = makeEntity('npc', 'thug', avatar.pos.x + 1, avatar.pos.y + 1, 0.35)
    mover.health = { hp: 40, max: 40, iframes: 0 }
    mover.ai = undefined
    addEntity(host.world, mover)

    for (let i = 0; i < SNAPSHOT_INTERVAL_TICKS * 2; i++) {
      mover.pos.x = avatar.pos.x + 1
      mover.pos.y = avatar.pos.y + 1
      host.tick()
      client.tick()
      await flush()
    }
    expect(clientHas(client, mover.id)).toBe(true)

    // Walk it well outside the window and keep it there.
    for (let i = 0; i < SNAPSHOT_INTERVAL_TICKS * 3; i++) {
      mover.pos.x = avatar.pos.x + 25
      mover.pos.y = avatar.pos.y + 25
      host.tick()
      client.tick()
      await flush()
    }
    expect(clientHas(client, mover.id), 'ghost sprite left behind after leaving interest').toBe(false)
  })

  it('re-adds an entity that leaves the window and comes back', async () => {
    const { host, client } = await bootClient(7)
    const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
    const mover = makeEntity('npc', 'thug', avatar.pos.x + 1, avatar.pos.y + 1, 0.35)
    mover.health = { hp: 40, max: 40, iframes: 0 }
    mover.ai = undefined
    addEntity(host.world, mover)

    const hold = async (dx: number, dy: number, ticks: number): Promise<void> => {
      for (let i = 0; i < ticks; i++) {
        mover.pos.x = avatar.pos.x + dx
        mover.pos.y = avatar.pos.y + dy
        host.tick()
        client.tick()
        await flush()
      }
    }
    await hold(1, 1, SNAPSHOT_INTERVAL_TICKS * 2)
    expect(clientHas(client, mover.id)).toBe(true)
    await hold(25, 25, SNAPSHOT_INTERVAL_TICKS * 3)
    expect(clientHas(client, mover.id)).toBe(false)
    await hold(1, 1, SNAPSHOT_INTERVAL_TICKS * 3)
    expect(clientHas(client, mover.id), 'entity never came back after re-entering interest').toBe(true)
  })

  it('leaves no ghost for an entity that DIES while outside the window', async () => {
    const { host, client } = await bootClient(7)
    const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
    const doomed = makeEntity('npc', 'thug', avatar.pos.x + 1, avatar.pos.y + 1, 0.35)
    doomed.health = { hp: 40, max: 40, iframes: 0 }
    doomed.ai = undefined
    addEntity(host.world, doomed)

    for (let i = 0; i < SNAPSHOT_INTERVAL_TICKS * 2; i++) {
      doomed.pos.x = avatar.pos.x + 1
      doomed.pos.y = avatar.pos.y + 1
      host.tick()
      client.tick()
      await flush()
    }
    expect(clientHas(client, doomed.id)).toBe(true)

    // Wander out of interest, then die out there where nobody can see it.
    for (let i = 0; i < SNAPSHOT_INTERVAL_TICKS * 3; i++) {
      doomed.pos.x = avatar.pos.x + 25
      doomed.pos.y = avatar.pos.y + 25
      host.tick()
      client.tick()
      await flush()
    }
    doomed.dead = true
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 2)
    for (let i = 0; i < 4; i++) {
      client.tick()
      await flush()
    }
    expect(host.world.byId.has(doomed.id)).toBe(false) // the host really swept it
    expect(clientHas(client, doomed.id), 'client still renders an entity that died out of sight').toBe(false)
  })
})

// --- 4. backpressure on a link far slower than the sim ---------------------

describe('backpressure — a link slower than the host produces', () => {
  it('never drops or reorders a RELIABLE message while snapshots are being overwritten', async () => {
    const hub = new ScaleHub(20) // 20-byte MTU: the BLE floor
    const { host, centrals } = await start8(1, hub)
    huddleAt(host, 18, 18)
    await hub.releaseAll()
    clearWire(centrals)
    hub.throttle = true

    // The host runs 60 ticks; the radio carries a starvation budget of 8
    // packets per tick across ALL 7 peers (a ~48-entity snapshot alone is 25
    // packets at a 20-byte MTU, so this link is deeply oversubscribed).
    // A tagged reliable message EVERY tick, so the FIFO builds a deep backlog
    // the slow link cannot keep up with. A shallow backlog would let a queue
    // that silently sheds or reorders its overflow still look correct.
    const expected: number[] = []
    for (let t = 0; t < 60; t++) {
      host.tick()
      const msg = encodeJson(MsgType.LobbyState, { players: host.lobbyPlayers(), marker: t })
      expected.push(t)
      for (const p of host.peersBySlot.values()) p.queue.queueReliable(msg)
      await flush()
      await hub.release(8)
    }
    hub.throttle = false
    await hub.releaseAll()
    await flush()

    for (const c of centrals) {
      const markers = c.received
        .filter((m) => m[0] === MsgType.LobbyState)
        .map((m) => (JSON.parse(new TextDecoder().decode(m.subarray(1))) as { marker?: number }).marker)
        .filter((m): m is number => m !== undefined)
      // Every reliable marker arrived, exactly once, in the order it was sent —
      // no drops, no duplicates, no reordering, however deep the backlog got.
      expect(markers, `peer ${c.peer} lost or reordered reliable messages`).toEqual(expected)
    }
  })

  it('degrades snapshots latest-wins: the client sees far fewer than were produced, and never an older tick', async () => {
    const hub = new ScaleHub(20)
    const { host, centrals } = await start8(1, hub)
    huddleAt(host, 18, 18)
    await hub.releaseAll()
    clearWire(centrals)
    hub.throttle = true

    const produced = 90 / SNAPSHOT_INTERVAL_TICKS
    for (let t = 0; t < 90; t++) {
      host.tick()
      await flush()
      await hub.release(10)
    }
    hub.throttle = false
    await hub.releaseAll()
    await flush()

    for (const c of centrals) {
      expect(c.snapshots.length, `peer ${c.peer} got everything — link was not actually slow`).toBeLessThan(produced)
      const ticks = c.snapshots.map((s) => s.tick)
      // Latest-wins must never hand the client a tick older than one it already had.
      const sorted = [...ticks].sort((a, b) => a - b)
      expect(ticks, `peer ${c.peer} received snapshots out of tick order`).toEqual(sorted)
    }
  })

  it('raises SendQueue.overwrites as the backlog builds, and relaxes it once the link catches up', async () => {
    const hub = new ScaleHub(20)
    const { host } = await start8(1, hub)
    huddleAt(host, 18, 18)
    await hub.releaseAll()
    hub.throttle = true

    for (let t = 0; t < 45; t++) {
      host.tick()
      await flush()
      await hub.release(2) // brutally under-provisioned
    }
    const peaked = [...host.peersBySlot.values()].map((p) => p.queue.overwrites)
    expect(Math.max(...peaked), 'no backpressure signal at all under a 2-packet/tick link').toBeGreaterThan(0)

    hub.throttle = false
    await hub.releaseAll()
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 2)
    const relaxed = [...host.peersBySlot.values()].map((p) => p.queue.overwrites)
    expect(Math.max(...relaxed), 'overwrites never cleared after the link recovered').toBe(0)
  })

  it('keeps positional updates flowing even while reliable traffic floods (the snapshot lane is not starved)', async () => {
    const hub = new ScaleHub(20)
    const { host, centrals } = await start8(1, hub)
    huddleAt(host, 18, 18)
    await hub.releaseAll()
    clearWire(centrals)
    hub.throttle = true

    // A firefight's worth of reliable chatter: one broadcast per tick, forever,
    // on a link that cannot keep up. Under strict reliable-first priority the
    // snapshot slot is never drained and every client's world FREEZES while
    // control traffic flows perfectly — the worst possible failure mode,
    // because the game looks connected and is not.
    //
    // Measured DURING the flood, not after: draining the backlog at the end
    // would hand the client its snapshots late and hide the freeze.
    for (let t = 0; t < 60; t++) {
      host.tick()
      for (const p of host.peersBySlot.values()) {
        p.queue.queueReliable(encodeJson(MsgType.Events, { tick: host.world.tick, events: [{ type: 'noise', t }] }))
      }
      await flush()
      await hub.release(12)
    }

    for (const c of centrals) {
      expect(
        c.snapshots.length,
        `peer ${c.peer} received NO snapshot during 60 ticks of reliable flood — its world is frozen`,
      ).toBeGreaterThan(0)
    }
    hub.throttle = false
    await hub.releaseAll()
  })

  /**
   * github#34 — "Host stops sending snapshots once a floor gets busy". Measured
   * in a built-dist e2e run: on floor 3 the lobby-joined client sat at
   * `lastAckedSeq` 82 with 0 entities and the late joiner never applied a single
   * snapshot, while the host reported itself perfectly healthy (input seq 1160,
   * 0 drops, 0 stream desyncs). No `peerDisconnected` ever fires, so the client
   * never even tries to reconnect: the game looks connected and is frozen.
   *
   * This drives the REAL path — actual sim events broadcast reliably by
   * `NetHostSession.tick` on a genuinely busy floor — rather than hand-fed
   * reliable traffic, so it fails for the reported reason and not a rigged one.
   */
  it('github#34: keeps serving snapshots on a BUSY floor whose real Events traffic outruns the link', async () => {
    const hub = new ScaleHub(180)
    const { host, centrals } = await start8(424242, hub, stubInput({ attack: true, moveX: 0.3 }))
    makeBusy(host)
    await hub.releaseAll()
    clearWire(centrals)
    hub.throttle = true

    // A link that can carry the reliable lane and little else. Every byte here
    // comes from the host's own tick(): Events (~12Hz on this floor), StateMsg
    // (2Hz) and Inventory — no synthetic traffic at all.
    let eventTicks = 0
    for (let t = 0; t < 150; t++) {
      host.tick()
      if (host.world.events.length > 0) eventTicks++
      await flush()
      await hub.release(3)
    }

    // The floor really is busy — otherwise this test proves nothing.
    expect(eventTicks, 'floor was not busy enough to reproduce the starvation').toBeGreaterThan(20)
    for (const c of centrals) {
      expect(
        c.snapshots.length,
        `peer ${c.peer} applied NO snapshot across 150 busy ticks — github#34 freeze`,
      ).toBeGreaterThan(0)
    }
    hub.throttle = false
    await hub.releaseAll()
  })

  it('github#34: the starvation is permanent — a starved peer never self-heals while the floor stays busy', async () => {
    const hub = new ScaleHub(180)
    const { host, centrals } = await start8(424242, hub, stubInput({ attack: true, moveX: 0.3 }))
    makeBusy(host)
    await hub.releaseAll()
    clearWire(centrals)
    hub.throttle = true

    // Sample in two halves: if the lane is starved rather than merely slow, the
    // SECOND half is just as empty as the first, forever.
    const half = (): number[] => centrals.map((c) => c.snapshots.length)
    for (let t = 0; t < 90; t++) {
      host.tick()
      await flush()
      await hub.release(3)
    }
    const firstHalf = half()
    for (let t = 0; t < 90; t++) {
      host.tick()
      await flush()
      await hub.release(3)
    }
    const secondHalf = half()

    for (let i = 0; i < centrals.length; i++) {
      expect(
        secondHalf[i] - firstHalf[i],
        `peer ${centrals[i].peer} received no NEW snapshot in the second 90 ticks — permanently starved`,
      ).toBeGreaterThan(0)
    }
    hub.throttle = false
    await hub.releaseAll()
  })

  it('drops only the oversized message when framing rejects one, and keeps serving the peer', async () => {
    // sendQueue.pump is started as `void this.pump()`, so anything frameMessage
    // throws escapes as an unhandled rejection and abandons the whole queue.
    // (test/net-protocol-fuzz makes frameMessage throw on oversized messages;
    // this must hold whether or not that change is present.)
    const hub = new ScaleHub(180)
    const { host, centrals } = await start8(7, hub)
    clearWire(centrals)
    const peer = host.peersBySlot.get(1)!
    const rejections: unknown[] = []
    const onRejection = (e: PromiseRejectionEvent | unknown): void => void rejections.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      // Way past MAX_MESSAGE_BYTES (16384).
      peer.queue.queueReliable(encodeJson(MsgType.LobbyState, { pad: 'x'.repeat(40000) }))
      await flush()
      // The peer must still be served afterwards.
      peer.queue.queueReliable(encodeJson(MsgType.LobbyState, { players: host.lobbyPlayers(), marker: 'after' }))
      await flush()
      await tickHost(host, SNAPSHOT_INTERVAL_TICKS)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(rejections, 'an oversized message produced an unhandled rejection').toEqual([])
    const c = centrals[0]
    const sawMarker = c.received.some(
      (m) => m[0] === MsgType.LobbyState && new TextDecoder().decode(m.subarray(1)).includes('"marker":"after"'),
    )
    expect(sawMarker, 'queue stopped serving the peer after an unframeable message').toBe(true)
    expect(c.snapshots.length, 'snapshots stopped after an unframeable message').toBeGreaterThan(0)
  })
})

// --- 5. out-of-order / stale snapshot arrival ------------------------------

describe('stale snapshot arrival', () => {
  it('ignores a snapshot older than one already applied instead of rubber-banding the world backwards', async () => {
    const hub = new ScaleHub()
    const host = new NetHostSession(7, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const client = hub.attachClient('c1', 'Bob', stubInput())
    await flush()
    host.beginGame()
    await flush()
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 2)
    for (let i = 0; i < 3; i++) {
      client.tick()
      await flush()
    }

    const selfId = host.peersBySlot.get(1)!.entityId!
    const push = async (snap: WireSnapshot): Promise<void> => {
      for (const pk of frameMessage(encodeSnapshot(snap), hub.maxPacket)) {
        hub['clientHandlers'].get('c1')?.({ type: 'data', peer: 'host', bytes: pk })
      }
      await flush()
    }
    const at = (tick: number, x: number): WireSnapshot => ({
      tick,
      floor: 1,
      alarm: 0,
      lastInputSeq: tick,
      entities: [{ id: selfId, archetype: 'player', x, y: 20, facing: 0, hpPct: 1, flags: 0 }],
    })

    await push(at(1000, 40))
    const afterNew = client.renderView().entities.find((e) => e.id === selfId)!
    expect(afterNew).toBeDefined()
    // An older snapshot turns up late (reordered on the air). 100 ticks behind
    // is a reordering, not the host restarting the run.
    await push(at(900, 10))
    const afterStale = client.renderView().entities.find((e) => e.id === selfId)!
    expect(afterStale, 'stale snapshot yanked the world back to an old tick').toBeDefined()
    expect(Math.abs(afterStale.pos.x - 10)).toBeGreaterThan(1)
  })

  it('does not let a stale snapshot regenerate an old floor and wipe the live one', async () => {
    const hub = new ScaleHub()
    const host = new NetHostSession(7, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const client = hub.attachClient('c1', 'Bob', stubInput())
    await flush()
    host.beginGame()
    await flush()
    await tickHost(host, SNAPSHOT_INTERVAL_TICKS * 2)

    const selfId = host.peersBySlot.get(1)!.entityId!
    const push = async (snap: WireSnapshot): Promise<void> => {
      for (const pk of frameMessage(encodeSnapshot(snap), hub.maxPacket)) {
        hub['clientHandlers'].get('c1')?.({ type: 'data', peer: 'host', bytes: pk })
      }
      await flush()
    }
    const mk = (tick: number, floor: number): WireSnapshot => ({
      tick,
      floor,
      alarm: 0,
      lastInputSeq: 1,
      entities: [{ id: selfId, archetype: 'player', x: 20, y: 20, facing: 0, hpPct: 1, flags: 0 }],
    })
    await push(mk(2000, 2)) // party took the lift to floor 2
    expect(client.renderView().floor === 2 || client.renderView().entities.length > 0).toBe(true)
    const floorAfterAdvance = client.renderView().level
    await push(mk(1990, 1)) // a floor-1 snapshot straggles in behind it
    expect(client.renderView().level, 'a stale snapshot regenerated the previous floor').toBe(floorAfterAdvance)
  })
})

// --- 6. inventory change-gating --------------------------------------------

describe('inventory change-gating at 8 players', () => {
  it('sends nothing while inventories are unchanged', async () => {
    const { host } = await start8(7)
    await tickHost(host, 4) // let the initial push settle
    const before = host.debugInventorySends
    await tickHost(host, 30)
    expect(host.debugInventorySends).toBe(before)
  })

  it('never misses a change that is reverted within one gate window', async () => {
    const { host, centrals } = await start8(7)
    await tickHost(host, 4)
    clearWire(centrals)
    const before = host.debugInventorySends

    const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
    const loadout = avatar.loadout!
    const original = JSON.parse(JSON.stringify(loadout.inventory)) as typeof loadout.inventory

    // Change, ship it, then revert and ship that too: BOTH transitions are real
    // state the client must see. A gate that only compares against the last
    // SENT signature is correct here; one that compared against the last TICK's
    // would swallow the pair and leave the client showing a phantom item.
    avatar.loadout!.inventory = [...original, { itemId: 'grenade', qty: 3 }]
    await tickHost(host, 1)
    expect(host.debugInventorySends).toBe(before + 1)
    avatar.loadout!.inventory = original
    await tickHost(host, 1)
    expect(host.debugInventorySends, 'revert within one window was swallowed').toBe(before + 2)

    const invs = centrals[0].received.filter((m) => m[0] === MsgType.Inventory)
    expect(invs.length).toBeGreaterThanOrEqual(2)
    const last = JSON.parse(new TextDecoder().decode(invs.at(-1)!.subarray(1))) as { inventory: unknown[] }
    expect(last.inventory).toEqual(original)
  })

  it('gates per-peer: one player looting does not re-send everyone else their inventory', async () => {
    const { host } = await start8(7)
    await tickHost(host, 4)
    const before = host.debugInventorySends
    const avatar = host.world.byId.get(host.peersBySlot.get(3)!.entityId!)!
    avatar.loadout!.inventory = [...avatar.loadout!.inventory, { itemId: 'briefcase', qty: 1 }]
    await tickHost(host, 2)
    expect(host.debugInventorySends).toBe(before + 1)
  })
})

// --- 7. the measured byte budget -------------------------------------------

describe('8-player wire budget', () => {
  it('reports and bounds bytes/sec per peer over 30 seconds of 8-player play', async () => {
    const hub = new ScaleHub(180)
    const { host, centrals } = await start8(1, hub, stubInput({ moveX: 1, attack: true }))
    makeBusy(host)
    clearWire(centrals)
    // Settle every tick: on a fast link nothing coalesces, so this measures what
    // the host actually PRODUCES. (Letting the capacity-1 snapshot slot swallow
    // most snapshots would flatter the number and make the budget insensitive —
    // snapshots every tick instead of every 3 would still "pass".)
    const TICKS = 300 // 10s at 30tps
    for (let t = 0; t < TICKS; t++) {
      host.tick()
      await flush()
    }

    const secs = TICKS / 30
    const perPeer = centrals.map((c) => c.bytes / secs)
    const aggregate = perPeer.reduce((a, b) => a + b, 0)
    // MEASURED, 8 players on a busy floor (host + 7 remote peers):
    //   per peer   ~8.0-8.9 KB/s      aggregate ~56-63 KB/s
    //   breakdown  Snapshot ~4.9 KB/s (61%) · State ~1.65 KB/s (21%)
    //              Events ~1.4 KB/s (17%) · Inventory ~10 B/s
    //   packets/s per peer: 411 at a 20B MTU, 53 at 180B, 49 at 244B
    //              (aggregate 2872/s at 20B — far past any BLE radio)
    // That is well ABOVE what a BLE peripheral serving 7 centrals can carry, so
    // the link is expected to be oversubscribed in the field; the point of this
    // bound is to catch a regression that makes it dramatically worse.
    for (const bps of perPeer) expect(bps).toBeLessThan(11000)
    expect(aggregate).toBeLessThan(75000)
    expect(Math.min(...perPeer)).toBeGreaterThan(0)
  })

  it('a full 48-entity snapshot fits the BLE packet budget it claims', async () => {
    const entities = Array.from({ length: SNAPSHOT_ENTITY_CAP }, (_, i) => ({
      id: i + 1,
      archetype: 'thug',
      x: i,
      y: i,
      facing: 0,
      hpPct: 1,
      flags: 0,
    }))
    const bytes = encodeSnapshot({ tick: 1, floor: 1, alarm: 0, lastInputSeq: 1, entities })
    // 10B header + 10B/entity = 490B. At the 20-byte BLE floor that is 25
    // packets for ONE peer's ONE snapshot; at 244B MTU it is 3.
    expect(bytes.length).toBeLessThanOrEqual(512)
    expect(frameMessage(bytes, 20).length).toBeLessThanOrEqual(26)
    expect(frameMessage(bytes, 244).length).toBeLessThanOrEqual(3)
  })
})
