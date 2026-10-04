import { type Conn, planClose, planFrame, planOpen } from '../../worker/roomRelay'
import type { WsLike } from './wsTransport'

// In-memory relay harness: fake sockets wired through the SAME pure planner the
// Durable Object uses (roomRelay.ts). This exercises the full WsTransport <-> relay
// loop deterministically, no workerd. The real DO adapter is covered by e2e.

const CONNECTING = 0
export const OPEN = 1
export const CLOSED = 3

export class FakeSocket implements WsLike {
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

export class Hub {
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
    if (!conn) return
    const frame =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    this.dispatch(planFrame(this.state(), conn.conn, frame))
  }

  onClose(sock: FakeSocket): void {
    const conn = this.conns.get(sock)
    if (!conn) return
    const actions = planClose(this.state(), conn.conn)
    this.conns.delete(sock)
    this.dispatch(actions)
  }

  private dispatch(actions: ReturnType<typeof planFrame>): void {
    for (const a of actions) {
      const target = this.find(a.conn)
      if (a.kind === 'close') {
        queueMicrotask(() => target?.close(a.code, a.reason))
        continue
      }
      if (!target || target.readyState !== OPEN) continue
      const data = a.data instanceof Uint8Array ? bufferOf(a.data) : JSON.stringify(a.data)
      queueMicrotask(() => target.onmessage?.({ data }))
    }
  }
}

/** Copy into a standalone ArrayBuffer (what a real arraybuffer-typed socket yields). */
const bufferOf = (u: Uint8Array): ArrayBuffer => u.slice().buffer
