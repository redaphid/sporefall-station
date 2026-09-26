// Sequenced mods over the co-op link: a client's reorder reaches the host as an
// input, and the client's HUD reads the host's own castIndex/recharge
// (InventoryMsg), never a local copy.
//
// The host is the ship's quartermaster here; the client is the night-shift tech
// who keeps asking why the cryo rounds come out first.

import { describe, expect, it } from 'vitest'
import { worldDigest } from '../debug/worldDigest'
import type { WeaponMod } from '../game/entity'
import { packModSwap } from '../game/systems/modSequence'
import { weaponStack } from '../game/systems/inventory'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { decodeInput, encodeInput } from '../net/protocol/messages'
import type { PeerId, Transport, TransportEvent } from '../net/types'
import { buildSequence } from '../ui/sequenceModel'
import { HostSession } from './hostSession'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

class MockHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    const deliver = (fn: (() => void) | undefined): Promise<void> => Promise.resolve().then(() => fn?.())
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer: PeerId, bytes: Uint8Array) => deliver(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  private deliverToHost(peer: PeerId, bytes: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes }))
  }

  addClient(
    name: string,
    input: InputSource,
  ): { session: NetClientSession; connect: () => void; drop: () => void; peer: PeerId } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) => void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })))
    const clientTransport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) => this.deliverToHost(peer, bytes),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, clientTransport)
    const connect = (): void => {
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
    }
    const drop = (): void => {
      this.centrals.delete(peer)
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
      void Promise.resolve().then(() => clientHandler?.({ type: 'peerDisconnected', peer: 'host', reason: 'remote' }))
    }
    return { session, connect, drop, peer }
  }

}

