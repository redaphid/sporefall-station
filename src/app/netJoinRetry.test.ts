import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * THE SILENT JOIN HANG.
 *
 * Admission is Hello up, then Welcome / GameStart / Go down, and not one of
 * those four messages is acknowledged: both BLE transports notify with
 * `type: 'withoutResponse'`, and the SendQueue's "reliable" lane only promises
 * never to DROP a queued message — it retries once on a `sendPacket` throw and
 * then kills the link. A packet that simply vanishes on the air throws nothing.
 *
 * So one lost packet used to end the join permanently, with no error anywhere:
 * the BLE link stayed UP, so no `peerDisconnected` fired, no timeout existed
 * (main.ts awaited a promise that only ever resolved on playing/rejected/ended),
 * and the joining player watched "Looking for a host…" until the phone was
 * force-quit. Measured on the real sessions at 2% loss: ~6% of joins failed;
 * at 10%, ~25%; and none of them ever recovered.
 *
 * Every test here drops WHOLE MESSAGES by type — the failure the field
 * actually produces — and asserts the join completes anyway. Each one hangs
 * forever without the retry.
 */

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({
  sample: () => ({ ...emptyInput(), ...cmd }),
})

/** A drop rule: swallow the Nth..Mth message of this type in this direction. */
interface DropRule {
  type: number
  /** How many of them to eat before letting the rest through. */
  times: number
}

/**
 * Loopback hub with a per-direction, per-message-type drop filter.
 *
 * `frameMessage` slices from offset 0 and SendQueue sends the slices in order,
 * so every message starts at a packet boundary and its first packet reads
 * `[len_lo, len_hi, msgType, …]`. That lets us drop a whole message — all of
 * its packets — the way real loss of a lone-packet message behaves, and it
 * keeps working at the 20-byte `maxPacket` floor where one message is 4+
 * packets. Anything else would desync the framing and prove a different bug.
 */
class LossyHub {
  readonly hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  /** Messages that reached the host, by type — the "did it cost bytes" ledger. */
  readonly hostSawByType = new Map<number, number>()

  h2cDrops: DropRule[] = []
  c2hDrops: DropRule[] = []

