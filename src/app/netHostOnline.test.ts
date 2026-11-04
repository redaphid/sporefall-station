import { describe, expect, it, vi } from 'vitest'
import { captureReproducible, StateRing } from '../debug/stateLink'
import { flush, LoopbackHub } from '../debug/loopback'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { encodeJson } from '../net/framing/codec'
import { frameMessage } from '../net/framing/chunkedStream'
import { MsgType, type Transport } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * The host half of online play, over the in-process loopback: the real
 * NetHostSession and NetClientSession, with the guest's transport marked
 * online so it pings. The world is the one the host session builds for its
 * run; nothing here authors one.
 */

const input = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })

const online = (t: Transport): Transport => ({ ...t, medium: 'online' })

const startCoop = async (guestInput: InputSource = input()) => {
  let clock = 1000
  const now = () => clock
  const hub = new LoopbackHub()
  const host = new NetHostSession(4242, 'Host', input(), hub.hostTransport, 'normal', now)
  const central = hub.addCentral()
  const guest = new NetClientSession('Guest', guestInput, online(central.transport), now)
  await host.start()
  await guest.start()
  central.connect()
  await flush()
  host.beginGame()
  await flush()
  expect(guest.phase).toBe('playing')
  const step = async (n: number, ms = 1000 / 30): Promise<void> => {
    for (let i = 0; i < n; i++) {
      clock += ms
      host.tick()
      guest.tick()
      await flush()
    }
  }
  return { host, guest, step, hub, advance: (ms: number) => (clock += ms) }
}

describe('NetHostSession answers pings', () => {
  it("a guest's ping gets its Pong back, so the guest measures a round trip", async () => {
    const { guest, step } = await startCoop()
    expect(guest.linkStatus().rttMs).toBeNull()
    await step(3)
    expect(guest.linkStatus().rttMs).not.toBeNull()
    expect(guest.linkStatus().rttMs).toBeGreaterThanOrEqual(0)
  })

  it("the host's chip shows the round trip its guest reports", async () => {
    const { host, guest, step } = await startCoop()
    expect(host.linkStatus().rttMs).toBeNull()
    await step(45)
    expect(host.linkStatus().rttMs).toBe(Math.round(guest.linkStatus().rttMs!))
    expect(host.linkStatus().health).toBe('good')
  })

  it("the host's chip warns when its guest has gone quiet", async () => {
    const { host, step, advance } = await startCoop()
    await step(3)
    advance(2500)
    host.tick()
    expect(host.linkStatus().health).toBe('degraded')
  })
})

describe('NetHostSession hangs up on players it refuses', () => {
  it('a version mismatch is rejected and then dropped from the transport', async () => {
    const hub = new LoopbackHub()
    const drop = vi.fn(async () => {})
    const host = new NetHostSession(4242, 'Host', input(), { ...hub.hostTransport, drop }, 'normal')
    await host.start()
    const central = hub.addCentral()
    central.connect()
    await flush()
    for (const bytes of frameMessage(encodeJson(MsgType.Hello, { v: 0, name: 'Old' }), 180))
      await central.transport.sendPacket('host', bytes)
    await flush()
    expect(drop).toHaveBeenCalledWith('central-1')
    expect(host.lobbyPlayers()).toHaveLength(1)
  })

  it('an admitted player is never dropped', async () => {
    const hub = new LoopbackHub()
    const drop = vi.fn(async () => {})
    const host = new NetHostSession(4242, 'Host', input(), { ...hub.hostTransport, drop }, 'normal')
    const central = hub.addCentral()
    const guest = new NetClientSession('Guest', input(), central.transport)
    await host.start()
    await guest.start()
    central.connect()
    await flush()
    expect(host.lobbyPlayers()).toHaveLength(2)
    expect(drop).not.toHaveBeenCalled()
  })
})

describe('an online host shares a two-player moment', () => {
  it("records the guest's commands, so the share replays green with both players", async () => {
    const { host, step } = await startCoop(input({ moveX: 1, moveY: 0.3 }))
    const ring = new StateRing(host.world)
    let pending: Map<number, InputCmd> | undefined
    host.onTickInputs = (inputs) => {
      pending = new Map([...inputs].map(([slot, cmd]) => [slot, { ...cmd }]))
    }
    const guestAvatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
    const from = { ...guestAvatar.pos }
    for (let i = 0; i < 60; i++) {
      await step(1)
      if (pending) ring.observe(host.world, pending)
      pending = undefined
    }
    expect(Math.hypot(guestAvatar.pos.x - from.x, guestAvatar.pos.y - from.y)).toBeGreaterThan(0.5)

    const out = captureReproducible(host.world, { note: 'online' }, ring.rewind())
    expect(out.runUpDropped).toBeUndefined()
    expect(out.check.ok).toBe(true)
    expect(out.check.rewindTicks).toBeGreaterThanOrEqual(30)
    expect(out.payload.world.entities.filter((e) => e.playerCtl)).toHaveLength(2)
  })
})
