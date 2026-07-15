// Coverage for the in-app DebugChannel: the WebSocket glue that registers as the
// `game`, answers verbs, and — crucially — DEFERS mutating verbs onto the tick
// boundary so a write never tears mid-frame, while reads answer immediately.
//
// A FakeWebSocket stands in for the real socket so we can drive open/message/
// close deterministically and inspect exactly what the channel sent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { createWorld, type World } from '../game/world'
import type { SimEvent } from '../game/types'
import { startDebugChannel } from './channel'
import type { DebugMsg, RepMsg } from './protocol'

class FakeWebSocket {
  static last: FakeWebSocket | null = null
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.last = this
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
  // Test-side drivers:
  open(): void {
    this.onopen?.()
  }
  recv(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  recvRaw(data: string): void {
    this.onmessage?.({ data })
  }
  parsed(): DebugMsg[] {
    return this.sent.map((s) => JSON.parse(s) as DebugMsg)
  }
  ofType<T extends DebugMsg['t']>(t: T): Extract<DebugMsg, { t: T }>[] {
    return this.parsed().filter((m) => m.t === t) as Extract<DebugMsg, { t: T }>[]
  }
}

const realWS = globalThis.WebSocket
beforeEach(() => {
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  FakeWebSocket.last = null
})
afterEach(() => {
  ;(globalThis as { WebSocket: unknown }).WebSocket = realWS
})

const setup = (): { w: World; ws: FakeWebSocket; ch: ReturnType<typeof startDebugChannel> } => {
  const w = createWorld(1234, 1)
  const ch = startDebugChannel(w, 'ws://test:7810', () => {})
  const ws = FakeWebSocket.last!
  ws.open()
  return { w, ws, ch }
}

describe('handshake', () => {
  it('registers as the game role on open', () => {
    const { ws } = setup()
    const hello = ws.ofType('hello')
    expect(hello).toHaveLength(1)
    expect(hello[0].role).toBe('game')
  })
  it('does not send before the socket is open', () => {
    const w = createWorld(1234, 1)
    startDebugChannel(w, 'ws://test:7810', () => {})
    const ws = FakeWebSocket.last!
    // No open() yet — a read request produces no reply because send is gated.
    ws.recv({ t: 'req', id: 1, verb: 'state' })
    expect(ws.sent).toHaveLength(0)
  })
})

describe('read verbs answer immediately', () => {
  it('replies to a read without waiting for afterTick', () => {
    const { w, ws } = setup()
    spawnNpc(w, 'cop', 0, 0)
    ws.recv({ t: 'req', id: 7, verb: 'state' })
    const reps = ws.ofType('rep')
    expect(reps).toHaveLength(1)
    expect(reps[0].id).toBe(7)
    expect(reps[0].ok).toBe(true)
    expect(JSON.parse(reps[0].body).total).toBe(1)
  })
  it('replies ok:false with the error text on a bad verb', () => {
    const { ws } = setup()
    ws.recv({ t: 'req', id: 3, verb: 'frobnicate 1' })
    const rep = ws.ofType('rep')[0]
    expect(rep.ok).toBe(false)
    expect(rep.body).toMatch(/unknown verb/)
  })
})

describe('write verbs defer to the tick boundary', () => {
  it('does not mutate the world at receive time', () => {
    const { w, ws } = setup()
    const npc = spawnNpc(w, 'thug', 0, 0)
    ws.recv({ t: 'req', id: 9, verb: `kill ${npc.id}` })
    // Deferred: no reply and no mutation until afterTick drains the queue.
    expect(ws.ofType('rep')).toHaveLength(0)
    expect(npc.dead).toBeFalsy()
  })
  it('applies the write and replies when afterTick drains', () => {
    const { w, ws, ch } = setup()
    const npc = spawnNpc(w, 'thug', 0, 0)
    ws.recv({ t: 'req', id: 9, verb: `kill ${npc.id}` })
    ch.afterTick()
    const rep = ws.ofType('rep').find((r) => r.id === 9) as RepMsg
    expect(rep.ok).toBe(true)
    expect(JSON.parse(rep.body).dead).toBe(true)
    expect(npc.dead).toBe(true)
  })
})

describe('event streaming + ordering', () => {
  it("streams a kill's death event instead of the next tick clearing it", () => {
    const { w, ws, ch } = setup()
    const npc = spawnNpc(w, 'thug', 0, 0)
    ws.recv({ t: 'req', id: 1, verb: `kill ${npc.id}` })
    // Drain-then-stream in a single afterTick: the death event pushed by the
    // deferred kill must reach the wire, not get swept by the following tick.
    ch.afterTick()
    const events = ws.ofType('event').map((m) => JSON.parse(m.body))
    const death = events.find((e) => e.type === 'death' && e.entityId === npc.id)
    expect(death).toBeTruthy()
    expect(death.tick).toBe(w.tick) // stamped with the current tick
  })
  it('streams events that the sim placed in world.events', () => {
    const { w, ws, ch } = setup()
    w.events.push({ type: 'explosion', x: 1, y: 2, radius: 3 })
    ch.afterTick()
    const ev = ws.ofType('event').map((m) => JSON.parse(m.body))
    expect(ev.some((e) => e.type === 'explosion' && e.radius === 3)).toBe(true)
  })
  it('feeds the recent-events ring back to an `events` read', () => {
    const { w, ws, ch } = setup()
    w.events.push({ type: 'noise', x: 5, y: 6 })
    ch.afterTick()
    ws.recv({ t: 'req', id: 2, verb: 'events' })
    const rep = ws.ofType('rep').find((r) => r.id === 2) as RepMsg
    const ring = JSON.parse(rep.body) as SimEvent[]
    expect(ring.some((e) => e.type === 'noise')).toBe(true)
  })
  it('caps the recent-events ring at MAX_EVENTS (256)', () => {
    const { w, ws, ch } = setup()
    for (let i = 0; i < 300; i++) w.events.push({ type: 'noise', x: i, y: 0 })
    ch.afterTick()
    // All 300 were streamed out...
    expect(ws.ofType('event')).toHaveLength(300)
    // ...but the retained ring is trimmed to the cap.
    ws.recv({ t: 'req', id: 1, verb: 'events' })
    const rep = ws.ofType('rep').find((r) => r.id === 1) as RepMsg
    expect((JSON.parse(rep.body) as SimEvent[]).length).toBe(256)
  })
})

describe('malformed / irrelevant inbound messages', () => {
  it('ignores non-JSON frames without crashing', () => {
    const { ws } = setup()
    const before = ws.sent.length
    expect(() => ws.recvRaw('this is not json {')).not.toThrow()
    expect(ws.sent.length).toBe(before)
  })
  it('ignores message types other than req', () => {
    const { ws } = setup()
    const before = ws.sent.length
    ws.recv({ t: 'hello', role: 'debugger' })
    ws.recv({ t: 'event', body: '{}' })
    ws.recv({ t: 'rep', id: 1, ok: true, body: '{}' })
    expect(ws.sent.length).toBe(before)
  })
})

describe('lifecycle', () => {
  it('stop() closes the socket', () => {
    const { ws, ch } = setup()
    ch.stop()
    expect(ws.closed).toBe(true)
  })
  it('goes quiet after the socket closes', () => {
    const { ws } = setup()
    ws.close()
    const before = ws.sent.length
    ws.recv({ t: 'req', id: 1, verb: 'state' })
    expect(ws.sent.length).toBe(before) // send gated on `ready`, now false
  })
})
