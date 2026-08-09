/**
 * DETERMINISTIC ECS simulated-environment matrix — the every-push CI gate.
 *
 * Two worlds from ONE seed, joined by a configurable channel, asserting
 * convergence per tick. Divergence names the ENTITY, the TICK and the FIELD.
 *
 * Why this exists alongside `e2e/net-conditions.mts`:
 *   net-conditions.mts is the deep, realistic, REAL-TIME rig — it drives the
 *   sessions with `sleep()` and measures with `Date.now()`. That makes it the
 *   right tool for soaks and rejoin, and the WRONG tool for every push: under
 *   CI load its 60s profiles sit close enough to their thresholds to flip. That
 *   is not hypothetical — `ctl-reordering-clean-60s` went red on a loaded box
 *   and green three times when run alone.
 *
 *   So this harness removes wall-clock time entirely. Latency and jitter are
 *   counted in TICKS, delivery is pumped by an explicit tick counter, and every
 *   random decision comes from one seeded PRNG. Same seed → same run, on any
 *   machine, at any load. A CI gate that can flip at random teaches people to
 *   ignore it, which is worse than having no gate.
 *
 * Determinism has one precondition, and it is checked below: the happy path of
 * the net code must contain no timers. It does not — the only `setTimeout`s in
 * `src/net/` and the sessions are on the send-RETRY and RECONNECT paths. So
 * this harness models a dropout as a silent CHANNEL blackout (the link stays
 * nominally up and simply delivers nothing), never as a transport reconnect.
 * That is also the more dangerous case in the field, because nothing notices.
 *
 * WHAT THIS DOES NOT COVER — printed at the end of every run, on purpose:
 *   • the real radio: no RF interference, no range, no coexistence with Wi-Fi
 *   • `src/net/transport/bleTransport.ts` itself — the Capacitor plugin, GATT,
 *     MTU negotiation and notification back-pressure are all stubbed here
 *   • the packaged APK, Android's BLE stack, and its per-handset limit on
 *     simultaneous centrals (the thing that actually caps player count)
 *   • phones in pockets: bodies, battery saver, doze, and screen-off throttling
 *   A green run here means the PROTOCOL and the SIM agree under a modelled
 *   channel. It is not evidence that four phones work around a campfire.
 *
 * Run: npx tsx e2e/net-matrix.mts [--seed <n>] [--only <profile>] [--self-test]
 * Gated on exit code.
 */
import type { Entity } from '../src/game/entity'
import { emptyInput, type InputCmd } from '../src/game/types'
import type { InputSource } from '../src/input/input'
import type { RenderView } from '../src/app/session'
import { NetClientSession } from '../src/app/netClient'
import { NetHostSession } from '../src/app/netHost'
import { SNAPSHOT_INTERVAL_TICKS, type PeerId, type Transport, type TransportEvent } from '../src/net/types'

const SIM_HZ = 30
/** bleTransport.ts MAX_PACKET — the conservative post-negotiation floor. */
const BLE_MAX_PACKET = 180
/** netHost.ts INTEREST_RADIUS. Entities well inside this must reach the client. */
const INTEREST_RADIUS = 14

// ------------------------------------------------------------ BLE bandwidth
//
// These are the budget the gate enforces. They are ASSUMPTIONS, stated here so
// they can be argued with rather than buried, and echoed in the run output.
//
// What the code actually asks the radio for (verified by grep, not memory):
//   • `requestMtu({ mtu: 512 })` on the CLIENT only, clamped to 244; the HOST
//     peripheral writes at the 180-byte conservative floor (MAX_PACKET).
//   • NO `requestConnectionPriority(...)` call anywhere → Android's default
//     CONNECTION_PRIORITY_BALANCED applies, nominally ~30ms interval.
//   • NO `setPreferredPhy(...)` anywhere → 1M PHY, not 2M.
// So the app takes whatever the stack gives it. The budget below assumes the
// BALANCED default and a conservative 3 notifications per connection event
// (Android commonly permits 4-6 with Data Length Extension; 3 leaves margin).
//
//   180 B x 3 packets / 0.030 s = 18,000 B/s per link.
const PER_PEER_BUDGET_BPS = 18_000
// With several centrals a single peripheral radio TIME-SLICES connection events
// between them, so host aggregate is NOT per-link x N. This is the shared
// ceiling the host must fit all its clients inside.
const AGGREGATE_BUDGET_BPS = 24_000

