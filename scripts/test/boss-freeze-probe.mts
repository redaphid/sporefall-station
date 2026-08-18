/**
 * Exploratory probe: "we let the boss out and everybody else froze".
 *
 * Runs the REAL NetHostSession + N NetClientSessions over a microtask loopback
 * (the netCoop MockHub shape), drives the party to a boss floor, breaches the
 * objective gate, and reports the FIRST throw from either side plus whether
 * clients keep applying snapshots.
 */
import { emptyInput, type InputCmd } from '../../src/game/types'
import type { InputSource } from '../../src/input/input'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../../src/net/types'
import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'
import { nextFloor } from '../../src/game/systems/missions'

class MockHub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  constructor() {
    const deliver = (fn: (() => void) | undefined): Promise<void> => Promise.resolve().then(() => fn?.())
    this.hostTransport = {
      role: 'host', maxPacket: 180,
      start: async () => {}, stop: async () => {},
      sendPacket: (peer, bytes) => deliver(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => { this.hostHandler = h; return () => {} },
      peers: () => [...this.centrals.keys()],
    }
  }
  addClient(name: string, input: InputSource) {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let ch: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (b) => void Promise.resolve().then(() => ch?.({ type: 'data', peer: 'host', bytes: b })))
    const t: Transport = {
      role: 'client', maxPacket: 180,
      start: async () => {}, stop: async () => {},
      sendPacket: (_p, bytes) => Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes })),
      on: (h) => { ch = h; return () => {} },
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, t)
    return { session, connect: () => {
      void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
      void Promise.resolve().then(() => ch?.({ type: 'peerConnected', peer: 'host' }))
    } }
  }
}

const stub = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)) }

const CLIENTS = 3

const run = async (seed: number, targetFloor: number) => {
  const hub = new MockHub()
  const host = new NetHostSession(seed, 'Host', stub(), hub.hostTransport)
  const clients = Array.from({ length: CLIENTS }, (_, i) => hub.addClient(`C${i + 1}`, stub()))
  await host.start()
  for (const c of clients) { await c.session.start(); c.connect() }
  await flush()
  host.beginGame()
  await flush()
  for (let i = 0; i < 12; i++) { host.tick(); for (const c of clients) c.session.tick(); await flush() }

  // Descend to the requested floor using the real transition.
  while (host.world.floor < targetFloor) {
    nextFloor(host.world)
    for (let i = 0; i < 20; i++) { host.tick(); for (const c of clients) c.session.tick(); await flush() }
  }

  const w = host.world
  const tmpl = w.mission.template
  const gateId = w.mission.objectiveDoorId
  if (tmpl !== 'assassinate' && tmpl !== 'infiltrate') return { skip: `mission=${tmpl}` }
  if (gateId === undefined) return { skip: 'no objective gate' }
  const gate = w.byId.get(gateId)
  if (!gate?.door) return { skip: 'gate missing' }

  // Put the whole party at the gate so the boss reveal can fire.
  for (const e of w.entities) {
    if (!e.playerCtl) continue
    e.pos.x = gate.pos.x; e.pos.y = gate.pos.y + 1
    e.prevPos.x = e.pos.x; e.prevPos.y = e.pos.y
    if (e.health) { e.health.hp = e.health.max }
  }
  for (let i = 0; i < 10; i++) { host.tick(); for (const c of clients) c.session.tick(); await flush() }

  // LET THE BOSS OUT.
  gate.door.locked = false
  gate.door.open = true

  const snapsBefore = clients.map((c) => (c.session as any).lastSnapTick)
  let hostThrow: string | null = null
  const clientThrows: (string | null)[] = clients.map(() => null)

  for (let i = 0; i < 240; i++) {
    if (!hostThrow) {
      try { host.tick() } catch (e) { hostThrow = `tick+${i}: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}` }
    }
    clients.forEach((c, ci) => {
      if (clientThrows[ci]) return
      try { c.session.tick(); c.session.renderView() } catch (e) { clientThrows[ci] = `tick+${i}: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}` }
    })
    await flush()
  }
  const snapsAfter = clients.map((c) => (c.session as any).lastSnapTick)
  return {
    floor: w.floor, tmpl, seed,
    entities: w.entities.length,
    hostThrow,
    clientThrows,
    advanced: snapsAfter.map((a, i) => a - snapsBefore[i]),
    phases: clients.map((c) => c.session.phase),
  }
}

const main = async () => {
  for (const seed of [20260808, 1234, 7, 42, 99]) {
    for (const floor of [1, 2, 3]) {
      try {
        const r = await run(seed, floor)
        console.log(JSON.stringify({ seed, floor, ...r }))
      } catch (e) {
        console.log(JSON.stringify({ seed, floor, HARNESS_THROW: (e as Error).stack?.split('\n').slice(0, 6).join(' | ') }))
      }
    }
  }
}
void main()
