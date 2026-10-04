import { mulberry32 } from '../../game/rng'

/**
 * An in-memory stand-in for the browser's RTCPeerConnection, for tests of
 * RtcTransport and the sessions over it. Two connections pair up through the
 * fake SDP; once both have a remote description, their data channels open on a
 * microtask. The net can refuse to connect (symmetric NAT, client isolation),
 * lose datagrams on unreliable channels, go silent, or close every channel.
 */

type Handler<E> = ((ev: E) => void) | null

let nextId = 1

export class FakeChannel {
  readyState: RTCDataChannelState = 'connecting'
  bufferedAmount = 0
  binaryType = 'arraybuffer'
  onmessage: Handler<{ data: ArrayBuffer }> = null
  onopen: Handler<unknown> = null
  onclose: Handler<unknown> = null
  peer: FakeChannel | null = null

  constructor(
    readonly label: string,
    readonly reliable: boolean,
    private net: FakeRtcNet,
  ) {}

  send(data: Uint8Array): void {
    if (this.readyState !== 'open') throw new Error(`channel ${this.label} is ${this.readyState}`)
    const target = this.peer
    if (!target || this.net.silent) return
    if (!this.reliable && this.net.drop()) return
    const copy = data.slice().buffer
    this.net.sent[this.reliable ? 'reliable' : 'unreliable']++
    queueMicrotask(() => {
      if (target.readyState === 'open') target.onmessage?.({ data: copy })
    })
  }

  close(): void {
    for (const ch of [this, this.peer]) {
      if (!ch || ch.readyState === 'closed') continue
      ch.readyState = 'closed'
      const fire = ch.onclose
      queueMicrotask(() => fire?.({}))
    }
  }
}

export class FakePeerConnection {
  readonly id = nextId++
  localDescription: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  onicecandidate: Handler<{ candidate: { toJSON: () => RTCIceCandidateInit } | null }> = null
  onconnectionstatechange: Handler<unknown> = null
  ondatachannel: Handler<{ channel: FakeChannel }> = null
  remote: FakePeerConnection | null = null
  channels: FakeChannel[] = []
  candidatesAdded = 0

  constructor(
    private net: FakeRtcNet,
    readonly config: RTCConfiguration,
  ) {
    net.pcs.push(this)
  }

  createDataChannel(label: string, init: RTCDataChannelInit = {}): FakeChannel {
    const ch = new FakeChannel(label, init.ordered !== false && init.maxRetransmits === undefined, this.net)
    this.channels.push(ch)
    return ch
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: `fake:${this.id}` }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: `fake:${this.id}` }
  }

  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = d
    const c: RTCIceCandidateInit = { candidate: `candidate:${this.id} 1 udp 2130706431 10.0.0.${this.id} 50000 typ host`, sdpMid: '0' }
    queueMicrotask(() => this.onicecandidate?.({ candidate: { toJSON: () => c } }))
  }

  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    const id = Number(String(d.sdp).split(':')[1])
    this.remote = this.net.pcs.find((p) => p.id === id) ?? null
    const other = this.remote
    if (other?.remote !== this) return
    if (this.localDescription?.type === 'offer') this.net.connect(this, other)
    else this.net.connect(other, this)
  }

  async addIceCandidate(): Promise<void> {
    this.candidatesAdded++
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return new Map<string, Record<string, unknown>>([
      ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.002 }],
      ['l', { type: 'local-candidate', candidateType: 'host' }],
      ['r', { type: 'remote-candidate', candidateType: 'host' }],
    ])
  }

  setState(s: RTCPeerConnectionState): void {
    if (this.connectionState === s) return
    this.connectionState = s
    this.onconnectionstatechange?.({})
  }

  close(): void {
    this.connectionState = 'closed'
    for (const ch of this.channels) ch.close()
  }
}

export class FakeRtcNet {
  pcs: FakePeerConnection[] = []
  /** ICE never finds a working pair: every peer must fall back to the relay. */
  blocked = false
  /** Datagrams on unreliable channels vanish, nothing closes. */
  silent = false
  /** Fraction of unreliable datagrams lost, drawn from a seeded stream. */
  lossRate = 0
  sent = { reliable: 0, unreliable: 0 }
  private rng = mulberry32(0x5eed)

  readonly makePeerConnection = (config: RTCConfiguration): RTCPeerConnection =>
    new FakePeerConnection(this, config) as unknown as RTCPeerConnection

  drop(): boolean {
    return this.lossRate > 0 && this.rng.next() < this.lossRate
  }

  connect(offerer: FakePeerConnection, answerer: FakePeerConnection): void {
    if (this.blocked) return
    queueMicrotask(() => {
      if (offerer.connectionState === 'closed' || answerer.connectionState === 'closed') return
      for (const a of offerer.channels) {
        const b = new FakeChannel(a.label, a.reliable, this)
        a.peer = b
        b.peer = a
        answerer.channels.push(b)
        answerer.ondatachannel?.({ channel: b })
      }
      offerer.setState('connected')
      answerer.setState('connected')
      for (const ch of [...offerer.channels, ...answerer.channels]) {
        ch.readyState = 'open'
        ch.onopen?.({})
      }
    })
  }

  /** Every direct link dies at once: channels close, ICE reports failed. */
  kill(): void {
    for (const pc of this.pcs) {
      if (pc.connectionState === 'closed') continue
      for (const ch of pc.channels) ch.close()
      pc.setState('failed')
    }
  }
}
