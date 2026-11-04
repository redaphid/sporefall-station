import { describe, expect, it } from 'vitest'
import { walledRoom, worldFromRows } from '../game/testkit'
import { emptyInput } from '../game/types'
import { StreamReader } from '../net/framing/chunkedStream'
import { MsgType, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * "Play again" restarts the host's tick counter at 0, and the client re-baselines
 * its newest-snapshot tick on GameStart. A snapshot of the OLD run that arrives
 * after that (the unordered WebRTC lane allows it) used to apply: it dragged the
 * client back into the previous run, and then every snapshot of the new run
 * looked older than it and was refused. The run epoch on each snapshot stops it.
 */

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const pair = async () => {
  let toHost: (e: TransportEvent) => void = () => {}
  let toClient: (e: TransportEvent) => void = () => {}
  /** Host→client messages in send order, held until the test delivers them. */
  const outbox: Uint8Array[] = []
  const reader = new StreamReader()
  const base = { medium: 'online' as const, maxPacket: 65536, start: async () => {}, stop: async () => {} }
  const hostT: Transport = {
    ...base,
    role: 'host',
    sendPacket: async (_p, bytes) => reader.push(bytes, (m) => outbox.push(m)),
    on: (h) => ((toHost = h), () => {}),
    peers: () => ['guest'],
  }
  const clientT: Transport = {
    ...base,
    role: 'client',
    sendPacket: async (_p, bytes) => toHost({ type: 'data', peer: 'guest', bytes }),
    on: (h) => ((toClient = h), () => {}),
    peers: () => ['host'],
  }
  const host = new NetHostSession(9, 'Host', { sample: () => emptyInput() }, hostT, 'casual', () => 0, (seed, mode) =>
    worldFromRows(walledRoom(14, 10), { seed, mode, hostile: false }),
  )
  const client = new NetClientSession('Guest', { sample: () => ({ ...emptyInput(), moveX: 1 }) }, clientT)
  const deliver = (msgs: Uint8Array[]): void => {
    for (const m of msgs) toClient({ type: 'data', peer: 'host', bytes: m, datagram: true })
  }
  toHost({ type: 'peerConnected', peer: 'guest' })
  toClient({ type: 'peerConnected', peer: 'host' })
  await flush()
  host.beginGame()
  await flush()
  deliver(outbox.splice(0))
  return { host, client, outbox, deliver }
}

const isSnapshot = (m: Uint8Array): boolean => m[0] === MsgType.Snapshot

describe('snapshot run epoch', () => {
  it('ignores a late snapshot of the previous run, and follows the new one', async () => {
    const { host, client, outbox, deliver } = await pair()
    for (let i = 0; i < 300; i++) host.tick()
    await flush()
    const oldRun = outbox.splice(0)
    deliver(oldRun)
    expect(client.renderView().simTick).toBeGreaterThan(250)
    const late = oldRun.filter(isSnapshot).at(-1)!

    host.restart()
    await flush()
    deliver(outbox.splice(0)) // GameStart + Go of the new run
    deliver([late])
    for (let i = 0; i < 9; i++) host.tick()
    await flush()
    deliver(outbox.splice(0))

    const view = client.renderView()
    expect(view.simTick).toBeLessThan(20)
    expect(view.self?.playerCtl).toBeDefined()
  })

  it('stamps every snapshot with the epoch its GameStart announced', async () => {
    const { host, outbox } = await pair()
    host.restart()
    host.restart()
    for (let i = 0; i < 6; i++) host.tick()
    await flush()
    const msgs = outbox.splice(0)
    const start = msgs.filter((m) => m[0] === MsgType.GameStart).at(-1)!
    const epoch = JSON.parse(new TextDecoder().decode(start.subarray(1))).epoch
    expect(epoch).toBe(2)
    const snaps = msgs.filter(isSnapshot)
    expect(snaps.length).toBeGreaterThan(0)
    for (const s of snaps) expect(s[5]).toBe(2)
  })

  it('asks for its admission again when the GameStart of a new run never came', async () => {
    const { host, client, outbox, deliver } = await pair()
    for (let i = 0; i < 30; i++) host.tick()
    await flush()
    deliver(outbox.splice(0))
    host.restart()
    await flush()
    outbox.splice(0) // the new run's GameStart and Go are lost
    for (let i = 0; i < 60; i++) {
      host.tick()
      await flush()
      deliver(outbox.splice(0))
    }
    const view = client.renderView()
    expect(client.phase).toBe('playing')
    expect(view.simTick).toBeGreaterThan(30)
    expect(view.simTick).toBeLessThan(70)
    expect(view.self?.playerCtl).toBeDefined()
  })
})

