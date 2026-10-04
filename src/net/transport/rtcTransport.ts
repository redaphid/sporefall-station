import type { DropReason, LinkPath, PeerId, Transport, TransportEvent } from '../types'
import { resolveWsBaseUrl, WsTransport } from './wsTransport'

/**
 * Online play, peer to peer where the network allows it.
 *
 * Wraps the relay transport (WsTransport on the RoomDO). The relay announces who
 * is in the room and carries the WebRTC signalling (offer, answer, ICE). Each
 * guest then opens one RTCPeerConnection to the host (a host-star) with two data
 * channels:
 *
 * - `ctl`: reliable and ordered. The framed message stream (`sendPacket`).
 * - `fast`: unordered with `maxRetransmits: 0`. One whole message per datagram
 *   (`sendDatagram`): snapshots, input bundles, Ping/Pong.
 *
 * A peer whose link is not open within `iceTimeoutMs` (symmetric NAT, wifi with
 * client isolation, no WebRTC) plays over the relay instead. A link that dies
 * mid-game (channel closed, ICE failed, or `silenceMs` with no bytes) switches
 * that peer to the relay without dropping the session. The switch is one-way,
 * and each side tells the other over the relay so both stop using the link.
 *
 * The relay stays the session's anchor: a relay drop is a peer drop, as before.
 */

/** First byte of every frame this transport puts on the relay. */
const TAG_STREAM = 0
const TAG_SIGNAL = 1

/** A datagram of one zero byte: keeps the link's silence clock honest when the
 * game has nothing to say (the lobby). No message type is 0. */
const HEARTBEAT = new Uint8Array([0])

/**
 * Largest message `sendDatagram` takes. SCTP over DTLS carries about 1170 bytes
 * of user data per UDP packet in Chrome; a larger message is split, and losing
 * any piece loses all of it. Anything bigger goes on the reliable channel.
 */
export const MAX_DATAGRAM = 1100

/** Queued bytes past which a datagram is dropped rather than queued: it is
 * newest-wins state, and the next one is already on its way. */
const MAX_BUFFERED = 64 * 1024

export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]

type Signal =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: RTCIceCandidateInit }
  /** The sender has stopped using the link to this peer; use the relay. */
  | { t: 'relay' }

export interface RtcOptions {
  /** False plays every peer over the relay (`?p2p=0`). */
  p2p?: boolean
  iceServers?: RTCIceServer[]
  /** How long a new link has to open before the peer plays over the relay. */
  iceTimeoutMs?: number
  /** No bytes on an open link for this long means it is dead. */
  silenceMs?: number
  heartbeatMs?: number
  makePeerConnection?: (config: RTCConfiguration) => RTCPeerConnection
  now?: () => number
  log?: (msg: string) => void
}

type Phase = 'negotiating' | 'p2p' | 'relay'

interface Link {
  phase: Phase
  /** The session has been told this peer is connected. */
  announced: boolean
  pc?: RTCPeerConnection
  ctl?: RTCDataChannel
  fast?: RTCDataChannel
  remoteSet: boolean
  pendingIce: RTCIceCandidateInit[]
  /** Data that arrived on an open channel before the link was announced. */
  early: TransportEvent[]
  deadline?: ReturnType<typeof setTimeout>
  born: number
  lastRx: number
  lastTx: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const tagged = (tag: number, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(body.length + 1)
  out[0] = tag
  out.set(body, 1)
  return out
}

const parseSignal = (bytes: Uint8Array): Signal | null => {
  try {
    const s = JSON.parse(dec.decode(bytes)) as Signal
    if (s && (s.t === 'offer' || s.t === 'answer') && typeof s.sdp === 'string') return s
    if (s && s.t === 'ice' && s.c && typeof s.c === 'object') return s
    if (s && s.t === 'relay') return s
    return null
  } catch {
    return null
  }
}

export class RtcTransport implements Transport {
  readonly medium = 'online'
  /** One relay frame carries the tag byte plus a packet. */
  readonly maxPacket: number
  private handlers = new Set<(e: TransportEvent) => void>()
  private links = new Map<PeerId, Link>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private unsub: (() => void) | null = null
  private readonly opts: Required<Omit<RtcOptions, 'makePeerConnection' | 'log'>> &
    Pick<RtcOptions, 'makePeerConnection' | 'log'>