/** Same mulberry32 the sim uses — every channel decision is reproducible. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Yield to the microtask/macrotask queue WITHOUT consuming wall-clock time.
 * `setImmediate` orders deterministically and never depends on elapsed time,
 * so the async plumbing in SendQueue settles identically on every machine. */
const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

// -------------------------------------------------------------- the channel

export interface Channel {
  /** One-way delay, in TICKS (30Hz), not milliseconds. */
  delayTicks: number
  /** Extra uniform delay of 0..jitterTicks, from the seeded PRNG. */
  jitterTicks: number
  /** Independent per-packet loss. */
  lossPct: number
  /** false = FIFO, which is what BLE actually gives you within a connection.
   * true = the channel may deliver out of order (a deliberate control). */
  reorder: boolean
  /** A silent blackout: the link stays nominally up and delivers nothing. */
  dropout?: { atTick: number; durTicks: number }
  maxPacket: number
}

interface LinkStat {
  packets: number
  bytes: number
  dropped: number
}

interface Pending {
  due: number
  seq: number
  link: string
  bytes: number
  deliver: (b: Uint8Array) => void
  payload: Uint8Array
}

/**
 * A deterministic multi-peer hub. One host peripheral, N centrals. Packets are
 * scheduled onto a TICK, not a timestamp; `pump()` delivers everything due.
 */
class DetHub {
  tickNow = 0
  private rnd: () => number
  private queue: Pending[] = []
  private seq = 0
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  readonly stats = new Map<string, LinkStat>()
  readonly hostTransport: Transport

  constructor(
    private cond: Channel,
    seed: number,
  ) {
    this.rnd = mulberry32(seed)
    this.hostTransport = {
      role: 'host',
      maxPacket: cond.maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer, bytes) =>
        this.transmit(`h2c:${peer}`, bytes, (b) => this.centrals.get(peer)?.(b)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  private stat(link: string): LinkStat {
    let s = this.stats.get(link)
    if (!s) {
      s = { packets: 0, bytes: 0, dropped: 0 }
      this.stats.set(link, s)
    }
    return s
  }

  private transmit(link: string, bytes: Uint8Array, deliver: (b: Uint8Array) => void): Promise<void> {
    const s = this.stat(link)
    s.packets++
    s.bytes += bytes.length
    const d = this.cond.dropout
    const blacked = d != null && this.tickNow >= d.atTick && this.tickNow < d.atTick + d.durTicks
    if (blacked || this.rnd() * 100 < this.cond.lossPct) {
      s.dropped++
      return Promise.resolve()
    }
    const jitter = this.cond.jitterTicks > 0 ? Math.floor(this.rnd() * (this.cond.jitterTicks + 1)) : 0
    this.queue.push({
      due: this.tickNow + this.cond.delayTicks + jitter,
      seq: this.seq++,
      link,
      bytes: bytes.length,
      deliver,
      payload: new Uint8Array(bytes),
    })
    return Promise.resolve()
  }

  /** Deliver everything due at the current tick. */
  pump(tamper: ((b: Uint8Array) => Uint8Array) | null): void {
    // Group by link so FIFO is enforced per connection, as BLE does.
    const byLink = new Map<string, Pending[]>()
    for (const p of this.queue) {
      const arr = byLink.get(p.link)
      if (arr) arr.push(p)
      else byLink.set(p.link, [p])
    }
    const going: Pending[] = []
    for (const arr of byLink.values()) {
      arr.sort((a, b) => a.seq - b.seq)
      if (this.cond.reorder) {
        for (const p of arr) if (p.due <= this.tickNow) going.push(p)
      } else {
        // In-order: a delayed packet holds up everything behind it.
        for (const p of arr) {
          if (p.due > this.tickNow) break
          going.push(p)
        }
      }
    }
    if (going.length === 0) return
    const send = this.cond.reorder ? going.sort((a, b) => a.due - b.due || a.seq - b.seq) : going
    const goneSeqs = new Set(send.map((p) => p.seq))
    this.queue = this.queue.filter((p) => !goneSeqs.has(p.seq))
    for (const p of send) p.deliver(tamper ? tamper(p.payload) : p.payload)
  }

  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void; peer: PeerId } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) => clientHandler?.({ type: 'data', peer: 'host', bytes }))

    const clientTransport: Transport = {
      role: 'client',
      maxPacket: this.cond.maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p, bytes) =>
        this.transmit(`c2h:${peer}`, bytes, (b) => this.hostHandler?.({ type: 'data', peer, bytes: b })),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => (this.centrals.has(peer) ? ['host'] : []),
    }
    const session = new NetClientSession(name, input, clientTransport)
    return {
      session,
      peer,
      connect: () => {
        this.hostHandler?.({ type: 'peerConnected', peer })
        clientHandler?.({ type: 'peerConnected', peer: 'host' })
      },
    }
  }
}

