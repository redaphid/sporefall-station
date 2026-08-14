import { describe, expect, it } from 'vitest'
import { makeEntity } from '../game/entity'
import { generateLevel } from '../game/levelgen/generate'
import { levelChecksum } from '../game/levelgen/level'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { encodeJson } from '../net/framing/codec'
import { encodeSnapshot, toWireEntity } from '../net/protocol/messages'
import { MsgType, SNAPSHOT_INTERVAL_TICKS, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'
import {
  atLeast,
  diffHostClient,
  formatDivergence,
  SEVERITY,
  type DivergenceKind,
  type DivergenceReport,
} from './netDivergence'
import type { RenderView } from './session'

/**
 * HOST↔CLIENT DIVERGENCE HUNT.
 *
 * The instrument under test is `netDivergence.diffHostClient`. Everything below
 * either (a) proves the instrument can go RED — one known-divergent pair per
 * issue kind — or (b) points it at real host/client sequences looking for drift.
 *
 * The (a) half is not optional ceremony. A detector nobody has watched fail is
 * indistinguishable from `return { diverged: false }`, and every green result it
 * ever produces is worthless. The final test in that suite asserts that EVERY
 * kind in `SEVERITY` was actually observed firing, so a new kind cannot be added
 * without a proof that it can fire.
 */

// --- Loopback with fault injection ------------------------------------------

/**
 * The in-memory peer-to-peer link (what BLE gives us between two phones), plus
 * the three faults a real radio produces that the plain loopback cannot: a
 * STALLED downlink, a REPLAYED (duplicated/reordered) message, and a wire tap so
 * a test can capture what the host actually said and say it again later.
 */
class DesyncHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer: PeerId, bytes: Uint8Array) =>
        Promise.resolve().then(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  /** `reconnectable` gives the client transport a `reconnect()`, which is what
   * makes `NetClientSession` enter the `reconnecting` phase on a mid-game drop
   * instead of going straight to `ended` (netClient.onDisconnected). */
  addClient(name: string, input: InputSource, { reconnectable = false } = {}): ClientHandle {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    const deliver = (bytes: Uint8Array): void => {
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    }

    // Wire tap: reassemble the host→client stream in parallel so a test can grab
    // a real message off the wire and replay it out of order.
    const tap = new StreamReader()
    const heard: Uint8Array[] = []
    const gate = { hold: false, held: [] as Uint8Array[] }

    this.centrals.set(peer, (bytes) => {
      tap.push(bytes, (m) => heard.push(new Uint8Array(m)))
      if (gate.hold) gate.held.push(bytes)
      else deliver(bytes)
    })

    const clientTransport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) =>
        Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes })),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
      // A radio that is still gone: every attempt fails, so the session parks in
      // `reconnecting` — the phase whose GameStart handling we want to inspect.
      ...(reconnectable ? { reconnect: async () => { throw new Error('radio still gone') } } : {}),
    }

    const session = new NetClientSession(name, input, clientTransport)
    return {
      session,
      peer,
      connect: () => {
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
      },
      drop: () => {
        this.centrals.delete(peer)
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerDisconnected', peer: 'host', reason: 'remote' }))
      },
      heard: () => heard,
      holdDownlink: () => {
        gate.hold = true
      },
      releaseDownlink: () => {
        gate.hold = false
        for (const b of gate.held) deliver(b)
        gate.held.length = 0
      },
      /** Deliver a (possibly stale, possibly duplicate) message to the client. */
      injectMessage: (msg: Uint8Array) => {
        for (const pkt of frameMessage(msg, 180)) deliver(pkt)
      },
    }
  }
}

interface ClientHandle {
  session: NetClientSession
  peer: PeerId
  connect: () => void
  drop: () => void
  heard: () => Uint8Array[]
  holdDownlink: () => void
  releaseDownlink: () => void
  injectMessage: (msg: Uint8Array) => void
}

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })

/** A steerable input source — lets a test drive the client's prediction. */
const driven = (): { source: InputSource; set: (c: Partial<InputCmd>) => void } => {
  let cur: InputCmd = emptyInput()
  return { source: { sample: () => ({ ...cur }) }, set: (c) => { cur = { ...emptyInput(), ...c } } }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Microtask-only drain. Every hop in this loopback (`sendPacket`, the deliver
 * closures, the SendQueue pump) is a promise continuation, so a run of microtask
 * checkpoints settles the link without paying ~1 ms of real timer per tick —
 * which is the difference between a 3000-tick soak taking 30 s and 3 s. Starving
 * the link would show up as runaway drift, i.e. it can only fail LOUD, never
 * silently green.
 */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}

