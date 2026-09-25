import { describe, expect, it } from 'vitest'
import { generateLevel } from '../game/levelgen/generate'
import type { Level } from '../game/levelgen/level'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { encodeJson } from '../net/framing/codec'
import { decodeSnapshot, encodeSnapshot, toWireEntity, type WireEntity } from '../net/protocol/messages'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { isNewerTick, NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * REPLAY GUARDS on the client.
 *
 * BLE packet loss desynchronises the framing layer, and the reader resynchronises
 * IN-BAND (`StreamReader.onDesync`) rather than tearing the link down. That is
 * precisely how a client gets handed a DUPLICATED or REORDERED message: the
 * transport is fine, the bytes are valid, they are just old. Two of those are
 * catastrophic on screen:
 *
 *  - a replayed `floorChange` regenerates a floor the host has already left,
 *    wiping every entity and rebuilding the level under the player's feet;
 *  - a replayed snapshot rewinds every entity AND hauls the predicted avatar
 *    backwards through `reconcile` (measured at 5.56 tiles).
 *
 * Both directions matter. The client's self-heal — a client that MISSED messages
 * being dragged onto the host's floor and the host's positions by the next
 * snapshot — is load-bearing and must survive the guard, so every "stale is
 * ignored" test below is paired with a "newer still applies" one.
 *
 * Harness re-derived here rather than shared with netLateJoin.test.ts's MockHub:
 * these tests need a wire TAP (to capture what the host really said and say it
 * again later) and an INJECT path (to deliver a message the host never sent
 * twice), neither of which that hub has.
 */
class ReplayHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer: PeerId, bytes: Uint8Array) => Promise.resolve().then(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  addClient(name: string, input: InputSource): ClientHandle {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    const deliver = (bytes: Uint8Array): void => {
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    }
    // Wire tap: reassemble the host→client stream in parallel, so a test can grab
    // a real message off the wire and replay it later.
    const tap = new StreamReader()
    const heard: Uint8Array[] = []
    this.centrals.set(peer, (bytes) => {
      tap.push(bytes, (m) => heard.push(new Uint8Array(m)))
      deliver(bytes)
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
    }
    const session = new NetClientSession(name, input, clientTransport)
    return {
      session,
      connect: () => {
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
      },
      heard: () => heard,
      /** Deliver a (possibly stale, possibly duplicate) message to the client. */
      inject: (msg: Uint8Array) => {
        for (const pkt of frameMessage(msg, 180)) deliver(pkt)
      },
    }
  }
}

interface ClientHandle {
  session: NetClientSession
  connect: () => void
  heard: () => Uint8Array[]
  inject: (msg: Uint8Array) => void
}

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })

/** A steerable input source, so a test can drive the client's own prediction. */
const driven = (): { source: InputSource; set: (c: Partial<InputCmd>) => void } => {
  let cur: InputCmd = emptyInput()
  return { source: { sample: () => ({ ...cur }) }, set: (c) => void (cur = { ...emptyInput(), ...c }) }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Levels regenerate bit-exact from seed+floor, so the tiles identify the floor. */
const tilesOf = (l: Level): string => `${l.w}x${l.h}:${l.spawn.x},${l.spawn.y}:${l.tiles.join('')}`

const clientLevel = (bob: ClientHandle): string => tilesOf(bob.session.renderView().level)
const levelFor = (seed: number, floor: number): string => tilesOf(generateLevel(seed, floor))

const startPair = async (
  seed: number,
  input: InputSource = stubInput(),
): Promise<{ hub: ReplayHub; host: NetHostSession; bob: ClientHandle; selfId: () => number }> => {
  const hub = new ReplayHub()
  const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
  const bob = hub.addClient('Bob', input)
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  return { hub, host, bob, selfId: () => host.peersBySlot.get(1)!.entityId! }
}

const step = async (host: NetHostSession, bob: ClientHandle, n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) {
    host.tick()
    bob.session.tick()
    await flush()
  }
}

/** Unlock the exit and stand a player on it, so the NEXT host tick descends via
 * the real mission system — floorChange event broadcast included. */
const armDescent = (host: NetHostSession): void => {
  host.world.mission.exitUnlocked = true
  const player = host.world.entities.find((e) => e.playerCtl && !e.dead && !e.playerCtl.downed)!
  player.pos.x = host.world.level.exit.x + 0.5
  player.pos.y = host.world.level.exit.y + 0.5
  player.prevPos.x = player.pos.x
  player.prevPos.y = player.pos.y
}

