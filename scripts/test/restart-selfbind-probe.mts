/** End-to-end: host "play again" with a NEW seed + a snapshot delivered between
 *  GameStart and Go => client binds `self` to a non-player entity => renderView throws. */
import { emptyInput, type InputCmd } from '../../src/game/types'
import type { InputSource } from '../../src/input/input'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../../src/net/types'
import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'

class Hub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  /** When set, host->client packets are captured instead of delivered. */
  hold: Uint8Array[] | null = null
  constructor() {
    this.hostTransport = {
      role: 'host', maxPacket: 180, start: async () => {}, stop: async () => {},
      sendPacket: (peer, bytes) => Promise.resolve().then(() => {
        if (this.hold) { this.hold.push(new Uint8Array(bytes)); return }
        this.centrals.get(peer)?.(bytes)
      }),
      on: (h) => { this.hostHandler = h; return () => {} },
      peers: () => [...this.centrals.keys()],
    }
  }
  addClient(name: string, input: InputSource) {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let ch: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (b) => void Promise.resolve().then(() => ch?.({ type: 'data', peer: 'host', bytes: b })))
    const t: Transport = {
      role: 'client', maxPacket: 180, start: async () => {}, stop: async () => {},
      sendPacket: (_p, bytes) => Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes })),
      on: (h) => { ch = h; return () => {} }, peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, t)
    return { session, peer, deliver: (b: Uint8Array) => ch?.({ type: 'data', peer: 'host', bytes: b }),
      connect: () => { void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer })); void Promise.resolve().then(() => ch?.({ type: 'peerConnected', peer: 'host' })) } }
  }
}
const stub = (): InputSource => ({ sample: () => ({ ...emptyInput() }) })
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0)) }

const run = async (seedA: number, seedB: number) => {
  const hub = new Hub()
  const host = new NetHostSession(seedA, 'Host', stub(), hub.hostTransport)
  const c = hub.addClient('Friend', stub())
  await host.start(); await c.session.start(); c.connect(); await flush()
  host.beginGame(); await flush()
  for (let i = 0; i < 30; i++) { host.tick(); c.session.tick(); await flush() }
  if (c.session.phase !== 'playing') return { err: `phase=${c.session.phase}` }
  const staleSelfId = (c.session as any).selfId
  c.session.renderView() // fine so far

  // The party wipes; the host presses "New Seed" (restart with a different seed).
  hub.hold = []                     // capture host->client bytes so we control order
  host.restart(seedB)
  for (let i = 0; i < 6; i++) { host.tick(); await flush() }
  const captured = hub.hold; hub.hold = null

  // Reassemble which captured packets belong to GameStart / Go / Snapshot is done
  // by the client's own StreamReader; we simply deliver in the order the real
  // SendQueue produces at backlog === 3 (mod 4): GameStart, Snapshot, Go.
  // Here we deliver everything EXCEPT the Go frame first, then Go last.
  // (Packets are 180B chunks of framed messages; identify by the type byte at
  //  offset 2 of a message-start packet.)
  const groups: { type: number; packets: Uint8Array[] }[] = []
  let cur: { type: number; packets: Uint8Array[] } | null = null
  let need = 0
  for (const p of captured) {
    if (need === 0) {
      const len = p[0] | (p[1] << 8)
      cur = { type: p[2], packets: [] }
      groups.push(cur)
      need = 2 + len
    }
    cur!.packets.push(p)
    need -= p.length
    if (need <= 0) need = 0
  }
  const goGroup = groups.find((g) => g.type === MsgType.Go)
  const rest = groups.filter((g) => g !== goGroup)
  for (const g of rest) for (const p of g.packets) { c.deliver(p); await flush() }
  const boundBeforeGo = (c.session as any).self
  let threw: string | null = null
  try { c.session.renderView() } catch (e) { threw = (e as Error).message }
  if (goGroup) for (const p of goGroup.packets) { c.deliver(p); await flush() }

  const newSelfId = (c.session as any).selfId
  return {
    staleSelfId, newSelfId,
    boundArchetype: boundBeforeGo?.archetype ?? '(none)',
    boundHasPlayerCtl: boundBeforeGo ? !!boundBeforeGo.playerCtl : null,
    renderViewThrew: threw,
    groups: groups.map((g) => Object.entries(MsgType).find(([, v]) => v === g.type)?.[0] ?? g.type).join(','),
  }
}

for (const [a, b] of [[20260808, 1234], [20260808, 7], [1234, 99], [99, 42], [7, 20260808], [42, 1234], [5, 6], [11, 23]] as [number, number][]) {
  const r = await run(a, b)
  console.log(`seedA=${a} seedB=${b}  ${JSON.stringify(r)}`)
}
