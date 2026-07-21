import type { PeerId, Transport, TransportEvent } from '../types'
import { decodeAddressed, encodeAddressed, parseControl } from './wsWire'

/** The slice of the browser WebSocket API this transport uses — narrowed so tests
 * can inject a fake socket without a DOM. The real `WebSocket` structurally
 * satisfies it. */
export interface WsLike {
  binaryType: string
  readonly readyState: number
  send(data: ArrayBufferView | ArrayBuffer | string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

/** WebSocket.OPEN. */
const OPEN = 1

/**
 * WebSocket transport: dials the RoomDO relay (a Cloudflare Worker Durable
 * Object) and speaks the wire format in wsWire.ts. It mirrors
 * BroadcastChannelTransport's contract exactly — a client sees a single peer
 * named 'host'; a host sees each client by its relay-assigned peer id — so
 * NetHost/NetClientSession are transport-agnostic.
 *
 * `baseUrl` is the relay origin+path WITHOUT the room, e.g. `wss://host/ws`; the
 * room and `?role` are appended on start(). `makeSocket` is injectable for tests.
 */
export class WsTransport implements Transport {
  // A real network link — no BLE MTU. Framing still chunks to this, so keep it
  // comfortably above a full snapshot to avoid needless fragmentation.
  readonly maxPacket = 65536

  private socket: WsLike | null = null
  private handlers = new Set<(e: TransportEvent) => void>()
  private connected = new Set<PeerId>()
  private stopping = false

  constructor(
    readonly role: 'host' | 'client',
    private room: string,
    private baseUrl: string,
    private makeSocket: (url: string) => WsLike = (url) => new WebSocket(url) as unknown as WsLike,
  ) {}

  private url(): string {
    const base = this.baseUrl.replace(/\/$/, '')
    return `${base}/${encodeURIComponent(this.room)}?role=${this.role}`
  }

  async start(): Promise<void> {
    this.stopping = false
    await this.open()
  }

  /** Open the socket and wait for the relay to accept the upgrade (onopen). Peer
   * connections are then announced asynchronously by control frames. */
  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = this.makeSocket(this.url())
      sock.binaryType = 'arraybuffer'
      this.socket = sock
      let opened = false
      sock.onopen = () => {
        opened = true
        resolve()
      }
      sock.onmessage = (ev) => this.onMessage(ev.data)
      sock.onclose = (ev) => {
        // A close before onopen means the upgrade itself failed.
        if (!opened) reject(new Error(`ws closed before open (code ${ev.code ?? '?'})`))
        this.onClose()
      }
      sock.onerror = () => {
        if (!opened) reject(new Error('ws error before open'))
      }
    })
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.onControl(data)
      return
    }
    // Binary: a data frame. Client frames are bare payloads addressed to 'host';
    // host frames are peer-addressed and must be un-wrapped.
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array)
    if (this.role === 'client') {
      if (this.connected.has('host')) this.emit({ type: 'data', peer: 'host', bytes })
      return
    }
    const { id, payload } = decodeAddressed(bytes)
    if (this.connected.has(id)) this.emit({ type: 'data', peer: id, bytes: payload })
  }

  private onControl(text: string): void {
    const msg = parseControl(text)
    if (!msg) return
    switch (msg.t) {
      case 'host+':
        if (this.role === 'client' && !this.connected.has('host')) {
          this.connected.add('host')
          this.emit({ type: 'peerConnected', peer: 'host' })
        }
        break
      case 'host-':
        if (this.role === 'client' && this.connected.delete('host')) {
          this.emit({ type: 'peerDisconnected', peer: 'host', reason: msg.reason })
        }
        break
      case 'peer+':
        if (this.role === 'host' && !this.connected.has(msg.id)) {
          this.connected.add(msg.id)
          this.emit({ type: 'peerConnected', peer: msg.id })
        }
        break
      case 'peer-':
        if (this.role === 'host' && this.connected.delete(msg.id)) {
          this.emit({ type: 'peerDisconnected', peer: msg.id, reason: msg.reason })
        }
        break
    }
  }

  /** The relay socket dropped: every peer we were routing through it is gone. A
   * caller-initiated stop() reports 'local'; anything else is an 'error' drop. */
  private onClose(): void {
    const reason = this.stopping ? 'local' : 'error'
    for (const peer of this.connected) this.emit({ type: 'peerDisconnected', peer, reason })
    this.connected.clear()
    this.socket = null
  }

  async sendPacket(peer: PeerId, bytes: Uint8Array): Promise<void> {
    const sock = this.socket
    if (!sock || sock.readyState !== OPEN) throw new Error('ws not open')
    if (!this.connected.has(peer)) throw new Error(`peer ${peer} not connected`)
    // Client → relay: bare payload (the relay knows it's for the host).
    // Host → relay: prefix the target client's id so the relay can route it.
    sock.send(this.role === 'client' ? bytes : encodeAddressed(peer, bytes))
  }

  async reconnect(): Promise<void> {
    if (this.role !== 'client') throw new Error('host transports do not reconnect')
    // A fresh socket is a fresh relay connection; the host sees a new peer join.
    try {
      this.socket?.close()
    } catch {
      /* already closing */
    }
    this.connected.clear()
    this.socket = null
    await this.open()
  }

  async stop(): Promise<void> {
    this.stopping = true
    try {
      this.socket?.close(1000, 'client stop')
    } catch {
      /* already closing */
    }
    // If the socket never opened / already closed, onClose won't fire — flush now.
    if (this.socket === null && this.connected.size > 0) {
      for (const peer of this.connected) this.emit({ type: 'peerDisconnected', peer, reason: 'local' })
      this.connected.clear()
    }
  }

  on(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  peers(): PeerId[] {
    return [...this.connected]
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e)
  }
}

/** Resolve the relay base URL (origin + `/ws`) for the current page. Same-origin
 * when served by the Worker; overridable via `?ws=` (dev pointing at
 * `wrangler dev`) or a `VITE_WS_URL` build-time default (native builds, which
 * load from file:// and have no same-origin server). */
export const resolveWsBaseUrl = (search = '', loc?: { protocol: string; host: string }): string => {
  const override = new URLSearchParams(search).get('ws')
  if (override) return override
  const envUrl = (import.meta.env?.VITE_WS_URL as string | undefined) ?? ''
  if (envUrl) return envUrl.replace(/\/$/, '')
  const l = loc ?? location
  const scheme = l.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${l.host}/ws`
}