/** Drive the host down one floor and let the client follow it there. */
const descend = async (host: NetHostSession, bob: ClientHandle): Promise<number> => {
  const from = host.world.floor
  armDescent(host)
  await step(host, bob, 1)
  expect(host.world.floor).toBe(from + 1)
  await step(host, bob, 6) // let the event + snapshots land
  return host.world.floor
}

/** A snapshot the host never sent: one player entity, at `tick`, on `floor`. */
const fakeSnapshot = (tick: number, floor: number, self: WireEntity): Uint8Array =>
  encodeSnapshot({ tick, floor, alarm: 0, lastInputSeq: 0, entities: [self] })

const wireSelf = (id: number, x: number, y: number): WireEntity => ({
  id,
  archetype: 'player',
  x,
  y,
  facing: 0,
  hpPct: 1,
  flags: 0,
})

// ---------------------------------------------------------------------------

describe('isNewerTick — u32 serial comparison', () => {
  it('orders ordinary ticks and rejects duplicates', () => {
    expect(isNewerTick(11, 10)).toBe(true)
    expect(isNewerTick(10, 10)).toBe(false) // a verbatim duplicate is not newer
    expect(isNewerTick(9, 10)).toBe(false)
    expect(isNewerTick(10_000, 10)).toBe(true)
  })

  it('survives the u32 wrap that a plain `>` would wedge on forever', () => {
    const MAX = 0xffff_ffff
    expect(isNewerTick(3, MAX - 2)).toBe(true) // wrapped forward by 5
    expect(isNewerTick(MAX - 2, 3)).toBe(false) // and the reverse is old
    expect(isNewerTick(0, MAX)).toBe(true)
    // Exactly half the space away is treated as OLD — the tie has to break
    // somewhere, and refusing to rewind is the safe side of it.
    expect(isNewerTick(0x8000_0000, 0)).toBe(false)
    expect(isNewerTick(0x7fff_ffff, 0)).toBe(true)
  })
})

describe('replayed snapshots', () => {
  it('IGNORES a stale snapshot instead of yanking the predicted avatar backwards', async () => {
    const walk = driven()
    const { host, bob, selfId } = await startPair(8001, walk.source)
    walk.set({ moveX: 1 })
    await step(host, bob, 12)

    const snaps = bob.heard().filter((m) => m[0] === MsgType.Snapshot)
    expect(snaps.length).toBeGreaterThan(1)
    const old = snaps[0] // ~12 ticks of walking ago

    await step(host, bob, 30)
    const before = bob.session.renderView()
    const wasX = before.self!.pos.x
    const wasCount = before.entities.length
    expect(wasCount).toBeGreaterThan(1)

    bob.inject(old) // duplicate delivery after an in-band framing resync
    await flush()

    const after = bob.session.renderView()
    expect(after.self!.pos.x).toBeCloseTo(wasX, 6)
    expect(after.entities.length).toBe(wasCount)
    // Sanity: the injected frame really WAS a rewind, and really did arrive. A
    // test whose "replay" carried today's position, or never reached the client,
    // would pass with the guard deleted.
    const carried = decodeSnapshot(old).entities.find((e) => e.id === selfId())!
    expect(wasX - carried.x).toBeGreaterThan(1) // ≥1 tile of rewind on offer
    expect(decodeSnapshot(old).tick).toBeLessThan(host.world.tick)
  })

  it('IGNORES an exact duplicate of the newest snapshot', async () => {
    const { host, bob } = await startPair(8002)
    await step(host, bob, 12)
    const snaps = bob.heard().filter((m) => m[0] === MsgType.Snapshot)
    const newest = snaps[snaps.length - 1]

    // Prune-proof: a re-applied snapshot rebuilds the entity set from its own
    // contents, so we watch a hand-placed marker that is NOT in it.
    const marker = { ...toWireEntity(host.world.entities[0], host.world.tick), id: 4242 }
    bob.inject(fakeSnapshot(host.world.tick + 1, host.world.floor, { ...marker, archetype: 'player' }))
    await flush()
    expect(bob.session.renderView().entities.map((e) => e.id)).toContain(4242)

    bob.inject(newest) // older than the one we just applied → must not resurrect the old set
    await flush()
    expect(bob.session.renderView().entities.map((e) => e.id)).toContain(4242)
  })

  it('STILL APPLIES a genuinely newer snapshot (self-heal preserved)', async () => {
    const { host, bob, selfId } = await startPair(8003)
    await step(host, bob, 12)
    const before = bob.session.renderView()
    expect(before.entities.length).toBeGreaterThan(1)

    const far = { x: before.self!.pos.x + 6, y: before.self!.pos.y + 4 }
    bob.inject(fakeSnapshot(host.world.tick + 1, host.world.floor, wireSelf(selfId(), far.x, far.y)))
    await flush()

    const after = bob.session.renderView()
    expect(after.self!.pos.x).toBeCloseTo(far.x, 3)
    expect(after.self!.pos.y).toBeCloseTo(far.y, 3)
    expect(after.entities.length).toBe(1) // pruned to the snapshot's contents
  })

  it('re-baselines after "play again", whose host world restarts at tick 0', async () => {
    const { host, bob } = await startPair(8004)
    await step(host, bob, 40)
    expect(host.world.tick).toBeGreaterThan(30)
    const staleTick = host.world.tick

    host.restart() // netHost.restart → createWorld: a brand-new world at tick 0
    await flush()
    expect(host.world.tick).toBeLessThan(staleTick)

    await step(host, bob, 9)
    const view = bob.session.renderView()
    // Without the re-baseline every snapshot of the new run looks "older" than
    // the last of the old run, and the client freezes on a dead screen forever.
    expect(view.entities.length).toBeGreaterThan(1)
    expect(view.self).toBeDefined()
    expect(view.self!.id).toBe(host.peersBySlot.get(1)!.entityId)
    // The new run's avatar really is a different entity in a fresh world.
    expect(host.world.tick).toBeLessThan(staleTick)
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 1))
  })
})

