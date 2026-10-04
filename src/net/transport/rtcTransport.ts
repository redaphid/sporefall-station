// PROTOTYPE (proto/webrtc-vs-relay, not for merge). A WebRTC data-channel
// Transport that signals over an existing relay Transport (the RoomDO WebSocket).
// Signalling frames ride the relay's binary data lane behind SIG_BYTE, a first
// byte no MsgType uses, so the relay needs no change. If the data channel is not
// open within `fallbackMs`, the peer stays reachable through the relay itself.

import { MsgType, type PeerId, type Transport, type TransportEvent } from '../types'

export type RtcMode = 'reliable' | 'unreliable'

export interface RtcOptions {
  mode: RtcMode
  iceServers: RTCIceServer[]
  fallbackMs?: number
  /** Rewrite (or drop, with null) a remote candidate before it is applied. */
  mapRemoteCandidate?: (c: RTCIceCandidateInit) => RTCIceCandidateInit | null
  onLocalCandidate?: (c: RTCIceCandidate) => void
  /** First bytes for the unordered channel in 'unreliable' mode. */
  unreliableTypes?: ReadonlySet<number>
}

export const SIG_BYTE = 0xee

/** First bytes that ride the unordered, no-retransmit channel in 'unreliable' mode. */
export const UNRELIABLE_TYPES: ReadonlySet<number> = new Set([MsgType.Snapshot, 0xf2])

type Sig = { t: 'offer' | 'answer'; sdp: string } | { t: 'ice'; c: RTCIceCandidateInit }

interface Link {
  pc: RTCPeerConnection
  rel?: RTCDataChannel
  snap?: RTCDataChannel
  via: 'pending' | 'p2p' | 'relay'
  timer?: ReturnType<typeof setTimeout>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export class RtcTransport implements Transport {
  readonly maxPacket = 65536
  private handlers = new Set<(e: TransportEvent) => void>()
  private links = new Map<PeerId, Link>()
  private unsub: (() => void) | null = null

  constructor(
    readonly role: 'host' | 'client',
    private sig: Transport,
    private opts: RtcOptions,
  ) {}

  async start(): Promise<void> {
    this.unsub = this.sig.on((e) => this.onSig(e))
    await this.sig.start()
  }

  async stop(): Promise<void> {
    for (const [peer] of this.links) this.drop(peer, 'local')
    this.unsub?.()
    await this.sig.stop()
  }

  /** Which path each connected peer is on. */
  paths(): Record<PeerId, Link['via']> {
    return Object.fromEntries([...this.links].map(([p, l]) => [p, l.via]))
  }

  private onSig(e: TransportEvent): void {
    if (e.type === 'peerConnected') {
      if (this.role === 'host') void this.offer(e.peer)
      return
    }
    if (e.type === 'peerDisconnected') {
      this.drop(e.peer, e.reason)
      return
    }
    if (e.bytes[0] === SIG_BYTE) {
      void this.onSignal(e.peer, JSON.parse(dec.decode(e.bytes.subarray(1))) as Sig)
      return
    }
    if (this.links.get(e.peer)?.via === 'relay') this.emit({ type: 'data', peer: e.peer, bytes: e.bytes })
  }

  private send(peer: PeerId, m: Sig): void {
    const body = enc.encode(JSON.stringify(m))
    const out = new Uint8Array(body.length + 1)
    out[0] = SIG_BYTE
    out.set(body, 1)
    void this.sig.sendPacket(peer, out)
  }

  private newLink(peer: PeerId): Link {
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers })
    const link: Link = { pc, via: 'pending' }
    this.links.set(peer, link)
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return
      this.opts.onLocalCandidate?.(ev.candidate)
      this.send(peer, { t: 'ice', c: ev.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && link.via === 'p2p') this.drop(peer, 'error')
    }
    link.timer = setTimeout(() => {
      if (link.via !== 'pending') return
      link.via = 'relay'
      this.emit({ type: 'peerConnected', peer })
    }, this.opts.fallbackMs ?? 10000)
    return link
  }

  private attach(peer: PeerId, link: Link, ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer'
    if (ch.label === 'snap') link.snap = ch
    else link.rel = ch
    ch.onmessage = (ev) => this.emit({ type: 'data', peer, bytes: new Uint8Array(ev.data as ArrayBuffer) })
    ch.onopen = () => this.maybeOpen(peer, link)
    if (ch.readyState === 'open') this.maybeOpen(peer, link)
  }

  private maybeOpen(peer: PeerId, link: Link): void {
    const needSnap = this.opts.mode === 'unreliable'
    if (link.via !== 'pending' || link.rel?.readyState !== 'open') return
    if (needSnap && link.snap?.readyState !== 'open') return
    link.via = 'p2p'
    clearTimeout(link.timer)
    this.emit({ type: 'peerConnected', peer })
  }

  private async offer(peer: PeerId): Promise<void> {
    const link = this.newLink(peer)
    this.attach(peer, link, link.pc.createDataChannel('rel', { ordered: true }))
    if (this.opts.mode === 'unreliable') {
      this.attach(peer, link, link.pc.createDataChannel('snap', { ordered: false, maxRetransmits: 0 }))
    }
    await link.pc.setLocalDescription(await link.pc.createOffer())
    this.send(peer, { t: 'offer', sdp: link.pc.localDescription!.sdp })
  }

  private async onSignal(peer: PeerId, m: Sig): Promise<void> {
    if (m.t === 'offer') {
      const link = this.newLink(peer)
      link.pc.ondatachannel = (ev) => this.attach(peer, link, ev.channel)
      await link.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
      await link.pc.setLocalDescription(await link.pc.createAnswer())
      this.send(peer, { t: 'answer', sdp: link.pc.localDescription!.sdp })
      return
    }
    const link = this.links.get(peer)
    if (!link) return
    if (m.t !== 'ice') {
      await link.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp })
      return
    }
    const c = this.opts.mapRemoteCandidate ? this.opts.mapRemoteCandidate(m.c) : m.c
    if (c) await link.pc.addIceCandidate(c).catch(() => {})
  }

  private drop(peer: PeerId, reason: 'remote' | 'local' | 'error'): void {
    const link = this.links.get(peer)
    if (!link) return
    this.links.delete(peer)
    clearTimeout(link.timer)
    link.pc.close()
    if (link.via !== 'pending') this.emit({ type: 'peerDisconnected', peer, reason })
  }

  async sendPacket(peer: PeerId, bytes: Uint8Array): Promise<void> {
    const link = this.links.get(peer)
    if (!link || link.via === 'pending') throw new Error(`peer ${peer} not connected`)
    if (link.via === 'relay') return this.sig.sendPacket(peer, bytes)
    const ch = link.snap && (this.opts.unreliableTypes ?? UNRELIABLE_TYPES).has(bytes[0]!) ? link.snap : link.rel!
    ch.send(bytes as Uint8Array<ArrayBuffer>)
  }

  on(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  peers(): PeerId[] {
    return [...this.links].filter(([, l]) => l.via !== 'pending').map(([p]) => p)
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e)
  }
}
