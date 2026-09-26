// #84 — the floor draft over the co-op link. The host deals the hand; the client
// learns it from the host's state message, taps a card, and the pick travels as
// an input. The client never touches its own loadout.

import { describe, expect, it } from 'vitest'
import { emptyInput, type InputCmd } from '../game/types'
import { weaponStack } from '../game/systems/inventory'
import { floorDraftOffer, floorTraitOffer } from '../game/systems/draft'
import { encodeJson } from '../net/framing/codec'
import { MsgType } from '../net/types'
import type { InputSource } from '../input/input'
import { withDraftPicks } from '../input/draftPick'
import { decodeInput, encodeInput } from '../net/protocol/messages'
import type { PeerId, Transport, TransportEvent } from '../net/types'
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

  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) => void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })))
    const clientTransport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) =>
        Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes })),
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
    return { session, connect }
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

const SEED = 8401

const startPair = async (clientInput: InputSource) => {
  const hub = new MockHub()
  const host = new NetHostSession(SEED, 'Host', makeInput().source, hub.hostTransport, 'normal')
  const bob = hub.addClient('Bob', clientInput)
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  const avatar = host.world.byId.get(host.peersBySlot.get(1)!.entityId!)!
  return { host, bob, avatar }
}

const step = async (host: NetHostSession, bob: ReturnType<MockHub['addClient']>, n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) {
    host.tick()
    bob.session.tick()
    await flush()
  }
}

/** Put the host's own player on the exit so the next host tick advances the floor. */
const descend = (host: NetHostSession): void => {
  host.world.mission.exitUnlocked = true
  const p = host.self
  p.pos.x = p.prevPos.x = host.world.level.exit.x + 0.5
  p.pos.y = p.prevPos.y = host.world.level.exit.y + 0.5
}

describe('floor draft over co-op', () => {
  it("the client's hand arrives from the host, a tap picks through the host, and the hand closes", async () => {
    const input = makeInput()
    const picks = withDraftPicks(input.source)
    const { host, bob, avatar } = await startPair(picks)
    await step(host, bob, 3)
    descend(host)
    await step(host, bob, 16) // one floor advance + a 2 Hz state message
    const offer = floorDraftOffer(SEED, 1)
    expect(avatar.playerCtl!.draft!.offer).toEqual(offer)
    const clientHand = bob.session.renderView().self!.playerCtl!.draft
    expect(clientHand?.offer).toEqual(offer)
    expect(clientHand?.until).toBe(avatar.playerCtl!.draft!.until)
    // The client never touched its loadout: the gun is still vanilla on both sides.
    expect(weaponStack(avatar)!.mods ?? []).toEqual([])

    picks.pick(1)
    await step(host, bob, 4)
    expect(avatar.playerCtl!.draft).toBeUndefined()
    expect(weaponStack(avatar)!.mods).toEqual([{ id: offer[1], stacks: 1 }])
    expect(weaponStack(bob.session.renderView().self!)!.mods).toEqual([{ id: offer[1], stacks: 1 }])
    await step(host, bob, 16)
    expect(bob.session.renderView().self!.playerCtl!.draft).toBeUndefined()
  })

  it('the YOU card crosses the link: the hand carries it, a tap takes it on the host, and the trait comes back to that client', async () => {
    const input = makeInput()
    const picks = withDraftPicks(input.source)
    const { host, bob, avatar } = await startPair(picks)
    await step(host, bob, 3)
    descend(host)
    await step(host, bob, 16)
    const trait = floorTraitOffer(SEED, 1)!
    expect(bob.session.renderView().self!.playerCtl!.draft!.trait).toBe(trait)

    picks.pick(2)
    await step(host, bob, 4)
    expect(avatar.playerCtl!.traits).toEqual([{ id: trait, stacks: 1 }])
    expect(weaponStack(avatar)!.mods ?? []).toEqual([])
    expect(host.self.playerCtl!.traits).toBeUndefined() // the host still has its own hand open
    expect(bob.session.renderView().self!.playerCtl!.traits).toEqual([{ id: trait, stacks: 1 }])
    // and it stays through later inventory traffic
    await step(host, bob, 30)
    expect(bob.session.renderView().self!.playerCtl!.traits).toEqual([{ id: trait, stacks: 1 }])
  })

  it('a client that joins mid-floor gets no hand, then the next hand with its YOU card, and its trait arrives', async () => {
    const hub = new MockHub()
    const host = new NetHostSession(SEED, 'Host', makeInput().source, hub.hostTransport, 'normal')
    await host.start()
    host.beginGame()
    for (let i = 0; i < 5; i++) host.tick()
    const input = makeInput()
    const picks = withDraftPicks(input.source)
    const bob = hub.addClient('Late', picks)
    await bob.session.start()
    bob.connect()
    await flush()
    await step(host, bob, 20)
    const self = () => bob.session.renderView().self!
    expect(self().playerCtl!.draft).toBeUndefined()
    descend(host)
    await step(host, bob, 16)
    expect(self().playerCtl!.draft!.trait).toBe(floorTraitOffer(SEED, 1))
    picks.pick(2)
    await step(host, bob, 20)
    expect(self().playerCtl!.traits).toEqual([{ id: floorTraitOffer(SEED, 1), stacks: 1 }])
  })

  it('a drafting client does not predict a walk the host will not make', async () => {
    const input = makeInput()
    const { host, bob, avatar } = await startPair(input.source)
    await step(host, bob, 3)
    descend(host)
    await step(host, bob, 16)
    expect(bob.session.renderView().self!.playerCtl!.draft).toBeDefined()
    const hostAt = { ...avatar.pos }
    input.set({ moveX: 1, moveY: 0.4 })
    await step(host, bob, 20)
    const self = bob.session.renderView().self!
    expect(avatar.pos).toEqual(hostAt)
    expect(Math.hypot(self.pos.x - hostAt.x, self.pos.y - hostAt.y)).toBeLessThan(0.05)
  })
})