describe('replayed floor changes', () => {
  it('IGNORES a replayed floorChange event instead of rebuilding a floor the host left', async () => {
    const { host, bob } = await startPair(8101)
    await step(host, bob, 12)
    const floorNow = await descend(host, bob)
    expect(floorNow).toBe(2)
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 2))
    const populated = bob.session.renderView().entities.length
    expect(populated).toBeGreaterThan(1)

    bob.inject(encodeJson(MsgType.Events, { tick: 1, events: [{ type: 'floorChange', floor: floorNow - 1 }] }))
    await flush()

    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 2)) // still the host's map
    expect(bob.session.renderView().entities.length).toBe(populated) // nothing vanished
  })

  it('STILL APPLIES a real floorChange event (descent still works)', async () => {
    const { host, bob } = await startPair(8102)
    await step(host, bob, 12)
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 1))
    await descend(host, bob)
    expect(host.world.floor).toBe(2)
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 2))
    expect(bob.session.renderView().floor).toBe(2)
  })

  it('IGNORES a floor that walks BACKWARDS on a StateMsg, in the map and in the HUD', async () => {
    const { host, bob } = await startPair(8103)
    await step(host, bob, 12)
    await descend(host, bob)
    await step(host, bob, 16) // let a real StateMsg for floor 2 land
    expect(bob.session.renderView().floor).toBe(2)
    const populated = bob.session.renderView().entities.length

    bob.inject(
      encodeJson(MsgType.State, {
        floor: 1,
        missionText: 'stale',
        missionComplete: false,
        gameOver: false,
        alarm: 0,
        huds: {},
      }),
    )
    await flush()

    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 2))
    expect(bob.session.renderView().entities.length).toBe(populated)
    expect(bob.session.renderView().floor).toBe(2) // HUD must not walk back either
  })

  it('IGNORES a floorChange for the floor we are ALREADY on', async () => {
    // The routine StateMsg carries the CURRENT floor ~twice a second, and a
    // duplicated Events frame carries it again. If equality counted as a change,
    // the level would be rebuilt and the entity set wiped all game long — so the
    // guard has to be `<=`, not `<`.
    const { host, bob } = await startPair(8105)
    await step(host, bob, 12)
    const before = bob.session.renderView()
    expect(before.entities.length).toBeGreaterThan(1)
    let rebuilds = 0
    bob.session.onLevelChange = () => rebuilds++

    bob.inject(encodeJson(MsgType.Events, { tick: 2, events: [{ type: 'floorChange', floor: host.world.floor }] }))
    await flush()
    await step(host, bob, 20) // spans several real StateMsgs for the same floor

    expect(rebuilds).toBe(0)
    expect(bob.session.renderView().level).toBe(before.level) // same object: never regenerated
    expect(bob.session.renderView().entities.length).toBeGreaterThan(1)
  })

  it('STILL SELF-HEALS onto a DEEPER floor a client never heard about', async () => {
    // The client misses the floorChange entirely (host descends twice while the
    // client sits on floor 1); a snapshot for floor 3 must drag it onto the right
    // map. This is the path the guard must NOT break.
    const { host, bob, selfId } = await startPair(8104)
    await step(host, bob, 12)
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 1))

    bob.inject(fakeSnapshot(host.world.tick + 500, 3, wireSelf(selfId(), 5, 5)))
    await flush()
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 3))

    // …and a StateMsg for a deeper floor heals it too.
    bob.inject(
      encodeJson(MsgType.State, {
        floor: 4,
        missionText: 'deeper',
        missionComplete: false,
        gameOver: false,
        alarm: 0,
        huds: {},
      }),
    )
    await flush()
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 4))
    expect(bob.session.renderView().floor).toBe(4)
  })
})

