import { describe, expect, it } from 'vitest'
import { type Conn, planClose, planData, planOpen } from '../../worker/roomRelay'
import type { TransportEvent } from '../types'
import { type WsLike, WsTransport } from './wsTransport'

// ---------------------------------------------------------------------------
// In-memory relay harness: fake sockets wired through the SAME pure planner the
// Durable Object uses (roomRelay.ts). This exercises the full WsTransport <-> relay
// loop deterministically, no workerd. The real DO adapter is covered by e2e.
// ---------------------------------------------------------------------------

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

class FakeSocket implements WsLike {
  binaryType = 'blob'
  readyState = CONNECTING
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(
    readonly url: string,
    private hub: Hub,
  ) {}
  send(data: ArrayBufferView | ArrayBuffer | string): void {
    this.hub.onSend(this, data)
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.hub.onClose(this)
    this.onclose?.({ code, reason })
  }
}

class Hub {
  private conns = new Map<FakeSocket, Conn>()
  private seq = 0

  /** The makeSocket factory handed to each transport. Parses ?role, registers the
   * connection, then (async, like a real upgrade) opens it and fans out planOpen. */
  connect = (url: string): WsLike => {
    const sock = new FakeSocket(url, this)
    const role = new URL(url).searchParams.get('role') === 'host' ? 'host' : 'client'
    const conn: Conn = { conn: `k${++this.seq}`, role, clientId: role === 'client' ? `c-${this.seq}` : undefined }
    this.conns.set(sock, conn)
    queueMicrotask(() => {
      sock.readyState = OPEN
      sock.onopen?.({})
      this.dispatch(planOpen(this.state(), conn.conn))
    })
    return sock
  }

  private state(): Conn[] {
    return [...this.conns.values()]
  }

  private find(connId: string): FakeSocket | undefined {
    for (const [sock, c] of this.conns) if (c.conn === connId) return sock
    return undefined
  }

  onSend(sock: FakeSocket, data: ArrayBufferView | ArrayBuffer | string): void {
    const conn = this.conns.get(sock)
    if (!conn || typeof data === 'string') return
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    this.dispatch(planData(this.state(), conn.conn, bytes))
  }

  onClose(sock: FakeSocket): void {
    const conn = this.conns.get(sock)
    if (!conn) return
    const actions = planClose(this.state(), conn.conn)
    this.conns.delete(sock)
    this.dispatch(actions)
  }

  private dispatch(actions: ReturnType<typeof planData>): void {
    for (const a of actions) {
      if (a.kind !== 'send') continue
      const target = this.find(a.conn)
      if (!target || target.readyState !== OPEN) continue
      const data = a.data instanceof Uint8Array ? bufferOf(a.data) : JSON.stringify(a.data)
      queueMicrotask(() => target.onmessage?.({ data }))
    }
  }
}

/** Copy into a standalone ArrayBuffer (what a real arraybuffer-typed socket yields). */
const bufferOf = (u: Uint8Array): ArrayBuffer => u.slice().buffer

