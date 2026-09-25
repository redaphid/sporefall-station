/** Can the REAL SendQueue slot a Snapshot between GameStart and Go? */
import { SendQueue } from '../../src/net/channel/sendQueue'
import { encodeJson } from '../../src/net/framing/codec'
import { StreamReader } from '../../src/net/framing/chunkedStream'
import { isKnownMsgType, MsgType, type PeerId, type Transport } from '../../src/net/types'

const order: number[] = []
const reader = new StreamReader({ isValidStart: isKnownMsgType })
const transport: Transport = {
  role: 'host', maxPacket: 180,
  start: async () => {}, stop: async () => {},
  sendPacket: async (_p: PeerId, bytes: Uint8Array) => {
    await new Promise((r) => setTimeout(r, 0))
    reader.push(bytes, (m) => order.push(m[0]))
  },
  on: () => () => {}, peers: () => ['c1'],
}
const q = new SendQueue(transport, 'c1', () => {})
const name = (t: number) => Object.entries(MsgType).find(([, v]) => v === t)?.[0] ?? String(t)

// Model the real restart(): a reliable backlog already in flight (Events/State/
// LobbyState from the dying run), then GameStart+Go, with snapshots still being
// produced by the host's tick loop the whole time.
for (let i = 0; i < 6; i++) q.queueReliable(encodeJson(MsgType.Events, { tick: i, events: [{ type: 'death', x: 1, y: 1, entityId: i }] }))
q.queueSnapshot(new Uint8Array([MsgType.Snapshot, ...new Array(40).fill(1)]))
q.queueReliable(encodeJson(MsgType.GameStart, { seed: 5, players: [], floor: 1 }))
q.queueReliable(encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: 3 } }))
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 1))
  q.queueSnapshot(new Uint8Array([MsgType.Snapshot, ...new Array(40).fill(1)]))
}
await new Promise((r) => setTimeout(r, 200))

console.log('delivery order:', order.map(name).join(' -> '))
const gs = order.indexOf(MsgType.GameStart)
const go = order.indexOf(MsgType.Go)
const snapBetween = order.slice(gs + 1, go).filter((t) => t === MsgType.Snapshot).length
console.log(`\nGameStart at #${gs}, Go at #${go}, Snapshots in between: ${snapBetween}`)
console.log(snapBetween > 0
  ? 'CONFIRMED: the real SendQueue delivers a Snapshot between GameStart and Go.'
  : 'not reproduced in this ordering')