/** Host + one connected, playing client. */
const startPair = async (
  seed: number,
  input: InputSource = stubInput(),
  mode?: 'casual' | 'normal',
): Promise<{ hub: DesyncHub; host: NetHostSession; bob: ClientHandle; selfId: () => number }> => {
  const hub = new DesyncHub()
  const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport, mode)
  const bob = hub.addClient('Bob', input)
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  return { hub, host, bob, selfId: () => host.peersBySlot.get(1)!.entityId! }
}

const step = async (host: NetHostSession, clients: ClientHandle[], n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) {
    host.tick()
    for (const c of clients) c.session.tick()
    await flush()
  }
}

/** `step`, but draining microtasks instead of timers — for long soaks only. */
const stepFast = async (host: NetHostSession, clients: ClientHandle[]): Promise<void> => {
  host.tick()
  for (const c of clients) c.session.tick()
  await drain()
}

const check = (
  host: NetHostSession,
  bob: ClientHandle,
  extra: Parameters<typeof diffHostClient>[2] = {},
): DivergenceReport =>
  diffHostClient(host.world, bob.session.renderView(), {
    selfEntityId: host.peersBySlot.get(bob.session.slot)?.entityId,
    ...extra,
  })

/**
 * Build the snapshot the host WOULD send to the peer owning `avatarId`, using
 * netHost.sendSnapshots' own rule (all live players, plus non-players inside the
 * interest radius, capped at 48). Used when a test has to inject snapshots by
 * hand — a naive "first N entities" stand-in would drop the player out of its own
 * snapshot and manufacture divergence that the real host never produces.
 */
const hostSnapshotFor = (host: NetHostSession, avatarId: number): Uint8Array => {
  const w = host.world
  const avatar = w.byId.get(avatarId)
  const entities = []
  for (const e of w.entities) {
    if (e.dead) continue
    const near =
      avatar !== undefined && Math.abs(e.pos.x - avatar.pos.x) < 14 && Math.abs(e.pos.y - avatar.pos.y) < 14
    if (e.playerCtl === undefined && !near) continue
    entities.push(toWireEntity(e, w.tick))
    if (entities.length >= 48) break
  }
  return encodeSnapshot({ tick: w.tick, floor: w.floor, alarm: w.alarm, lastInputSeq: 0, entities })
}

/** Unlock the exit and stand a player on it, so the NEXT host tick descends via
 * the real `missionSystem` → `nextFloor` path (event broadcast included). */
const armDescent = (host: NetHostSession): void => {
  host.world.mission.exitUnlocked = true
  const player = host.world.entities.find((e) => e.playerCtl && !e.dead && !e.playerCtl.downed)!
  player.pos.x = host.world.level.exit.x + 0.5
  player.pos.y = host.world.level.exit.y + 0.5
  player.prevPos.x = player.pos.x
  player.prevPos.y = player.pos.y
}

// ---------------------------------------------------------------------------
// (a) PROVING THE INSTRUMENT CAN GO RED
// ---------------------------------------------------------------------------

/** Every kind observed firing across the proof suite — asserted complete below. */
const proven = new Set<DivergenceKind>()

const expectFires = (report: DivergenceReport, kind: DivergenceKind): void => {
  const hit = report.issues.filter((i) => i.kind === kind)
  expect(hit, `expected ${kind} to fire; got: ${formatDivergence(report)}`).not.toHaveLength(0)
  proven.add(kind)
}

const patch = (view: RenderView, over: Partial<RenderView>): RenderView => ({ ...view, ...over })