describe('trait wire cost', () => {
  it('a trait costs its own id once, on the owner\u2019s change-gated inventory message, and nothing when absent', () => {
    const inv = { slot: 1, inventory: [{ itemId: 'pistol', qty: 1 }], activeSlot: -1, weapon: 'pistol' }
    const bare = encodeJson(MsgType.Inventory, inv).length
    const one = encodeJson(MsgType.Inventory, { ...inv, traits: [{ id: 'staticSkin', stacks: 1 }] }).length
    const three = encodeJson(MsgType.Inventory, {
      ...inv,
      traits: [
        { id: 'staticSkin', stacks: 1 },
        { id: 'softSteps', stacks: 2 },
        { id: 'medicHands', stacks: 1 },
      ],
    }).length
    expect(one - bare).toBeLessThanOrEqual(45)
    expect(three - bare).toBeLessThanOrEqual(120)
  })
})

describe('input wire: the draft tail is additive', () => {
  const base: InputCmd = { ...emptyInput(), seq: 42, attack: true, hotbar: 1, aimX: 0, aimY: 1 }
  const edges = { attack: true, interact: false, special: false }

  it('a command without a pick encodes exactly as before', () => {
    expect(encodeInput(base, edges).length).toBe(9)
    expect(decodeInput(encodeInput(base, edges)).cmd.draftPick).toBeUndefined()
    expect(encodeInput({ ...base, modSwap: 5 }, edges).length).toBe(11)
  })

  it('a pick rides after an empty swap slot and round-trips, card 0 included', () => {
    for (const pick of [0, 1, 2, 254]) {
      const bytes = encodeInput({ ...base, draftPick: pick }, edges)
      expect(bytes.length).toBe(12)
      const { cmd } = decodeInput(bytes)
      expect(cmd.draftPick).toBe(pick)
      expect(cmd.modSwap).toBeUndefined()
      expect(cmd.hotbar).toBe(1)
    }
  })

  it('a swap and a pick in one packet both survive', () => {
    const { cmd } = decodeInput(encodeInput({ ...base, modSwap: 0x0203, draftPick: 1 }, edges))
    expect(cmd.modSwap).toBe(0x0203)
    expect(cmd.draftPick).toBe(1)
  })

  it('an unencodable pick is dropped, and a stray byte is never read as one', () => {
    for (const bad of [-1, 255, 1000]) expect(encodeInput({ ...base, draftPick: bad }, edges).length).toBe(9)
    const plain = encodeInput(base, edges)
    expect(decodeInput(new Uint8Array([...plain, 3])).cmd.draftPick).toBeUndefined()
  })
})

describe('withDraftPicks', () => {
  it('rides exactly one sampled command, then clears', () => {
    const src = withDraftPicks({ sample: () => emptyInput() })
    expect(src.sample().draftPick).toBeUndefined()
    src.pick(1)
    expect(src.sample().draftPick).toBe(1)
    expect(src.sample().draftPick).toBeUndefined()
  })

  it('a later tap before the next sample wins; junk taps are ignored', () => {
    const src = withDraftPicks({ sample: () => emptyInput() })
    src.pick(0)
    src.pick(2)
    expect(src.sample().draftPick).toBe(2)
    for (const bad of [-1, 1.5, NaN, 255]) src.pick(bad)
    expect(src.sample().draftPick).toBeUndefined()
  })
})