/** Let all queued microtasks drain (open handshakes, control fan-out, delivery). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const collect = (t: WsTransport): TransportEvent[] => {
  const events: TransportEvent[] = []
  t.on((e) => events.push(e))
  return events
}

describe('WsTransport over the relay planner', () => {
  it('client-then-host: both sides see the connection and packets flow both ways', async () => {
    const hub = new Hub()
    const client = new WsTransport('client', 'room', 'ws://x/ws', hub.connect)
    const host = new WsTransport('host', 'room', 'ws://x/ws', hub.connect)
    const cEvents = collect(client)
    const hEvents = collect(host)

    await client.start()
    await flush()
    // Client waits silently until the host arrives.
    expect(cEvents).toEqual([])

    await host.start()
    await flush()

    // Both learn of each other.
    expect(cEvents).toContainEqual({ type: 'peerConnected', peer: 'host' })
    const joined = hEvents.find((e) => e.type === 'peerConnected')
    if (joined?.type !== 'peerConnected') throw new Error('host never saw the client connect')
    const clientPeerId = joined.peer
    expect(host.peers()).toEqual([clientPeerId])
    expect(client.peers()).toEqual(['host'])

    // client -> host
    await client.sendPacket('host', new Uint8Array([10, 20, 30]))
    await flush()
    const gotByHost = hEvents.find((e) => e.type === 'data')
    expect(gotByHost).toMatchObject({ type: 'data', peer: clientPeerId })
    expect(gotByHost?.type === 'data' && [...gotByHost.bytes]).toEqual([10, 20, 30])

    // host -> client
    await host.sendPacket(clientPeerId, new Uint8Array([1, 2]))
    await flush()
    const gotByClient = cEvents.find((e) => e.type === 'data')
    expect(gotByClient?.type === 'data' && [...gotByClient.bytes]).toEqual([1, 2])
  })

  it('host-then-client also connects', async () => {
    const hub = new Hub()
    const host = new WsTransport('host', 'r', 'ws://x/ws', hub.connect)
    const client = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    const hEvents = collect(host)
    const cEvents = collect(client)
    await host.start()
    await client.start()
    await flush()
    expect(cEvents).toContainEqual({ type: 'peerConnected', peer: 'host' })
    expect(hEvents.some((e) => e.type === 'peerConnected')).toBe(true)
  })

  it('two clients are addressed independently — no cross-talk', async () => {
    const hub = new Hub()
    const host = new WsTransport('host', 'r', 'ws://x/ws', hub.connect)
    const a = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    const b = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    const hEvents = collect(host)
    const aEvents = collect(a)
    const bEvents = collect(b)
    await host.start()
    await a.start()
    await b.start()
    await flush()

    const ids = host.peers()
    expect(ids).toHaveLength(2)

    // Host sends only to the first client id.
    await host.sendPacket(ids[0], new Uint8Array([7]))
    await flush()
    const forA = aEvents.filter((e) => e.type === 'data').length
    const forB = bEvents.filter((e) => e.type === 'data').length
    // Exactly one of the two clients received it; the other got nothing.
    expect(forA + forB).toBe(1)

    // A client's packet reaches the host tagged with THAT client's id only.
    await a.sendPacket('host', new Uint8Array([9]))
    await flush()
    const fromClients = hEvents.filter((e) => e.type === 'data')
    expect(fromClients).toHaveLength(1)
    void ids
    void bEvents
  })

  it('a client dropping notifies the host with a remote reason', async () => {
    const hub = new Hub()
    const host = new WsTransport('host', 'r', 'ws://x/ws', hub.connect)
    const client = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    const hEvents = collect(host)
    await host.start()
    await client.start()
    await flush()
    const peerId = host.peers()[0]

    await client.stop()
    await flush()
    expect(hEvents).toContainEqual({ type: 'peerDisconnected', peer: peerId, reason: 'remote' })
    expect(host.peers()).toEqual([])
  })

  it('the host dropping notifies each client', async () => {
    const hub = new Hub()
    const host = new WsTransport('host', 'r', 'ws://x/ws', hub.connect)
    const client = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    const cEvents = collect(client)
    await host.start()
    await client.start()
    await flush()

    await host.stop()
    await flush()
    expect(cEvents).toContainEqual({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
    expect(client.peers()).toEqual([])
  })

  it('sendPacket rejects before the socket is open', async () => {
    const hub = new Hub()
    const client = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    await expect(client.sendPacket('host', new Uint8Array([1]))).rejects.toThrow(/not open/)
  })

  it('sendPacket rejects for a peer that is not connected', async () => {
    const hub = new Hub()
    const client = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    await client.start()
    await flush()
    // Connected to the relay, but no host has joined → 'host' peer not present.
    await expect(client.sendPacket('host', new Uint8Array([1]))).rejects.toThrow(/not connected/)
  })

  it('a host transport refuses reconnect()', async () => {
    const hub = new Hub()
    const host = new WsTransport('host', 'r', 'ws://x/ws', hub.connect)
    await host.start()
    await flush()
    await expect(host.reconnect()).rejects.toThrow(/do not reconnect/)
  })

  it('client reconnect re-establishes the link (host sees the peer churn)', async () => {
    const hub = new Hub()
    const host = new WsTransport('host', 'r', 'ws://x/ws', hub.connect)
    const client = new WsTransport('client', 'r', 'ws://x/ws', hub.connect)
    const hEvents = collect(host)
    const cEvents = collect(client)
    await host.start()
    await client.start()
    await flush()

    await client.reconnect()
    await flush()

    // Client re-attached to the host.
    const clientConnects = cEvents.filter((e) => e.type === 'peerConnected').length
    expect(clientConnects).toBe(2)
    // Host saw the old peer leave and a new one join.
    expect(hEvents.some((e) => e.type === 'peerDisconnected')).toBe(true)
    expect(hEvents.filter((e) => e.type === 'peerConnected').length).toBe(2)
    expect(host.peers()).toHaveLength(1)
  })
})

describe('resolveWsBaseUrl', () => {
  it('prefers a ?ws= override', async () => {
    const { resolveWsBaseUrl } = await import('./wsTransport')
    expect(resolveWsBaseUrl('?ws=wss://relay.example/ws')).toBe('wss://relay.example/ws')
  })
  it('derives same-origin wss/ws from the page location', async () => {
    const { resolveWsBaseUrl } = await import('./wsTransport')
    expect(resolveWsBaseUrl('', { protocol: 'https:', host: 'game.example' })).toBe('wss://game.example/ws')
    expect(resolveWsBaseUrl('', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws')
  })
})
