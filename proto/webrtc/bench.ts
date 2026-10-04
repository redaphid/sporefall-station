import { WsTransport } from '../../src/net/transport/wsTransport'
import { RtcTransport } from '../../src/net/transport/rtcTransport'
import type { Transport, PeerId } from '../../src/net/types'

type Path = 'ws' | 'rtc-rel' | 'rtc-unrel' | 'rtc-unrel-all'
interface Opts { path: Path; durS: number; wsBase: string; proxyIp: string; ua: number; ub: number }

const now = () => performance.now()
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const r1 = (x: number) => Math.round(x * 10) / 10

const pkt = (type: number, seq: number, t: number, len: number) => {
  const b = new Uint8Array(len)
  const v = new DataView(b.buffer)
  b[0] = type
  v.setUint32(1, seq)
  v.setFloat64(5, t)
  return b
}

const synth = (ip: string, port: number) => {
  let sent = false
  return (c: RTCIceCandidateInit): RTCIceCandidateInit | null => {
    if (sent) return null
    sent = true
    return {
      candidate: `candidate:1 1 udp 2130706431 ${ip} ${port} typ host generation 0`,
      sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment: c.usernameFragment,
    }
  }
}

const waitPeer = (t: Transport, ms: number) =>
  new Promise<PeerId>((res, rej) => {
    const off = t.on((e) => {
      if (e.type === 'peerConnected') { off(); res(e.peer) }
    })
    setTimeout(() => rej(new Error('peer timeout')), ms)
  })

async function runBench(o: Opts) {
  const room = `bench-${Math.random().toString(36).slice(2, 10)}`
  const hWs = new WsTransport('host', room, o.wsBase)
  const cWs = new WsTransport('client', room, o.wsBase)
  let host: Transport = hWs, client: Transport = cWs
  if (o.path !== 'ws') {
    const mode = o.path === 'rtc-rel' ? 'reliable' : 'unreliable'
    const unreliableTypes = o.path === 'rtc-unrel-all' ? new Set([1, 2, 0xf1, 0xf2]) : undefined
    host = new RtcTransport('host', hWs, { mode, unreliableTypes, iceServers: [], fallbackMs: 20000, mapRemoteCandidate: synth(o.proxyIp, o.ua) })
    client = new RtcTransport('client', cWs, { mode, unreliableTypes, iceServers: [], fallbackMs: 20000, mapRemoteCandidate: synth(o.proxyIp, o.ub) })
  }
  const tConnect0 = now()
  const hp = waitPeer(host, 30000), cp = waitPeer(client, 30000)
  await host.start()
  await client.start()
  const guest = await hp
  await cp
  const connectMs = now() - tConnect0
  const via = o.path === 'ws' ? 'relay' : (host as RtcTransport).paths()[guest]

  const owd: number[] = [], arrivals: number[] = [], rtt: number[] = []
  let snapsSent = 0, pingsSent = 0, maxSeq = -1, reordered = 0, inputs = 0, events = 0
  const startT = now() + 2000
  const recording = () => now() >= startT

  host.on((e) => {
    if (e.type !== 'data') return
    const b = e.bytes
    if (b[0] === 0xf1) {
      const r = b.slice()
      r[0] = 0xf2
      void host.sendPacket(guest, r)
    } else if (b[0] === 2) inputs++
  })
  client.on((e) => {
    if (e.type !== 'data') return
    const b = e.bytes, v = new DataView(b.buffer, b.byteOffset)
    const t = v.getFloat64(5), seq = v.getUint32(1), at = now()
    if (b[0] === 1) {
      if (t < startT) return
      owd.push(at - t)
      arrivals.push(at)
      if (seq < maxSeq) reordered++
      maxSeq = Math.max(maxSeq, seq)
    } else if (b[0] === 0xf2) {
      if (t >= startT) rtt.push(at - t)
    } else if (b[0] === 17) events++
  })

  let hs = 0, cs = 0
  const hi = setInterval(() => {
    const t = now()
    if (t >= startT) snapsSent++
    void host.sendPacket(guest, pkt(1, hs, t, 262)).catch(() => {})
    if (hs % 3 === 0) void host.sendPacket(guest, pkt(17, hs, t, 80)).catch(() => {})
    hs++
  }, 100)
  const ci = setInterval(() => {
    const t = now()
    void client.sendPacket('host', pkt(2, cs, t, 24)).catch(() => {})
    if (cs % 3 === 0) {
      if (t >= startT) pingsSent++
      void client.sendPacket('host', pkt(0xf1, cs, t, 24)).catch(() => {})
    }
    cs++
  }, 100 / 3)

  await new Promise((r) => setTimeout(r, 2000 + o.durS * 1000))
  clearInterval(hi)
  clearInterval(ci)
  await new Promise((r) => setTimeout(r, 1500))
  await client.stop().catch(() => {})
  await host.stop().catch(() => {})

  const gaps = arrivals.slice(1).map((a, i) => a - arrivals[i]!)
  const minOwd = Math.min(...owd)
  const mean = owd.reduce((a, b) => a + b, 0) / owd.length
  const sd = Math.sqrt(owd.reduce((a, b) => a + (b - mean) ** 2, 0) / owd.length)
  return {
    path: o.path, via, connectMs: Math.round(connectMs),
    rttN: rtt.length, pingsSent, rttP50: r1(pct(rtt, 50)), rttP95: r1(pct(rtt, 95)), rttP99: r1(pct(rtt, 99)), rttMax: r1(Math.max(...rtt)),
    snapsSent, snapsGot: owd.length, snapLossPct: r1((100 * (snapsSent - owd.length)) / snapsSent), reordered,
    owdP50: r1(pct(owd, 50)), owdP95: r1(pct(owd, 95)), owdP99: r1(pct(owd, 99)), owdMax: r1(Math.max(...owd)), owdMin: r1(minOwd),
    jitterSd: r1(sd), jitterP95: r1(pct(owd, 95) - pct(owd, 50)),
    gapP95: r1(pct(gaps, 95)), gapMax: r1(Math.max(...gaps)), inputs, events,
  }
}

async function natProbe(urls: string[]) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls }] })
  pc.createDataChannel('x')
  const cands: string[] = []
  pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate) }
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise<void>((r) => {
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r() }
    setTimeout(r, 8000)
  })
  pc.close()
  return cands
}

Object.assign(window, { runBench, natProbe })
