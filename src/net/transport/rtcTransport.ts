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
 * mid-game (channel closed, ICE failed, or `silenceMs` with no bytes) moves that
 * peer to the relay without dropping the session, and each side tells the other
 * so both stop using the link. The host then retries a direct link in the
 * background (`retryDelaysMs`), so a wifi blip or a locked phone does not leave
 * a player on the relay for the rest of the run.
 *
 * Moving the stream between paths must not reorder it. Going down to the relay,
 * messages in flight on the dying channel are lost; the session resends what
 * matters (`pathChanged`). Coming back up, the direct link is faster than the
 * relay, so a message on `ctl` could overtake one still crossing the relay.
 * Each side therefore sends a `p2p` marker on the relay, behind its last relay
 * frame, as it moves its stream to `ctl`, and the other side holds that peer's
 * `ctl` messages until the marker lands.
 *
 * The relay stays the session's anchor: a relay drop is a peer drop.
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

/** A direct link that lasts this long has proved itself, and the next retry
 * after it drops starts from the shortest delay again. */
const HEALTHY_MS = 60_000

export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]

type Signal =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: RTCIceCandidateInit }
  /** The sender has stopped using the link to this peer; use the relay.
   * `off`: it plays over the relay only (`?p2p=0`), so offer it nothing more. */
  | { t: 'relay'; off?: true }
  /** The sender's stream moves to `ctl` after this; nothing more follows on the relay. */
  | { t: 'p2p' }

export interface RtcOptions {
  /** False plays every peer over the relay (`?p2p=0`). */
  p2p?: boolean
  iceServers?: RTCIceServer[]
  /** How long a link attempt has to open before it is given up. */
  iceTimeoutMs?: number
  /** No bytes on an open link for this long means it is dead. */
  silenceMs?: number
  heartbeatMs?: number
  /** Host: waits before each new attempt at a direct link to a peer on the
   * relay. The last one repeats. */
  retryDelaysMs?: readonly number[]
  makePeerConnection?: (config: RTCConfiguration) => RTCPeerConnection
  now?: () => number
  log?: (msg: string) => void
}

export interface CandidatePair {
  local: string
  remote: string
  rttMs: number | null
}

