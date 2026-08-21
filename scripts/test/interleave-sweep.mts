import { SendQueue } from '../../src/net/channel/sendQueue'
import { encodeJson } from '../../src/net/framing/codec'
import { StreamReader } from '../../src/net/framing/chunkedStream'
import { isKnownMsgType, MsgType, type PeerId, type Transport } from '../../src/net/types'

const trial = async (backlog: number) => {
  const order: number[] = []
  const reader = new StreamReader({ isValidStart: isKnownMsgType })
  const transport: Transport = {
    role: 'host', maxPacket: 180, start: async () => {}, stop: async () => {},
    sendPacket: async (_p: PeerId, b: Uint8Array) => { await new Promise((r) => setTimeout(r, 0)); reader.push(b, (m) => order.push(m[0])) },
    on: () => () => {}, peers: () => ['c1'],
  }
  const q = new SendQueue(transport, 'c1', () => {})
  for (let i = 0; i < backlog; i++) q.queueReliable(encodeJson(MsgType.Events, { tick: i, events: [] }))
  q.queueSnapshot(new Uint8Array([MsgType.Snapshot, ...new Array(40).fill(1)]))
  q.queueReliable(encodeJson(MsgType.GameStart, { seed: 5, players: [], floor: 1 }))
  q.queueReliable(encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: 3 } }))
  for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 1)); q.queueSnapshot(new Uint8Array([MsgType.Snapshot, ...new Array(40).fill(1)])) }
  await new Promise((r) => setTimeout(r, 150))
  const gs = order.indexOf(MsgType.GameStart), go = order.indexOf(MsgType.Go)
  const between = gs >= 0 && go > gs ? order.slice(gs + 1, go).filter((t) => t === MsgType.Snapshot).length : -1
  return { backlog, between, order: order.map((t) => (Object.entries(MsgType).find(([, v]) => v === t)?.[0] ?? t)).join(' ') }
}
for (let b = 0; b <= 8; b++) {
  const r = await trial(b)
  console.log(`backlog=${b}: snapshots between GameStart and Go = ${r.between}${r.between > 0 ? '   <-- REPRODUCED' : ''}`)
  if (r.between > 0) console.log(`   ${r.order}`)
}