  constructor(
    private relay: Transport,
    opts: RtcOptions = {},
  ) {
    this.maxPacket = relay.maxPacket - 1
    const canRtc = opts.makePeerConnection !== undefined || typeof RTCPeerConnection !== 'undefined'
    this.opts = {
      p2p: (opts.p2p ?? true) && canRtc,
      iceServers: opts.iceServers ?? ICE_SERVERS,
      iceTimeoutMs: opts.iceTimeoutMs ?? 3000,
      silenceMs: opts.silenceMs ?? 2000,
      heartbeatMs: opts.heartbeatMs ?? 250,
      now: opts.now ?? (() => performance.now()),
      makePeerConnection: opts.makePeerConnection,
      log: opts.log,
    }
  }

  get role(): 'host' | 'client' {
    return this.relay.role
  }

  async start(): Promise<void> {
    this.unsub ??= this.relay.on((e) => this.onRelay(e))
    this.heartbeat ??= setInterval(() => this.beat(), this.opts.heartbeatMs)
    await this.relay.start()
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const link of this.links.values()) this.closeLink(link)
    await this.relay.stop()
  }

  async reconnect(): Promise<void> {
    if (!this.relay.reconnect) throw new Error('this relay does not reconnect')
    await this.relay.reconnect()
  }

  async drop(peer: PeerId): Promise<void> {
    await this.relay.drop?.(peer)
  }

  pathOf(peer: PeerId): LinkPath | undefined {
    const link = this.links.get(peer)
    return link?.announced ? (link.phase === 'p2p' ? 'p2p' : 'relay') : undefined
  }

