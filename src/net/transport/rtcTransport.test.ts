import { describe, expect, it } from 'vitest'
import type { PeerId, TransportEvent } from '../types'
import { FakeRtcNet } from './fakeRtc'
import { MAX_DATAGRAM, RtcTransport, type RtcOptions } from './rtcTransport'
import { Hub } from './testRelay'
import { WsTransport } from './wsTransport'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FAST: RtcOptions = { iceTimeoutMs: 60, silenceMs: 120, heartbeatMs: 20 }

const setup = async (opts: { net?: FakeRtcNet; host?: RtcOptions; client?: RtcOptions; relayMs?: number } = {}) => {
  const hub = new Hub(opts.relayMs)
  const net = opts.net ?? new FakeRtcNet()
  const relayFrames = { count: 0 }
  const make = (role: 'host' | 'client', o: RtcOptions = {}) => {
    const ws = new WsTransport(role, 'room', 'ws://x/ws', hub.connect)
    const send = ws.sendPacket.bind(ws)
    ws.sendPacket = (peer, bytes) => {
      relayFrames.count++
      return send(peer, bytes)
    }
    return new RtcTransport(ws, { ...FAST, makePeerConnection: net.makePeerConnection, ...o })
  }
  const host = make('host', opts.host)
  const client = make('client', opts.client)
  const hostEvents: TransportEvent[] = []
  const clientEvents: TransportEvent[] = []
  host.on((e) => hostEvents.push(e))
  client.on((e) => clientEvents.push(e))
  await host.start()
  await client.start()
  const guest = (): PeerId => {
    const e = hostEvents.find((x) => x.type === 'peerConnected')
    if (e?.type !== 'peerConnected') throw new Error('the host never saw the guest')
    return e.peer
  }
  const stop = async () => {
    await client.stop()
    await host.stop()
  }
  return { net, host, client, hostEvents, clientEvents, guest, relayFrames, stop }
}

const dataOf = (events: TransportEvent[]) =>
  events.flatMap((e) => (e.type === 'data' ? [{ bytes: [...e.bytes], datagram: e.datagram === true }] : []))

