// The channel's self-removal + liveness behaviour (issue #45). The core bug was
// a backgrounded/reloaded webview whose reconnect loop kept re-attaching a frozen
// world as a ghost. The fix: on hidden/pagehide the channel closes its socket AND
// cancels the reconnect loop, re-arming only when foregrounded again — and it
// heartbeats so the hub can see a live, advancing game vs a frozen one.
//
// A fake WebSocket + a fake page-lifecycle target let us drive open/close/hide/
// show and inspect exactly what the channel did, with no DOM or device.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorld } from '../game/world'
import { startDebugChannel, startHarnessChannel, type LifecycleTarget } from './channel'
import { GameHarness } from './harness'

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
  fireOpen(): void {
    this.onopen?.()
  }
  msgs(): Array<{ t: string; tick?: number; role?: string; name?: string }> {
    return this.sent.map((s) => JSON.parse(s))
  }
}

/** A hand-driven page lifecycle: tests `fire()` events and flip `_hidden`. */
class FakeLifecycle implements LifecycleTarget {
  private handlers = new Map<string, Array<() => void>>()
  _hidden = false
  addEventListener(type: string, cb: () => void): void {
    ;(this.handlers.get(type) ?? this.handlers.set(type, []).get(type)!).push(cb)
  }
  removeEventListener(type: string, cb: () => void): void {
    const arr = this.handlers.get(type)
    if (arr) this.handlers.set(type, arr.filter((h) => h !== cb))
  }
  hidden(): boolean {
    return this._hidden
  }
  fire(type: string): void {
    for (const cb of this.handlers.get(type) ?? []) cb()
  }
  count(type: string): number {
    return this.handlers.get(type)?.length ?? 0
  }
}

const WS = FakeWS as unknown as typeof WebSocket

beforeEach(() => {
  FakeWS.reset()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

const setup = (extra: Record<string, unknown> = {}) => {
  const world = createWorld(1, 1)
  const lifecycle = new FakeLifecycle()
  const ch = startDebugChannel(world, 'ws://x', () => {}, { WebSocketImpl: WS, baseDelayMs: 100, maxDelayMs: 1000, heartbeatMs: 1000, lifecycle, ...extra })
  return { world, lifecycle, ch }
}

describe('heartbeat', () => {
  it('pings with the current world tick on the interval', () => {
    const { world, ch } = setup()
    FakeWS.instances[0].fireOpen()
    world.tick = 42
    vi.advanceTimersByTime(1000)
    const ping = FakeWS.instances[0].msgs().find((m) => m.t === 'ping')
    expect(ping).toMatchObject({ t: 'ping', tick: 42 })
    ch.stop()
  })

  it('stops heartbeating after stop()', () => {
    const { ch } = setup()
    FakeWS.instances[0].fireOpen()
    ch.stop()
    const before = FakeWS.instances[0].sent.length
    vi.advanceTimersByTime(5000)
    expect(FakeWS.instances[0].sent.length).toBe(before)
  })

  it('harness heartbeat carries NO tick (never judged frozen between verbs)', () => {
    const harness = new GameHarness()
    const ch = startHarnessChannel(harness, 'ws://x', () => {}, { WebSocketImpl: WS, heartbeatMs: 1000 })
    FakeWS.instances[0].fireOpen()
    vi.advanceTimersByTime(1000)
    const ping = FakeWS.instances[0].msgs().find((m) => m.t === 'ping')
    expect(ping).toBeTruthy()
    expect(ping!.tick).toBeUndefined()
    ch.stop()
  })
})

describe('self-removal on background / unload', () => {
  it('closes the socket AND cancels reconnect when hidden', () => {
    const { lifecycle, ch } = setup()
    FakeWS.instances[0].fireOpen()
    lifecycle._hidden = true
    lifecycle.fire('visibilitychange')
    expect(FakeWS.instances[0].closed).toBe(true)
    // The reconnect loop must NOT re-dial a backgrounded page.
    vi.advanceTimersByTime(5000)
    expect(FakeWS.instances).toHaveLength(1)
    ch.stop()
  })

  it('closes + does not re-dial on pagehide (reloading page)', () => {
    const { lifecycle, ch } = setup()
    FakeWS.instances[0].fireOpen()
    lifecycle.fire('pagehide')
    expect(FakeWS.instances[0].closed).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(FakeWS.instances).toHaveLength(1)
    ch.stop()
  })

  it('closes on beforeunload too', () => {
    const { lifecycle, ch } = setup()
    FakeWS.instances[0].fireOpen()
    lifecycle.fire('beforeunload')
    expect(FakeWS.instances[0].closed).toBe(true)
    ch.stop()
  })

  it('re-dials (re-arms) when the page becomes visible again', () => {
    const { lifecycle, ch } = setup()
    FakeWS.instances[0].fireOpen()
    lifecycle._hidden = true
    lifecycle.fire('visibilitychange')
    expect(FakeWS.instances).toHaveLength(1)
    lifecycle._hidden = false
    lifecycle.fire('visibilitychange')
    expect(FakeWS.instances).toHaveLength(2) // re-opened a fresh socket
    FakeWS.instances[1].fireOpen()
    expect(FakeWS.instances[1].msgs()[0]).toMatchObject({ t: 'hello', role: 'game' })
    ch.stop()
  })

  it('an unintentional drop still reconnects (not confused with a pause)', () => {
    const { ch } = setup()
    FakeWS.instances[0].fireOpen()
    FakeWS.instances[0].onclose?.() // socket dropped, not a page-hide
    vi.advanceTimersByTime(100)
    expect(FakeWS.instances).toHaveLength(2)
    ch.stop()
  })

  it('does not re-dial after stop even when visibility fires', () => {
    const { lifecycle, ch } = setup()
    FakeWS.instances[0].fireOpen()
    ch.stop()
    lifecycle._hidden = false
    lifecycle.fire('visibilitychange')
    vi.advanceTimersByTime(5000)
    expect(FakeWS.instances).toHaveLength(1)
  })

  it('stop() unregisters its lifecycle listeners', () => {
    const { lifecycle, ch } = setup()
    ch.stop()
    expect(lifecycle.count('visibilitychange')).toBe(0)
    expect(lifecycle.count('pagehide')).toBe(0)
    expect(lifecycle.count('beforeunload')).toBe(0)
  })
})

describe('game name / identity', () => {
  it('includes the configured name in hello', () => {
    const world = createWorld(1, 1)
    const ch = startDebugChannel(world, 'ws://x', () => {}, { WebSocketImpl: WS, name: 'alice', heartbeatMs: 0 })
    FakeWS.instances[0].fireOpen()
    expect(FakeWS.instances[0].msgs()[0]).toMatchObject({ t: 'hello', role: 'game', name: 'alice' })
    ch.stop()
  })

  it('omits name when none is given (backward compatible)', () => {
    const world = createWorld(1, 1)
    const ch = startDebugChannel(world, 'ws://x', () => {}, { WebSocketImpl: WS, heartbeatMs: 0 })
    FakeWS.instances[0].fireOpen()
    expect(FakeWS.instances[0].msgs()[0]).not.toHaveProperty('name')
    ch.stop()
  })
})