  /** The ICE candidate types of the pair carrying `peer`, e.g. host to host on
   * one wifi network. Null when the peer is not on a direct link. */
  async selectedPair(peer: PeerId): Promise<{ local: string; remote: string; rttMs: number | null } | null> {
    const pc = this.links.get(peer)?.pc
    if (!pc || this.links.get(peer)?.phase !== 'p2p') return null
    const stats = await pc.getStats()
    let pair: Record<string, unknown> | undefined
    stats.forEach((s: Record<string, unknown>) => {
      if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = stats.get(s.selectedCandidatePairId)
    })
    if (!pair) stats.forEach((s: Record<string, unknown>) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s
    })
    if (!pair) return null
    const local = stats.get(pair.localCandidateId as string) as { candidateType?: string } | undefined
    const remote = stats.get(pair.remoteCandidateId as string) as { candidateType?: string } | undefined
    const rtt = pair.currentRoundTripTime
    return {
      local: local?.candidateType ?? '?',
      remote: remote?.candidateType ?? '?',
      rttMs: typeof rtt === 'number' ? rtt * 1000 : null,
    }
  }

  on(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Peers the relay has in the room, including any still negotiating a link. */
  peers(): PeerId[] {
    return [...this.links.keys()]
  }

  async sendPacket(peer: PeerId, bytes: Uint8Array): Promise<void> {
    const link = this.links.get(peer)
    if (!link?.announced) throw new Error(`peer ${peer} not connected`)
    if (link.phase === 'p2p' && link.ctl?.readyState === 'open') {
      try {
        link.ctl.send(bytes as Uint8Array<ArrayBuffer>)
        link.lastTx = this.opts.now()
        return
      } catch {
        this.toRelay(peer, link, 'ctl send failed')
      }
    }
    await this.relay.sendPacket(peer, tagged(TAG_STREAM, bytes))
  }

  sendDatagram(peer: PeerId, msg: Uint8Array): boolean {
    const link = this.links.get(peer)
    if (!link || link.phase !== 'p2p' || link.fast?.readyState !== 'open') return false
    if (msg.length > MAX_DATAGRAM) return false
    if (link.fast.bufferedAmount <= MAX_BUFFERED) {
      try {
        link.fast.send(msg as Uint8Array<ArrayBuffer>)
        link.lastTx = this.opts.now()
      } catch {
        this.toRelay(peer, link, 'fast send failed')
        return false
      }
    }
    return true
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e)
  }

  private log(msg: string): void {
    this.opts.log?.(`rtc: ${msg}`)
  }

  private onRelay(e: TransportEvent): void {
    if (e.type === 'peerConnected') this.onPeerJoined(e.peer)
    else if (e.type === 'peerDisconnected') this.onPeerGone(e.peer, e.reason)
    else if (e.type === 'data') {
      const link = this.links.get(e.peer)
      if (!link || e.bytes.length === 0) return
      if (e.bytes[0] === TAG_SIGNAL) {
        const sig = parseSignal(e.bytes.subarray(1))
        if (sig) void this.onSignal(e.peer, link, sig)
      } else if (e.bytes[0] === TAG_STREAM && link.announced) {
        this.emit({ type: 'data', peer: e.peer, bytes: e.bytes.subarray(1) })
      }
    }
  }

  private onPeerJoined(peer: PeerId): void {
    const old = this.links.get(peer)
    if (old) this.closeLink(old)
    const now = this.opts.now()
    const link: Link = { phase: 'negotiating', announced: false, remoteSet: false, pendingIce: [], early: [], born: now, lastRx: now, lastTx: now }
    this.links.set(peer, link)
    this.log(`${peer} joined the room`)
    if (!this.opts.p2p) {
      this.toRelay(peer, link, 'p2p off')
      return
    }
    link.deadline = setTimeout(() => {
      if (link.phase === 'negotiating') this.toRelay(peer, link, `no direct link within ${this.opts.iceTimeoutMs} ms`)
    }, this.opts.iceTimeoutMs)
    if (this.role === 'host') void this.offer(peer, link)
  }

  private onPeerGone(peer: PeerId, reason: DropReason): void {
    const link = this.links.get(peer)
    if (!link) return
    this.links.delete(peer)
    this.closeLink(link)
    if (link.announced) this.emit({ type: 'peerDisconnected', peer, reason })
  }

  private newPeerConnection(peer: PeerId, link: Link): RTCPeerConnection {
    const config: RTCConfiguration = { iceServers: this.opts.iceServers }
    const pc = this.opts.makePeerConnection ? this.opts.makePeerConnection(config) : new RTCPeerConnection(config)
    link.pc = pc
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.links.get(peer) === link) this.signal(peer, { t: 'ice', c: ev.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      this.log(`${peer} connection ${s}`)
      if ((s === 'failed' || s === 'disconnected' || s === 'closed') && link.phase === 'p2p') this.toRelay(peer, link, `ice ${s}`)
    }
    return pc
  }

  private async offer(peer: PeerId, link: Link): Promise<void> {
    try {
      const pc = this.newPeerConnection(peer, link)
      this.attach(peer, link, pc.createDataChannel('ctl', { ordered: true }))
      this.attach(peer, link, pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }))
      await pc.setLocalDescription(await pc.createOffer())
      if (this.links.get(peer) === link && link.phase === 'negotiating') this.signal(peer, { t: 'offer', sdp: pc.localDescription!.sdp })
    } catch (err) {
      this.toRelay(peer, link, `offer failed: ${String(err)}`)
    }
  }

  private async onSignal(peer: PeerId, link: Link, sig: Signal): Promise<void> {
    if (sig.t === 'relay') {
      this.toRelay(peer, link, 'peer asked for the relay', false)
      return
    }
    if (link.phase !== 'negotiating') return
    try {
      if (sig.t === 'offer' && this.role === 'client' && !link.pc) {
        const pc = this.newPeerConnection(peer, link)
        pc.ondatachannel = (ev) => this.attach(peer, link, ev.channel)
        await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp })
        await this.flushIce(link)
        await pc.setLocalDescription(await pc.createAnswer())
        if (link.phase === 'negotiating') this.signal(peer, { t: 'answer', sdp: pc.localDescription!.sdp })
      } else if (sig.t === 'answer' && this.role === 'host' && link.pc && !link.remoteSet) {
        await link.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp })
        await this.flushIce(link)
      } else if (sig.t === 'ice') {
        if (link.remoteSet && link.pc) await link.pc.addIceCandidate(sig.c).catch(() => {})
        else link.pendingIce.push(sig.c)
      }
    } catch (err) {
      this.toRelay(peer, link, `signalling failed: ${String(err)}`)
    }
  }

  private async flushIce(link: Link): Promise<void> {
    link.remoteSet = true
    const pending = link.pendingIce.splice(0)
    for (const c of pending) await link.pc?.addIceCandidate(c).catch(() => {})
  }

  private attach(peer: PeerId, link: Link, ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer'
    if (ch.label === 'fast') link.fast = ch
    else link.ctl = ch
    const datagram = ch.label === 'fast'
    ch.onmessage = (ev: MessageEvent) => {
      if (this.links.get(peer) !== link || link.phase === 'relay') return
      link.lastRx = this.opts.now()
      const bytes = new Uint8Array(ev.data as ArrayBuffer)
      if (datagram && bytes.length === 1 && bytes[0] === 0) return
      const e: TransportEvent = datagram ? { type: 'data', peer, bytes, datagram: true } : { type: 'data', peer, bytes }
      if (link.announced) this.emit(e)
      else link.early.push(e)
    }
    ch.onopen = () => this.maybeOpen(peer, link)
    ch.onclose = () => {
      if (link.phase === 'p2p') this.toRelay(peer, link, `${ch.label} closed`)
    }
    if (ch.readyState === 'open') this.maybeOpen(peer, link)
  }

  private maybeOpen(peer: PeerId, link: Link): void {
    if (link.phase !== 'negotiating' || this.links.get(peer) !== link) return
    if (link.ctl?.readyState !== 'open' || link.fast?.readyState !== 'open') return
    link.phase = 'p2p'
    clearTimeout(link.deadline)
    link.lastRx = link.lastTx = this.opts.now()
    this.log(`${peer} direct after ${Math.round(this.opts.now() - link.born)} ms`)
    this.announce(peer, link)
  }

  private announce(peer: PeerId, link: Link): void {
    if (link.announced) {
      this.emit({ type: 'pathChanged', peer, path: link.phase === 'p2p' ? 'p2p' : 'relay' })
      return
    }
    link.announced = true
    this.emit({ type: 'peerConnected', peer })
    for (const e of link.early.splice(0)) this.emit(e)
  }

  /** Stop using the direct link to `peer` for good, tell the peer to do the same,
   * and carry on over the relay. */
  private toRelay(peer: PeerId, link: Link, why: string, tellPeer = true): void {
    if (link.phase === 'relay' || this.links.get(peer) !== link) return
    link.phase = 'relay'
    this.log(`${peer} on the relay: ${why}`)
    this.closeLink(link)
    if (tellPeer) this.signal(peer, { t: 'relay' })
    this.announce(peer, link)
  }

  private closeLink(link: Link): void {
    clearTimeout(link.deadline)
    const pc = link.pc
    link.pc = undefined
    for (const ch of [link.ctl, link.fast]) {
      if (ch) ch.onmessage = ch.onopen = ch.onclose = null
    }
    link.ctl = link.fast = undefined
    if (pc) {
      pc.onicecandidate = pc.onconnectionstatechange = pc.ondatachannel = null
      try {
        pc.close()
      } catch {
        /* already closed */
      }
    }
  }

  private signal(peer: PeerId, sig: Signal): void {
    this.relay.sendPacket(peer, tagged(TAG_SIGNAL, enc.encode(JSON.stringify(sig)))).catch(() => {})
  }

  /** Keep each direct link's silence clock fed, and give up on one that went quiet. */
  private beat(): void {
    const now = this.opts.now()
    for (const [peer, link] of this.links) {
      if (link.phase !== 'p2p') continue
      if (now - link.lastRx >= this.opts.silenceMs) {
        this.toRelay(peer, link, `silent for ${Math.round(now - link.lastRx)} ms`)
        continue
      }
      if (now - link.lastTx >= this.opts.heartbeatMs) this.sendDatagram(peer, HEARTBEAT)
    }
  }
}

/** An online transport for the relay room `room`: peer to peer where it can be,
 * the relay where it can't. `?ws=` points at another relay, `?p2p=0` keeps
 * every peer on the relay. */
export const onlineTransport = (role: 'host' | 'client', room: string, search: string, log?: (msg: string) => void): RtcTransport =>
  new RtcTransport(new WsTransport(role, room, resolveWsBaseUrl(search)), {
    p2p: new URLSearchParams(search).get('p2p') !== '0',
    log,
  })