describe('RtcTransport', () => {
  it('opens a direct link and carries both lanes over it, not the relay', async () => {
    const t = await setup()
    await wait(10)
    expect(t.clientEvents).toContainEqual({ type: 'peerConnected', peer: 'host' })
    const guest = t.guest()
    expect(t.host.pathOf(guest)).toBe('p2p')
    expect(t.client.pathOf('host')).toBe('p2p')
    const relayBefore = t.relayFrames.count
    await t.client.sendPacket('host', new Uint8Array([1, 2, 3]))
    expect(t.host.sendDatagram(guest, new Uint8Array([9, 8]))).toBe(true)
    await wait(5)
    expect(dataOf(t.hostEvents)).toContainEqual({ bytes: [1, 2, 3], datagram: false })
    expect(dataOf(t.clientEvents)).toContainEqual({ bytes: [9, 8], datagram: true })
    expect(t.relayFrames.count).toBe(relayBefore)
    expect(t.host.pairs()[guest]).toEqual({ local: 'host', remote: 'host', rttMs: 2 })
    await t.stop()
  })

  it('plays over the relay when ICE never connects, after the deadline and not before', async () => {
    const net = new FakeRtcNet()
    net.blocked = true
    const t = await setup({ net })
    await wait(20)
    expect(t.clientEvents.filter((e) => e.type === 'peerConnected')).toHaveLength(0)
    await wait(80)
    const guest = t.guest()
    expect(t.host.pathOf(guest)).toBe('relay')
    expect(t.client.pathOf('host')).toBe('relay')
    expect(t.host.sendDatagram(guest, new Uint8Array([7]))).toBe(false)
    await t.host.sendPacket(guest, new Uint8Array([4, 5]))
    await wait(5)
    expect(dataOf(t.clientEvents)).toEqual([{ bytes: [4, 5], datagram: false }])
    await t.stop()
  })

  it('goes straight to the relay with p2p off, and tells the other side', async () => {
    const t = await setup({ host: { p2p: false, iceTimeoutMs: 10_000 }, client: { iceTimeoutMs: 10_000 } })
    await wait(10)
    expect(t.host.pathOf(t.guest())).toBe('relay')
    expect(t.client.pathOf('host')).toBe('relay')
    expect(t.net.pcs).toHaveLength(0)
    await t.stop()
  })

  it('switches a live peer to the relay when the channels die, without dropping it', async () => {
    const t = await setup()
    await wait(10)
    const guest = t.guest()
    t.net.kill()
    await wait(10)
    expect(t.hostEvents).toContainEqual({ type: 'pathChanged', peer: guest, path: 'relay' })
    expect(t.clientEvents).toContainEqual({ type: 'pathChanged', peer: 'host', path: 'relay' })
    expect([...t.hostEvents, ...t.clientEvents].some((e) => e.type === 'peerDisconnected')).toBe(false)
    await t.client.sendPacket('host', new Uint8Array([6]))
    await wait(5)
    expect(dataOf(t.hostEvents).at(-1)).toEqual({ bytes: [6], datagram: false })
    await t.stop()
  })

  it('switches to the relay when a link goes silent with its channels still open', async () => {
    const t = await setup()
    await wait(10)
    t.net.silent = true
    await wait(60)
    expect(t.client.pathOf('host')).toBe('p2p')
    await wait(150)
    expect(t.client.pathOf('host')).toBe('relay')
    expect(t.host.pathOf(t.guest())).toBe('relay')
    await t.stop()
  })

  it('keeps an idle link alive with heartbeats the session never sees', async () => {
    const t = await setup()
    await wait(300)
    expect(t.client.pathOf('host')).toBe('p2p')
    expect(dataOf(t.clientEvents)).toEqual([])
    expect(dataOf(t.hostEvents)).toEqual([])
    await t.stop()
  })

  it('never fragments a datagram: an oversized one is refused for the reliable lane', async () => {
    const t = await setup()
    await wait(10)
    expect(t.host.sendDatagram(t.guest(), new Uint8Array(MAX_DATAGRAM))).toBe(true)
    expect(t.host.sendDatagram(t.guest(), new Uint8Array(MAX_DATAGRAM + 1))).toBe(false)
    await t.stop()
  })

  it('reports a relay drop as the peer leaving, with the relay reason', async () => {
    const t = await setup()
    await wait(10)
    await t.host.stop()
    await wait(10)
    expect(t.clientEvents).toContainEqual({ type: 'peerDisconnected', peer: 'host', reason: 'left' })
    await t.client.stop()
  })

  it('ignores relay frames it does not understand', async () => {
    const t = await setup()
    await wait(10)
    const ws = (t.client as unknown as { relay: WsTransport }).relay
    await ws.sendPacket('host', new Uint8Array([1, 0x7b, 0x7d]))
    await ws.sendPacket('host', new Uint8Array([1, 0xff]))
    await ws.sendPacket('host', new Uint8Array([9, 9, 9]))
    await wait(10)
    expect(t.host.pathOf(t.guest())).toBe('p2p')
    expect(dataOf(t.hostEvents)).toEqual([])
    await t.stop()
  })

  it('goes back to a direct link after a blip, without dropping the peer', async () => {
    const t = await setup({ host: { retryDelaysMs: [300] } })
    await wait(10)
    const guest = t.guest()
    t.net.silent = true
    await wait(200)
    expect(t.host.pathOf(guest)).toBe('relay')
    expect(t.client.pathOf('host')).toBe('relay')
    t.net.silent = false
    await wait(400)
    expect(t.host.pathOf(guest)).toBe('p2p')
    expect(t.client.pathOf('host')).toBe('p2p')
    expect(t.hostEvents.filter((e) => e.type === 'pathChanged').map((e) => e.type === 'pathChanged' && e.path)).toEqual(['relay', 'p2p'])
    expect([...t.hostEvents, ...t.clientEvents].some((e) => e.type === 'peerDisconnected')).toBe(false)
    expect(t.host.sendDatagram(guest, new Uint8Array([3]))).toBe(true)
    await t.stop()
  })

  it('backs off between retries while the direct path stays blocked, then takes it when it clears', async () => {
    const t = await setup({ host: { retryDelaysMs: [50, 150, 400] } })
    await wait(10)
    const guest = t.guest()
    t.net.kill()
    t.net.blocked = true
    const pcsAt = (ms: number) => wait(ms).then(() => t.net.pcs.length)
    const before = t.net.pcs.length
    // Each attempt opens one pc per side; attempts land at about 50, 50+60+150, ...
    expect(await pcsAt(80)).toBe(before + 2)
    expect(await pcsAt(120)).toBe(before + 2)
    expect(await pcsAt(150)).toBe(before + 4)
    t.net.blocked = false
    await wait(700)
    expect(t.host.pathOf(guest)).toBe('p2p')
    expect(t.client.pathOf('host')).toBe('p2p')
    await t.stop()
  })

  it('keeps the reliable stream in order across a switch down to the relay and back up', async () => {
    const t = await setup({ relayMs: 15, host: { retryDelaysMs: [150] } })
    await wait(60)
    const guest = t.guest()
    expect(t.host.pathOf(guest)).toBe('p2p')
    let n = 0
    const pump = setInterval(() => {
      const v = n++
      void t.host.sendPacket(guest, new Uint8Array([v & 0xff, v >> 8])).catch(() => {})
    }, 2)
    await wait(30)
    t.net.silent = true
    await wait(180)
    expect(t.host.pathOf(guest)).toBe('relay')
    const sentOnRelayFrom = n
    t.net.silent = false
    await wait(300)
    expect(t.host.pathOf(guest)).toBe('p2p')
    await wait(40)
    clearInterval(pump)
    await wait(60)
    const got = dataOf(t.clientEvents).map((d) => d.bytes[0] | (d.bytes[1] << 8))
    // Messages sent into the silent link are lost. Everything sent from the
    // switch to the relay on arrives, once, and nothing is ever out of order.
    for (let i = 1; i < got.length; i++) expect(got[i], `message ${i}`).toBeGreaterThan(got[i - 1])
    const seen = new Set(got)
    for (let v = sentOnRelayFrom; v < n; v++) expect(seen.has(v), `message ${v}`).toBe(true)
    await t.stop()
  })
})
