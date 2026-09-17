// SIM-AUTHORED ANNOTATIONS MUST REACH A BLE CLIENT.
//
// The annotation layer is how a system TALKS TO THE PLAYER (see ui/overlay.ts):
// The Vigil publishes its noise meter as a label pinned to itself, and the whole
// fairness argument for a stealth boss is that the meter is readable. Until this
// suite existed the set never crossed the wire at all — `HostSession.renderView`
// put `world.annotations` on its view, `NetClientSession.renderView` omitted the
// key entirely, and nothing in `src/net/` had ever heard of an annotation. So on
// a joiner's phone the meter simply did not exist, and the overlay's
// `view.annotations ?? []` made that look intentional.
//
// Everything here runs the REAL sessions over a loopback of the offline
// peer-to-peer link (the same MockHub shape as netCoop/netLateJoin), and the
// Vigil cases run the REAL boss system rather than a hand-written label.
//
// The two adversarial axes that matter for this feature:
//   BANDWIDTH — BLE is the binding constraint, so "it works" is not enough; an
//   unchanged set must cost ZERO bytes, and the worst case must be bounded.
//   TRUST — the set arrives off a radio from a peer that may be on another
//   build or hostile, so a malformed one must cost only itself.

import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { nextFloor } from '../game/systems/missions'
import { wakeThreshold } from '../game/systems/vigil'
import { emptyInput, type Annotation, type InputCmd } from '../game/types'
import type { Entity } from '../game/entity'
import { makeEntity } from '../game/entity'
import { addEntity } from '../game/world'
import type { InputSource } from '../input/input'
import { decodeJson, encodeJson } from '../net/framing/codec'
import { frameMessage, MAX_MESSAGE_BYTES, StreamReader } from '../net/framing/chunkedStream'
import {
  fromWireAnnotations,
  toWireAnnotations,
  MAX_WIRE_ANNOTATIONS,
  MAX_WIRE_ANNOTATION_TEXT,
  type AnnotationsMsg,
} from '../net/protocol/messages'
import {
  isKnownMsgType,
  MsgType,
  PROTOCOL_VERSION,
  type PeerId,
  type Transport,
  type TransportEvent,
} from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

// --- harness ---------------------------------------------------------------

