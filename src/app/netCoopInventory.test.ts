import { describe, expect, it } from 'vitest'
import type { ItemStack } from '../game/entity'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { decodeJson, encodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import { type InventoryMsg } from '../net/protocol/messages'
import { MsgType, PROTOCOL_VERSION, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * Loopback transport (same shape as netCoop.test.ts) — one host peripheral, N
 * connecting centrals — so we can prove the CLIENT gets its OWN authoritative
 * inventory (slots / activeSlot / per-weapon mods / ammo) and can switch weapons.
 */
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

  /** A raw central that collects host messages, for handshake/rejoin edge cases. */
  addRawCentral(): { connect: () => void; send: (msg: Uint8Array) => void; received: () => Uint8Array[]; drop: () => void; peer: PeerId } {
    const peer: PeerId = `raw-${this.centrals.size + 1}`
    const reader = new StreamReader()
    const messages: Uint8Array[] = []
    this.centrals.set(peer, (bytes) => reader.push(bytes, (m) => messages.push(m)))
    return {
      connect: () => void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer })),
      send: (msg) => {
        for (const packet of frameMessage(msg, 180)) void this.deliverToHost(peer, packet)
      },
      received: () => messages,
      drop: () => {
        this.centrals.delete(peer)
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
      },
      peer,
    }
  }
}

/** A mutable input source — set the next command the session will sample. */
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

/** Stand up host + one joined client already playing; return handles. */
const startPair = async (
  seed = 100,
  clientInput: InputSource = makeInput().source,
): Promise<{ hub: MockHub; host: NetHostSession; bob: ReturnType<MockHub['addClient']> }> => {
  const hub = new MockHub()
  const host = new NetHostSession(seed, 'Alice', makeInput().source, hub.hostTransport)
  const bob = hub.addClient('Bob', clientInput)
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  return { hub, host, bob }
}

/** The host-side entity for a given player slot. */
const avatarOf = (host: NetHostSession, slot: number) => host.world.byId.get(host.peersBySlot.get(slot)!.entityId!)!

/** Give a host-side player a rich, multi-weapon inventory incl. a modded gun. */
const richLoadout = (): { inventory: ItemStack[]; activeSlot: number } => ({
  inventory: [
    { itemId: 'pistol', qty: 20 },
    { itemId: 'freezeRay', qty: 6, mods: [{ id: 'frost', stacks: 2 }] },
    { itemId: 'stunGun', qty: 4 },
    { itemId: 'bandage', qty: 37 },
  ],
  activeSlot: 0,
})

const tickN = async (host: NetHostSession, bob: ReturnType<MockHub['addClient']>, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    host.tick()
    bob.session.tick()
    await flush()
  }
}

