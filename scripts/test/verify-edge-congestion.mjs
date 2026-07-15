// Repro: client-side input edges dropped when the snapshot-lane slot is
// overwritten while a prior packet is still in flight (BLE stall).
import { SendQueue } from '../../src/net/channel/sendQueue.ts'
import { StreamReader } from '../../src/net/framing/chunkedStream.ts'
import { encodeInput, decodeInput } from '../../src/net/protocol/messages.ts'
import { emptyInput } from '../../src/game/types.ts'

// A transport that holds the FIRST sendPacket in flight until released, so
// later queued snapshots pile onto the capacity-1 slot and overwrite each other.
let release
const gate = new Promise((r) => (release = r))
let firstTaken = false
const received = []
const reader = new StreamReader()
const transport = {
  role: 'client', maxPacket: 180,
  start: async () => {}, stop: async () => {},
  sendPacket: async (_peer, bytes) => {
    if (!firstTaken) { firstTaken = true; await gate }
    reader.push(bytes, (m) => received.push(decodeInput(m)))
  },
  on: () => () => {}, peers: () => ['host'],
}

const q = new SendQueue(transport, 'host', () => {})
const noEdges = { attack: false, interact: false, special: false }

// Packet #1 (seq 1, no edge) — becomes the in-flight packet, gated.
q.queueSnapshot(encodeInput({ ...emptyInput(), seq: 1 }, noEdges))
await new Promise((r) => setTimeout(r, 0))
// Packet #2 (seq 2) carries the ATTACK edge — the player's tap.
q.queueSnapshot(encodeInput({ ...emptyInput(), seq: 2 }, { ...noEdges, attack: true }))
// Packet #3 (seq 3, no edge) overwrites #2 in the slot before it can be sent.
q.queueSnapshot(encodeInput({ ...emptyInput(), seq: 3 }, noEdges))
// Release the stall — the queue drains what's left.
release()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

const seqs = received.map((r) => r.cmd.seq)
const attackEdgeArrived = received.some((r) => (r.edges & 1) !== 0)
console.log('host received seqs:', seqs)
console.log('attack edge arrived at host:', attackEdgeArrived)
console.log(attackEdgeArrived ? 'OK — edge survived' : 'BUG — attack edge (seq 2) was DROPPED on the wire')