describe('divergence detector — proving it can fail (red before green)', () => {
  it('CONTROL: a genuinely synced host/client pair reports no divergence at all', async () => {
    const { host, bob } = await startPair(4001)
    await step(host, [bob], 18) // past one StateMsg (15 ticks) and several snapshots
    const report = check(host, bob)
    expect(formatDivergence(report)).toBe(`no divergence at tick ${host.world.tick}`)
    expect(report.diverged).toBe(false)
    expect(report.clientLevelOrigin).toBe('match')
  })

  it('fires level.map on a SEED mismatch, and names it as an unknown origin', async () => {
    const { host, bob } = await startPair(4002)
    await step(host, [bob], 18)
    const view = patch(bob.session.renderView(), { level: generateLevel(host.world.seed + 1, 1) })
    const report = diffHostClient(host.world, view, { selfEntityId: host.peersBySlot.get(1)!.entityId })
    expectFires(report, 'level.map')
    expect(report.clientLevelOrigin).toBe('unknown')
    expect(formatDivergence(report)).toMatch(/seed mismatch/)
  })

  it('fires level.map on a FLOOR mismatch, and identifies which floor the client is on', async () => {
    const { host, bob } = await startPair(4003)
    await step(host, [bob], 18)
    const view = patch(bob.session.renderView(), { level: generateLevel(host.world.seed, 4) })
    const report = diffHostClient(host.world, view, { selfEntityId: host.peersBySlot.get(1)!.entityId })
    expectFires(report, 'level.map')
    expect(report.clientLevelOrigin).toEqual({ seed: host.world.seed, floor: 4 })
  })

  it('fires floor + level.selfInconsistent when the reported floor does not match the drawn map', async () => {
    const { host, bob } = await startPair(4004)
    await step(host, [bob], 18)
    const view = patch(bob.session.renderView(), { floor: 5 })
    const report = diffHostClient(host.world, view, { selfEntityId: host.peersBySlot.get(1)!.entityId })
    expectFires(report, 'floor')
    expectFires(report, 'level.selfInconsistent')
  })

  it('fires self.missing when the client has no avatar', async () => {
    const { host, bob } = await startPair(4005)
    await step(host, [bob], 18)
    const view = patch(bob.session.renderView(), { self: undefined })
    expectFires(diffHostClient(host.world, view, { selfEntityId: host.peersBySlot.get(1)!.entityId }), 'self.missing')
  })

  it('fires self.identity when the client thinks it controls a different entity', async () => {
    const { host, bob } = await startPair(4006)
    await step(host, [bob], 18)
    const real = bob.session.renderView().self!
    const view = patch(bob.session.renderView(), { self: { ...real, id: real.id + 5000 } })
    expectFires(diffHostClient(host.world, view, { selfEntityId: host.peersBySlot.get(1)!.entityId }), 'self.identity')
  })

  it('fires self.position when the predicted avatar is beyond prediction tolerance', async () => {
    const { host, bob, selfId } = await startPair(4007)
    await step(host, [bob], 18)
    const real = bob.session.renderView().self!
    const view = patch(bob.session.renderView(), {
      self: { ...real, pos: { x: real.pos.x + 9, y: real.pos.y } },
    })
    const report = diffHostClient(host.world, view, { selfEntityId: selfId() })
    expectFires(report, 'self.position')
    expect(report.selfDrift).toBeGreaterThan(8)
  })

  it('fires entity.phantom for something only the client can see', async () => {
    const { host, bob, selfId } = await startPair(4008)
    await step(host, [bob], 18)
    const view = bob.session.renderView()
    const ghost = makeEntity('npc', 'thug', 5, 5)
    ghost.id = 60000
    expectFires(
      diffHostClient(host.world, patch(view, { entities: [...view.entities, ghost] }), { selfEntityId: selfId() }),
      'entity.phantom',
    )
  })

  it('fires entity.phantom when the host has already killed the entity', async () => {
    const { host, bob, selfId } = await startPair(4009)
    await step(host, [bob], 18)
    const view = bob.session.renderView()
    const victim = view.entities.find((e) => e.id !== selfId() && host.world.byId.has(e.id))!
    // Kill it on the host WITHOUT ticking, so the client still renders the body.
    host.world.byId.get(victim.id)!.dead = true
    expectFires(diffHostClient(host.world, view, { selfEntityId: selfId() }), 'entity.phantom')
  })

  it('fires entity.missing when a PLAYER the host has is absent from the client view', async () => {
    const { host, bob, selfId } = await startPair(4010)
    await step(host, [bob], 18)
    const view = bob.session.renderView()
    const hostAvatarId = host.self.id
    expect(view.entities.some((e) => e.id === hostAvatarId)).toBe(true) // it really was there
    expectFires(
      diffHostClient(host.world, patch(view, { entities: view.entities.filter((e) => e.id !== hostAvatarId) }), {
        selfEntityId: selfId(),
      }),
      'entity.missing',
    )
  })

  it('fires entity.archetype when the two sides disagree about what a thing IS', async () => {
    const { host, bob, selfId } = await startPair(4011)
    await step(host, [bob], 18)
    const view = bob.session.renderView()
    // Exactly the ARCHETYPES-index class of bug: right id, right place, wrong thing.
    const target = view.entities.find((e) => e.id !== selfId())!
    const entities = view.entities.map((e) => (e.id === target.id ? { ...e, archetype: 'wrong-thing' } : e))
    expectFires(diffHostClient(host.world, patch(view, { entities }), { selfEntityId: selfId() }), 'entity.archetype')
  })

  it('fires entity.position when a remote entity is adrift beyond smoothing', async () => {
    const { host, bob, selfId } = await startPair(4012)
    await step(host, [bob], 18)
    const view = bob.session.renderView()
    const target = view.entities.find((e) => e.id !== selfId())!
    const entities = view.entities.map((e) =>
      e.id === target.id ? { ...e, pos: { x: e.pos.x + 11, y: e.pos.y } } : e,
    )
    const report = diffHostClient(host.world, patch(view, { entities }), { selfEntityId: selfId() })
    expectFires(report, 'entity.position')
    expect(report.maxDrift).toBeGreaterThan(10)
  })

  it('fires gameOver and mission when the mirrored run state disagrees', async () => {
    const { host, bob, selfId } = await startPair(4013)
    await step(host, [bob], 18)
    const view = bob.session.renderView()
    const report = diffHostClient(
      host.world,
      patch(view, { gameOver: !host.world.gameOver, missionText: 'not what the host said', missionComplete: true }),
      { selfEntityId: selfId() },
    )
    expectFires(report, 'gameOver')
    expectFires(report, 'mission')
  })

  it('every declared divergence kind has been observed firing', () => {
    const declared = Object.keys(SEVERITY).sort()
    expect([...proven].sort()).toEqual(declared)
  })
})

