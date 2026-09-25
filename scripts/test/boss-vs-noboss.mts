/** Does an ACTIVE BOSS FIGHT change the self-bind freeze rate at restart?
 *  Same seed pairs, run twice: with the boss fight, and without it. */
import { emptyInput } from '../../src/game/types'
import type { InputSource } from '../../src/input/input'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../../src/net/types'
import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'

class Hub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  hold: Map<PeerId, Uint8Array[]> | null = null
  constructor() {
    this.hostTransport = {
      role: 'host', maxPacket: 180, start: async () => {}, stop: async () => {},
      sendPacket: (peer, bytes) => Promise.resolve().then(() => {
        if (this.hold) { const a = this.hold.get(peer) ?? []; a.push(new Uint8Array(bytes)); this.hold.set(peer, a); return }
        this.centrals.get(peer)?.(bytes)
      }),
      on: (h) => { this.hostHandler = h; return () => {} }, peers: () => [...this.centrals.keys()],
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
    return { session: new NetClientSession(name, input, t), peer,
      deliver: (b: Uint8Array) => ch?.({ type: 'data', peer: 'host', bytes: b }),
      connect: () => { void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer })); void Promise.resolve().then(() => ch?.({ type: 'peerConnected', peer: 'host' })) } }
  }
}
const stub = (): InputSource => ({ sample: () => ({ ...emptyInput() }) })
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) }
const groupMessages = (packets: Uint8Array[]) => {
  const g: { type: number; packets: Uint8Array[] }[] = []
  let cur: any = null, need = 0
  for (const p of packets) {
    if (need === 0) { const len = p[0] | (p[1] << 8); cur = { type: p[2], packets: [] }; g.push(cur); need = 2 + len }
    cur.packets.push(p); need -= p.length; if (need < 0) need = 0
  }
  return g
}

const run = async (seedA: number, seedB: number, withBoss: boolean) => {
  const hub = new Hub()
  const host = new NetHostSession(seedA, 'Host', stub(), hub.hostTransport)
  const cs = [0, 1, 2].map((i) => hub.addClient(`P${i + 2}`, stub()))
  await host.start(); for (const c of cs) { await c.session.start(); c.connect() }
  await flush(); host.beginGame(); await flush()
  for (let i = 0; i < 15; i++) { host.tick(); for (const c of cs) c.session.tick(); await flush() }
  if (cs.some((c) => c.session.phase !== 'playing')) return null
  const w: any = host.world
  const boss = w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
  const hasBoss = !!boss && boss.archetype === 'boss'
  if (!hasBoss) return null
  let brood = 0
  if (withBoss) {
    for (const e of w.entities) if (e.playerCtl) { e.pos.x = boss.pos.x + 1.5; e.pos.y = boss.pos.y; if (e.health) e.health.hp = 1e6 }
    for (let i = 0; i < 200; i++) { host.tick(); for (const c of cs) c.session.tick(); await flush() }
    brood = w.entities.filter((e: any) => e.archetype === 'sporeling').length
  }
  for (const e of w.entities) if (e.playerCtl) e.dead = true
  host.tick(); await flush()
  hub.hold = new Map(); host.restart(seedB)
  for (let i = 0; i < 6; i++) { host.tick(); await flush() }
  const cap = hub.hold; hub.hold = null
  let frozen = 0; const detail: string[] = []
  for (const c of cs) {
    const groups = groupMessages(cap.get(c.peer) ?? [])
    const go = groups.find((g) => g.type === MsgType.Go)
    for (const g of groups) { if (g === go) continue; for (const p of g.packets) { c.deliver(p); await flush() } }
    const self = (c.session as any).self
    try { c.session.renderView() } catch (e) { frozen++; detail.push(`selfId=${(c.session as any).selfId} boundTo='${self?.archetype}' ${(e as Error).message}`) }
    if (go) for (const p of go.packets) { c.deliver(p); await flush() }
  }
  return { frozen, brood, detail }
}

const pairs: [number, number][] = [[1,48],[3,8],[6,8],[3,27],[6,27],[7,23],[5,2],[5,32],[1,8],[1,27],[2,16],[4,43]]
for (const withBoss of [false, true]) {
  let frozen = 0, clients = 0, brood = 0, runs = 0
  const detail: string[] = []
  for (const [a, b] of pairs) {
    const r = await run(a, b, withBoss)
    if (!r) continue
    runs++; frozen += r.frozen; clients += 3; brood += r.brood
    for (const d of r.detail) detail.push(`  seedA=${a} seedB=${b}: ${d}`)
  }
  console.log(`${withBoss ? 'WITH boss fight   ' : 'WITHOUT boss fight'}: ${frozen}/${clients} clients frozen across ${runs} restarts (brood summoned: ${brood})`)
  for (const d of detail.slice(0, 5)) console.log(d)
}