describe('co-op client inventory (issue #57)', () => {
  it("gives the joining client its OWN full inventory — slots, activeSlot, mods, ammo — not a bandage summary", async () => {
    const { host, bob } = await startPair(201)
    const avatar = avatarOf(host, 1)
    const { inventory, activeSlot } = richLoadout()
    avatar.loadout!.inventory = inventory
    avatar.loadout!.activeSlot = activeSlot
    avatar.combat!.weapon = 'pistol'

    await tickN(host, bob, 6)

    const self = bob.session.renderView().self!
    const inv = self.loadout!.inventory
    // Full slot list arrives — the pistol, the modded freeze ray, the stun gun.
    expect(inv.map((s) => s.itemId)).toEqual(['pistol', 'freezeRay', 'stunGun', 'bandage'])
    expect(self.loadout!.activeSlot).toBe(0)
    // Ammo qty rides along per slot.
    expect(inv.find((s) => s.itemId === 'pistol')!.qty).toBe(20)
    // Per-weapon mods survive to the client so the badge renders.
    expect(inv.find((s) => s.itemId === 'freezeRay')!.mods).toEqual([{ id: 'frost', stacks: 2 }])
    // Bandages are ONE stack of 37 — not 37 phantom slots.
    expect(inv.filter((s) => s.itemId === 'bandage')).toHaveLength(1)
    expect(inv.find((s) => s.itemId === 'bandage')!.qty).toBe(37)
  })

  it('round-trips a client hotbar switch → host equips → client reflects the new active weapon', async () => {
    const input = makeInput()
    const { host, bob } = await startPair(202, input.source)
    const avatar = avatarOf(host, 1)
    avatar.loadout!.inventory = richLoadout().inventory
    avatar.loadout!.activeSlot = 0
    avatar.combat!.weapon = 'pistol'
    await tickN(host, bob, 4)
    expect(bob.session.renderView().self!.loadout!.activeSlot).toBe(0)

    // Client taps hotbar slot 1 (the freeze ray).
    input.set({ hotbar: 1 })
    await tickN(host, bob, 2)
    input.set({}) // release the tap
    await tickN(host, bob, 4)

    // Host equipped it authoritatively…
    expect(avatar.loadout!.activeSlot).toBe(1)
    expect(avatar.combat!.weapon).toBe('freezeRay')
    // …and the change came back to the client.
    const self = bob.session.renderView().self!
    expect(self.loadout!.activeSlot).toBe(1)
    expect(self.combat!.weapon).toBe('freezeRay')
  })

  it('syncs ammo count to the client as the host spends rounds', async () => {
    const { host, bob } = await startPair(203)
    const avatar = avatarOf(host, 1)
    avatar.loadout!.inventory = [{ itemId: 'pistol', qty: 20 }]
    avatar.loadout!.activeSlot = 0
    avatar.combat!.weapon = 'pistol'
    await tickN(host, bob, 4)
    expect(bob.session.renderView().self!.loadout!.inventory[0].qty).toBe(20)

    avatar.loadout!.inventory[0].qty = 12 // host fired 8 rounds
    await tickN(host, bob, 4)
    expect(bob.session.renderView().self!.loadout!.inventory[0].qty).toBe(12)
  })

  it('late-joiner receives its full inventory', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(204, 'Alice', makeInput().source, hub.hostTransport)
    await host.start()
    host.beginGame()
    await flush()

    const late = hub.addClient('Late', makeInput().source)
    await late.session.start()
    late.connect()
    await flush()
    expect(late.session.phase).toBe('playing')

    const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
    avatar.loadout!.inventory = richLoadout().inventory
    avatar.loadout!.activeSlot = 1
    avatar.combat!.weapon = 'freezeRay'
    await tickN(host, late, 6)

    const self = late.session.renderView().self!
    expect(self.loadout!.inventory.map((s) => s.itemId)).toEqual(['pistol', 'freezeRay', 'stunGun', 'bandage'])
    expect(self.loadout!.activeSlot).toBe(1)
  })

  it('gives multiple clients each THEIR own inventory, not each other\'s', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(205, 'Alice', makeInput().source, hub.hostTransport)
    const bob = hub.addClient('Bob', makeInput().source)
    const cara = hub.addClient('Cara', makeInput().source)
    await host.start()
    for (const c of [bob, cara]) {
      await c.session.start()
      c.connect()
      await flush()
    }
    host.beginGame()
    await flush()

    const bobAvatar = avatarOf(host, 1)
    const caraAvatar = avatarOf(host, 2)
    bobAvatar.loadout!.inventory = [{ itemId: 'pistol', qty: 5 }]
    bobAvatar.loadout!.activeSlot = 0
    caraAvatar.loadout!.inventory = [{ itemId: 'shotgun', qty: 3 }, { itemId: 'stunGun', qty: 4 }]
    caraAvatar.loadout!.activeSlot = 1

    for (let i = 0; i < 6; i++) {
      host.tick()
      bob.session.tick()
      cara.session.tick()
      await flush()
    }

    expect(bob.session.renderView().self!.loadout!.inventory.map((s) => s.itemId)).toEqual(['pistol'])
    expect(cara.session.renderView().self!.loadout!.inventory.map((s) => s.itemId)).toEqual(['shotgun', 'stunGun'])
    expect(cara.session.renderView().self!.loadout!.activeSlot).toBe(1)
  })

  it('does not flood the reliable channel — inventory is sent only on change', async () => {
    const { host, bob } = await startPair(206)
    const avatar = avatarOf(host, 1)
    avatar.loadout!.inventory = [{ itemId: 'pistol', qty: 20 }]
    avatar.loadout!.activeSlot = 0
    await tickN(host, bob, 4)
    const sentAfterFirst = host.debugInventorySends
    // No inventory change over many ticks → no further inventory sends.
    await tickN(host, bob, 30)
    expect(host.debugInventorySends).toBe(sentAfterFirst)
    // A change resumes sending.
    avatar.loadout!.inventory[0].qty = 19
    await tickN(host, bob, 2)
    expect(host.debugInventorySends).toBeGreaterThan(sentAfterFirst)
  })

  it('round-trips a client Use/Throw input → host consumes the held item → client sees the new qty', async () => {
    const input = makeInput()
    const { host, bob } = await startPair(207, input.source)
    const avatar = avatarOf(host, 1)
    avatar.loadout!.inventory = [{ itemId: 'bandage', qty: 3 }]
    avatar.loadout!.activeSlot = 0
    avatar.health!.hp = 40 // hurt, so the bandage actually heals
    await tickN(host, bob, 4)
    expect(bob.session.renderView().self!.loadout!.inventory[0].qty).toBe(3)

    input.set({ throwItem: true }) // Use the held bandage
    await tickN(host, bob, 2)
    input.set({})
    await tickN(host, bob, 4)

    // Host consumed one and healed authoritatively…
    expect(avatar.loadout!.inventory[0].qty).toBe(2)
    expect(avatar.health!.hp).toBe(70)
    // …and the client's own inventory reflects the spend.
    expect(bob.session.renderView().self!.loadout!.inventory[0].qty).toBe(2)
  })

  it("syncs a weapon-mod applied on the host to the client's own weapon (mod pickup)", async () => {
    const { host, bob } = await startPair(208)
    const avatar = avatarOf(host, 1)
    avatar.loadout!.inventory = [{ itemId: 'pistol', qty: 20 }]
    avatar.loadout!.activeSlot = 0
    avatar.combat!.weapon = 'pistol'
    await tickN(host, bob, 4)
    expect(bob.session.renderView().self!.loadout!.inventory[0].mods).toBeUndefined()

    // Host grabs a mod pickup for this player → the mod lands on the equipped gun.
    avatar.loadout!.inventory[0].mods = [{ id: 'frost', stacks: 1 }]
    await tickN(host, bob, 4)
    expect(bob.session.renderView().self!.loadout!.inventory[0].mods).toEqual([{ id: 'frost', stacks: 1 }])
  })

  it('re-sends the full inventory to a rejoining client (ghost reclaim)', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(209, 'Alice', makeInput().source, hub.hostTransport)
    await host.start()

    // Join a raw central, start, give it a rich loadout, then drop it to a ghost.
    const a = hub.addRawCentral()
    a.connect()
    await flush()
    a.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob' }))
    await flush()
    const welcome = decodeJson<{ slot: number; token: string }>(a.received().find((m) => m[0] === MsgType.Welcome)!)
    host.beginGame()
    await flush()
    const entityId = host.peersBySlot.get(welcome.slot)!.entityId!
    host.world.byId.get(entityId)!.loadout!.inventory = richLoadout().inventory
    host.tick()
    await flush()
    a.drop()
    await flush()

    // Rejoin with the token; the host reclaims the same avatar and must re-stream it.
    const b = hub.addRawCentral()
    b.connect()
    await flush()
    b.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob', rejoin: { slot: welcome.slot, token: welcome.token } }))
    await flush()
    host.tick()
    await flush()

    const invMsg = b.received().find((m) => m[0] === MsgType.Inventory)
    expect(invMsg).toBeDefined()
    const inv = decodeJson<InventoryMsg>(invMsg!)
    expect(inv.inventory.map((s) => s.itemId)).toEqual(['pistol', 'freezeRay', 'stunGun', 'bandage'])
    expect(inv.inventory.find((s) => s.itemId === 'freezeRay')!.mods).toEqual([{ id: 'frost', stacks: 2 }])
  })

  it('serializes an InventoryMsg round-trip losslessly (mods + ammo preserved)', () => {
    const msg: InventoryMsg = {
      slot: 3,
      inventory: [
        { itemId: 'pistol', qty: 17 },
        { itemId: 'freezeRay', qty: 6, mods: [{ id: 'frost', stacks: 2 }, { id: 'rapid', stacks: 1 }] },
        { itemId: 'bandage', qty: 37 },
      ],
      activeSlot: 1,
      weapon: 'freezeRay',
    }
    const back = decodeJson<InventoryMsg>(encodeJson(MsgType.Inventory, msg))
    expect(back).toEqual(msg)
  })

  it('is deterministic: two identical host runs stream byte-identical inventory to the client', async () => {
    const capture = async (): Promise<InventoryMsg> => {
      const hub = new MockHub()
      const host = new NetHostSession(210, 'Alice', makeInput().source, hub.hostTransport)
      await host.start()
      const raw = hub.addRawCentral()
      raw.connect()
      await flush()
      raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Bob' }))
      await flush()
      host.beginGame()
      await flush()
      for (let i = 0; i < 5; i++) {
        host.tick()
        await flush()
      }
      return decodeJson<InventoryMsg>(raw.received().find((m) => m[0] === MsgType.Inventory)!)
    }
    expect(await capture()).toEqual(await capture())
  })
})