/**
 * - `negotiating`: the first attempt; the session has not heard of the peer yet.
 * - `p2p`: the stream and datagrams go on the direct link.
 * - `relay`: they go on the relay. A `pc` here is a retry still negotiating.
 */
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
  /** The peer's `ctl` messages wait here until its `p2p` marker says nothing
   * older is still crossing the relay. Null when they flow straight through. */
  held: Uint8Array[] | null
  /** The peer's `p2p` marker landed before our end of the link opened. */
  peerMarked: boolean
  /** The current attempt's deadline. */
  deadline?: ReturnType<typeof setTimeout>
  retry?: ReturnType<typeof setTimeout>
  retries: number
  /** The peer has P2P off: never offer it a direct link. */
  declined: boolean
  pair: CandidatePair | null
  born: number
  directSince: number
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
    if (s && (s.t === 'relay' || s.t === 'p2p')) return s
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
  private beats = 0
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
      retryDelaysMs: opts.retryDelaysMs ?? [5_000, 15_000, 60_000],
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
    for (const link of this.links.values()) this.forget(link)
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

  /** The ICE candidate types under each direct link (host to host on one wifi
   * network), refreshed about once a second. Null for a peer on the relay. */
  pairs(): Record<PeerId, CandidatePair | null> {
    return Object.fromEntries([...this.links].map(([peer, link]) => [peer, link.phase === 'p2p' ? link.pair : null]))
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
    if (old) this.forget(old)
    const now = this.opts.now()
    const link: Link = {
      phase: 'negotiating',
      announced: false,
      remoteSet: false,
      pendingIce: [],
      early: [],
      held: null,
      peerMarked: false,
      retries: 0,
      declined: false,
      pair: null,
      born: now,
      directSince: now,
      lastRx: now,
      lastTx: now,
    }
    this.links.set(peer, link)
    this.log(`${peer} joined the room`)
    if (!this.opts.p2p) {
      this.toRelay(peer, link, 'p2p off')
      return
    }
    this.attempt(peer, link)
  }

  private onPeerGone(peer: PeerId, reason: DropReason): void {
    const link = this.links.get(peer)
    if (!link) return
    this.links.delete(peer)
    this.forget(link)
    if (link.announced) this.emit({ type: 'peerDisconnected', peer, reason })
  }

  private forget(link: Link): void {
    clearTimeout(link.deadline)
    clearTimeout(link.retry)
    this.closePc(link)
  }

  /** Start one attempt at a direct link: the host offers, the client waits for
   * the offer. Either way it is given `iceTimeoutMs` to open. */
  private attempt(peer: PeerId, link: Link): void {
    clearTimeout(link.deadline)
    link.deadline = setTimeout(() => {
      if (this.links.get(peer) !== link || link.phase === 'p2p') return
      const why = `no direct link within ${this.opts.iceTimeoutMs} ms`
      if (link.phase === 'negotiating') this.toRelay(peer, link, why)
      else this.giveUpAttempt(peer, link, why)
    }, this.opts.iceTimeoutMs)
    if (this.role === 'host') void this.offer(peer, link)
  }

  /** A retry that did not open: drop it, stay on the relay, try again later. */
  private giveUpAttempt(peer: PeerId, link: Link, why: string): void {
    this.log(`${peer} retry failed: ${why}`)
    clearTimeout(link.deadline)
    this.closePc(link)
    // The peer's ctl messages held since its marker landed are in order now:
    // its next frames come over the relay, behind them. Kept, they would surface
    // at the next upgrade, after newer relay frames.
    if (link.peerMarked) {
      const held = link.held ?? []
      link.held = []
      for (const bytes of held) this.emit({ type: 'data', peer, bytes })
    }
    this.scheduleRetry(peer, link)
  }

  private scheduleRetry(peer: PeerId, link: Link): void {
    if (this.role !== 'host' || !this.opts.p2p || link.declined || link.phase !== 'relay') return
    clearTimeout(link.retry)
    const delays = this.opts.retryDelaysMs
    const wait = delays[Math.min(link.retries, delays.length - 1)]
    link.retries++
    link.retry = setTimeout(() => {
      link.retry = undefined
      if (this.links.get(peer) === link && link.phase === 'relay' && !link.pc) this.attempt(peer, link)
    }, wait)
  }

  private newPeerConnection(peer: PeerId, link: Link): RTCPeerConnection {
    this.closePc(link)
    const config: RTCConfiguration = { iceServers: this.opts.iceServers }
    const pc = this.opts.makePeerConnection ? this.opts.makePeerConnection(config) : new RTCPeerConnection(config)
    link.pc = pc
    link.remoteSet = false
    link.pendingIce = []
    link.peerMarked = false
    pc.onicecandidate = (ev) => {
      if (ev.candidate && link.pc === pc) this.signal(peer, { t: 'ice', c: ev.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (link.pc !== pc) return
      const s = pc.connectionState
      this.log(`${peer} connection ${s}`)
      // `disconnected` often recovers by itself within a second or two; the
      // silence clock decides that one.
      if (s !== 'failed' && s !== 'closed') return
      if (link.phase === 'p2p') this.toRelay(peer, link, `ice ${s}`)
      else if (link.phase === 'relay') this.giveUpAttempt(peer, link, `ice ${s}`)
    }
    return pc
  }

  private async offer(peer: PeerId, link: Link): Promise<void> {
    try {
      const pc = this.newPeerConnection(peer, link)
      this.attach(peer, link, pc.createDataChannel('ctl', { ordered: true }))
      this.attach(peer, link, pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }))
      await pc.setLocalDescription(await pc.createOffer())
      if (link.pc === pc) this.signal(peer, { t: 'offer', sdp: pc.localDescription!.sdp })
    } catch (err) {
      this.failAttempt(peer, link, `offer failed: ${String(err)}`)
    }
  }

  private failAttempt(peer: PeerId, link: Link, why: string): void {
    if (link.phase === 'negotiating') this.toRelay(peer, link, why)
    else if (link.phase === 'relay') this.giveUpAttempt(peer, link, why)
  }

  private async onSignal(peer: PeerId, link: Link, sig: Signal): Promise<void> {
    if (sig.t === 'relay') {
      if (sig.off) {
        link.declined = true
        clearTimeout(link.retry)
        link.retry = undefined
      }
      if (link.phase !== 'relay') {
        this.toRelay(peer, link, 'peer asked for the relay', false)
      } else if (link.pc) {
        // The peer gave up on the link our retry is still opening.
        this.giveUpAttempt(peer, link, 'peer went back to the relay')
      }
      return
    }
    if (sig.t === 'p2p') {
      this.releaseHeld(peer, link)
      return
    }
    if (link.phase === 'p2p') return
    if (sig.t === 'offer' && !this.opts.p2p) {
      this.signal(peer, { t: 'relay', off: true })
      return
    }
    try {
      if (sig.t === 'offer' && this.role === 'client') {
        if (link.phase === 'relay') this.attempt(peer, link)
        const pc = this.newPeerConnection(peer, link)
        pc.ondatachannel = (ev) => this.attach(peer, link, ev.channel)
        await pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp })
        await this.flushIce(link, pc)
        await pc.setLocalDescription(await pc.createAnswer())
        if (link.pc === pc) this.signal(peer, { t: 'answer', sdp: pc.localDescription!.sdp })
      } else if (sig.t === 'answer' && this.role === 'host' && link.pc && !link.remoteSet) {
        const pc = link.pc
        await pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp })
        await this.flushIce(link, pc)
      } else if (sig.t === 'ice') {
        if (link.remoteSet && link.pc) await link.pc.addIceCandidate(sig.c).catch(() => {})
        else link.pendingIce.push(sig.c)
      }
    } catch (err) {
      this.failAttempt(peer, link, `signalling failed: ${String(err)}`)
    }
  }

  private async flushIce(link: Link, pc: RTCPeerConnection): Promise<void> {
    if (link.pc !== pc) return
    link.remoteSet = true
    const pending = link.pendingIce.splice(0)
    for (const c of pending) await pc.addIceCandidate(c).catch(() => {})
  }

  private attach(peer: PeerId, link: Link, ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer'
    if (ch.label === 'fast') link.fast = ch
    else link.ctl = ch
    const datagram = ch.label === 'fast'
    const current = (): boolean => this.links.get(peer) === link && (link.ctl === ch || link.fast === ch)
    ch.onmessage = (ev: MessageEvent) => {
      if (!current()) return
      link.lastRx = this.opts.now()
      const bytes = new Uint8Array(ev.data as ArrayBuffer)
      if (datagram && bytes.length === 1 && bytes[0] === 0) return
      if (!datagram && link.held) {
        link.held.push(bytes)
        return
      }
      const e: TransportEvent = datagram ? { type: 'data', peer, bytes, datagram: true } : { type: 'data', peer, bytes }
      if (link.announced) this.emit(e)
      else link.early.push(e)
    }
    ch.onopen = () => this.maybeOpen(peer, link)
    ch.onclose = () => {
      if (!current()) return
      if (link.phase === 'p2p') this.toRelay(peer, link, `${ch.label} closed`)
      else if (link.phase === 'relay') this.giveUpAttempt(peer, link, `${ch.label} closed`)
    }
    if (ch.readyState === 'open') this.maybeOpen(peer, link)
  }

  private maybeOpen(peer: PeerId, link: Link): void {
    if (link.phase === 'p2p' || this.links.get(peer) !== link) return
    if (link.ctl?.readyState !== 'open' || link.fast?.readyState !== 'open') return
    const upgrade = link.phase === 'relay'
    clearTimeout(link.deadline)
    clearTimeout(link.retry)
    link.retry = undefined
    link.phase = 'p2p'
    link.directSince = link.lastRx = link.lastTx = this.opts.now()
    this.log(upgrade ? `${peer} back on a direct link` : `${peer} direct after ${Math.round(link.directSince - link.born)} ms`)
    if (upgrade) {
      // Behind every relay frame we sent; the peer holds our ctl data until it lands.
      this.signal(peer, { t: 'p2p' })
      if (link.peerMarked) this.flushHeld(peer, link)
    }
    void this.refreshPair(peer, link)
    this.announce(peer, link)
  }

  /** The peer's marker landed: everything it sent on the relay is in, so its
   * held ctl messages can follow in order. */
  private releaseHeld(peer: PeerId, link: Link): void {
    if (link.phase === 'p2p') {
      this.flushHeld(peer, link)
      return
    }
    // Our end has not opened yet. What arrived so far is in order; keep holding
    // until it opens, then let the rest straight through.
    link.peerMarked = true
    const held = link.held ?? []
    link.held = []
    for (const bytes of held) this.emit({ type: 'data', peer, bytes })
  }

  private flushHeld(peer: PeerId, link: Link): void {
    const held = link.held ?? []
    link.held = null
    for (const bytes of held) this.emit({ type: 'data', peer, bytes })
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

  /** Stop using the direct link to `peer`, tell the peer to do the same, carry
   * on over the relay, and (host) try for a direct link again later. */
  private toRelay(peer: PeerId, link: Link, why: string, tellPeer = true): void {
    if (link.phase === 'relay' || this.links.get(peer) !== link) return
    if (link.phase === 'p2p' && this.opts.now() - link.directSince >= HEALTHY_MS) link.retries = 0
    link.phase = 'relay'
    this.log(`${peer} on the relay: ${why}`)
    clearTimeout(link.deadline)
    this.closePc(link)
    // From here the peer's stream comes over the relay, so a later direct link
    // must wait for its marker before passing ctl data on.
    link.held ??= []
    link.pair = null
    if (tellPeer) this.signal(peer, this.opts.p2p ? { t: 'relay' } : { t: 'relay', off: true })
    this.announce(peer, link)
    this.scheduleRetry(peer, link)
  }

  private closePc(link: Link): void {
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

  private async refreshPair(peer: PeerId, link: Link): Promise<void> {
    const pc = link.pc
    if (!pc || link.phase !== 'p2p') return
    try {
      const stats = await pc.getStats()
      let pair: Record<string, unknown> | undefined
      stats.forEach((s: Record<string, unknown>) => {
        if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = stats.get(s.selectedCandidatePairId)
      })
      if (!pair) {
        stats.forEach((s: Record<string, unknown>) => {
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s
        })
      }
      if (!pair || link.pc !== pc || this.links.get(peer) !== link) return
      const local = stats.get(pair.localCandidateId as string) as { candidateType?: string } | undefined
      const remote = stats.get(pair.remoteCandidateId as string) as { candidateType?: string } | undefined
      const rtt = pair.currentRoundTripTime
      link.pair = {
        local: local?.candidateType ?? '?',
        remote: remote?.candidateType ?? '?',
        rttMs: typeof rtt === 'number' ? rtt * 1000 : null,
      }
    } catch {
      /* stats are best effort */
    }
  }

  /** Keep each direct link's silence clock fed, give up on one that went quiet,
   * and refresh the candidate pairs about once a second. */
  private beat(): void {
    const now = this.opts.now()
    const refresh = ++this.beats % Math.max(1, Math.round(1000 / this.opts.heartbeatMs)) === 0
    for (const [peer, link] of this.links) {
      if (link.phase !== 'p2p') continue
      if (now - link.lastRx >= this.opts.silenceMs) {
        this.toRelay(peer, link, `silent for ${Math.round(now - link.lastRx)} ms`)
        continue
      }
      if (now - link.lastTx >= this.opts.heartbeatMs) this.sendDatagram(peer, HEARTBEAT)
      if (refresh || !link.pair) void this.refreshPair(peer, link)
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
