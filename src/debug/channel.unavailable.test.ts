// A hub the browser refuses to dial must never take the game down. Browsers
// throw synchronously from `new WebSocket(url)` for a `ws://` URL on an HTTPS
// page (SecurityError) and for a malformed URL such as an out-of-range
// `?debugPort=` (SyntaxError). Before the fix that throw escaped main.ts's boot
// before the frame loop started: a blank screen with the world stuck at tick 0.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostSession } from '../app/hostSession'
import { createScriptedInput } from '../input/scripted'
import { startDebugLink, type LifecycleTarget } from './channel'

const SECURITY = (): Error =>
  new DOMException(
    "Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.",
    'SecurityError',
  )
const SYNTAX = (): Error => new DOMException("Failed to construct 'WebSocket': The URL 'ws://h:99999' is invalid.", 'SyntaxError')

const refusingSocket = (err: () => Error): { WS: typeof WebSocket; dials: () => number } => {
  let dials = 0
  class RefusingWS {
    constructor() {
      dials++
      throw err()
    }
  }
  return { WS: RefusingWS as unknown as typeof WebSocket, dials: () => dials }
}

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
}

const bootSolo = (err: () => Error) => {
  const session = new HostSession(1, createScriptedInput([]))
  const socket = refusingSocket(err)
  const lifecycle = new FakeLifecycle()
  const logs: string[] = []
  const link = startDebugLink(session.world, 'ws://sporefall.hypnodroid.com:7810', (m) => logs.push(m), {
    WebSocketImpl: socket.WS,
    lifecycle,
    heartbeatMs: 1000,
    gameId: 'test-game',
  })
  const play = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      session.tick()
      link.afterTick()
    }
  }
  return { session, socket, lifecycle, logs, link, play }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe.each([
  ['SecurityError (ws:// from an HTTPS page)', SECURITY],
  ['SyntaxError (malformed hub URL)', SYNTAX],
])('debug link when the WebSocket constructor throws %s', (_label, err) => {
  it('returns a link instead of throwing, and the solo run ticks through it', () => {
    const boot = bootSolo(err)
    boot.play(30)
    expect(boot.session.world.tick).toBe(30)
    boot.link.stop()
  })

  it('reports "hub unavailable" once, naming the URL and the browser reason', () => {
    const boot = bootSolo(err)
    expect(boot.logs).toHaveLength(1)
    expect(boot.logs[0]).toMatch(/hub unavailable/)
    expect(boot.logs[0]).toContain('ws://sporefall.hypnodroid.com:7810')
    expect(boot.logs[0]).toContain(err().message)
    boot.link.stop()
  })

  it('gives up for good: backoff time, heartbeats, and hide/show never re-dial or re-log', () => {
    const boot = bootSolo(err)
    boot.play(5)
    vi.advanceTimersByTime(60_000)
    boot.lifecycle._hidden = true
    boot.lifecycle.fire('visibilitychange')
    boot.lifecycle._hidden = false
    boot.lifecycle.fire('visibilitychange')
    boot.lifecycle.fire('pagehide')
    vi.advanceTimersByTime(60_000)
    boot.play(5)
    expect(boot.socket.dials()).toBe(1)
    expect(boot.logs).toHaveLength(1)
    expect(boot.session.world.tick).toBe(10)
    boot.link.stop()
  })

  it('survives a New Seed rebind and keeps ticking the fresh world', () => {
    const boot = bootSolo(err)
    boot.play(3)
    boot.session.restart()
    expect(() => boot.link.rebind(boot.session.world)).not.toThrow()
    boot.play(7)
    expect(boot.session.world.tick).toBe(7)
    boot.link.stop()
  })
})
