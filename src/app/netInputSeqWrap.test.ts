import { describe, expect, it } from 'vitest'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import type { PeerId, Transport, TransportEvent } from '../net/types'
import { liftAckedSeq, NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * THE 36-MINUTE WARP.
 *
 * `inputSeq` is an unbounded counter incremented once per 30 Hz tick and never
 * masked or reset. `encodeInput` truncates it to u16 on the wire, the host
 * stores the truncated value, and `snapshot.lastInputSeq` hands that raw u16
 * back — which the client used to assign straight into `lastAckedSeq` and then
 * compare against unbounded `p.seq` values. Two different units, one `>`.
 *
 * 65536 / 30 = 36.4 minutes of continuous play in a single page load. Past it
 * the ack restarts near zero, every pending input looks unacknowledged, the
 * backlog pins at its cap of 60, and `reconcile()` replays two full seconds of
 * movement on EVERY snapshot at 10 Hz — about nine tiles of warping, for the
 * rest of the session, until the page is reloaded.
 *
 * No test covered this before. Every assertion here fails on `main`.
 */

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({
  sample: () => ({ ...emptyInput(), ...cmd }),
})

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

  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(
      peer,
      (bytes) => void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })),
    )
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
    return {
      session: new NetClientSession(name, input, clientTransport),
      connect: () => {
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
      },
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A host + a client walking steadily right, already in the run. */
const playingPair = async (
  seed: number,
): Promise<{ host: NetHostSession; client: NetClientSession; step: (n: number) => Promise<void> }> => {
  const hub = new MockHub()
  const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
  const c = hub.addClient('Bob', stubInput({ moveX: 1, moveY: 0.2 }))
  await host.start()
  await c.session.start()
  c.connect()
  await flush()
  host.beginGame()
  await flush()
  expect(c.session.phase).toBe('playing')
  // Immortal: isolate the sequence arithmetic from the death/down path.
  for (const e of host.world.entities) {
    if (e.playerCtl && e.health) {
      e.health.hp = 1e6
      e.health.max = 1e6
    }
  }
  const step = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      host.tick()
      c.session.tick()
      await flush()
    }
  }
  return { host, client: c.session, step }
}

/** Reach into the two private counters the wrap is about. */
const peek = (c: NetClientSession): { inputSeq: number; lastAckedSeq: number; backlog: number } => {
  const anyC = c as unknown as { inputSeq: number; lastAckedSeq: number; pendingInputs: unknown[] }
  return { inputSeq: anyC.inputSeq, lastAckedSeq: anyC.lastAckedSeq, backlog: anyC.pendingInputs.length }
}

describe('input sequence u16 wrap — the ack and the counter must be in the same units', () => {
  describe('liftAckedSeq', () => {
    it('is the identity while the counter still fits in a u16', () => {
      expect(liftAckedSeq(100, 97)).toBe(97)
      expect(liftAckedSeq(1, 0)).toBe(0)
      expect(liftAckedSeq(65535, 65530)).toBe(65530)
    })

    it('lifts an ack that wrapped past 2^16 back onto the counter', () => {
      // Counter at 65600; its u16 shadow is 64. An ack of 64 means "all of it".
      expect(liftAckedSeq(65600, 64)).toBe(65600)
      // Ack ten behind: u16 54 → 65590, not 54.
      expect(liftAckedSeq(65600, 54)).toBe(65590)
      // A second lap behaves identically.
      expect(liftAckedSeq(131_136, 64)).toBe(131_136)
    })

    it('never claims more than has been sent, at any offset in the window', () => {
      for (const inputSeq of [0, 1, 65_535, 65_536, 65_537, 200_000, 1_000_000]) {
        for (const behind of [0, 1, 2, 59, 60]) {
          const trueAck = Math.max(0, inputSeq - behind)
          expect(liftAckedSeq(inputSeq, trueAck & 0xffff)).toBe(trueAck)
        }
      }
    })
  })

  it('keeps the pending-input backlog small across the 2^16 boundary', async () => {
    const { host, client, step } = await playingPair(20260818)
    await step(40)
    const before = peek(client)
    expect(before.backlog).toBeLessThan(10) // healthy baseline

    // Fast-forward BOTH ends to just under the boundary, exactly as 36 minutes
    // of real play would leave them, then walk across it.
    const anyC = client as unknown as { inputSeq: number }
    anyC.inputSeq = 65_500
    const peer = [...host.peersBySlot.values()][0]
    peer.lastInputSeq = 65_500 & 0xffff
    await step(120)

    const after = peek(client)
    expect(after.inputSeq).toBeGreaterThan(65_536) // we really did cross it
    // Before the fix this pins at the cap of 60 and never recovers.
    expect(after.backlog).toBeLessThan(10)
    // And the ack is expressed in the counter's units, not the wire's.
    expect(after.lastAckedSeq).toBeGreaterThan(65_536)
  })

  it('does not replay two seconds of movement on every snapshot after the wrap', async () => {
    // The player-visible cost, measured as WORK rather than as distance.
    //
    // Distance is the wrong probe here and a tuned-to-pass test would be worse
    // than none: `moveAndCollide` clamps the replay against walls, and the
    // client's own per-tick prediction walks into the SAME wall, so a client
    // holding one direction ends up pinned beside the host's avatar and the
    // drift reads small even while it is badly broken. Count the replayed
    // inputs instead — that is the defect itself, and it is independent of
    // where the level generator happened to put a wall.
    const { host, client, step } = await playingPair(4242)
    await step(40)

    const anyC = client as unknown as { inputSeq: number; stepSelf: (cmd: InputCmd) => void }
    const realStepSelf = anyC.stepSelf.bind(client)
    let steps = 0
    anyC.stepSelf = (cmd: InputCmd) => {
      steps++
      realStepSelf(cmd)
    }

    anyC.inputSeq = 65_500
    const peer = [...host.peersBySlot.values()][0]
    peer.lastInputSeq = 65_500 & 0xffff
    await step(120) // walks across 2^16

    // 120 ticks each call stepSelf once for the live prediction; snapshots land
    // at 10 Hz (SNAPSHOT_INTERVAL_TICKS = 3) and each one replays its backlog.
    // Healthy, that is ~40 snapshots × a 2-3 entry backlog. Broken, it is
    // ~40 × 60 = 2400 replays — 2.0s of input re-simulated, every snapshot.
    expect(steps).toBeLessThan(120 + 40 * 10)
  })

  it('still prunes acknowledged inputs after the wrap instead of replaying them', async () => {
    const { host, client, step } = await playingPair(99)
    const anyC = client as unknown as { inputSeq: number }
    anyC.inputSeq = 65_530
    const peer = [...host.peersBySlot.values()][0]
    peer.lastInputSeq = 65_530 & 0xffff
    await step(60)

    const { inputSeq, lastAckedSeq, backlog } = peek(client)
    // Everything older than the ack must be gone, and the ack must trail the
    // counter by only the handful of inputs genuinely still in flight.
    expect(inputSeq - lastAckedSeq).toBeLessThan(10)
    expect(backlog).toBeLessThan(10)
  })
})
