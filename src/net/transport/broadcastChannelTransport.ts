import type { PeerId, Transport, TransportEvent } from '../types'

/** Dev diagnostics, readable from the console / smoke tests. */
export const debugNet = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, dropped: 0, fatal: '' }
;(globalThis as Record<string, unknown>).__net = debugNet

interface WireMsg {
  kind: 'join' | 'accept' | 'data' | 'leave'
  from: string
  to?: string
  bytes?: number[]
}

/**
 * Dev transport: browser tabs on the same origin, one BroadcastChannel per room.
 * Mimics BLE pacing with an injectable latency/jitter so the interpolation and
 * backpressure paths get exercised honestly on desktop.
 */
export class BroadcastChannelTransport implements Transport {
  readonly maxPacket = 244 // pretend to be BLE so framing is exercised
  private channel: BroadcastChannel
  private handlers = new Set<(e: TransportEvent) => void>()
  private connected = new Set<PeerId>()
  private id = `peer-${Math.random().toString(36).slice(2, 10)}`

  constructor(
    readonly role: 'host' | 'client',
    room = 'dev',
    private latencyMs = 40,
    private jitterMs = 15,
  ) {
    this.channel = new BroadcastChannel(`sor-${room}`)
  }

  async start(): Promise<void> {
    this.channel.onmessage = (ev: MessageEvent<WireMsg>) => this.onWire(ev.data)
    if (this.role === 'client') this.post({ kind: 'join', from: this.id })
  }

  async stop(): Promise<void> {
    this.post({ kind: 'leave', from: this.id })
    this.channel.close()
    for (const peer of this.connected) this.emit({ type: 'peerDisconnected', peer, reason: 'local' })
    this.connected.clear()
  }

  private onWire(msg: WireMsg): void {
    if (msg.from === this.id) return
    if (msg.to !== undefined && msg.to !== this.id) return
    switch (msg.kind) {
      case 'join':
        if (this.role === 'host') {
          this.connected.add(msg.from)
          this.post({ kind: 'accept', from: this.id, to: msg.from })
          this.emit({ type: 'peerConnected', peer: msg.from })
        }
        break
      case 'accept':
        if (this.role === 'client' && !this.connected.has('host')) {
          this.connected.add('host')
          this.hostWireId = msg.from
          this.emit({ type: 'peerConnected', peer: 'host' })
        }
        break
      case 'data': {
        const peer = this.role === 'client' ? 'host' : msg.from
        if (!this.connected.has(peer)) {
          debugNet.dropped++
          return
        }
        debugNet.packetsReceived++
        this.emit({ type: 'data', peer, bytes: new Uint8Array(msg.bytes!) })
        break
      }
      case 'leave': {
        const peer = this.role === 'client' ? 'host' : msg.from
        if (this.role === 'client' && msg.from !== this.hostWireId) return
        if (this.connected.delete(peer)) this.emit({ type: 'peerDisconnected', peer, reason: 'remote' })
        break
      }
    }
  }

  private hostWireId: string | null = null

  async sendPacket(peer: PeerId, bytes: Uint8Array): Promise<void> {
    if (!this.connected.has(peer)) throw new Error(`peer ${peer} not connected`)
    const delay = this.latencyMs + Math.random() * this.jitterMs
    const to = this.role === 'client' ? (this.hostWireId ?? undefined) : peer
    await new Promise((r) => setTimeout(r, delay))
    this.post({ kind: 'data', from: this.id, to, bytes: [...bytes] })
    debugNet.packetsSent++
    debugNet.bytesSent += bytes.length
  }

  on(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  peers(): PeerId[] {
    return [...this.connected]
  }

  private post(msg: WireMsg): void {
    this.channel.postMessage(msg)
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e)
  }
}