// ---------------------------------------------------------------------------
// (b) THE HUNT
// ---------------------------------------------------------------------------

describe('divergence hunt — floor changes', () => {
  it('the client follows the host down a floor (level realigns, no fatal divergence)', async () => {
    const { host, bob, selfId } = await startPair(5001)
    await step(host, [bob], 18)
    expect(formatDivergence(check(host, bob))).toBe(`no divergence at tick ${host.world.tick}`)

    const before = host.world.floor
    armDescent(host)
    await step(host, [bob], 1)
    expect(host.world.floor).toBe(before + 1)

    // Give the client one snapshot + one State message to catch up.
    await step(host, [bob], 18)
    const report = check(host, bob, { selfEntityId: selfId() })
    expect(formatDivergence(report)).toBe(`no divergence at tick ${host.world.tick}`)
  })

  it('measures how long the client is on the WRONG MAP after a host descent', async () => {
    const { host, bob } = await startPair(5002)
    await step(host, [bob], 12)
    armDescent(host)

    let wrongMapTicks = 0
    let staleFloorTicks = 0
    for (let i = 0; i < 24; i++) {
      await step(host, [bob], 1)
      const r = check(host, bob, { ignoreStaleState: true })
      if (r.issues.some((x) => x.kind === 'level.map')) wrongMapTicks++
      if (r.issues.some((x) => x.kind === 'floor')) staleFloorTicks++
    }
    // The floorChange event is RELIABLE and broadcast in the same host tick that
    // descends, so the map realigns immediately — before any snapshot.
    expect(wrongMapTicks).toBe(0)
    // The floor NUMBER rides the 2 Hz StateMsg, so the HUD lags the map it draws.
    expect(staleFloorTicks).toBeGreaterThan(0)
    expect(staleFloorTicks).toBeLessThanOrEqual(15)
  })

  it('follows a floor change that lands while the client is mid-prediction', async () => {
    const walk = driven()
    const { host, bob, selfId } = await startPair(5003, walk.source)
    walk.set({ moveX: 1, moveY: 0.3 })
    await step(host, [bob], 12)

    // Descend with unacked predicted inputs outstanding on the client.
    armDescent(host)
    host.tick() // host descends; floorChange queued
    bob.session.tick() // client predicts one more step on the OLD level
    bob.session.tick() // …and another, still unaware
    await flush()
    walk.set({})
    await step(host, [bob], 18)

    const report = check(host, bob, { selfEntityId: selfId() })
    expect(atLeast(report, 'major')).toEqual([])
    expect(report.clientLevelOrigin).toBe('match')
  })

  it('follows TWO descents that land before the client can ack the first', async () => {
    const { host, bob, selfId } = await startPair(5004)
    await step(host, [bob], 12)

    // Stall the downlink so nothing reaches the client, descend twice, then let
    // the whole burst arrive at once — a BLE hiccup across a double descent.
    bob.holdDownlink()
    armDescent(host)
    host.tick()
    const mid = host.world.floor
    armDescent(host)
    host.tick()
    expect(host.world.floor).toBe(mid + 1)
    bob.session.tick()
    bob.session.tick()
    await flush()
    bob.releaseDownlink()
    await flush()

    await step(host, [bob], 18)
    const report = check(host, bob, { selfEntityId: selfId() })
    expect(formatDivergence(report)).toBe(`no divergence at tick ${host.world.tick}`)
    expect(report.clientLevelOrigin).toBe('match')
  })
})