/**
 * SEMANTIC-CONFLICT REGRESSIONS — the integration of seven branches.
 *
 * Each fix below is correct on its own; these tests pin the places where two of
 * them could be JOINTLY wrong. They exist because the merged unit suites all
 * passed without covering these paths.
 *
 * The shared hazard is that "play again" is the one moment when BOTH monotonic
 * counters the client now keeps must go backwards at once:
 *   - the snapshot tick (`lastSnapTick`), because `restart()` calls `createWorld`
 *     and the host's tick counter returns to 0; and
 *   - the floor, because a run that reached floor 3 restarts on floor 1.
 * `changeFloor` refuses to go shallower and `applySnapshot` refuses to go older,
 * so if GameStart did not re-baseline BOTH, a party that pressed "play again"
 * from deep in a run would get a client stuck on the old floor's map, frozen on
 * the old run's last snapshot, with the transport still perfectly healthy.
 */
describe('play again from deep in a run — both monotonic guards must re-baseline', () => {
  it('rebuilds floor 1 and keeps applying snapshots after a restart from floor 3', async () => {
    const { host, bob, selfId } = await startPair(9101)
    await step(host, bob, 12)
    await descend(host, bob)
    await descend(host, bob)
    expect(host.world.floor).toBe(3)
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 3))
    await step(host, bob, 10)

    const tickBefore = host.world.tick
    expect(tickBefore, 'the host must have a tick counter to regress FROM').toBeGreaterThan(20)
    const seed = host.world.seed

    host.restart() // "play again" — same seed, fresh world at tick 0, floor 1
    await flush()
    expect(host.world.tick).toBeLessThan(tickBefore) // the regression really happened
    expect(host.world.floor).toBe(1)

    // FLOOR re-baselined DOWNWARD, despite changeFloor being monotonic.
    expect(clientLevel(bob), 'client stuck on the old run\'s floor after play-again').toBe(levelFor(seed, 1))
    expect(bob.session.renderView().floor).toBe(1)

    // …and the SNAPSHOT lane is live again, despite the tick counter regressing.
    await step(host, bob, 12)
    const view = bob.session.renderView()
    expect(view.entities.length, 'client froze: no snapshot was applied after play-again').toBeGreaterThan(0)
    expect(view.self, 'client never re-acquired its own avatar after play-again').toBeDefined()
    expect(view.self!.id).toBe(selfId())
    expect(clientLevel(bob)).toBe(levelFor(seed, 1))
  })

  it('follows a re-seeded restart from deep in a run onto the new seed\'s floor 1', async () => {
    const { host, bob } = await startPair(9102)
    await step(host, bob, 12)
    await descend(host, bob)
    expect(host.world.floor).toBe(2)
    const oldSeed = host.world.seed

    const newSeed = 0x1234abcd
    host.restart(newSeed) // "New Seed" with the client still connected
    await flush()
    expect(host.world.seed).toBe(newSeed)

    expect(clientLevel(bob)).toBe(levelFor(newSeed, 1))
    expect(clientLevel(bob)).not.toBe(levelFor(oldSeed, 1))
    expect(clientLevel(bob)).not.toBe(levelFor(oldSeed, 2))

    await step(host, bob, 12)
    expect(bob.session.renderView().entities.length, 'client froze after a re-seeded restart').toBeGreaterThan(0)
    expect(bob.session.renderView().self).toBeDefined()
  })

  it('can still descend normally AFTER a play-again — the guards are not left latched', async () => {
    // The nastiest shape of the bug would be a client that survives the restart
    // but has a poisoned baseline, so the NEXT floor change or snapshot silently
    // stops applying. Drive a full second run to prove both guards still track.
    const { host, bob } = await startPair(9103)
    await step(host, bob, 12)
    await descend(host, bob)
    await descend(host, bob)
    host.restart()
    await flush()
    await step(host, bob, 8)
    expect(clientLevel(bob)).toBe(levelFor(host.world.seed, 1))

    await descend(host, bob)
    expect(host.world.floor).toBe(2)
    expect(clientLevel(bob), 'client stopped following floors after a play-again').toBe(
      levelFor(host.world.seed, 2),
    )
    await step(host, bob, 8)
    expect(bob.session.renderView().entities.length).toBeGreaterThan(0)
    expect(bob.session.renderView().floor).toBe(2)
  })
})
