/**
 * Tick-by-tick trace of ONE remote entity on a REAL host/client pair, so the
 * rendered motion can be inspected directly rather than through summary stats.
 * Also emits CSV for the plot in plot.mts.
 */
import { emptyInput, type InputCmd } from '../../src/game/types'
import type { InputSource } from '../../src/input/input'
import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../../src/net/types'
import { StreamReader } from '../../src/net/framing/chunkedStream'
import { writeFileSync } from 'node:fs'

const SIM_HZ = 30
const TICK_MS = 1000 / SIM_HZ
const BLE_MAX_PACKET = 180
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Hub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  private rnd: () => number
  private wire = new Map<string, { at: number; fn: () => void }[]>()
  private armed = new Set<string>()
  private lastDelivery = new Map<string, number>()
  private shadowTx = new StreamReader()
  snapSizes: number[] = []
  h2cPackets = 0
  h2cDropped = 0
  /** Set by the driver each loop so arrivals can be attributed to a tick. */
  nowTick = 0
  /** Ticks at which a Snapshot message was fully DELIVERED to the client. */
  arrivals: number[] = []
  private rxShadow = new StreamReader()
  constructor(
    private lossPct: number,
    private latencyMs: number,
    private jitterMs: number,
    seed = 0x5eed,
  ) {
    this.rnd = mulberry32(seed)
    this.hostTransport = {
      role: 'host',
      maxPacket: BLE_MAX_PACKET,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer, bytes) => this.tx(`h2c:${peer}`, bytes, (b) => this.centrals.get(peer)?.(b)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }
  private enqueue(dir: string, at: number, fn: () => void) {
    const q = this.wire.get(dir) ?? []
    if (q.length === 0) this.wire.set(dir, q)
    q.push({ at, fn })
    this.drain(dir)
  }
  private drain(dir: string) {
    if (this.armed.has(dir)) return
    const q = this.wire.get(dir)
    if (!q || !q.length) return
    this.armed.add(dir)
    setTimeout(
      () => {
        this.armed.delete(dir)
        const now = Date.now()
        while (q.length && q[0].at <= now) q.shift()!.fn()
        this.drain(dir)
      },
      Math.max(0, q[0].at - Date.now()),
    )
  }
  private async tx(dir: string, bytes: Uint8Array, deliver: (b: Uint8Array) => void) {
    if (dir.startsWith('h2c')) {
      this.h2cPackets++
      this.shadowTx.push(new Uint8Array(bytes), (m) => {
        if (m[0] === MsgType.Snapshot) this.snapSizes.push(m.length)
      })
    }
    const lost = this.rnd() * 100 < this.lossPct
    const copy = new Uint8Array(bytes)
    if (lost) {
      if (dir.startsWith('h2c')) this.h2cDropped++
      await sleep(4)
      return
    }
    const jit = (this.rnd() * 2 - 1) * this.jitterMs
    const delay = Math.max(0, this.latencyMs + jit)
    const at = Math.max(Date.now() + delay, (this.lastDelivery.get(dir) ?? 0) + 0.5)
    this.lastDelivery.set(dir, at)
    this.enqueue(dir, at, () => {
      if (dir.startsWith('h2c')) {
        this.rxShadow.push(new Uint8Array(copy), (m) => {
          if (m[0] === MsgType.Snapshot) this.arrivals.push(this.nowTick)
        })
      }
      deliver(copy)
    })
    await sleep(4)
  }
  addClient(name: string, input: InputSource, Ctor: new (n: string, i: InputSource, t: Transport) => NetClientSession = NetClientSession) {
    const peer: PeerId = 'central-1'
    let ch: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (b) => ch?.({ type: 'data', peer: 'host', bytes: b }))
    const t: Transport = {
      role: 'client',
      maxPacket: BLE_MAX_PACKET,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p, b) => this.tx(`c2h:${peer}`, b, (x) => this.hostHandler?.({ type: 'data', peer, bytes: x })),
      on: (h) => {
        ch = h
        return () => {}
      },
      peers: () => ['host'],
    }
    const session = new Ctor(name, input, t)
    return {
      session,
      connect: () => {
        this.hostHandler?.({ type: 'peerConnected', peer })
        ch?.({ type: 'peerConnected', peer: 'host' })
      },
    }
  }
}

class Scripted implements InputSource {
  cmd: InputCmd = emptyInput()
  sample() {
    return { ...this.cmd }
  }
  set(p: Partial<InputCmd>) {
    this.cmd = { ...emptyInput(), ...p }
  }
}

export interface TraceRow {
  tick: number
  hx: number
  hy: number
  cx: number
  cy: number
  arrived: boolean
  hostSpeed: number
  drawnSpeed: number
  lag: number
}

/** Which client implementation to instrument — shipped, or the pinned baseline
 * copy of origin/main's client, so the A/B is against real code on both sides. */
export type ClientCtor = new (name: string, input: InputSource, t: Transport) => NetClientSession