/** A raw central that reassembles the host's stream and accounts for its bytes. */
interface RawCentral {
  connect: () => void
  send: (msg: Uint8Array) => void
  received: () => Uint8Array[]
  /** Every Annotations message this peer was sent, in order. */
  annotations: () => Uint8Array[]
  /** Total bytes of Annotations traffic delivered to this peer. */
  annotationBytes: () => number
  /** Total bytes of ALL traffic delivered to this peer. */
  totalBytes: () => number
}

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

  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) =>
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })),
    )
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
    return { session, connect }
  }

  addRawCentral(): RawCentral {
    const peer: PeerId = `raw-${this.centrals.size + 1}`
    const reader = new StreamReader({ isValidStart: isKnownMsgType })
    const messages: Uint8Array[] = []
    let bytes = 0
    this.centrals.set(peer, (b) => {
      bytes += b.length
      reader.push(b, (m) => messages.push(m.slice()))
    })
    const anns = (): Uint8Array[] => messages.filter((m) => m[0] === MsgType.Annotations)
    return {
      connect: () => void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer })),
      send: (msg) => {
        for (const packet of frameMessage(msg, 180)) void this.deliverToHost(peer, packet)
      },
      received: () => messages,
      annotations: anns,
      // Framing is [u16 length][message], so a message costs its own length + 2.
      annotationBytes: () => anns().reduce((n, m) => n + m.length + 2, 0),
      totalBytes: () => bytes,
    }
  }
}

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({
  sample: () => ({ ...emptyInput(), ...cmd }),
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const annotationsOf = (s: NetClientSession): readonly Annotation[] => s.renderView().annotations ?? []

const textsOf = (list: readonly Annotation[]): (string | undefined)[] => list.map((a) => a.text)

/** A started host with no peers yet. */
const soloHost = async (seed: number): Promise<{ hub: MockHub; host: NetHostSession }> => {
  const hub = new MockHub()
  const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
  await host.start()
  host.beginGame()
  await flush()
  return { hub, host }
}

/** A started host with one fully-joined client. */
const pair = async (
  seed: number,
): Promise<{ hub: MockHub; host: NetHostSession; bob: NetClientSession }> => {
  const hub = new MockHub()
  const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
  const bob = hub.addClient('Bob', stubInput())
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  expect(bob.session.phase).toBe('playing')
  return { hub, host, bob: bob.session }
}

/** Put a REVEALED Vigil next to the host's avatar — the real boss, real system. */
const revealVigil = (host: NetHostSession): Entity => {
  const at = host.self.pos
  const boss = spawnNpc(host.world, 'vigil', at.x + 2, at.y)!
  host.world.mission.bossRevealed = true
  return boss
}

const hostMeterText = (host: NetHostSession): string | undefined =>
  host.world.annotations.find((a) => String(a.id).startsWith('vigil:'))?.text

// ---------------------------------------------------------------------------

describe('annotations reach a joined client (the regression)', () => {
  it('delivers a host-authored annotation to the client’s render view', async () => {
    const { host, bob } = await pair(1234)
    host.world.annotations.push({ id: 'meter', kind: 'label', targetId: host.self.id, text: 'HELLO' })

    host.tick()
    await flush()

    const got = annotationsOf(bob)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ id: 'meter', kind: 'label', targetId: host.self.id, text: 'HELLO' })
    // What the overlay draws on each phone is now the SAME list.
    expect(textsOf(got)).toEqual(textsOf(host.renderView().annotations ?? []))
  })

  it('carries every annotation kind, with its geometry intact', async () => {
    const { host, bob } = await pair(1235)
    host.world.annotations.push(
      { id: 1, kind: 'pin', x: 12.125, y: 9.5, color: '#ff0000' },
      { id: 2, kind: 'circle', x: 3.25, y: 4.75, radius: 2.5, text: 'blast' },
      { id: 3, kind: 'arrow', x: 1.5, y: 2.5, x2: 8.5, y2: 7.5 },
      { id: 4, kind: 'text', x: 100, y: 24, text: 'BANNER' },
      { id: 5, kind: 'label', targetId: host.self.id, text: 'you' },
    )

    host.tick()
    await flush()

    const got = annotationsOf(bob)
    expect(got.map((a) => a.kind)).toEqual(['pin', 'circle', 'arrow', 'text', 'label'])
    expect(got[0]).toMatchObject({ x: 12.13, y: 9.5, color: '#ff0000' })
    expect(got[1]).toMatchObject({ radius: 2.5, text: 'blast' })
    expect(got[2]).toMatchObject({ x2: 8.5, y2: 7.5 })
    expect(got[3]).toMatchObject({ kind: 'text', text: 'BANNER' })
    expect(got[4]).toMatchObject({ targetId: host.self.id })
  })

  it('keeps the host’s own list untouched — the wire copy is a projection, not the state', async () => {
    const { host, bob } = await pair(1236)
    const mark: Annotation = { id: 'm', kind: 'label', targetId: host.self.id, text: 'x', ttlTick: 999999 }
    host.world.annotations.push(mark)

    host.tick()
    await flush()

    expect(host.world.annotations).toHaveLength(1)
    expect(host.world.annotations[0]).toBe(mark) // same object, unmutated
    expect(mark.ttlTick).toBe(999999)
    // ...and the client got a COPY, never a shared reference into host state.
    expect(annotationsOf(bob)[0]).not.toBe(mark)
  })
})