const makeInput = (): { source: InputSource; set: (c: Partial<InputCmd>) => void } => {
  let cur = emptyInput()
  return {
    source: { sample: () => ({ ...cur }) },
    set: (c) => {
      cur = { ...emptyInput(), ...c }
    },
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const LOCKER_7: WeaponMod[] = [
  { id: 'overload', stacks: 1 },
  { id: 'frost', stacks: 1 },
  { id: 'incendiary', stacks: 1 },
  { id: 'shock', stacks: 1 },
]

const startPair = async (seed: number, clientInput: InputSource) => {
  const hub = new MockHub()
  const host = new NetHostSession(seed, 'Quartermaster', makeInput().source, hub.hostTransport, 'normal')
  const bob = hub.addClient('NightShift', clientInput)
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
  weaponStack(avatar)!.mods = LOCKER_7.map((m) => ({ ...m }))
  avatar.health!.iframes = 99999 // keep the tech alive through a long test
  return { host, bob, avatar }
}

const step = async (host: NetHostSession, bob: ReturnType<MockHub['addClient']>, n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) {
    host.tick()
    bob.session.tick()
    await flush()
  }
}

describe('sequenced mods over co-op', () => {
  it("the client's view carries the host tick its recharge bar is measured against", async () => {
    const { host, bob } = await startPair(301, makeInput().source)
    await step(host, bob, 2)
    expect(bob.session.renderView().simTick).toBe(host.world.tick)
  })

  it("the client's HUD shows the host's castIndex and recharge on every tick of a firefight", async () => {
    const input = makeInput()
    const { host, bob, avatar } = await startPair(303, input.source)
    await step(host, bob, 2)
    input.set({ attack: true, aimX: 1, aimY: 0 })
    let sawWrap = false
    let sawAdvance = false
    for (let t = 0; t < 150; t++) {
      await step(host, bob)
      const hostStack = weaponStack(avatar)!
      const clientStack = weaponStack(bob.session.renderView().self!)!
      expect(clientStack.castIndex).toBe(hostStack.castIndex)
      expect(clientStack.rechargeUntil).toBe(hostStack.rechargeUntil)
      if ((hostStack.castIndex ?? 0) > 0) sawAdvance = true
      if (hostStack.rechargeUntil !== undefined) sawWrap = true
      // The strip the client draws marks the same cast as the host's own model.
      const view = bob.session.renderView()
      const clientModel = buildSequence(view.self, view.simTick ?? view.tick)!
      const hostModel = buildSequence(avatar, host.world.tick)!
      expect(clientModel.entries.map((e) => e.next)).toEqual(hostModel.entries.map((e) => e.next))
      expect(clientModel.rechargeLeft).toBe(hostModel.rechargeLeft)
    }
    expect(sawAdvance).toBe(true)
    expect(sawWrap).toBe(true)
  })

  it("a client's reorder arrives at the host as an input and comes back in its inventory", async () => {
    const input = makeInput()
    const { host, bob, avatar } = await startPair(304, input.source)
    await step(host, bob, 2)
    input.set({ modSwap: packModSwap(1, 3) })
    await step(host, bob, 2)
    input.set({})
    await step(host, bob, 3)
    const order = ['overload', 'shock', 'incendiary', 'frost']
    expect(weaponStack(avatar)!.mods!.map((m) => m.id)).toEqual(order)
    expect(weaponStack(bob.session.renderView().self!)!.mods!.map((m) => m.id)).toEqual(order)
  })
})

describe('input wire: the reorder tail is additive', () => {
  const base: InputCmd = { ...emptyInput(), seq: 42, attack: true, hotbar: 1, aimX: 0, aimY: 1 }
  const edges = { attack: true, interact: false, special: false }

  it('a command without a swap encodes exactly as before (no tail)', () => {
    const plain = encodeInput(base, edges)
    expect(plain.length).toBe(9)
    expect(decodeInput(plain).cmd.modSwap).toBeUndefined()
  })

  it('a swap appends two bytes after the unchanged legacy body, and round-trips', () => {
    const plain = encodeInput(base, edges)
    const withSwap = encodeInput({ ...base, modSwap: packModSwap(2, 5) }, edges)
    expect(withSwap.length).toBe(plain.length + 2)
    expect([...withSwap.subarray(0, plain.length)]).toEqual([...plain])
    const { cmd } = decodeInput(withSwap)
    expect(cmd.modSwap).toBe(packModSwap(2, 5))
    expect(cmd.hotbar).toBe(1)
  })

  it('swap 0<->0 packs to 0 and still survives the +1 bias', () => {
    expect(decodeInput(encodeInput({ ...base, modSwap: 0 }, edges)).cmd.modSwap).toBe(0)
  })

  it('a truncated tail (one stray byte) is ignored, not misread', () => {
    const plain = encodeInput(base, edges)
    const odd = new Uint8Array([...plain, 7])
    expect(decodeInput(odd).cmd.modSwap).toBeUndefined()
  })
})

describe('determinism', () => {
  /** Hold fire, sweep aim, and reorder every 41st tick. */
  const script = (t: number): InputCmd => {
    const a = t * 0.05
    const cmd: InputCmd = { ...emptyInput(), seq: t, attack: true, aimX: Math.cos(a), aimY: Math.sin(a) }
    if (t % 41 === 0) cmd.modSwap = packModSwap(t % 4, (t + 2) % 4)
    return cmd
  }
  const scripted = (): InputSource => {
    let t = 0
    return { sample: () => script(++t) }
  }

  const soloRun = (seed: number, ticks: number): HostSession => {
    const s = new HostSession(seed, scripted(), undefined, 'normal')
    weaponStack(s.self)!.mods = LOCKER_7.map((m) => ({ ...m }))
    s.self.health!.iframes = 99999
    for (let i = 0; i < ticks; i++) s.tick()
    return s
  }

  it('the same seed and inputs give identical world digests, twice over', () => {
    const a = soloRun(4242, 500)
    const b = soloRun(4242, 500)
    expect(worldDigest(a.world)).toBe(worldDigest(b.world))
    expect(weaponStack(a.self)!.castIndex).toBeDefined()
  })

  it('host and a replaying peer agree: a second host fed the same inputs reaches the same digest', async () => {
    // The co-op client does not simulate combat (it renders the host), so the
    // host-vs-client check for SIM state is: an independent host fed the exact
    // per-tick commands the first one consumed lands on the same world.
    const first = new HostSession(777, scripted(), undefined, 'normal')
    weaponStack(first.self)!.mods = LOCKER_7.map((m) => ({ ...m }))
    const log: InputCmd[] = []
    first.onTickInputs = (inputs) => log.push({ ...inputs.get(0)! })
    for (let i = 0; i < 300; i++) first.tick()
    let k = 0
    const replay = new HostSession(777, { sample: () => ({ ...log[k++] }) }, undefined, 'normal')
    weaponStack(replay.self)!.mods = LOCKER_7.map((m) => ({ ...m }))
    for (let i = 0; i < 300; i++) replay.tick()
    expect(worldDigest(replay.world)).toBe(worldDigest(first.world))
  })
})