/** An input source a scenario steers tick by tick. */
class ScriptedInput implements InputSource {
  cmd: InputCmd = emptyInput()
  sample(): InputCmd {
    return { ...this.cmd }
  }
  set(patch: Partial<InputCmd>): void {
    this.cmd = { ...emptyInput(), ...patch }
  }
}

// ------------------------------------------------------------- convergence

const identityOf = (e: Entity): string => `${e.kind}:${e.archetype}`

interface Divergence {
  /** The FIELD that disagrees. */
  code: string
  /** Stable key, so we can tell a persistent desync from ordinary flight time. */
  key: string
  /** The TICK it was observed on. */
  tick: number
  /** The ENTITY, where the divergence has one. */
  entity: number | null
  detail: string
}

/** Samples are every 6 ticks. A divergence must survive this many consecutive
 * samples to be real: below it we are looking at snapshot cadence, not desync. */
const PERSIST_SAMPLES = 10

const compare = (host: RenderView, client: RenderView, tol: number, tick: number): Divergence[] => {
  const out: Divergence[] = []
  const hostById = new Map(host.entities.map((e) => [e.id, e]))

  for (const ce of client.entities) {
    const he = hostById.get(ce.id)
    if (!he) {
      out.push({
        code: 'GHOST', key: `GHOST:${ce.id}`, tick, entity: ce.id,
        detail: `client renders entity ${ce.id} (${identityOf(ce)}) that the host does not have`,
      })
      continue
    }
    if (identityOf(he) !== identityOf(ce)) {
      out.push({
        code: 'IDENTITY', key: `IDENTITY:${ce.id}`, tick, entity: ce.id,
        detail: `entity ${ce.id}: host shows "${identityOf(he)}", client shows "${identityOf(ce)}"`,
      })
    }
    const d = Math.hypot(he.pos.x - ce.pos.x, he.pos.y - ce.pos.y)
    if (d > tol) {
      out.push({
        code: 'POSITION', key: `POSITION:${ce.id}`, tick, entity: ce.id,
        detail: `entity ${ce.id} (${identityOf(ce)}) is ${d.toFixed(1)} tiles apart (tolerance ${tol})`,
      })
    }
    const ha = (he.health?.hp ?? 1) > 0
    const ca = (ce.health?.hp ?? 1) > 0
    if (ha !== ca) {
      out.push({
        code: 'ALIVE', key: `ALIVE:${ce.id}`, tick, entity: ce.id,
        detail: `entity ${ce.id} (${identityOf(ce)}): host alive=${ha}, client alive=${ca}`,
      })
    }
  }

  // Coverage: things well inside the interest box must arrive.
  const self = client.entities.find((e) => e.playerCtl)
  if (self) {
    const clientIds = new Set(client.entities.map((e) => e.id))
    for (const he of host.entities) {
      const dx = Math.abs(he.pos.x - self.pos.x)
      const dy = Math.abs(he.pos.y - self.pos.y)
      if (dx < INTEREST_RADIUS - 4 && dy < INTEREST_RADIUS - 4 && !clientIds.has(he.id)) {
        out.push({
          code: 'MISSING', key: `MISSING:${he.id}`, tick, entity: he.id,
          detail: `host entity ${he.id} (${identityOf(he)}) is well inside the client's interest box but absent on the client`,
        })
      }
    }
  }

  for (const [code, h, c] of [
    ['FLOOR', host.floor, client.floor],
    ['MISSION', host.missionComplete, client.missionComplete],
    ['GAMEOVER', host.gameOver, client.gameOver],
  ] as const) {
    if (h !== c) {
      out.push({ code, key: code, tick, entity: null, detail: `host ${code.toLowerCase()}=${h}, client=${c}` })
    }
  }
  return out
}