describe('The Vigil’s noise meter on a joiner’s phone', () => {
  it('shows the sleeping meter, then follows it as the fight gets loud', async () => {
    const { host, bob } = await pair(4242)
    const boss = revealVigil(host)

    host.tick()
    await flush()
    expect(hostMeterText(host)).toMatch(/^ASLEEP/)
    expect(textsOf(annotationsOf(bob))).toEqual([hostMeterText(host)])

    // Someone is loud: the meter fills. The text is the thing that changes, and
    // the client must follow it — a frozen meter is worse than no meter.
    boss.ai!.noise = wakeThreshold(host.world) * 0.75
    host.tick()
    await flush()
    const midFight = hostMeterText(host)
    expect(midFight).toMatch(/^ASLEEP \[\|/) // at least one bar filled
    expect(textsOf(annotationsOf(bob))).toEqual([midFight])

    // Past the threshold it wakes, and the label becomes the warning.
    boss.ai!.noise = wakeThreshold(host.world) + 10
    host.tick()
    await flush()
    expect(hostMeterText(host)).toMatch(/AWAKE/)
    expect(textsOf(annotationsOf(bob))).toEqual([hostMeterText(host)])
    expect(annotationsOf(bob)[0].targetId).toBe(boss.id)
  })

  it('takes the meter away with the corpse (removal, not just addition)', async () => {
    const { host, bob } = await pair(4243)
    const boss = revealVigil(host)
    host.tick()
    await flush()
    expect(annotationsOf(bob)).toHaveLength(1)

    boss.dead = true // vigilSystem's clearMeter path
    host.tick()
    await flush()

    expect(host.world.annotations).toHaveLength(0)
    expect(annotationsOf(bob)).toHaveLength(0)
  })

  it('takes away a mark whose target died even when the sim forgets to', async () => {
    // Not every author is as tidy as the Vigil. A mark pinned to a dead entity
    // draws nothing on the host (the overlay finds no entity), so it must draw
    // nothing on the client either — otherwise the two screens disagree.
    const { host, bob } = await pair(4244)
    const npc = makeEntity('npc', 'thug', host.self.pos.x + 1, host.self.pos.y)
    addEntity(host.world, npc)
    host.world.annotations.push({ id: 'tag', kind: 'label', targetId: npc.id, text: 'TARGET' })
    host.tick()
    await flush()
    expect(annotationsOf(bob)).toHaveLength(1)

    npc.dead = true
    host.tick()
    await flush()

    expect(host.world.annotations).toHaveLength(1) // the sim still holds it
    expect(annotationsOf(bob)).toHaveLength(0) // ...and neither screen draws it
  })
})

describe('a LATE JOINER lands mid-fight, not mid-blackout', () => {
  it('hands a joiner the meter that is already on screen, with no further host ticks', async () => {
    const { hub, host } = await soloHost(777)
    revealVigil(host)
    host.tick()
    await flush()
    const meter = hostMeterText(host)
    expect(meter).toBeDefined()
    const sendsBefore = host.debugAnnotationSends

    const carol = hub.addClient('Carol', stubInput())
    await carol.session.start()
    carol.connect()
    await flush()

    // The host has NOT ticked since the join. Nothing re-broadcasts on a timer,
    // and the change-gate would never re-announce an unchanged set — so this can
    // only have come from the admission push.
    expect(carol.session.phase).toBe('playing')
    expect(textsOf(annotationsOf(carol.session))).toEqual([meter])
    expect(host.debugAnnotationSends).toBe(sendsBefore + 1)
  })

  it('puts the set in the admission burst on the wire (Welcome/GameStart/Go/Annotations)', async () => {
    const { hub, host } = await soloHost(778)
    revealVigil(host)
    host.tick()
    await flush()

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    await flush()

    const ann = raw.annotations()
    expect(ann).toHaveLength(1)
    const msg = decodeJson<AnnotationsMsg>(ann[0])
    expect(msg.floor).toBe(host.world.floor)
    expect(msg.annotations).toHaveLength(1)
    expect(msg.annotations[0].text).toBe(hostMeterText(host))
  })

  it('adds nothing to the admission burst when there is nothing to draw', async () => {
    const { hub } = await soloHost(779)
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    await flush()

    expect(raw.annotations()).toHaveLength(0)
  })

  it('re-sends the set to a client whose admission was lost and re-asked (duplicate Hello)', async () => {
    const { hub, host } = await soloHost(780)
    revealVigil(host)
    host.tick()
    await flush()

    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' }))
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Late' })) // the reply was lost
    await flush()

    // Same argument as the inventory re-push: whatever else went missing, assume
    // this did too. Both answers carry the same set.
    const ann = raw.annotations()
    expect(ann).toHaveLength(2)
    expect(decodeJson<AnnotationsMsg>(ann[0]).annotations).toEqual(
      decodeJson<AnnotationsMsg>(ann[1]).annotations,
    )
  })
})

describe('BLE budget: an unchanged set costs nothing', () => {
  it('sends ZERO annotation bytes across 60 ticks of a run that never annotates', async () => {
    const { hub, host } = await soloHost(900)
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Raw' }))
    await flush()

    for (let i = 0; i < 60; i++) {
      host.tick()
      await flush()
    }

    expect(raw.annotations()).toHaveLength(0)
    expect(raw.annotationBytes()).toBe(0)
    expect(host.debugAnnotationSends).toBe(0)
  })

  it('sends ONE message for a mark that never changes, then nothing for 60 ticks', async () => {
    const { hub, host } = await soloHost(901)
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Raw' }))
    await flush()

    host.world.annotations.push({ id: 'static', kind: 'label', targetId: host.self.id, text: 'ASLEEP [·····]' })
    host.tick()
    await flush()
    expect(raw.annotations()).toHaveLength(1)
    const afterFirst = raw.annotationBytes()
    expect(afterFirst).toBeGreaterThan(0)

    for (let i = 0; i < 60; i++) {
      host.tick()
      await flush()
    }

    // 60 ticks = 2 seconds of play. A per-tick push would have been 60 messages;
    // a 1Hz heartbeat would have been 2. Change-gated, it is still one.
    expect(raw.annotations()).toHaveLength(1)
    expect(raw.annotationBytes()).toBe(afterFirst)
    expect(host.debugAnnotationSends).toBe(1)
  })

  it('spends one small message per meter change — and the whole Vigil fight is a handful', async () => {
    const { hub, host } = await soloHost(902)
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Raw' }))
    await flush()

    const boss = revealVigil(host)
    // Walk the meter up through every bucket and back down: the loudest
    // realistic churn this annotation can produce in one fight.
    for (let i = 0; i <= 5; i++) {
      boss.ai!.noise = (wakeThreshold(host.world) * i) / 5
      host.tick()
      await flush()
    }
    for (let i = 0; i < 30; i++) {
      host.tick() // quiet again: the meter decays back down
      await flush()
    }

    const msgs = raw.annotations()
    const bytes = raw.annotationBytes()
    // Six bucket steps up plus the decay back down is a dozen-ish rewrites, each
    // one small message — NOT one per tick (36 ticks here, 30Hz in play).
    expect(msgs.length).toBeLessThanOrEqual(16)
    expect(msgs.length).toBeLessThan(36)
    // Each message is one BLE-sane packet at 180B MTU, and ~5 at the 20B floor.
    for (const m of msgs) {
      expect(m.length).toBeLessThan(180)
      expect(frameMessage(m, 20).length).toBeLessThanOrEqual(8)
    }
    // Whole-fight annotation traffic is a rounding error next to one snapshot
    // (490B) every 3 ticks.
    expect(bytes).toBeLessThan(2000)
  })

  it('bounds the WORST case: a full 12-mark set still fits a couple of snapshots', () => {
    const marks: Annotation[] = []
    for (let i = 0; i < 50; i++) {
      marks.push({ id: `mark-${i}`, kind: 'label', targetId: i + 1, text: 'W'.repeat(400), color: '#ffcc00' })
    }
    const wire = toWireAnnotations(marks, 0, () => true)
    const bytes = encodeJson(MsgType.Annotations, { floor: 9, annotations: wire })

    expect(wire).toHaveLength(MAX_WIRE_ANNOTATIONS)
    // Measured: 1473B — three 490B snapshots — and it is paid ONLY on a change,
    // where a snapshot is paid three times a second per peer forever.
    expect(bytes.length).toBeLessThan(1600)
    expect(bytes.length).toBeLessThan(MAX_MESSAGE_BYTES)
    expect(frameMessage(bytes, 20).length).toBeLessThanOrEqual(80) // measured 74 at the MTU floor
  })
})

describe('floors: furniture never follows you downstairs', () => {
  it('clears the previous floor’s annotations when the party descends', async () => {
    const { host, bob } = await pair(1500)
    const boss = revealVigil(host)
    host.tick()
    await flush()
    expect(annotationsOf(bob)).toHaveLength(1)
    expect(boss.id).toBeGreaterThan(0)

    // Rebuilds entities/byId; `w.annotations` is deliberately left alone by the
    // sim, so the wire projection is what has to notice. 40 ticks so the client
    // has had both a snapshot (10Hz, moves its level) and a State (2Hz, moves
    // the HUD number).
    nextFloor(host.world)
    for (let i = 0; i < 40; i++) {
      host.tick()
      bob.tick()
      await flush()
    }

    expect(bob.renderView().floor).toBe(2)
    expect(annotationsOf(bob)).toHaveLength(0)
  })

  it('refuses to draw a set tagged for the floor the client has left, even before a new set lands', () => {
    // THE HAZARD THE TAG EXISTS FOR. A client can learn it has changed floor
    // from a snapshot (10Hz) before the host's updated annotation set has been
    // processed — and the host only sends that set on CHANGE. In that window the
    // previous floor's furniture must not be painted over this floor's map.
    const cap = makeCapturingClientTransport()
    const client = new NetClientSession('Bob', stubInput(), cap.transport)
    cap.connect()
    inject(cap, encodeJson(MsgType.Welcome, { slot: 1, token: 't' }))
    inject(cap, encodeJson(MsgType.GameStart, { seed: 424242, players: [], floor: 1 }))
    inject(cap, encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: 5 } }))
    inject(cap, encodeJson(MsgType.Annotations, { floor: 1, annotations: [{ id: 'f1', kind: 'text', text: 'FLOOR ONE' }] }))
    expect(textsOf(annotationsOf(client))).toEqual(['FLOOR ONE'])

    inject(cap, encodeJson(MsgType.Events, { tick: 30, events: [{ type: 'floorChange', floor: 2 }] }))

    expect(annotationsOf(client)).toHaveLength(0)
  })

  it('is not a blunt wipe: a mark pinned to something that SURVIVED the descent follows the party', async () => {
    // Players carry over (`nextFloor` re-adds them), so a mark pinned to one is
    // still meaningful on the new floor — and the host re-announces the set
    // under the new floor tag rather than dropping it. The contract this suite
    // enforces is "both screens draw the same thing", not "forget everything".
    const { host, bob } = await pair(1501)
    host.world.annotations.push({ id: 'f1', kind: 'label', targetId: host.self.id, text: 'STILL YOU' })
    host.tick()
    await flush()
    expect(annotationsOf(bob)).toHaveLength(1)

    nextFloor(host.world)
    for (let i = 0; i < 40; i++) {
      host.tick()
      bob.tick()
      await flush()
    }

    expect(bob.renderView().floor).toBe(2)
    expect(textsOf(annotationsOf(bob))).toEqual(['STILL YOU'])
    expect(textsOf(host.renderView().annotations ?? [])).toEqual(['STILL YOU'])
  })

  it('keeps a set that arrives BEFORE the floor change it belongs to', async () => {
    // The host sends on CHANGE, so a set thrown away for arriving early would
    // never be re-sent — the joiner would stare at an empty overlay forever.
    const cap = makeCapturingClientTransport()
    const client = new NetClientSession('Bob', stubInput(), cap.transport)
    await client.start()
    cap.connect()
    const seed = 31337
    inject(cap, encodeJson(MsgType.Welcome, { slot: 1, token: 't' }))
    inject(cap, encodeJson(MsgType.GameStart, { seed, players: [], floor: 1 }))
    inject(cap, encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: 5 } }))
    // A set for floor 2 lands while we are still on floor 1.
    inject(cap, encodeJson(MsgType.Annotations, { floor: 2, annotations: [{ id: 'a', kind: 'text', text: 'DEEPER' }] }))
    expect(annotationsOf(client)).toHaveLength(0)

    // ...then the floor change arrives, and the set is there waiting.
    inject(cap, encodeJson(MsgType.Events, { tick: 10, events: [{ type: 'floorChange', floor: 2 }] }))
    expect(textsOf(annotationsOf(client))).toEqual(['DEEPER'])
  })

  it('clears the overlay on a fresh run (play again)', async () => {
    const { host, bob } = await pair(1502)
    host.world.annotations.push({ id: 'old', kind: 'label', targetId: host.self.id, text: 'OLD RUN' })
    host.tick()
    await flush()
    expect(annotationsOf(bob)).toHaveLength(1)

    host.restart()
    await flush()

    expect(host.world.annotations).toHaveLength(0)
    expect(annotationsOf(bob)).toHaveLength(0)
    // The gate re-baselined too, so annotating the same thing again still sends.
    host.world.annotations.push({ id: 'old', kind: 'label', targetId: host.self.id, text: 'OLD RUN' })
    host.tick()
    await flush()
    expect(textsOf(annotationsOf(bob))).toEqual(['OLD RUN'])
  })
})

