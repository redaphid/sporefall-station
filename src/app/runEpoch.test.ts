import { describe, expect, it } from 'vitest'
import { emptyInput } from '../game/types'
import { encodeJson } from '../net/framing/codec'
import { frameMessage } from '../net/framing/chunkedStream'
import { encodeSnapshot, type WireEntity } from '../net/protocol/messages'
import { MsgType, type Transport, type TransportEvent } from '../net/types'
import { HostSession } from './hostSession'
import { NetClientSession } from './netClient'

/**
 * `RenderView.runEpoch` marks run boundaries for per-run UI state (the boss
 * latch in screens.ts). It must change on a fresh run and on nothing else: a
 * rejoin to the same run and a late snapshot both happen mid-fight, and the
 * boss reveal fires once per floor, so a false boundary loses the boss bar for
 * the rest of the fight.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const makeClient = () => {
  let handler: ((e: TransportEvent) => void) | null = null
  const transport: Transport = {
    role: 'client',
    maxPacket: 180,
    start: async () => {},
    stop: async () => {},
    sendPacket: () => Promise.resolve(),
    on: (h) => {
      handler = h
      return () => {}
    },
    peers: () => ['host'],
    reconnect: async () => {},
  }
  const session = new NetClientSession('Friend', { sample: () => emptyInput() }, transport)
  const deliver = (msg: Uint8Array): void => {
    for (const packet of frameMessage(msg, 180)) handler?.({ type: 'data', peer: 'host', bytes: packet })
  }
  const emit = (ev: TransportEvent): void => handler?.(ev)
  return { session, deliver, emit }
}

const SELF = 7
const BOSS = 42
const wire = (id: number, archetype: string): WireEntity => ({ id, archetype, x: 5, y: 5, facing: 0, hpPct: 1, flags: 0 })
const snapshot = (tick: number, bossArchetype = 'boss'): Uint8Array =>
  encodeSnapshot({ tick, floor: 1, alarm: 0, lastInputSeq: 0, entities: [wire(SELF, 'player'), wire(BOSS, bossArchetype)] })
const gameStart = (seed: number): Uint8Array =>
  encodeJson(MsgType.GameStart, { seed, players: [{ slot: 1, name: 'Friend' }], floor: 1 })
const go = (): Uint8Array => encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: SELF } })

const admitted = async () => {
  const c = makeClient()
  await c.session.start()
  c.emit({ type: 'peerConnected', peer: 'host' })
  await flush()
  c.deliver(encodeJson(MsgType.Welcome, { slot: 1, token: 'tok' }))
  c.deliver(gameStart(1))
  c.deliver(go())
  c.deliver(snapshot(900))
  await flush()
  expect(c.session.phase).toBe('playing')
  return c
}

describe('a net client changes runEpoch only on a fresh run', () => {
  it('keeps it through late, duplicate and out-of-order snapshots', async () => {
    const c = await admitted()
    const epoch = c.session.renderView().runEpoch

    for (const tick of [910, 904, 904, 911, 3]) c.deliver(snapshot(tick))
    await flush()

    expect(c.session.renderView().runEpoch).toBe(epoch)
  })

  it('keeps it through a ghost rejoin to the same run', async () => {
    const c = await admitted()
    const epoch = c.session.renderView().runEpoch

    c.emit({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
    expect(c.session.phase).toBe('reconnecting')
    c.emit({ type: 'peerConnected', peer: 'host' })
    c.deliver(gameStart(1))
    c.deliver(go())
    c.deliver(snapshot(930))
    await flush()

    expect(c.session.phase).toBe('playing')
    expect(c.session.renderView().runEpoch).toBe(epoch)
  })

  it('changes it when the host starts a new run, same seed or new', async () => {
    const c = await admitted()
    const first = c.session.renderView().runEpoch

    c.deliver(gameStart(1))
    c.deliver(go())
    await flush()
    const second = c.session.renderView().runEpoch
    expect(second).not.toBe(first)

    c.deliver(gameStart(48))
    c.deliver(go())
    await flush()
    expect(c.session.renderView().runEpoch).not.toBe(second)
  })

  it('changes it when a rejoin finds the host on a DIFFERENT run', async () => {
    const c = await admitted()
    const epoch = c.session.renderView().runEpoch

    c.emit({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
    c.emit({ type: 'peerConnected', peer: 'host' })
    c.deliver(gameStart(48))
    c.deliver(go())
    await flush()

    expect(c.session.renderView().runEpoch).not.toBe(epoch)
  })
})

describe('a host changes runEpoch only on a fresh run', () => {
  it('changes it on "Run it back" and on "New Seed", and not while the run plays', () => {
    const host = new HostSession(1, { sample: () => emptyInput() })
    const first = host.renderView().runEpoch
    for (let i = 0; i < 30; i++) host.tick()
    expect(host.renderView().runEpoch).toBe(first)

    host.restart()
    const replay = host.renderView().runEpoch
    expect(replay).not.toBe(first)

    host.restart(48)
    expect(host.renderView().runEpoch).not.toBe(replay)
  })
})
