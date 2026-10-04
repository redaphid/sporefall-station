import { describe, expect, it } from 'vitest'
import { walledRoom, worldFromRows } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { FakeRtcNet } from '../net/transport/fakeRtc'
import { RtcTransport, type RtcOptions } from '../net/transport/rtcTransport'
import { Hub } from '../net/transport/testRelay'
import { WsTransport } from '../net/transport/wsTransport'
import type { Transport } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * Online sessions over the real transports: NetHost/NetClientSession on
 * RtcTransport on WsTransport, through the relay planner the Durable Object runs
 * (testRelay.ts) and a fake WebRTC network that can fail the ways real ones do.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const FAST: RtcOptions = { iceTimeoutMs: 60, silenceMs: 150, heartbeatMs: 20 }

/** Walks right, and taps attack (press one tick, release) every `every` ticks, 100 times. */
const tapper = (every: number) => {
  let t = 0
  let taps = 0
  const src: InputSource = {
    sample: (): InputCmd => {
      t++
      const tap = t % every === 0 && taps < 100
      if (tap) taps++
      return { ...emptyInput(), moveX: 1, attack: tap }
    },
  }
  return { src, taps: () => taps }
}

const rig = async (opts: { net?: FakeRtcNet; rtc?: RtcOptions | false; input?: InputSource } = {}) => {
  const hub = new Hub()
  const net = opts.net ?? new FakeRtcNet()
  const wrap = (role: 'host' | 'client'): Transport => {
    const ws = new WsTransport(role, 'room', 'ws://x/ws', hub.connect)
    return opts.rtc === false ? ws : new RtcTransport(ws, { ...FAST, makePeerConnection: net.makePeerConnection, ...opts.rtc })
  }
  const hostT = wrap('host')
  const clientT = wrap('client')
  const host = new NetHostSession(3, 'Host', { sample: () => emptyInput() }, hostT, 'casual', () => performance.now(), (seed, mode) =>
    worldFromRows(walledRoom(40, 12), { seed, mode, hostile: false }),
  )
  const client = new NetClientSession('Guest', opts.input ?? { sample: () => ({ ...emptyInput(), moveX: 1 }) }, clientT)
  await host.start()
  await client.start()
  await wait(opts.net?.blocked ? 120 : 20)
  host.beginGame()
  await wait(20)
  /** Host commands for the guest, one per host tick. */
  const ran: InputCmd[] = []
  host.onTickInputs = (inputs) => {
    const cmd = inputs.get(1)
    if (cmd) ran.push({ ...cmd })
  }
  const play = async (ticks: number): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      client.tick()
      host.tick()
      await wait(0)
    }
    await wait(5)
  }
  const stop = async () => {
    await client.close()
    await host.close()
  }
  return { host, client, hostT, clientT, net, ran, play, stop }
}

const risingEdges = (cmds: InputCmd[]): number => cmds.filter((c, i) => c.attack && !(cmds[i - 1]?.attack ?? false)).length

describe('online play over WebRTC with the relay as fallback', () => {
  it('plays peer to peer, and the link chip says so', async () => {
    const r = await rig()
    await r.play(60)
    expect(r.client.phase).toBe('playing')
    expect(r.client.renderView().simTick).toBeGreaterThan(50)
    expect(r.client.linkStatus().path).toBe('p2p')
    expect(r.host.linkStatus().path).toBe('p2p')
    expect(r.net.sent.unreliable).toBeGreaterThan(30)
    await r.stop()
  })

  it('joins and plays over the relay when ICE fails', async () => {
    const net = new FakeRtcNet()
    net.blocked = true
    const r = await rig({ net })
    await r.play(60)
    expect(r.client.phase).toBe('playing')
    expect(r.client.renderView().simTick).toBeGreaterThan(50)
    expect(r.client.linkStatus().path).toBe('relay')
    expect(r.net.sent.unreliable + r.net.sent.reliable).toBe(0)
    await r.stop()
  })

  it('keeps the run going when the direct link dies mid-game', async () => {
    const r = await rig()
    await r.play(60)
    const avatar = r.client.renderView().self!
    const xBefore = avatar.pos.x
    const tickBefore = r.client.renderView().simTick!
    const invBefore = r.host.debugInventorySends
    r.net.kill()
    await r.play(90)
    expect(r.client.phase).toBe('playing')
    expect(r.client.linkStatus().path).toBe('relay')
    expect(r.client.renderView().simTick! - tickBefore).toBeGreaterThan(80)
    expect(r.client.renderView().self).toBe(avatar)
    expect(avatar.pos.x).toBeGreaterThan(xBefore + 3)
    expect(r.host.peersBySlot.size).toBe(1)
    expect(r.host.debugInventorySends).toBeGreaterThan(invBefore)
    await r.stop()
  })

  it('keeps the run going when the direct link goes silent mid-game', async () => {
    const r = await rig()
    await r.play(30)
    r.net.silent = true
    await wait(250)
    await r.play(60)
    expect(r.client.phase).toBe('playing')
    expect(r.client.linkStatus().path).toBe('relay')
    expect(r.client.renderView().simTick).toBeGreaterThan(80)
    await r.stop()
  })

  it('loses no input at 5% datagram loss: every tap fires once', async () => {
    const net = new FakeRtcNet()
    net.lossRate = 0.05
    const input = tapper(9)
    const r = await rig({ net, input: input.src })
    await r.play(960)
    expect(r.client.linkStatus().path).toBe('p2p')
    expect(input.taps()).toBe(100)
    expect(risingEdges(r.ran)).toBe(input.taps())
    await r.stop()
  })

  it('a tap sent without the repeats is lost at the same loss, so the repeats are what save it', async () => {
    const net = new FakeRtcNet()
    net.lossRate = 0.05
    const input = tapper(9)
    const r = await rig({ net, input: input.src })
    r.client.inputRedundancy = 1
    await r.play(960)
    expect(risingEdges(r.ran)).toBeLessThan(input.taps())
    await r.stop()
  })

  it('plays over a plain relay transport exactly as before', async () => {
    const r = await rig({ rtc: false })
    await r.play(60)
    expect(r.client.phase).toBe('playing')
    expect(r.client.renderView().simTick).toBeGreaterThan(50)
    expect(r.client.linkStatus().path).toBeUndefined()
    await r.stop()
  })

  it('plays over the relay with p2p off', async () => {
    const r = await rig({ rtc: { p2p: false } })
    await r.play(60)
    expect(r.client.phase).toBe('playing')
    expect(r.client.linkStatus().path).toBe('relay')
    expect(r.net.pcs).toHaveLength(0)
    await r.stop()
  })
})