// ---------------------------------------------------------------- scenario

interface Profile {
  name: string
  clients: number
  ticks: number
  tol: number
  cond: Channel
}

interface Report {
  profile: string
  ok: boolean
  notes: string[]
  worst: Map<string, Divergence>
  perPeerBps: { link: string; bps: number }[]
  aggregateBps: number
  overBudget: string[]
  samples: number
  peakEntities: number
}

const BLE_BASE: Channel = { delayTicks: 1, jitterTicks: 0, lossPct: 0, reorder: false, maxPacket: BLE_MAX_PACKET }

const runProfile = async (p: Profile, seed: number, tamper: ((b: Uint8Array) => Uint8Array) | null): Promise<Report> => {
  const hub = new DetHub(p.cond, seed)
  const hostInput = new ScriptedInput()
  // The SIM seed and the CHANNEL seed both derive from one number, so a single
  // --seed reproduces the whole run: same world, same losses, same jitter.
  const host = new NetHostSession(seed, 'HostPhone', hostInput, hub.hostTransport)

  const clients = Array.from({ length: p.clients }, (_, i) => {
    const input = new ScriptedInput()
    const c = hub.addClient(`Friend${i + 1}`, input)
    return { ...c, input }
  })

  const notes: string[] = []
  const worst = new Map<string, Divergence>()
  const streak = new Map<string, number>()
  const record = (ds: Divergence[]): void => {
    const present = new Set(ds.map((d) => d.key))
    for (const k of [...streak.keys()]) if (!present.has(k)) streak.delete(k)
    for (const d of ds) {
      const n = (streak.get(d.key) ?? 0) + 1
      streak.set(d.key, n)
      if (n >= PERSIST_SAMPLES && !worst.has(d.code)) worst.set(d.code, d)
    }
  }

  await host.start()
  for (const c of clients) await c.session.start()
  for (const c of clients) c.connect()

  // Handshake, driven by ticks rather than by waiting.
  for (let i = 0; i < 400 && host.lobbyPlayers().length < p.clients + 1; i++) {
    hub.tickNow++
    hub.pump(tamper)
    await settle()
  }
  if (host.lobbyPlayers().length < p.clients + 1) {
    notes.push(`JOIN FAILED: lobby has ${host.lobbyPlayers().length} of ${p.clients + 1} expected players`)
  }

  host.beginGame()
  for (let i = 0; i < 400 && clients.some((c) => c.session.phase !== 'playing'); i++) {
    host.tick()
    for (const c of clients) c.session.tick()
    hub.tickNow++
    hub.pump(tamper)
    await settle()
  }
  const notPlaying = clients.filter((c) => c.session.phase !== 'playing')
  if (notPlaying.length > 0) notes.push(`${notPlaying.length} client(s) never reached 'playing'`)

  // Measure only the steady state, so the join burst does not flatter or
  // distort the bandwidth figure.
  for (const s of hub.stats.values()) {
    s.packets = 0
    s.bytes = 0
    s.dropped = 0
  }
  const measureStart = hub.tickNow

  let samples = 0
  let peakEntities = 0
  for (let t = 0; t < p.ticks; t++) {
    // Deterministic, non-trivial movement: everyone walks, so snapshots carry
    // real position churn rather than a static scene.
    const phase = t / 12
    hostInput.set({ moveX: Math.cos(phase), moveY: Math.sin(phase) })
    clients.forEach((c, i) => {
      const ph = phase + (i + 1) * 1.7
      c.input.set({ moveX: Math.cos(ph), moveY: Math.sin(ph) })
    })

    host.tick()
    for (const c of clients) c.session.tick()
    hub.tickNow++
    hub.pump(tamper)
    await settle()

    if (t % 6 === 0) {
      const hv = host.renderView()
      peakEntities = Math.max(peakEntities, hv.entities.length)
      const all: Divergence[] = []
      for (const c of clients) all.push(...compare(hv, c.session.renderView(), p.tol, hv.tick))
      record(all)
      samples++
    }
  }

  const elapsedSec = (hub.tickNow - measureStart) / SIM_HZ
  const perPeerBps = [...hub.stats.entries()]
    .filter(([l]) => l.startsWith('h2c:'))
    .map(([link, s]) => ({ link, bps: s.bytes / elapsedSec }))
  const aggregateBps = perPeerBps.reduce((a, b) => a + b.bps, 0)

  const overBudget: string[] = []
  for (const { link, bps } of perPeerBps) {
    if (bps > PER_PEER_BUDGET_BPS) {
      overBudget.push(`${link} at ${bps.toFixed(0)} B/s exceeds the ${PER_PEER_BUDGET_BPS} B/s per-link BLE budget`)
    }
  }
  if (aggregateBps > AGGREGATE_BUDGET_BPS) {
    overBudget.push(
      `host egress ${aggregateBps.toFixed(0)} B/s across ${perPeerBps.length} peer(s) exceeds the ${AGGREGATE_BUDGET_BPS} B/s shared-radio budget`,
    )
  }

  const ok = notes.length === 0 && worst.size === 0 && overBudget.length === 0
  return { profile: p.name, ok, notes, worst, perPeerBps, aggregateBps, overBudget, samples, peakEntities }
}

