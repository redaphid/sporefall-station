/**
 * REAL end-to-end measurement: the actual NetHostSession + NetClientSession,
 * over a 180-byte BLE-like link with per-packet loss, instrumented every tick.
 * Validates (or refutes) the analytic filter model in model.mts.
 *
 * Measures the HOST's avatar as seen BY THE CLIENT — a remote entity going
 * through the SMOOTH/SNAP_DIST path in netClient.ts:454.
 */
import { emptyInput, type InputCmd } from '../../src/game/types'
import type { InputSource } from '../../src/input/input'
import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../../src/net/types'
import { StreamReader } from '../../src/net/framing/chunkedStream'

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
  /** Send-side shadow: message sizes, so we know real snapshot fragmentation. */
  private shadowTx = new StreamReader()
  snapSizes: number[] = []
  snapsSent = 0
  h2cPackets = 0
  h2cDropped = 0
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
        if (m[0] === MsgType.Snapshot) {
          this.snapsSent++
          this.snapSizes.push(m.length)
        }
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
    this.enqueue(dir, at, () => deliver(copy))
    await sleep(4)
  }
  addClient(name: string, input: InputSource) {
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
    const session = new NetClientSession(name, input, t)
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

interface Row {
  tick: number
  hx: number
  hy: number
  cx: number
  cy: number
}

const measure = async (lossPct: number, seconds: number, label: string) => {
  const hub = new Hub(lossPct, 25, 5)
  const hostInput = new Scripted()
  const clientInput = new Scripted()
  const host = new NetHostSession(20260808, 'HostPhone', hostInput, hub.hostTransport)
  const c = hub.addClient('FriendPhone', clientInput)
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
  if (c.session.phase !== 'playing') {
    console.log(`${label}: client never reached play`)
    return null
  }
  for (const e of host.world.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 }

  // Host walks; client stands still so its own prediction does not confound the
  // remote-entity measurement. Direction is re-rolled when it stalls on a wall.
  hostInput.set({ moveX: 1, moveY: 0.15, aimX: 1, aimY: 0 })
  clientInput.set({})

  const hostAvatarId = host.renderView().self?.id
  const rows: Row[] = []
  const endAt = Date.now() + seconds * 1000
  let stuck = 0
  let dir = 0
  while (Date.now() < endAt) {
    host.tick()
    c.session.tick()
    const hv = host.renderView()
    const cv = c.session.renderView()
    const he = hv.entities.find((e) => e.id === hostAvatarId)
    const ce = cv.entities.find((e) => e.id === hostAvatarId)
    if (he && ce) {
      const prev = rows[rows.length - 1]
      if (prev && Math.hypot(he.pos.x - prev.hx, he.pos.y - prev.hy) * SIM_HZ < 0.5) stuck++
      else stuck = 0
      // Wall-bound: turn, so we keep collecting genuinely-moving samples.
      if (stuck > 8) {
        dir = (dir + 1) % 4
        const dirs = [
          { moveX: 1, moveY: 0.15 },
          { moveX: 0, moveY: 1 },
          { moveX: -1, moveY: -0.15 },
          { moveX: 0, moveY: -1 },
        ]
        hostInput.set({ ...dirs[dir], aimX: 1, aimY: 0 })
        stuck = 0
      }
      rows.push({ tick: rows.length, hx: he.pos.x, hy: he.pos.y, cx: ce.pos.x, cy: ce.pos.y })
    }
    await sleep(TICK_MS)
  }
  return { rows, hub }
}

const f = (n: number, d = 2) => n.toFixed(d).padStart(8)

const report = (label: string, rows: Row[], hub: Hub) => {
  const speeds: number[] = []
  const errs: number[] = []
  const trueSpeeds: number[] = []
  const idx: number[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const p = rows[i - 1]
    const ts = Math.hypot(r.hx - p.hx, r.hy - p.hy) * SIM_HZ
    if (ts < 1.0) continue // host blocked by a wall / not walking: not a fair sample
    trueSpeeds.push(ts)
    speeds.push(Math.hypot(r.cx - p.cx, r.cy - p.cy) * SIM_HZ)
    errs.push(Math.hypot(r.hx - r.cx, r.hy - r.cy))
    idx.push(i)
  }
  if (speeds.length < 30) {
    console.log(`${label}: too few moving samples (${speeds.length})`)
    return
  }
  // Jerk only across CONSECUTIVE ticks, so a gap in the filtered series does not
  // fake a discontinuity.
  const jerks: number[] = []
  for (let i = 1; i < speeds.length; i++) if (idx[i] === idx[i - 1] + 1) jerks.push(Math.abs(speeds[i] - speeds[i - 1]))
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const ts = mean(trueSpeeds)
  const pkts = hub.snapSizes.map((s) => Math.ceil((2 + s) / BLE_MAX_PACKET))
  console.log(`\n--- ${label} ---`)
  console.log(`  moving samples          ${speeds.length}   host true speed ${ts.toFixed(2)} tiles/s`)
  console.log(
    `  snapshot msg size       mean ${mean(hub.snapSizes).toFixed(0)}B  max ${Math.max(...hub.snapSizes)}B  -> ${mean(pkts).toFixed(2)} BLE packets/snapshot (max ${Math.max(...pkts)})`,
  )
  console.log(
    `  h2c packets             ${hub.h2cPackets} sent, ${hub.h2cDropped} dropped (${((hub.h2cDropped / hub.h2cPackets) * 100).toFixed(1)}%)`,
  )
  console.log(
    `  positional lag (tiles)  mean ${f(mean(errs))}  max ${f(Math.max(...errs))}   = ${((mean(errs) / ts) * 1000).toFixed(0)} ms behind`,
  )
  console.log(`  RENDERED speed (t/s)    min  ${f(Math.min(...speeds))}  max ${f(Math.max(...speeds))}  mean ${f(mean(speeds))}`)
  console.log(
    `  speed swing             ${(Math.max(...speeds) / Math.max(0.001, Math.min(...speeds))).toFixed(1)}x   (true speed is ~CONSTANT ${ts.toFixed(2)})`,
  )
  console.log(`  rms jerk (t/s per tick) ${f(Math.sqrt(mean(jerks.map((j) => j * j))))}   max ${f(Math.max(...jerks))}`)
  console.log(
    `  visible STALL ticks     ${((speeds.filter((s) => s < ts * 0.25).length / speeds.length) * 100).toFixed(1)}%  (drawn <25% of true speed)`,
  )
  console.log(
    `  visible DART ticks      ${((speeds.filter((s) => s > ts * 1.75).length / speeds.length) * 100).toFixed(1)}%  (drawn >175% of true speed)`,
  )
}

const main = async () => {
  const runs: [number, number, string][] = [
    [0, 25, 'REAL: clean link, 0% packet loss'],
    [2, 25, 'REAL: 2% packet loss'],
    [5, 30, 'REAL: 5% packet loss'],
    [10, 30, 'REAL: 10% packet loss'],
  ]
  for (const [loss, secs, label] of runs) {
    const r = await measure(loss, secs, label)
    if (r) report(label, r.rows, r.hub)
  }
  process.exit(0)
}
void main()