describe('divergence hunt — seed mismatch', () => {
  it('a host "New Seed" restart re-maps every connected client', async () => {
    const { host, bob, selfId } = await startPair(6001)
    await step(host, [bob], 18)
    const oldSeed = host.world.seed

    host.restart(0xbeef1234)
    await flush()
    await step(host, [bob], 18)

    const report = diffHostClient(host.world, bob.session.renderView(), {
      selfEntityId: selfId(),
      candidateSeeds: [oldSeed],
    })
    expect(formatDivergence(report)).toBe(`no divergence at tick ${host.world.tick}`)
  })

  it('a re-seed clears the ghost table — which is the ONLY thing blocking the wrong-map rejoin', async () => {
    // This is the load-bearing host-side invariant behind the reproducer below.
    // `restart(seed)` clears `ghosts`, so a client that reconnects after a
    // re-seed is REFUSED rather than admitted onto a stale map. If a future
    // change makes rejoin survive "play again" (a very natural feature request),
    // that refusal disappears and the next test's scenario becomes reachable.
    const { host, bob } = await startPair(6002)
    await step(host, [bob], 12)
    expect(bob.session.slot).toBe(1)

    bob.drop() // mid-game drop → the host parks a ghost
    await flush()
    const ghosts = (host as unknown as { ghosts: Map<number, unknown> }).ghosts
    expect(ghosts.size, 'the drop should have parked a reclaimable ghost').toBe(1)

    host.restart(0xc0ffee) // "New Seed" while the client is away
    await flush()
    expect(ghosts.size, 'a re-seed must not leave a reclaimable ghost behind').toBe(0)
  })

  it('REPRODUCER: a GameStart whose seed changed during `reconnecting` strands the client on the OLD map forever', async () => {
    // netClient.handleMessage/GameStart assigns `this.seed = start.seed` and only
    // THEN takes the `phase === 'reconnecting'` early-out that skips level
    // regeneration. So a rejoining client adopts a new seed while keeping the old
    // seed's level. Nothing re-syncs it: `changeFloor` is the only thing that
    // regenerates a level, and it fires only when a floor NUMBER changes — which
    // it does not, because the re-seeded run restarts on floor 1 too.
    //
    // Currently unreachable (the test above shows a re-seed clears the ghosts, so
    // this rejoin is refused). This pins the client-side hazard so that if the
    // rejoin gate is ever relaxed, THIS test goes red instead of a playtest.
    const hub = new DesyncHub()
    const host = new NetHostSession(0xa11ce, 'Alice', stubInput(), hub.hostTransport)
    const bob = hub.addClient('Bob', stubInput(), { reconnectable: true })
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()
    await step(host, [bob], 18)
    const oldSeed = host.world.seed
    expect(formatDivergence(check(host, bob))).toBe(`no divergence at tick ${host.world.tick}`)

    bob.drop()
    await flush()
    expect(bob.session.phase, 'a reconnect-capable transport parks the session, not ends it').toBe('reconnecting')

    const newSeed = 0x5eed5eed
    host.restart(newSeed)
    await flush()
    expect(host.world.seed).toBe(newSeed)
    expect(host.world.floor).toBe(1) // same floor number as the client still holds

    // Hand the parked client exactly what netHost's rejoin branch sends
    // (GameStart + Go) — but carrying the NEW seed.
    const avatarId = host.self.id
    bob.injectMessage(
      encodeJson(MsgType.GameStart, { seed: host.seed, players: host.lobbyPlayers(), mode: host.world.mode }),
    )
    bob.injectMessage(encodeJson(MsgType.Go, { startTick: host.world.tick, entityIds: { 1: avatarId } }))
    await flush()
    expect(bob.session.phase).toBe('playing')

    // Keep feeding it authoritative snapshots on the SAME floor, exactly as a
    // live host would. There is no floor change, so nothing regenerates the map.
    for (let i = 0; i < 40; i++) {
      host.tick()
      bob.injectMessage(hostSnapshotFor(host, avatarId))
      bob.session.tick()
      await flush()
    }

    const report = diffHostClient(host.world, bob.session.renderView(), {
      selfEntityId: avatarId,
      candidateSeeds: [oldSeed],
      ignoreStaleState: true,
    })
    console.log(`[reconnect re-seed] after 40 authoritative snapshots: ${formatDivergence(report)}`)

    // The entity stream is perfectly healthy — the client is tracking every
    // entity the host sent, at the right positions. ONLY the ground under them
    // is wrong, which is precisely why this failure mode is invisible in play.
    expect(atLeast(report, 'major').map((i) => i.kind)).toEqual(['level.map'])
    expect(report.clientLevelOrigin).toEqual({ seed: oldSeed, floor: 1 })

    // …and the seed really WAS adopted, so the client is internally inconsistent:
    // the next floor change silently teleports it into the new seed's map family.
    bob.injectMessage(encodeJson(MsgType.Events, { tick: 1, events: [{ type: 'floorChange', floor: 2 }] }))
    await flush()
    const after = bob.session.renderView().level
    expect(levelChecksum(after)).toBe(levelChecksum(generateLevel(newSeed, 2)))

    bob.session.phase = 'ended' // stop the background reconnect loop
  })

  it('measures the window where a LATE JOINER walks a different map than the host', async () => {
    // Layout regenerates from seed+floor and GameStart carries only the seed, so
    // a client joining a run that has already descended builds FLOOR 1 while the
    // host is deeper. (netClient.ts GameStart → `this.floor = 1`. Another agent
    // owns adding a `floor` to GameStartMsg; this test measures the exposure that
    // fix removes, and should flip to a 0-tick window once it lands.)
    const hub = new DesyncHub()
    const host = new NetHostSession(6100, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()
    for (let d = 0; d < 2; d++) {
      armDescent(host)
      await step(host, [], 1)
    }
    expect(host.world.floor).toBe(3)

    const late = hub.addClient('Late', stubInput())
    await late.session.start()
    late.connect()
    await flush()
    expect(late.session.phase).toBe('playing')

    let wrongMapTicks = 0
    let worstSelfDrift = 0
    for (let i = 0; i < 30; i++) {
      const r = diffHostClient(host.world, late.session.renderView(), {
        selfEntityId: host.peersBySlot.get(late.session.slot)?.entityId,
        ignoreStaleState: true,
      })
      if (r.issues.some((x) => x.kind === 'level.map')) wrongMapTicks++
      worstSelfDrift = Math.max(worstSelfDrift, r.selfDrift)
      await step(host, [late], 1)
    }

    console.log(
      `[late join onto floor ${host.world.floor}] wrong-map for ${wrongMapTicks} tick(s); ` +
        `worst prediction error ${worstSelfDrift.toFixed(2)} tiles`,
    )
    // It DOES happen (this is the exposure), and a snapshot closes it fast.
    expect(wrongMapTicks).toBeGreaterThan(0)
    expect(wrongMapTicks).toBeLessThanOrEqual(SNAPSHOT_INTERVAL_TICKS)
    const settled = diffHostClient(host.world, late.session.renderView(), {
      selfEntityId: host.peersBySlot.get(late.session.slot)?.entityId,
    })
    expect(formatDivergence(settled)).toBe(`no divergence at tick ${host.world.tick}`)
  })

  it('measures how long a client keeps playing after the party has already wiped', async () => {
    const { host, bob } = await startPair(6200)
    await step(host, [bob], 18)
    expect(check(host, bob).diverged).toBe(false)

    for (const e of host.world.entities.filter((p) => p.playerCtl)) {
      e.health!.hp = 0
      e.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    }
    await step(host, [bob], 1)
    expect(host.world.gameOver).toBe(true)

    let lag = 0
    while (lag < 60 && !bob.session.renderView().gameOver) {
      await step(host, [bob], 1)
      lag++
    }
    console.log(`[game-over propagation] client learned the run ended ${lag} ticks (~${(lag / 30).toFixed(2)}s) late`)
    expect(bob.session.renderView().gameOver).toBe(true)
    expect(lag).toBeGreaterThan(0) // it is NOT immediate — gameOver rides the 2 Hz StateMsg
    expect(lag).toBeLessThanOrEqual(15)
  })
})

describe('divergence hunt — prediction reconciliation', () => {
  it('converges back to the host after the client predicts into a wall', async () => {
    const walk = driven()
    const { host, bob, selfId } = await startPair(7001, walk.source)
    await step(host, [bob], 12)

    // Drive hard into a wall for a long time: prediction and authority resolve
    // the collision independently, so any systematic offset shows up here.
    walk.set({ moveX: -1, moveY: -1 })
    let worst = 0
    for (let i = 0; i < 120; i++) {
      await step(host, [bob], 1)
      worst = Math.max(worst, check(host, bob, { ignoreStaleState: true }).selfDrift)
    }

    // Then stop and let it settle — a client that cannot converge is the finding.
    walk.set({})
    await step(host, [bob], 30)
    const settled = check(host, bob, { selfEntityId: selfId(), ignoreStaleState: true })
    expect(settled.selfDrift, `worst-during=${worst.toFixed(3)}`).toBeLessThan(0.5)
  })

  it('keeps the predicted avatar bounded while running continuously', async () => {
    const walk = driven()
    const { host, bob } = await startPair(7002, walk.source)
    await step(host, [bob], 12)
    walk.set({ moveX: 1, moveY: 0 })

    let worst = 0
    let worstTick = 0
    for (let i = 0; i < 300; i++) {
      await step(host, [bob], 1)
      const r = check(host, bob, { ignoreStaleState: true })
      if (r.selfDrift > worst) {
        worst = r.selfDrift
        worstTick = host.world.tick
      }
    }
    expect(worst, `worst prediction error ${worst.toFixed(3)} tiles at tick ${worstTick}`).toBeLessThan(1.5)
  })
})

describe('divergence hunt — out-of-order and duplicated messages', () => {
  it('rubber-bands but recovers when a STALE snapshot is replayed', async () => {
    const walk = driven()
    const { host, bob, selfId } = await startPair(8001, walk.source)
    walk.set({ moveX: 1 })
    await step(host, [bob], 12)

    const stale = bob.heard().filter((m) => m[0] === MsgType.Snapshot)
    expect(stale.length).toBeGreaterThan(1)
    const old = stale[0]

    await step(host, [bob], 30)
    const beforeReplay = check(host, bob, { ignoreStaleState: true })
    expect(beforeReplay.diverged, formatDivergence(beforeReplay)).toBe(false)

    bob.injectMessage(old) // a duplicated/reordered snapshot from 30 ticks ago
    await flush()
    const afterReplay = check(host, bob, { ignoreStaleState: true })

    // Recovery: the next snapshot must put everything back.
    await step(host, [bob], 12)
    const recovered = check(host, bob, { selfEntityId: selfId(), ignoreStaleState: true })

    console.log(
      `[stale-snapshot replay] before: drift=${beforeReplay.maxDrift.toFixed(2)} | ` +
        `immediately after: ${formatDivergence(afterReplay)} | ` +
        `after 12 more ticks: ${formatDivergence(recovered)}`,
    )
    // The replay DOES disturb the view (a detector that shrugged here would be
    // useless), and the very next snapshots undo it completely.
    expect(afterReplay.diverged).toBe(true)
    expect(atLeast(recovered, 'major'), formatDivergence(recovered)).toEqual([])
    expect(recovered.maxDrift).toBeLessThan(2.5)
  })

  it('a REPLAYED floorChange event throws the client onto a stale floor', async () => {
    const { host, bob, selfId } = await startPair(8002)
    await step(host, [bob], 12)
    armDescent(host)
    await step(host, [bob], 1)
    await step(host, [bob], 18)
    expect(check(host, bob).diverged).toBe(false)
    const floorNow = host.world.floor

    // Replay the floorChange for the floor we already left (a duplicate delivery
    // after an in-band framing resync, or a reordered reliable frame).
    bob.injectMessage(encodeJson(MsgType.Events, { tick: 1, events: [{ type: 'floorChange', floor: floorNow - 1 }] }))
    await flush()

    const hit = check(host, bob, { selfEntityId: selfId(), ignoreStaleState: true })
    const recoveryTicks = await ticksToRealign(host, bob)

    console.log(
      `[replayed floorChange] host on floor ${floorNow}; client thrown to ` +
        `${JSON.stringify(hit.clientLevelOrigin)}; realigned after ${recoveryTicks} ticks`,
    )
    // The client applies a floorChange event unconditionally — no tick or
    // monotonicity guard (netClient.ts handleMessage → changeFloor) — so a
    // replayed one regenerates a level the host has already left.
    expect(hit.issues.some((i) => i.kind === 'level.map')).toBe(true)
    expect(hit.clientLevelOrigin).toEqual({ seed: host.world.seed, floor: floorNow - 1 })
    // -1 would mean it NEVER came back; that would be top severity.
    expect(recoveryTicks).toBeGreaterThan(0)
    expect(recoveryTicks).toBeLessThanOrEqual(SNAPSHOT_INTERVAL_TICKS)
  })
})

/** Tick until the client's map matches the host's again; -1 if it never does. */
const ticksToRealign = async (host: NetHostSession, bob: ClientHandle, limit = 60): Promise<number> => {
  for (let i = 1; i <= limit; i++) {
    await step(host, [bob], 1)
    if (!check(host, bob, { ignoreStaleState: true }).issues.some((x) => x.kind === 'level.map')) return i
  }
  return -1
}

describe('divergence hunt — long-run co-op soak', () => {
  it('holds divergence bounded across a scripted multi-thousand-tick session', async () => {
    const walkA = driven()
    const walkB = driven()
    const hub = new DesyncHub()
    const host = new NetHostSession(9001, 'Alice', walkA.source, hub.hostTransport)
    const bob = hub.addClient('Bob', walkB.source)
    await host.start()
    await bob.session.start()
    bob.connect()
    await flush()
    host.beginGame()
    await flush()

    const TICKS = 3000
    let maxDrift = 0
    let maxDriftTick = 0
    let maxSelfDrift = 0
    let maxSelfDriftTick = 0
    const fatal: string[] = []
    const major: string[] = []
    let descents = 0

    for (let t = 1; t <= TICKS; t++) {
      // A scripted but varied co-op walk — deterministic, no Math.random.
      const phase = t % 120
      walkA.set({ moveX: Math.sin(phase / 19), moveY: Math.cos(phase / 23), attack: phase % 17 === 0 })
      walkB.set({ moveX: Math.cos(phase / 13), moveY: Math.sin(phase / 29), attack: phase % 11 === 0 })
      // Push the party down a floor a few times over the run.
      if (t % 700 === 0) {
        armDescent(host)
        descents++
      }
      await stepFast(host, [bob])

      const r = check(host, bob, { ignoreStaleState: true })
      if (r.selfDrift > maxSelfDrift) {
        maxSelfDrift = r.selfDrift
        maxSelfDriftTick = host.world.tick
      }
      if (r.maxDrift > maxDrift) {
        maxDrift = r.maxDrift
        maxDriftTick = host.world.tick
      }
      for (const i of r.issues) {
        if (i.severity === 'fatal') fatal.push(`t${host.world.tick} ${i.kind}: ${i.detail}`)
        // Entity-set integrity is only exact on the tick a snapshot was just
        // delivered; between snapshots a newly spawned bullet legitimately has
        // not been sent yet.
        else if (i.severity === 'major' && host.world.tick % SNAPSHOT_INTERVAL_TICKS === 0) {
          major.push(`t${host.world.tick} ${i.kind}: ${i.detail}`)
        }
      }
    }

    console.log(
      `[soak] ${TICKS} ticks, ${descents} descents, host floor ${host.world.floor}, ` +
        `maxSelfDrift=${maxSelfDrift.toFixed(3)} @t${maxSelfDriftTick}, ` +
        `maxDrift=${maxDrift.toFixed(3)} @t${maxDriftTick}, ` +
        `fatal=${fatal.length}, major=${major.length}`,
    )
    if (fatal.length) console.error('[soak] fatal:', fatal.slice(0, 5))
    if (major.length) console.error('[soak] major:', major.slice(0, 5))

    // The run really happened: floors advanced and the client stayed attached
    // the whole way. Without this, a starved link could report "no divergence"
    // simply by never having delivered anything.
    expect(descents).toBeGreaterThan(0)
    expect(host.world.floor).toBe(1 + descents)
    expect(bob.session.phase).toBe('playing')
    expect(bob.session.renderView().self).toBeDefined()
    // The link genuinely kept up: the client received ~one snapshot per
    // SNAPSHOT_INTERVAL_TICKS for the whole run. Without this, a drain too
    // shallow to deliver anything would present as a suspiciously clean soak.
    const snapshotsHeard = bob.heard().filter((m) => m[0] === MsgType.Snapshot).length
    expect(snapshotsHeard).toBeGreaterThan((TICKS / SNAPSHOT_INTERVAL_TICKS) * 0.9)

    expect(fatal).toEqual([])
    expect(major).toEqual([])
    expect(maxSelfDrift).toBeLessThan(2)
    expect(maxDrift).toBeLessThan(3)

    // …and settled at the end, the mirrored state agrees too.
    await step(host, [bob], 18)
    expect(formatDivergence(check(host, bob))).toBe(`no divergence at tick ${host.world.tick}`)
  }, 180_000)
})
