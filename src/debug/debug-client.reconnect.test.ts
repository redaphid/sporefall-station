// Adversarial coverage for the self-healing MCP/CLI bridge (tools/debug-client).
// Drives a REAL in-process hub on an ephemeral port (no phone/adb, no mocked
// socket) and proves the three failure modes the resilience work targets:
//   1. bridge starts while the hub is DOWN, then the hub comes UP → a verb
//      succeeds after the background reconnect (no startup blocking).
//   2. hub drops MID-SESSION → a verb fails fast with a clear error, then the
//      hub returns → verbs succeed again (transparent resume).
//   3. close() halts the reconnect loop → no leaked timers/sockets.
//
// The bridge uses Node's global WebSocket; the fake games use the `ws` client,
// exactly like hub.test.ts.

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as WsClient, type WebSocketServer } from 'ws'
import { type AddressInfo } from 'node:net'
import { startHub } from '../../tools/debug-hub/hub'
import { createDebugClient, type DebugClient } from '../../tools/debug-client'

const silent = { log: () => {} }

let servers: WebSocketServer[] = []
let games: WsClient[] = []
let clients: DebugClient[] = []

afterEach(async () => {
  for (const c of clients) c.close()
  clients = []
  for (const g of games) g.terminate()
  games = []
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
  servers = []
})

const onceEvent = (emitter: { once: (e: string, cb: () => void) => void }, event: string): Promise<void> =>
  new Promise((r) => emitter.once(event, () => r()))

/** Bring a hub up on a specific port (so we can drop and re-bind the SAME port). */
const startHubOn = async (port: number): Promise<WebSocketServer> => {
  const wss = startHub(port, silent)
  servers.push(wss)
  await onceEvent(wss, 'listening')
  return wss
}

/** Reserve a currently-free port, then leave it DOWN (server closed). */
const freeDownPort = async (): Promise<number> => {
  const wss = startHub(0, silent)
  await onceEvent(wss, 'listening')
  const port = (wss.address() as AddressInfo).port
  await new Promise<void>((r) => wss.close(() => r()))
  return port
}

/** A fake game that answers every verb with its own name → routing is provable. */
const connectGame = async (url: string, name = 'solo'): Promise<WsClient> => {
  const s = new WsClient(url)
  games.push(s)
  await onceEvent(s, 'open')
  s.send(JSON.stringify({ t: 'hello', role: 'game', name }))
  s.on('message', (data: Buffer) => {
    const m = JSON.parse(data.toString()) as { t: string; id: number }
    if (m.t === 'req') s.send(JSON.stringify({ t: 'rep', id: m.id, ok: true, body: name }))
  })
  return s
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `pred` until it is truthy or we run out of time. */
const waitFor = async (pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await delay(10)
  }
  throw new Error('waitFor: condition never became true')
}

const verbOk = (client: DebugClient, verb = 'state'): Promise<boolean> =>
  client.raw(verb, { timeoutMs: 500 }).then(
    () => true,
    () => false,
  )

const fast = { baseMs: 15, capMs: 60 }

describe('debug-client resilience (self-healing bridge over a real hub)', () => {
  it('starts while the hub is DOWN, then connects and serves a verb once the hub comes UP', async () => {
    const port = await freeDownPort()
    const url = `ws://127.0.0.1:${port}`

    // Bridge is created against a hub that isn't listening — must NOT throw/reject.
    const client = createDebugClient(url, fast)
    clients.push(client)

    // While down, a verb fails FAST (not after the 5s per-verb timeout) with a clear msg.
    await expect(client.raw('state', { timeoutMs: 5000 })).rejects.toThrow(/not connected to the hub .*retrying/)

    // Hub appears with a live game → the background loop reconnects transparently.
    const hubUp = await startHubOn(port)
    void hubUp
    await connectGame(url, 'solo')

    await waitFor(() => verbOk(client))
    expect(await client.raw('state')).toBe('solo')
  })

  it('fails fast when the hub drops mid-session, then resumes when the hub returns', async () => {
    const port = await freeDownPort()
    const url = `ws://127.0.0.1:${port}`

    const hub1 = await startHubOn(port)
    await connectGame(url, 'solo')
    const client = createDebugClient(url, fast)
    clients.push(client)

    await waitFor(() => verbOk(client))
    expect(await client.raw('state')).toBe('solo')

    // Drop the hub out from under the live bridge: force-close every socket the
    // hub holds (the bridge's own connection included) so the server can shut and
    // the bridge sees the disconnect, then close the server.
    for (const g of games) g.terminate()
    games = []
    for (const c of hub1.clients) c.terminate()
    await new Promise<void>((r) => hub1.close(() => r()))
    servers = servers.filter((s) => s !== hub1)

    // Once the bridge notices, verbs reject fast with the clear disconnected error.
    await waitFor(async () => !(await verbOk(client)))
    await expect(client.raw('state', { timeoutMs: 5000 })).rejects.toThrow(/not connected to the hub .*retrying/)

    // Hub returns on the same port with a fresh game → verbs transparently resume.
    await startHubOn(port)
    await connectGame(url, 'back')
    await waitFor(() => verbOk(client))
    expect(await client.raw('state')).toBe('back')
  })

  it('close() halts the reconnect loop — no further socket attempts, no leaked timers', async () => {
    const port = await freeDownPort()
    const url = `ws://127.0.0.1:${port}` // stays DOWN → the bridge keeps retrying

    const RealWebSocket = globalThis.WebSocket
    let attempts = 0
    class CountingWebSocket extends RealWebSocket {
      constructor(target: string | URL, protocols?: string | string[]) {
        super(target, protocols)
        attempts++
      }
    }
    globalThis.WebSocket = CountingWebSocket as unknown as typeof WebSocket
    try {
      const client = createDebugClient(url, fast)
      clients.push(client)

      // Let the retry loop spin a few times against the dead port.
      await waitFor(() => attempts >= 3)

      client.close()
      const frozenAt = attempts

      // Well past several backoff windows: no new sockets are created.
      await delay(fast.capMs * 4)
      expect(attempts).toBe(frozenAt)

      // A closed bridge still answers verbs fast (never hangs).
      await expect(client.raw('state', { timeoutMs: 5000 })).rejects.toThrow(/not connected to the hub/)
    } finally {
      globalThis.WebSocket = RealWebSocket
    }
  })
})