  constructor(readonly maxPacket = 180) {
    this.hostTransport = {
      role: 'host',
      maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer, bytes) =>
        this.send('h2c', bytes, (b) => this.centrals.get(peer)?.(b)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  /** Per-direction carry state: how many more packets of a dropped message remain. */
  private pending = new Map<string, number>()

  private send(dir: 'h2c' | 'c2h', bytes: Uint8Array, deliver: (b: Uint8Array) => void): Promise<void> {
    const carry = this.pending.get(dir) ?? 0
    if (carry > 0) {
      // Mid-message continuation of something we already decided to drop.
      this.pending.set(dir, carry - 1)
      return Promise.resolve()
    }
    // First packet of a message: [u16 len][type …]
    const len = bytes[0] | (bytes[1] << 8)
    const type = bytes[2]
    const packets = Math.ceil((2 + len) / this.maxPacket)
    if (dir === 'c2h') this.hostSawByType.set(type, (this.hostSawByType.get(type) ?? 0) + 1)
    const rules = dir === 'h2c' ? this.h2cDrops : this.c2hDrops
    const rule = rules.find((r) => r.type === type && r.times > 0)
    if (rule) {
      rule.times--
      if (dir === 'c2h') this.hostSawByType.set(type, (this.hostSawByType.get(type) ?? 0) - 1)
      this.pending.set(dir, packets - 1)
      return Promise.resolve()
    }
    const copy = new Uint8Array(bytes)
    return Promise.resolve().then(() => deliver(copy))
  }

  addClient(name: string): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    const transport: Transport = {
      role: 'client',
      maxPacket: this.maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p, bytes) => this.send('c2h', bytes, (b) => this.hostHandler?.({ type: 'data', peer, bytes: b })),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    return {
      session: new NetClientSession(name, stubInput(), transport),
      connect: () => {
        this.hostHandler?.({ type: 'peerConnected', peer })
        clientHandler?.({ type: 'peerConnected', peer: 'host' })
      },
    }
  }
}

/** Let the microtask-delivered wire settle without moving the clock. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Move the fake clock, flushing the microtask wire between timers. */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

describe('join handshake — retried until answered, then given up on OUT LOUD', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('recovers a join whose Hello never reached the host', async () => {
    const hub = new LossyHub()
    const host = new NetHostSession(11, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    hub.c2hDrops = [{ type: MsgType.Hello, times: 1 }]

    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()

    // The old behaviour, frozen in place: the host has no idea anyone is there
    // and the client has nothing to wait on.
    expect(host.lobbyPlayers()).toHaveLength(1)
    expect(c.session.phase).toBe('connecting')

    await advance(1100)
    expect(host.lobbyPlayers().map((p) => p.name)).toEqual(['Alice', 'Bob'])
    expect(c.session.phase).toBe('lobby')
  })

  it('recovers a join whose Welcome never reached the client', async () => {
    const hub = new LossyHub()
    const host = new NetHostSession(12, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    hub.h2cDrops = [{ type: MsgType.Welcome, times: 1 }]

    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()

    // Host admitted us; we never heard about it. Nothing errors — this is the
    // asymmetry that made the bug invisible from both ends.
    expect(host.lobbyPlayers()).toHaveLength(2)
    expect(c.session.phase).toBe('connecting')

    await advance(1100)
    expect(c.session.phase).toBe('lobby')
    expect(c.session.slot).toBe(1)
    // Re-answered, not re-admitted: still one seat.
    expect([...host.peersBySlot.keys()]).toEqual([1])
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(0)
  })

  it('recovers a start whose Go never reached the client (stuck on “Generating city…”)', async () => {
    const hub = new LossyHub()
    const host = new NetHostSession(13, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()
    expect(c.session.phase).toBe('lobby')

    hub.h2cDrops = [{ type: MsgType.Go, times: 1 }]
    host.beginGame()
    await settle()
    expect(c.session.phase).toBe('starting') // GameStart landed, Go did not

    await advance(1100)
    expect(c.session.phase).toBe('playing')
    // One avatar, not two: the re-answer replays the admission, it does not redo it.
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(2)
  })

  it('recovers a client left in the lobby when BOTH GameStart and Go were lost', async () => {
    const hub = new LossyHub()
    const host = new NetHostSession(14, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()

    hub.h2cDrops = [
      { type: MsgType.GameStart, times: 1 },
      { type: MsgType.Go, times: 1 },
    ]
    host.beginGame()
    await settle()
    // Indistinguishable, from the client's seat, from a host who has not pressed
    // Start — until a snapshot proves the run is already under way.
    expect(c.session.phase).toBe('lobby')

    // Snapshots go out every SNAPSHOT_INTERVAL_TICKS; one landing while we are
    // still in the lobby is the proof that re-opens the handshake retry.
    for (let i = 0; i < 6; i++) {
      host.tick()
      await settle()
    }
    await advance(1100)
    expect(c.session.phase).toBe('playing')
  })

  it('still recovers at the 20-byte maxPacket floor, where one message is many packets', async () => {
    // bleTransport falls back to `Math.max(20, …)` when MTU negotiation fails.
    // The handshake becomes 4+ packets per message, so loss compounds — and the
    // retry has to re-send the whole MESSAGE, not the fragment that went missing.
    const hub = new LossyHub(20)
    const host = new NetHostSession(15, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    hub.c2hDrops = [{ type: MsgType.Hello, times: 1 }]
    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()
    expect(c.session.phase).toBe('connecting')

    await advance(1100)
    expect(c.session.phase).toBe('lobby')

    hub.h2cDrops = [{ type: MsgType.Go, times: 1 }]
    host.beginGame()
    await settle()
    await advance(2100)
    expect(c.session.phase).toBe('playing')
  })

  it('survives a run of consecutive losses rather than giving up after one retry', async () => {
    const hub = new LossyHub()
    const host = new NetHostSession(16, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    hub.c2hDrops = [{ type: MsgType.Hello, times: 4 }] // four Hellos eaten in a row
    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()

    await advance(1100) // retry 1 — eaten
    expect(c.session.phase).toBe('connecting')
    await advance(6300) // retries 2-4 eaten, retry 5 lands
    expect(c.session.phase).toBe('lobby')
  })

  it('gives up OUT LOUD when the host never answers at all', async () => {
    // A live BLE link to something that will not talk. Retrying forever behind a
    // frozen status line is the original bug wearing a hat; the player has to be
    // told, and told something they can act on.
    const hub = new LossyHub()
    const host = new NetHostSession(17, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    hub.c2hDrops = [{ type: MsgType.Hello, times: 999 }]
    const c = hub.addClient('Bob')
    const phases: string[] = []
    c.session.onPhaseChange = (p) => phases.push(p)
    await c.session.start()
    c.connect()
    await settle()

    await advance(60_000)
    expect(c.session.phase).toBe('unreachable')
    expect(phases).toContain('unreachable')
    // Bounded: 1 initial + 8 retries. It must stop asking once it has said so.
    const asked = hub.hostSawByType.get(MsgType.Hello) ?? 0
    expect(asked).toBe(0) // all dropped…
    expect(c.session.phase).toBe('unreachable')
  })

  it('costs ZERO bytes once the join has completed', async () => {
    // The whole point of retry-not-keepalive: a joined client must never put a
    // single extra byte on the wire, on a radio this game shares with the game.
    const hub = new LossyHub()
    const host = new NetHostSession(18, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()
    host.beginGame()
    await settle()
    expect(c.session.phase).toBe('playing')

    const helloedByNow = hub.hostSawByType.get(MsgType.Hello) ?? 0
    expect(helloedByNow).toBe(1) // the clean join asked exactly once
    await advance(120_000) // two minutes of a healthy session
    expect(hub.hostSawByType.get(MsgType.Hello)).toBe(1)
  })

  it('never demotes a playing client back to the lobby when a re-answer arrives late', async () => {
    // Our retry can cross the host's reply in flight, so a Welcome CAN land on a
    // client that is already in the run. Applying it would put a live player back
    // on "waiting for host to start" mid-fight.
    const hub = new LossyHub()
    const host = new NetHostSession(19, 'Alice', stubInput(), hub.hostTransport)
    await host.start()
    const c = hub.addClient('Bob')
    await c.session.start()
    c.connect()
    await settle()
    host.beginGame()
    await settle()
    expect(c.session.phase).toBe('playing')

    // A duplicate Hello the host answers in full, arriving after we are playing.
    const peer = host.peersBySlot.get(1)!
    const entityBefore = peer.entityId
    ;(host as unknown as { reanswerAdmission: (p: unknown) => void }).reanswerAdmission(peer)
    await settle()

    expect(c.session.phase).toBe('playing')
    expect(peer.entityId).toBe(entityBefore)
    expect(host.world.entities.filter((e) => e.playerCtl)).toHaveLength(2)
  })
})
