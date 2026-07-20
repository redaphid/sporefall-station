// New-Seed / play-again re-registration (the "blind observer" bug). `restart()`
// swaps `session.world` for a BRAND-NEW World object in place — no page reload —
// so a debug channel captured against the OLD world would keep heart-beating that
// now-frozen world as a zombie on the hub while the fresh run went un-bridged and
// never registered. `startDebugLink().rebind(newWorld)` must re-dial the hub against
// the new world exactly like a fresh boot: close the old socket (hub drops the
// zombie) and send a fresh hello bound to the new world.
//
// Two halves, mirroring hub.test.ts / channel.reconnect.test.ts:
//   1. Integration over a REAL in-process hub on an ephemeral port (no mocks): prove
//      default routing follows the NEW world's seed/tick after a rebind and the old
//      registration is gone — exactly what the CLI/MCP `state` verb would have read.
//   2. A deterministic FakeWS unit test: prove rebind CLOSES the old socket and opens
//      a fresh one that re-sends `hello`.

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type WebSocketServer } from 'ws'
import { type AddressInfo } from 'node:net'
import { startHub } from '../../tools/debug-hub/hub'
import { createWorld, tickWorld } from '../game/world'
import { startDebugLink, type DebugLink } from './channel'

const WS = WebSocket as unknown as typeof globalThis.WebSocket

// --- integration over a real loopback hub -----------------------------------

let servers: WebSocketServer[] = []
let sockets: WebSocket[] = []
let links: DebugLink[] = []

afterEach(async () => {
  for (const l of links) l.stop()
  links = []
  for (const s of sockets) s.terminate()
  sockets = []
  for (const srv of servers) await new Promise((r) => srv.close(r))
  servers = []
})

const startTestHub = async (): Promise<string> => {
  // Generous stale/frozen windows: this test is about registration identity, not
  // liveness expiry, and must not race the heartbeat timers.
  const wss = startHub(0, { log: () => {}, now: () => Date.now(), staleMs: 60_000, frozenMs: 60_000 })
  servers.push(wss)
  await new Promise((r) => wss.on('listening', r)) // port 0 is assigned on listen
  const port = (wss.address() as AddressInfo).port
  return `ws://127.0.0.1:${port}`
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60))

const openDebugger = async (url: string): Promise<WebSocket> => {
  const s = await new Promise<WebSocket>((res) => {
    const sock = new WebSocket(url)
    sockets.push(sock)
    sock.on('open', () => res(sock))
  })
  s.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
  await settle()
  return s
}

let seq = 0
const rpc = (s: WebSocket, verb: string): Promise<{ ok: boolean; body: string }> =>
  new Promise((res) => {
    const id = ++seq
    const onMsg = (data: Buffer): void => {
      const m = JSON.parse(data.toString())
      if (m.t === 'rep' && m.id === id) {
        s.off('message', onMsg)
        res({ ok: m.ok, body: m.body })
      }
    }
    s.on('message', onMsg)
    s.send(JSON.stringify({ t: 'req', id, verb }))
  })

describe('New-Seed debug re-registration (integration)', () => {
  it('rebinds to the NEW world and drops the old zombie so `state` reads the fresh run', async () => {
    const url = await startTestHub()

    // A HostSession's world just before New-Seed: seed 1111, advanced a few ticks.
    const oldWorld = createWorld(1111, 1)
    for (let i = 0; i < 5; i++) tickWorld(oldWorld, new Map())

    const link = startDebugLink(oldWorld, url, () => {}, { WebSocketImpl: WS, name: 'run', heartbeatMs: 0 })
    links.push(link)
    await settle()
    const dbg = await openDebugger(url)

    // Baseline: exactly one game, and default routing hits the OLD world.
    expect(JSON.parse((await rpc(dbg, 'games')).body)).toHaveLength(1)
    const before = JSON.parse((await rpc(dbg, 'state')).body)
    expect(before.seed).toBe(1111)
    expect(before.tick).toBe(5)

    // New-Seed: restart() swaps in a brand-new World with a fresh seed/tick.
    const newWorld = createWorld(2222, 1)
    link.rebind(newWorld)
    await settle()

    // The hub sees exactly ONE game again — the old registration was closed (no
    // lingering frozen zombie), a fresh one re-registered...
    expect(JSON.parse((await rpc(dbg, 'games')).body)).toHaveLength(1)
    // ...and default routing now reads the NEW world: fresh seed 2222, fresh tick 0.
    const after = JSON.parse((await rpc(dbg, 'state')).body)
    expect(after.seed).toBe(2222)
    expect(after.tick).toBe(0)
  })

  it('survives repeated New-Seed presses without accumulating zombies', async () => {
    const url = await startTestHub()
    const link = startDebugLink(createWorld(10, 1), url, () => {}, { WebSocketImpl: WS, name: 'run', heartbeatMs: 0 })
    links.push(link)
    await settle()
    const dbg = await openDebugger(url)

    // Hammer New-Seed several times; each rebind must supersede the last, never pile up.
    for (const seed of [20, 30, 40]) {
      link.rebind(createWorld(seed, 1))
      await settle()
    }

    expect(JSON.parse((await rpc(dbg, 'games')).body)).toHaveLength(1)
    expect(JSON.parse((await rpc(dbg, 'state')).body).seed).toBe(40) // the newest run
  })
})

// --- deterministic FakeWS unit test -----------------------------------------

/** A controllable WebSocket stand-in (same shape as channel.reconnect.test.ts). */
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
  replies(): Array<{ t: string }> {
    return this.sent.map((s) => JSON.parse(s))
  }
}

describe('startDebugLink.rebind (unit)', () => {
  it('closes the old socket and dials a fresh one that re-sends hello', () => {
    FakeWS.reset()
    const opts = { WebSocketImpl: FakeWS as unknown as typeof globalThis.WebSocket, heartbeatMs: 0, name: 'run' }
    const link = startDebugLink(createWorld(1, 1), 'ws://x', () => {}, opts)
    expect(FakeWS.instances).toHaveLength(1)
    FakeWS.instances[0].fireOpen()
    expect(FakeWS.instances[0].replies()[0]).toMatchObject({ t: 'hello' })

    link.rebind(createWorld(2, 1))
    // Old socket intentionally closed (hub drops the zombie); a second socket dialed.
    expect(FakeWS.instances[0].closed).toBe(true)
    expect(FakeWS.instances).toHaveLength(2)

    FakeWS.instances[1].fireOpen()
    expect(FakeWS.instances[1].replies()[0]).toMatchObject({ t: 'hello' })

    // The closed old socket must NOT auto-reconnect as a ghost.
    expect(FakeWS.instances).toHaveLength(2)
    link.stop()
    expect(FakeWS.instances[1].closed).toBe(true)
  })
})