describe('degenerate and hostile input', () => {
  it('survives an absurd pile of absurdly long annotations without corrupting the stream', async () => {
    const { hub, host } = await pair(2000)
    const raw = hub.addRawCentral()
    raw.connect()
    await flush()
    raw.send(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Raw' }))
    await flush()
    const bob = hub.addClient('Carol', stubInput())
    await bob.session.start()
    bob.connect()
    await flush()

    for (let i = 0; i < 500; i++) {
      host.world.annotations.push({ id: i, kind: 'label', targetId: host.self.id, text: 'Z'.repeat(5000) })
    }
    host.tick()
    await flush()

    const ann = raw.annotations()
    expect(ann).toHaveLength(1)
    expect(ann[0].length).toBeLessThan(MAX_MESSAGE_BYTES)
    const msg = decodeJson<AnnotationsMsg>(ann[0])
    expect(msg.annotations).toHaveLength(MAX_WIRE_ANNOTATIONS)
    for (const a of msg.annotations) expect(a.text!.length).toBe(MAX_WIRE_ANNOTATION_TEXT)

    // The stream is still aligned behind it: later messages still arrive.
    const before = raw.received().length
    for (let i = 0; i < 20; i++) {
      host.tick()
      await flush()
    }
    expect(raw.received().length).toBeGreaterThan(before)
    expect(annotationsOf(bob.session)).toHaveLength(MAX_WIRE_ANNOTATIONS)
    expect(bob.session.renderView().self).toBeDefined()
  })

  it('keeps a mark whose target the client has NEVER seen (interest culling guarantees this)', async () => {
    const { host, bob } = await pair(2001)
    // 40 tiles away — far outside the 14-tile interest radius, so no snapshot
    // this client ever receives will contain it.
    const far = makeEntity('npc', 'thug', host.self.pos.x + 40, host.self.pos.y + 40)
    addEntity(host.world, far)
    host.world.annotations.push({ id: 'far', kind: 'label', targetId: far.id, text: 'OVER THERE' })

    for (let i = 0; i < 6; i++) {
      host.tick()
      bob.tick()
      await flush()
    }

    const view = bob.renderView()
    expect(view.entities.some((e) => e.id === far.id)).toBe(false)
    // Kept, not dropped: the overlay draws nothing for an anchor it cannot find
    // (ui/overlay.ts `anchorOf`), and starts drawing the moment it can.
    expect(textsOf(view.annotations ?? [])).toEqual(['OVER THERE'])
    expect(view.self).toBeDefined()
    expect(bob.streamDesyncs).toBe(0)
  })

  it('shrugs off a hostile Annotations message and keeps rendering', () => {
    const cap = makeCapturingClientTransport()
    const client = new NetClientSession('Bob', stubInput(), cap.transport)
    cap.connect()

    const hostile: unknown[] = [
      { floor: 1, annotations: 'not-an-array' },
      { floor: 1, annotations: null },
      { floor: 'one', annotations: [{ id: 'a', kind: 'text', text: 'ok' }] },
      { annotations: [{ kind: 'nope' }, null, 42, { kind: 'label' }] },
      { floor: 1, annotations: [{ kind: 'circle', x: Number.NaN, y: 1, radius: 1 }] },
    ]
    for (const payload of hostile) {
      expect(() => inject(cap, encodeJson(MsgType.Annotations, payload))).not.toThrow()
    }
    // Not even valid JSON behind a valid type byte.
    expect(() => inject(cap, new Uint8Array([MsgType.Annotations, 0x7b, 0xff, 0xfe]))).not.toThrow()

    // The stream is still usable afterwards.
    inject(cap, encodeJson(MsgType.Welcome, { slot: 4, token: 'tok' }))
    expect(client.slot).toBe(4)
  })

  it('validates each mark on the way in: one bad apple costs only itself', () => {
    const got = fromWireAnnotations([
      { id: 'good', kind: 'label', targetId: 3, text: 'fine' },
      { kind: 'not-a-kind', targetId: 3 }, // unknown kind
      { kind: 'pin' }, // no anchor at all
      { kind: 'circle', x: 1, y: 2, radius: 'big' }, // wrong type
      { id: 'long', kind: 'text', text: 'L'.repeat(10000) }, // truncated, not dropped
    ])

    expect(got.map((a) => a.id)).toEqual(['good', 'long'])
    expect(got[1].text).toHaveLength(MAX_WIRE_ANNOTATION_TEXT)
  })

  it('caps the count on the way IN as well as out — a sender-side cap is not a cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: i, kind: 'text', text: `t${i}` }))
    expect(fromWireAnnotations(many)).toHaveLength(MAX_WIRE_ANNOTATIONS)
    expect(fromWireAnnotations('nonsense')).toEqual([])
    expect(fromWireAnnotations(undefined)).toEqual([])
  })

  it('cannot be used to pollute a prototype', () => {
    const payload = JSON.parse('[{"kind":"label","targetId":1,"text":"hi","__proto__":{"polluted":true}}]') as unknown
    const got = fromWireAnnotations(payload)
    expect(got).toHaveLength(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('never ships an expired mark, and never ships the host clock that expires it', () => {
    // `ttlTick` is absolute in the HOST's tick domain; a client's `tick` is its
    // own local frame counter, so the field must not cross the wire at all.
    const marks: Annotation[] = [
      { id: 'live', kind: 'text', text: 'still here', ttlTick: 100 },
      { id: 'dead', kind: 'text', text: 'gone', ttlTick: 50 },
    ]
    const wire = toWireAnnotations(marks, 60, () => true)
    expect(wire.map((a) => a.id)).toEqual(['live'])
    expect('ttlTick' in wire[0]).toBe(false)
  })
})

describe('why this cost a PROTOCOL_VERSION bump', () => {
  it('an older peer does not IGNORE an unknown message type — it desyncs and drops it', () => {
    // The framing layer gates message starts on `isKnownMsgType`
    // (netClient.ts / netHost.ts wire it into `StreamReader.isValidStart`), so a
    // build that predates MsgType.Annotations treats the frame as stream
    // corruption rather than as something new to skip. That is not additive, and
    // two builds that behave this differently must not both claim one version.
    const v4KnowsNothingOfIt = (t: number): boolean => isKnownMsgType(t) && t !== MsgType.Annotations
    const reasons: string[] = []
    const delivered: number[] = []
    const reader = new StreamReader({
      isValidStart: v4KnowsNothingOfIt,
      onDesync: (r) => reasons.push(r),
    })

    const ann = encodeJson(MsgType.Annotations, { floor: 1, annotations: [{ id: 'a', kind: 'text', text: 'meter' }] })
    for (const p of frameMessage(ann, 180)) reader.push(p, (m) => delivered.push(m[0]))

    expect(delivered).toEqual([]) // the meter update is gone
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/unknown message type 20/)

    // And the counter it moves is the SAME one real packet loss moves, so the
    // damage is not even legible as a version problem in the field.
    const state = encodeJson(MsgType.State, { floor: 1, missionText: 'x', missionComplete: false, gameOver: false, alarm: 0, huds: {} })
    for (const p of frameMessage(state, 180)) reader.push(p, (m) => delivered.push(m[0]))
    expect(delivered).toEqual([MsgType.State]) // it re-syncs, having eaten one message
  })

  it('the current build knows the type, so the same bytes deliver cleanly', () => {
    const delivered: number[] = []
    const reasons: string[] = []
    const reader = new StreamReader({ isValidStart: isKnownMsgType, onDesync: (r) => reasons.push(r) })
    const ann = encodeJson(MsgType.Annotations, { floor: 1, annotations: [] })
    for (const p of frameMessage(ann, 180)) reader.push(p, (m) => delivered.push(m[0]))
    expect(delivered).toEqual([MsgType.Annotations])
    expect(reasons).toEqual([])
  })
})

// --- a client transport we can drive synchronously --------------------------

const makeCapturingClientTransport = (): {
  transport: Transport
  inject: (bytes: Uint8Array) => void
  connect: () => void
} => {
  let handler: ((e: TransportEvent) => void) | null = null
  const transport: Transport = {
    role: 'client',
    maxPacket: 180,
    start: async () => {},
    stop: async () => {},
    sendPacket: async () => {},
    on: (h) => {
      handler = h
      return () => {}
    },
    peers: () => ['host'],
  }
  return {
    transport,
    inject: (bytes) => handler?.({ type: 'data', peer: 'host', bytes }),
    connect: () => handler?.({ type: 'peerConnected', peer: 'host' }),
  }
}

/** Frame + hand one whole message to a capturing client, synchronously. */
const inject = (cap: ReturnType<typeof makeCapturingClientTransport>, msg: Uint8Array): void => {
  for (const packet of frameMessage(msg, 180)) cap.inject(packet)
}
