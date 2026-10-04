import { describe, expect, it } from 'vitest'
import type { Entity } from '../game/entity'
import { addStatus } from '../game/systems/statusFx'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import * as messages from '../net/protocol/messages'
import type { PeerId, Transport, TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * A stunned, asleep, or frozen joiner must not predict walking. The host sim
 * refuses the move, so a phone that predicts it anyway walks the avatar off and
 * then gets rubber-banded back by the next snapshot, which reads as lag.
 *
 * Drives the real NetHostSession -> encodeSnapshot -> loopback -> decodeSnapshot
 * -> NetClientSession path with the client holding a move stick the whole time.
 */

class Hub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer: PeerId, bytes: Uint8Array) => Promise.resolve().then(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) => void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })))
    const clientTransport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) => Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes })),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, clientTransport)
    return {
      session,
      connect: () => {
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
      },
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

interface Trace {
  /** Farthest the client's predicted self got from the host's authoritative avatar. */
  maxDrift: number
  /** Largest single-tick jump of the predicted self: the rubber-band snap. */
  maxSnap: number
  /** Net distance the predicted self travelled over the window. */
  travelled: number
}

const coop = async () => {
  const hub = new Hub()
  const stick: InputCmd = emptyInput()
  const host = new NetHostSession(4242, 'Alice', { sample: () => emptyInput() }, hub.hostTransport)
  const bob = hub.addClient('Bob', { sample: () => ({ ...stick }) })
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  const avatar: Entity = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
  const predicted = (): { x: number; y: number } => {
    const e = bob.session.renderView().entities.find((x) => x.id === avatar.id)
    expect(e, 'client never bound its own avatar').toBeDefined()
    return { x: e!.pos.x, y: e!.pos.y }
  }
  const step = async (n: number): Promise<Trace> => {
    const start = predicted()
    let prev = start
    let maxDrift = 0
    let maxSnap = 0
    for (let i = 0; i < n; i++) {
      host.tick()
      bob.session.tick()
      await flush()
      const p = predicted()
      maxDrift = Math.max(maxDrift, Math.hypot(p.x - avatar.pos.x, p.y - avatar.pos.y))
      maxSnap = Math.max(maxSnap, Math.hypot(p.x - prev.x, p.y - prev.y))
      prev = p
    }
    return { maxDrift, maxSnap, travelled: Math.hypot(prev.x - start.x, prev.y - start.y) }
  }
  for (let i = 0; i < 10; i++) {
    host.tick()
    bob.session.tick()
    await flush()
  }
  return { host, avatar, stick, step }
}

/** Hold the stick toward whichever cardinal the host lets the avatar walk
 * farthest, so a walk-blocking wall can't make an immobilize test pass. */
let open: Promise<[number, number]> | undefined
const openDirection = (): Promise<[number, number]> => (open ??= measureOpenDirection())
const measureOpenDirection = async (): Promise<[number, number]> => {
  let best: [number, number] = [1, 0]
  let bestDist = -1
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    const { avatar, stick, step } = await coop()
    const x0 = avatar.pos.x
    const y0 = avatar.pos.y
    stick.moveX = dx
    stick.moveY = dy
    await step(30)
    const d = Math.hypot(avatar.pos.x - x0, avatar.pos.y - y0)
    if (d > bestDist) {
      bestDist = d
      best = [dx, dy]
    }
  }
  return best
}

const frozenOnWire = 'WIRE_STATUSES' in messages

describe('client prediction honours the host immobilize rule', () => {
  it('control: a free joiner holding the stick walks, and prediction tracks the host', async () => {
    const [dx, dy] = await openDirection()
    const { stick, step } = await coop()
    stick.moveX = dx
    stick.moveY = dy
    const t = await step(40)
    expect(t.travelled).toBeGreaterThan(2)
  })

  const immobilizers: [string, (w: Awaited<ReturnType<typeof coop>>) => void][] = [
    ['stun', ({ avatar }) => void (avatar.status!.stun = 600)],
    ['sleep', ({ avatar }) => void (avatar.status!.sleep = 600)],
  ]

  for (const [name, apply] of immobilizers) {
    it(`an immobilized (${name}) joiner holding the stick does not drift and snap back`, async () => {
      const [dx, dy] = await openDirection()
      const s = await coop()
      apply(s)
      await s.step(6)
      s.stick.moveX = dx
      s.stick.moveY = dy
      const t = await s.step(60)
      expect(t, `${name}: predicted self walked off the stationary host avatar`).toEqual({
        maxDrift: expect.closeTo(0, 3),
        maxSnap: expect.closeTo(0, 3),
        travelled: expect.closeTo(0, 3),
      })
    })
  }

  it.runIf(frozenOnWire)('a frozen joiner holding the stick does not drift and snap back', async () => {
    const [dx, dy] = await openDirection()
    const s = await coop()
    addStatus(s.host.world, s.avatar, 'frozen', 600)
    await s.step(6)
    s.stick.moveX = dx
    s.stick.moveY = dy
    const t = await s.step(60)
    expect(t).toEqual({ maxDrift: expect.closeTo(0, 3), maxSnap: expect.closeTo(0, 3), travelled: expect.closeTo(0, 3) })
  })

  it('once the stun wears off on the host, the held stick walks again', async () => {
    const [dx, dy] = await openDirection()
    const s = await coop()
    s.avatar.status!.stun = 20
    await s.step(4)
    s.stick.moveX = dx
    s.stick.moveY = dy
    await s.step(40)
    const t = await s.step(30)
    expect(t.travelled).toBeGreaterThan(1.5)
  })
})
