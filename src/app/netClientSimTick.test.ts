import { describe, expect, it } from 'vitest'
import { emptyInput } from '../game/types'
import { encodeJson } from '../net/framing/codec'
import { frameMessage } from '../net/framing/chunkedStream'
import { encodeSnapshot, type WireEntity } from '../net/protocol/messages'
import { MsgType, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'

/**
 * `RenderView.simTick` is the host tick a client's view reflects. The HUD reads
 * a DROP in it as "the host started a new run" (screens.ts drops the boss latch,
 * whose entity id the new world recycles). So the client must not report a
 * drop that did not happen: `GameStart` and `Go` re-baseline the snapshot
 * clock, and a ghost REJOIN to the same run passes through that window with
 * the boss still alive. Reporting 0 there would cost the player the boss bar
 * for the rest of the fight, since the reveal fires once per floor.
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

const admitAt = async (tick: number) => {
  const c = makeClient()
  await c.session.start()
  c.emit({ type: 'peerConnected', peer: 'host' })
  await flush()
  c.deliver(encodeJson(MsgType.Welcome, { slot: 1, token: 'tok' }))
  c.deliver(gameStart(1))
  c.deliver(go())
  c.deliver(snapshot(tick))
  await flush()
  expect(c.session.phase).toBe('playing')
  expect(c.session.renderView().simTick).toBe(tick)
  return c
}

describe('a net client reports the host tick without inventing a drop', () => {
  it('a ghost rejoin to the SAME run keeps simTick at the last known host tick until the next snapshot', async () => {
    const c = await admitAt(900)

    c.emit({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
    expect(c.session.phase).toBe('reconnecting')
    c.emit({ type: 'peerConnected', peer: 'host' })
    c.deliver(gameStart(1))
    c.deliver(go())
    await flush()

    expect(c.session.phase).toBe('playing')
    expect(c.session.renderView().simTick).toBe(900)

    c.deliver(snapshot(905))
    await flush()
    expect(c.session.renderView().simTick).toBe(905)
  })

  it('a NEW run shows the drop as soon as its first snapshot lands', async () => {
    const c = await admitAt(900)

    c.deliver(gameStart(48))
    c.deliver(go())
    await flush()
    expect(c.session.renderView().simTick).toBe(900)

    c.deliver(snapshot(3, 'thug'))
    await flush()
    expect(c.session.renderView().simTick).toBe(3)
  })
})
