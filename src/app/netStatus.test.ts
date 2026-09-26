import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { addStatus, removeStatus } from '../game/systems/statusFx'
import { emptyInput } from '../game/types'
import type { InputSource } from '../input/input'
import type { PeerId, Transport, TransportEvent } from '../net/types'
import { composeStatus } from '../render/statusUniforms'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * Element statuses (Entity.fx: frozen/burning/wet/...) are what the renderer
 * reads to tint a body and clad it in a status shader (sprites.ts elementTint,
 * statusShaders.ts composeStatus). On a co-op client the only source of an
 * entity is the host snapshot, so if fx is not on the wire the joiner sees
 * every frozen or burning enemy as untouched.
 *
 * Drives the real NetHostSession -> encodeSnapshot -> loopback -> decodeSnapshot
 * -> NetClientSession path, then asks the renderer's own composer what it draws.
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

const stubInput = (): InputSource => ({ sample: () => emptyInput() })

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const coop = async (): Promise<{ host: NetHostSession; bob: NetClientSession; step: (n: number) => Promise<void>; near: () => { x: number; y: number } }> => {
  const hub = new Hub()
  const host = new NetHostSession(4242, 'Alice', stubInput(), hub.hostTransport)
  const bob = hub.addClient('Bob', stubInput())
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
  return {
    host,
    bob: bob.session,
    near: () => ({ x: avatar.pos.x + 2, y: avatar.pos.y }),
    step: async (n) => {
      for (let i = 0; i < n; i++) {
        host.tick()
        bob.session.tick()
        await flush()
      }
    },
  }
}

const drawnStatuses = (bob: NetClientSession, id: number): string[] => {
  const e = bob.renderView().entities.find((x) => x.id === id)
  expect(e, `client never received entity ${id}`).toBeDefined()
  return composeStatus(e!.fx, () => undefined).quads.map((q) => q.statusId)
}

describe('element statuses reach a co-op client', () => {
  it('a frozen, burning enemy on the host is drawn frozen and burning on the client', async () => {
    const { host, bob, step, near } = await coop()
    const p = near()
    const npc = spawnNpc(host.world, 'thug', p.x, p.y)
    addStatus(host.world, npc, 'frozen', 300)
    addStatus(host.world, npc, 'burning', 300)
    await step(6)
    expect(Object.keys(host.world.byId.get(npc.id)!.fx ?? {}).sort()).toEqual(['burning', 'frozen'])
    expect(drawnStatuses(bob, npc.id)).toEqual(['burning', 'frozen'])
  })

  it('every element kind survives the trip, and an unstatused bystander draws none', async () => {
    const { host, bob, step, near } = await coop()
    const p = near()
    // One body per kind: #87 makes elements interact on one body (wet douses
    // burning, a panic blocks a freeze), and this test is about the wire.
    const kinds = ['burning', 'electrified', 'frozen', 'poisoned', 'spore', 'wet']
    const hits = kinds.map((_, i) => spawnNpc(host.world, 'thug', p.x + (i % 3) - 1, p.y - 1 - Math.floor(i / 3)))
    const bystander = spawnNpc(host.world, 'thug', p.x, p.y + 1)
    await step(1)
    kinds.forEach((k, i) => addStatus(host.world, hits[i], k, 300))
    await step(6)
    for (const [i, k] of kinds.entries()) {
      expect(Object.keys(host.world.byId.get(hits[i].id)!.fx!), k).toEqual([k])
      expect(drawnStatuses(bob, hits[i].id), k).toEqual([k])
    }
    expect(drawnStatuses(bob, bystander.id)).toEqual([])
  })

  it('a status that ends on the host stops drawing on the client (no phantom)', async () => {
    const { host, bob, step, near } = await coop()
    const p = near()
    const npc = spawnNpc(host.world, 'thug', p.x, p.y)
    addStatus(host.world, npc, 'wet', 300)
    addStatus(host.world, npc, 'poisoned', 300)
    await step(6)
    expect(drawnStatuses(bob, npc.id)).toEqual(['poisoned', 'wet'])
    removeStatus(npc, 'wet')
    await step(6)
    expect(drawnStatuses(bob, npc.id)).toEqual(['poisoned'])
    removeStatus(npc, 'poisoned')
    await step(6)
    expect(drawnStatuses(bob, npc.id)).toEqual([])
  })
})
