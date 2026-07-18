import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnPlayer } from '../game/player'
import { createWorld } from '../game/world'
import { startDebugChannel, startHarnessChannel } from './channel'
import { GameHarness } from './harness'

/** A controllable WebSocket stand-in: tests drive open/close/message by hand. */
class FakeWS {
  static instances: FakeWS[] = []
  static reset(): void {
    FakeWS.instances = []
  }
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  sent: string[] = []
  closed = false
  constructor(readonly url: string) {
    FakeWS.instances.push(this)
  }
  send(s: string): void {
    this.sent.push(s)
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
  // test helpers
  fireOpen(): void {
    this.onopen?.()
  }
  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  drop(): void {
    this.onclose?.()
  }
  replies(): Array<{ t: string; ok?: boolean; body?: string }> {
    return this.sent.map((s) => JSON.parse(s))
  }
}

const WS = FakeWS as unknown as typeof WebSocket
const OPTS = { WebSocketImpl: WS, baseDelayMs: 100, maxDelayMs: 1000 }

beforeEach(() => {
  FakeWS.reset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('auto-reconnect', () => {
  it('re-dials the hub with backoff after a drop, re-sending hello', () => {
    const world = createWorld(1, 1)
    const ch = startDebugChannel(world, 'ws://x', () => {}, OPTS)
    expect(FakeWS.instances).toHaveLength(1)
    FakeWS.instances[0].fireOpen()
    expect(FakeWS.instances[0].replies()[0]).toMatchObject({ t: 'hello', role: 'game' })

    FakeWS.instances[0].drop()
    expect(FakeWS.instances).toHaveLength(1) // waiting on the backoff timer
    vi.advanceTimersByTime(100)
    expect(FakeWS.instances).toHaveLength(2) // re-dialed

    FakeWS.instances[1].fireOpen()
    expect(FakeWS.instances[1].replies()[0]).toMatchObject({ t: 'hello', role: 'game' })
    ch.stop()
  })

  it('backoff grows exponentially across repeated drops', () => {
    const world = createWorld(1, 1)
    startDebugChannel(world, 'ws://x', () => {}, OPTS)
    FakeWS.instances[0].drop()
    vi.advanceTimersByTime(100) // 1st retry after base
    expect(FakeWS.instances).toHaveLength(2)
    FakeWS.instances[1].drop()
    vi.advanceTimersByTime(100) // not yet — 2nd delay is 200
    expect(FakeWS.instances).toHaveLength(2)
    vi.advanceTimersByTime(100)
    expect(FakeWS.instances).toHaveLength(3)
  })

  it('stop() cancels any pending reconnect', () => {
    const world = createWorld(1, 1)
    const ch = startDebugChannel(world, 'ws://x', () => {}, OPTS)
    FakeWS.instances[0].fireOpen()
    ch.stop()
    vi.advanceTimersByTime(5000)
    expect(FakeWS.instances).toHaveLength(1) // never re-dialed
  })

  it('does not reconnect when disabled', () => {
    const world = createWorld(1, 1)
    startDebugChannel(world, 'ws://x', () => {}, { ...OPTS, reconnect: false })
    FakeWS.instances[0].drop()
    vi.advanceTimersByTime(5000)
    expect(FakeWS.instances).toHaveLength(1)
  })
})

describe('world channel over the wire', () => {
  it('answers a read verb immediately and defers writes to afterTick', () => {
    const world = createWorld(4242, 1)
    spawnPlayer(world, 0, 5, 5)
    const ch = startDebugChannel(world, 'ws://x', () => {}, OPTS)
    const sock = FakeWS.instances[0]
    sock.fireOpen()

    sock.fireMessage({ t: 'req', id: 1, verb: 'state' })
    const stateRep = sock.replies().find((r) => r.t === 'rep')!
    expect(JSON.parse(stateRep.body!).seed).toBe(4242)

    // A write is queued, not applied until afterTick.
    sock.fireMessage({ t: 'req', id: 2, verb: 'spawn npc cop 9 9' })
    expect(world.entities.filter((e) => e.kind === 'npc')).toHaveLength(0)
    ch.afterTick()
    expect(world.entities.filter((e) => e.kind === 'npc')).toHaveLength(1)
    ch.stop()
  })
})

describe('harness channel over the wire', () => {
  it('drives a full session through hub messages', () => {
    const harness = new GameHarness()
    const ch = startHarnessChannel(harness, 'ws://x', () => {}, OPTS)
    const sock = FakeWS.instances[0]
    sock.fireOpen()

    const call = (id: number, verb: string): { ok?: boolean; body?: string } => {
      const before = sock.sent.length
      sock.fireMessage({ t: 'req', id, verb })
      return JSON.parse(sock.sent[before])
    }

    expect(call(1, 'create 777').ok).not.toBe(false)
    expect(call(2, 'join_bot Bob').ok).not.toBe(false)
    expect(call(3, 'start_run').ok).not.toBe(false)
    const tickRep = call(4, 'tick 10')
    expect(JSON.parse(tickRep.body!).tick).toBe(10)
    expect(harness.world.tick).toBe(10)

    const err = call(5, 'frobnicate')
    expect(err.ok).toBe(false)
    ch.stop()
  })
})
