// An HTTPS page that dials the plain ws:// hub gets a synchronous SecurityError
// from `new WebSocket(url)`. That throw escaped startDebugLink, rejected main.ts's
// boot before the frame loop started, and froze `?debug` on the live site at tick 0.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostSession } from '../app/hostSession'
import { createScriptedInput } from '../input/scripted'
import { startDebugLink, type LifecycleTarget } from './channel'

const refusingSocket = () => {
  let dials = 0
  class RefusingWS {
    constructor() {
      dials++
      throw new DOMException(
        "Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.",
        'SecurityError',
      )
    }
  }
  return { WS: RefusingWS as unknown as typeof WebSocket, dials: () => dials }
}

const visibleLifecycle = () => {
  const handlers = new Map<string, Array<() => void>>()
  let hidden = false
  const target: LifecycleTarget = {
    addEventListener: (type, cb) => void (handlers.get(type) ?? handlers.set(type, []).get(type)!).push(cb),
    removeEventListener: (type, cb) => void handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== cb)),
    hidden: () => hidden,
  }
  const setHidden = (h: boolean): void => {
    hidden = h
    for (const cb of handlers.get('visibilitychange') ?? []) cb()
  }
  return { target, setHidden }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('debug link when the browser refuses to construct the hub socket', () => {
  const start = () => {
    const session = new HostSession(1, createScriptedInput([]))
    const socket = refusingSocket()
    const lifecycle = visibleLifecycle()
    const logs: string[] = []
    const link = startDebugLink(session.world, 'ws://sporefall.hypnodroid.com:7810', (m) => logs.push(m), {
      WebSocketImpl: socket.WS,
      lifecycle: lifecycle.target,
      heartbeatMs: 1000,
      gameId: 'g',
    })
    return { session, socket, lifecycle, logs, link }
  }

  it('returns a link and the run keeps ticking through afterTick', () => {
    const { session, link, logs } = start()
    for (let i = 0; i < 30; i++) {
      session.tick()
      link.afterTick()
    }
    expect(session.world.tick).toBe(30)
    expect(logs.some((m) => m.includes('hub unavailable') && m.includes('SecurityError'))).toBe(true)
    link.stop()
  })

  it('does not retry a URL the browser will never dial, even across timers and a background/foreground cycle', () => {
    const { socket, lifecycle, link } = start()
    vi.advanceTimersByTime(60_000)
    expect(() => {
      lifecycle.setHidden(true)
      lifecycle.setHidden(false)
    }).not.toThrow()
    expect(socket.dials()).toBe(1)
    link.stop()
  })

  it('rebind after a new seed does not throw either', () => {
    const { session, link } = start()
    expect(() => link.rebind(new HostSession(2, createScriptedInput([])).world)).not.toThrow()
    session.tick()
    link.afterTick()
    link.stop()
  })
})