export const runTrace = async (
  lossPct: number,
  seconds: number,
  seed = 0x5eed,
  Ctor: ClientCtor = NetClientSession,
): Promise<{ rows: TraceRow[]; hub: Hub }> => {
  const hub = new Hub(lossPct, 25, 5, seed)
  const hostInput = new Scripted()
  const clientInput = new Scripted()
  const host = new NetHostSession(20260808, 'HostPhone', hostInput, hub.hostTransport)
  const c = hub.addClient('FriendPhone', clientInput, Ctor)
  await host.start()
  await c.session.start()
  c.connect()
  let dl = Date.now() + 8000
  while (Date.now() < dl && host.lobbyPlayers().length < 2) await sleep(20)
  host.beginGame()
  dl = Date.now() + 10000
  while (Date.now() < dl && c.session.phase !== 'playing') {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  if (c.session.phase !== 'playing') throw new Error('client never reached play')
  for (const e of host.world.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 }

  const hostAvatarId = host.renderView().self?.id
  const rows: TraceRow[] = []
  const endAt = Date.now() + seconds * 1000
  let stuck = 0
  let dir = 0
  const dirs = [
    { moveX: 1, moveY: 0 },
    { moveX: 0, moveY: 1 },
    { moveX: -1, moveY: 0 },
    { moveX: 0, moveY: -1 },
  ]
  hostInput.set({ ...dirs[0], aimX: 1, aimY: 0 })
  clientInput.set({})
  let tick = 0
  let lastArrivals = 0
  while (Date.now() < endAt) {
    hub.nowTick = tick
    host.tick()
    c.session.tick()
    const hv = host.renderView()
    const cv = c.session.renderView()
    const he = hv.entities.find((e) => e.id === hostAvatarId)
    const ce = cv.entities.find((e) => e.id === hostAvatarId)
    if (he && ce) {
      const prev = rows[rows.length - 1]
      const hostSpeed = prev ? Math.hypot(he.pos.x - prev.hx, he.pos.y - prev.hy) * SIM_HZ : 0
      const drawnSpeed = prev ? Math.hypot(ce.pos.x - prev.cx, ce.pos.y - prev.cy) * SIM_HZ : 0
      if (prev && hostSpeed < 0.5) stuck++
      else stuck = 0
      if (stuck > 6) {
        dir = (dir + 1) % 4
        hostInput.set({ ...dirs[dir], aimX: 1, aimY: 0 })
        stuck = 0
      }
      rows.push({
        tick,
        hx: he.pos.x,
        hy: he.pos.y,
        cx: ce.pos.x,
        cy: ce.pos.y,
        arrived: hub.arrivals.length > lastArrivals,
        hostSpeed,
        drawnSpeed,
        lag: Math.hypot(he.pos.x - ce.pos.x, he.pos.y - ce.pos.y),
      })
      lastArrivals = hub.arrivals.length
    }
    tick++
    await sleep(TICK_MS)
  }
  return { rows, hub }
}

const main = async () => {
  const loss = Number(process.argv[2] ?? 0)
  const secs = Number(process.argv[3] ?? 30)
  const { rows, hub } = await runTrace(loss, secs)
  const snapTicks = rows.filter((r) => r.arrived).length
  console.log(`ticks=${rows.length}  snapshot arrivals=${snapTicks}  ticks/snapshot=${(rows.length / snapTicks).toFixed(2)}`)
  console.log(`h2c packets ${hub.h2cPackets} sent / ${hub.h2cDropped} dropped`)
  console.log(`snapshot size mean ${(hub.snapSizes.reduce((a, b) => a + b, 0) / hub.snapSizes.length).toFixed(0)}B`)
  // Longest run of consecutive ticks where the host walked steadily.
  let best = { s: 0, e: 0 }
  let cur = -1
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].hostSpeed > 3.0) {
      if (cur < 0) cur = i
      if (i - cur > best.e - best.s) best = { s: cur, e: i }
    } else cur = -1
  }
  console.log(`\nlongest steady walk: ticks ${best.s}..${best.e} (${best.e - best.s} ticks)`)
  console.log('\n tick  snap  host_speed  drawn_speed   lag')
  for (const r of rows.slice(best.s, Math.min(best.e, best.s + 40))) {
    const mark = r.drawnSpeed < r.hostSpeed * 0.25 ? ' <-- STALL' : r.drawnSpeed > r.hostSpeed * 1.75 ? ' <-- DART' : ''
    console.log(
      `  ${String(r.tick).padStart(4)}  ${r.arrived ? ' ok ' : '    '}  ${r.hostSpeed.toFixed(2).padStart(8)}  ${r.drawnSpeed.toFixed(2).padStart(10)}  ${r.lag.toFixed(2).padStart(5)}${mark}`,
    )
  }
  writeFileSync(
    `tools/tween/trace-loss${loss}.csv`,
    'tick,hx,hy,cx,cy,arrived,hostSpeed,drawnSpeed,lag\n' +
      rows.map((r) => `${r.tick},${r.hx},${r.hy},${r.cx},${r.cy},${r.arrived ? 1 : 0},${r.hostSpeed},${r.drawnSpeed},${r.lag}`).join('\n'),
  )
  console.log(`\nwrote tools/tween/trace-loss${loss}.csv`)
  process.exit(0)
}
if (process.argv[1]?.includes('trace.mts')) void main()