// ------------------------------------------------------------------ driver

const PROFILES: Profile[] = [
  // Convergence under a modelled BLE channel. Short on purpose: every push.
  { name: 'clean-2p', clients: 1, ticks: 240, tol: 3, cond: { ...BLE_BASE } },
  { name: 'latency-2p', clients: 1, ticks: 240, tol: 6, cond: { ...BLE_BASE, delayTicks: 6 } },
  { name: 'jitter-2p', clients: 1, ticks: 240, tol: 6, cond: { ...BLE_BASE, delayTicks: 3, jitterTicks: 4 } },
  { name: 'loss1-2p', clients: 1, ticks: 300, tol: 5, cond: { ...BLE_BASE, lossPct: 1 } },
  { name: 'loss5-2p', clients: 1, ticks: 300, tol: 5, cond: { ...BLE_BASE, lossPct: 5 } },
  { name: 'reorder-2p', clients: 1, ticks: 240, tol: 6, cond: { ...BLE_BASE, delayTicks: 3, jitterTicks: 4, reorder: true } },
  { name: 'dropout-2p', clients: 1, ticks: 300, tol: 6, cond: { ...BLE_BASE, dropout: { atTick: 90, durTicks: 60 } } },
  // The campfire shapes. 3 and 4 players is the question that actually matters.
  { name: 'clean-3p', clients: 2, ticks: 240, tol: 3, cond: { ...BLE_BASE } },
  { name: 'clean-4p', clients: 3, ticks: 240, tol: 3, cond: { ...BLE_BASE } },
  { name: 'loss1-4p', clients: 3, ticks: 300, tol: 5, cond: { ...BLE_BASE, lossPct: 1 } },
  { name: 'jitter-4p', clients: 3, ticks: 240, tol: 6, cond: { ...BLE_BASE, delayTicks: 3, jitterTicks: 4 } },
]

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const selfTest = args.includes('--self-test')
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null
  const seedIdx = args.indexOf('--seed')
  const seed = seedIdx >= 0 ? Number(args[seedIdx + 1]) : 20260809

  if (!Number.isFinite(seed)) {
    console.error(`[net-matrix] --seed must be a number, got "${args[seedIdx + 1]}"`)
    process.exit(2)
  }

  // Corrupt the archetype byte of snapshot entity records: the exact "everything
  // renders as a second Ranger" desync. If the matrix stays green under this,
  // the matrix is worthless and we say so and exit non-zero.
  const tamper = selfTest
    ? (b: Uint8Array): Uint8Array => {
        if (!(b.length > 16)) return b
        const out = new Uint8Array(b)
        out[out.length - 3] = (out[out.length - 3] + 7) & 0xff
        return out
      }
    : null

  const chosen = only ? PROFILES.filter((p) => p.name === only) : PROFILES
  if (chosen.length === 0) {
    console.error(`[net-matrix] no profile named "${only}"`)
    process.exit(2)
  }

  console.log(`[net-matrix] ${chosen.length} profile(s), seed=${seed}, BLE framing at ${BLE_MAX_PACKET}B/packet${selfTest ? ' — SELF-TEST (wire deliberately corrupted)' : ''}`)
  console.log(`[net-matrix] budget: ${PER_PEER_BUDGET_BPS} B/s per link, ${AGGREGATE_BUDGET_BPS} B/s host aggregate (BALANCED ~30ms interval, 3 pkt/event, 1M PHY, 180B payload)`)

  const reports: Report[] = []
  for (const p of chosen) {
    process.stdout.write(
      `\n[net-matrix] ${p.name}: ${p.clients + 1} players, delay=${p.cond.delayTicks}+0..${p.cond.jitterTicks} ticks, loss=${p.cond.lossPct}%, ${p.cond.reorder ? 'REORDERING' : 'in-order'}${p.cond.dropout ? `, blackout ${p.cond.dropout.durTicks}t @${p.cond.dropout.atTick}` : ''}\n`,
    )
    let r: Report
    try {
      r = await runProfile(p, seed, tamper)
    } catch (err) {
      r = {
        profile: p.name, ok: false, notes: [`THREW: ${(err as Error)?.stack ?? String(err)}`],
        worst: new Map(), perPeerBps: [], aggregateBps: 0, overBudget: [], samples: 0, peakEntities: 0,
      }
    }
    reports.push(r)
    console.log(
      `    bandwidth: ${r.perPeerBps.map((x) => `${x.link}=${x.bps.toFixed(0)}B/s`).join(' ')} | aggregate ${r.aggregateBps.toFixed(0)}B/s (${((r.aggregateBps * 8) / 1000).toFixed(1)} kbps), peak ${r.peakEntities} entities, ${r.samples} samples`,
    )
    if (r.perPeerBps.length > 0) {
      const worstLink = Math.max(...r.perPeerBps.map((x) => x.bps))
      console.log(
        `    headroom: per-link ${(100 - (worstLink / PER_PEER_BUDGET_BPS) * 100).toFixed(1)}% spare, aggregate ${(100 - (r.aggregateBps / AGGREGATE_BUDGET_BPS) * 100).toFixed(1)}% spare`,
      )
    }
    for (const n of r.notes) console.log(`    note: ${n}`)
    for (const o of r.overBudget) console.log(`    OVER BUDGET: ${o}`)
    for (const [, d] of r.worst) {
      console.log(`    DIVERGENCE[${d.code}] tick=${d.tick} entity=${d.entity ?? 'n/a'} — ${d.detail}`)
    }
    console.log(`    ${r.ok ? 'PASS' : 'FAIL'} ${p.name}`)
  }

  const failed = reports.filter((r) => !r.ok)
  console.log(`\n[net-matrix] ${reports.length - failed.length}/${reports.length} profiles passed`)

  console.log(`
[net-matrix] WHAT THIS RUN DOES NOT COVER:
  - the real radio: no RF interference, no range limit, no Wi-Fi coexistence
  - src/net/transport/bleTransport.ts: the Capacitor plugin, GATT, MTU
    negotiation and notification back-pressure are all stubbed out here
  - the packaged APK and Android's BLE stack, including its per-handset cap on
    simultaneous centrals -- that cap, not this matrix, is what limits players
  - phones in pockets: bodies, battery saver, doze, screen-off throttling
  A green run proves the protocol and the sim agree over a MODELLED channel.
  It is not evidence that four phones work around a campfire.`)

  if (selfTest) {
    if (failed.length === 0) {
      console.error(`\n[net-matrix] SELF-TEST FAILED: the wire was corrupted and the matrix still passed. The matrix cannot detect desync and proves nothing.`)
      process.exit(1)
    }
    console.log(`\n[net-matrix] SELF-TEST OK: corrupted wire produced ${failed.length} failing profile(s) — the matrix can go red.`)
    process.exit(0)
  }

  if (failed.length > 0) {
    console.error(`\n[net-matrix] FAILED: ${failed.map((r) => r.profile).join(', ')}`)
    console.error(`[net-matrix] reproduce exactly: npx tsx e2e/net-matrix.mts --seed ${seed} --only ${failed[0].profile}`)
    process.exit(1)
  }
  console.log(`[net-matrix] all profiles passed (seed ${seed})`)
}

void main()
