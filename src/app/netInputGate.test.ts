import { describe, expect, it } from 'vitest'
import { walledRoom, worldFromRows } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import { frameMessage } from '../net/framing/chunkedStream'
import { encodeJson } from '../net/framing/codec'
import { edgeBits, encodeInputBundle, type InputRecord } from '../net/protocol/messages'
import { MsgType, PROTOCOL_VERSION, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { EDGE_WINDOW } from './inputGate'
import { NetHostSession } from './netHost'

/**
 * The host's input gate, driven through a real NetHostSession on an authored
 * room. Records reach it the two ways a WebRTC guest sends them: datagrams on
 * the unordered lane and framed packets on the reliable one, in any order.
 */

const PEER: PeerId = 'guest'

const rig = () => {
  let emit: (e: TransportEvent) => void = () => {}
  const transport: Transport = {
    role: 'host',
    medium: 'online',
    maxPacket: 65536,
    start: async () => {},
    stop: async () => {},
    sendPacket: async () => {},
    on: (h) => {
      emit = h
      return () => {}
    },
    peers: () => [PEER],
  }
  const host = new NetHostSession(
    5,
    'Host',
    { sample: () => emptyInput() },
    transport,
    'casual',
    () => 0,
    (seed, mode) => worldFromRows(walledRoom(14, 10), { seed, mode, hostile: false }),
  )
  const reliable = (msg: Uint8Array): void => {
    for (const bytes of frameMessage(msg, transport.maxPacket)) emit({ type: 'data', peer: PEER, bytes })
  }
  const datagram = (msg: Uint8Array): void => emit({ type: 'data', peer: PEER, bytes: msg, datagram: true })
  emit({ type: 'peerConnected', peer: PEER })
  reliable(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: 'Guest' }))
  host.beginGame()
  const ran: InputCmd[] = []
  host.onTickInputs = (inputs) => ran.push({ ...inputs.get(1)! })
  const avatar = () => host.world.entities.find((e) => e.playerCtl?.playerId === 1)!
  return { host, reliable, datagram, ran, avatar }
}

const rec = (seq: number, cmd: Partial<InputCmd> = {}, edges: Parameters<typeof edgeBits>[0] | null = null): InputRecord => ({
  cmd: { ...emptyInput(), seq, ...cmd },
  edges: edges ? edgeBits(edges) : 0,
})
const ROLL = { attack: false, interact: false, special: false, roll: true }

describe('input gate: continuous state and edges are gated apart', () => {
  it('fires a reliable roll that arrives after a later unreliable input (#155)', () => {
    const { host, reliable, datagram, ran, avatar } = rig()
    datagram(encodeInputBundle([rec(12, { moveX: 1 })]))
    reliable(encodeInputBundle([rec(10, { moveX: 1 }, ROLL)]))
    host.tick()
    expect(ran[0].roll).toBe(true)
    expect(avatar().playerCtl!.roll).toBeDefined()
    // The late record is older movement: the held state stays seq 12's.
    expect(host.peersBySlot.get(1)!.lastInputSeq).toBe(12)
    expect(ran[0].moveX).toBe(1)
    host.tick()
    expect(ran[1].roll).toBe(false)
  })

  it('fires each record once, whichever lane and however many copies deliver it', () => {
    const { host, reliable, datagram, ran } = rig()
    const roll = rec(20, {}, ROLL)
    datagram(encodeInputBundle([rec(18), roll]))
    reliable(encodeInputBundle([roll]))
    datagram(encodeInputBundle([rec(18), roll, rec(22)]))
    datagram(encodeInputBundle([roll, rec(22), rec(24)]))
    for (let i = 0; i < 4; i++) host.tick()
    expect(ran.filter((c) => c.roll)).toHaveLength(1)
  })

  it('folds the edges of every record in a bundle, not only the newest', () => {
    const { host, datagram, ran } = rig()
    datagram(
      encodeInputBundle([
        rec(2, { hotbar: 1 }),
        rec(4, {}, { attack: false, interact: false, special: false, throwItem: true }),
        rec(6, { modSwap: 0x0102 }),
        rec(8, { draftPick: 2 }),
      ]),
    )
    host.tick()
    expect(ran[0]).toMatchObject({ hotbar: 1, throwItem: true, modSwap: 0x0102, draftPick: 2 })
    host.tick()
    expect(ran[1]).toMatchObject({ hotbar: -1, throwItem: false })
    expect(ran[1].modSwap).toBeUndefined()
  })

  it('drops the edges of a record older than the window', () => {
    const { host, reliable, datagram, ran } = rig()
    datagram(encodeInputBundle([rec(1000)]))
    reliable(encodeInputBundle([rec(1000 - EDGE_WINDOW, {}, ROLL)]))
    reliable(encodeInputBundle([rec(1000 - EDGE_WINDOW + 1, {}, { attack: true, interact: false, special: false })]))
    host.tick()
    expect(ran[0].roll).toBe(false)
    expect(ran[0].attack).toBe(true)
  })

  it('fires a seq again once the u16 counter comes round to it', () => {
    const { host, datagram, ran } = rig()
    datagram(encodeInputBundle([rec(100, {}, ROLL)]))
    host.tick()
    for (let seq = 300; seq <= 65_536 + 100 - 2; seq += 200) datagram(encodeInputBundle([rec(seq & 0xffff)]))
    datagram(encodeInputBundle([rec(100, {}, ROLL)]))
    host.tick()
    expect(ran.map((c) => c.roll)).toEqual([true, true])
  })

  it('accepts any first seq, then follows the counter across the wrap', () => {
    const { host, datagram } = rig()
    const p = host.peersBySlot.get(1)!
    for (const [seq, ack] of [
      [65000, 65000],
      [65535, 65535],
      [10, 10],
      [5, 10],
    ]) {
      datagram(encodeInputBundle([rec(seq)]))
      expect(p.lastInputSeq).toBe(ack)
    }
  })
})
