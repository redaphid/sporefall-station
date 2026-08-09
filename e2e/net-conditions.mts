/**
 * Two-instance co-op under adverse link conditions — the campfire test.
 *
 * Runs the REAL NetHostSession and NetClientSession against each other in one
 * Node process, connected by a link model that reproduces what BLE actually
 * gives you: 180-byte packets (bleTransport's MAX_PACKET), one packet in flight
 * (SendQueue awaits sendPacket, so tx pacing = real backpressure), added
 * latency, jitter, per-packet loss, and range dropouts.
 *
 * This is deliberately NOT the WS path. `e2e/ws-multiplayer.mjs` sends whole
 * messages through a 64KB WebSocket, so it never fragments and never exercises
 * chunkedStream's reassembly. On two phones every snapshot larger than 180B is
 * multi-packet, so the fragmentation path is the one that actually ships.
 *
 * What it asserts, per condition profile:
 *   • the join handshake completes and the client reaches 'playing'
 *   • IDENTITY: every entity the client renders exists on the host with the
 *     same archetype/kind (the ARCHETYPES-index desync class)
 *   • COVERAGE: entities well inside the client's interest box reach the client
 *   • POSITION: shared entities agree within a latency-scaled tolerance
 *   • GLOBALS: floor / missionComplete / gameOver / alert converge
 *   • LIVENESS: the client keeps applying snapshots (no wedged StreamReader)
 *
 * Gated on exit code. `--self-test` deliberately breaks the wire and REQUIRES
 * the harness to go red — a harness that cannot fail proves nothing.
 *
 * Run: npx tsx e2e/net-conditions.mts [--only <profile>] [--self-test]
 */
import type { Entity } from '../src/game/entity'
import { emptyInput, type InputCmd } from '../src/game/types'
import type { InputSource } from '../src/input/input'
import type { RenderView } from '../src/app/session'
import { NetClientSession } from '../src/app/netClient'
import { NetHostSession } from '../src/app/netHost'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../src/net/types'
import { ARCHETYPES } from '../src/net/protocol/messages'

/** Archetypes the host actually spawned that do NOT survive the wire registry —
 * they encode as index 0 and arrive as 'player'. Collected across every run. */
const archetypeGaps = new Set<string>()
const archetypeSeen = new Set<string>()
const ARCHETYPE_SET = new Set<string>(ARCHETYPES)

// ---------------------------------------------------------------- utilities

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Same mulberry32 the sim uses — conditions are reproducible from a seed. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SIM_HZ = 30
const TICK_MS = 1000 / SIM_HZ
/** netHost.ts INTEREST_RADIUS. Entities inside this box must reach the client. */
const INTEREST_RADIUS = 14
/** bleTransport.ts MAX_PACKET. */
const BLE_MAX_PACKET = 180

// ------------------------------------------------------------ link modelling

export interface Conditions {
  /** One-way delay added to every packet. */
  latencyMs: number
  /** Uniform +/- jitter on top of latency. Can reorder packets. */
  jitterMs: number
  /** Per-PACKET (i.e. per 180-byte chunk) drop probability, 0..100. */
  lossPct: number
  /** Time the sender is held before sendPacket resolves — models throughput. */
  perPacketMs: number
  /** Transport MTU. 180 = BLE; 65536 = the WS relay. */
  maxPacket: number
  /** Preserve delivery order, as a single BLE connection does (ATT/L2CAP on one
   * link never reorders). Set false only to model a reordering link, which BLE
   * is NOT — keep it true for anything meant to predict phone behaviour. */
  ordered?: boolean
}

const BLE_BASE: Conditions = { latencyMs: 25, jitterMs: 5, lossPct: 0, perPacketMs: 4, maxPacket: BLE_MAX_PACKET }

interface LinkStats {
  sent: number
  dropped: number
  delivered: number
  bytes: number
}

/**
 * One host "peripheral" plus N "centrals", with a conditioned link between
 * them. Mirrors the MockHub in netCoop.test.ts (same shape, same 180B packets)
 * but every delivery goes through the loss/latency/jitter model.
 */
class ConditionedHub {
  readonly hostTransport: Transport
  readonly stats: LinkStats = { sent: 0, dropped: 0, delivered: 0, bytes: 0 }

  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()
  private rnd: () => number
  /** Link is up but delivering nothing — "walked out of range", pre-timeout. */
  private blackhole = false
  /** Per-direction last scheduled delivery time, for in-order delivery. */
  private lastDelivery = new Map<string, number>()
  /** Optional wire tamper, used by --self-test to prove the harness can fail. */
  tamper: ((bytes: Uint8Array) => Uint8Array) | null = null

  constructor(
    private cond: Conditions,
    seed = 0x5eed,
  ) {
    this.rnd = mulberry32(seed)
    this.hostTransport = {
      role: 'host',
      maxPacket: cond.maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer, bytes) => this.transmit(`h2c:${peer}`, bytes, (b) => this.centrals.get(peer)?.(b)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  setBlackhole(on: boolean): void {
    this.blackhole = on
  }

  /**
   * Put one packet on the wire. Resolves after the tx slot is spent (this is
   * what paces SendQueue), while delivery lands later after latency+jitter.
   */
  private async transmit(dir: string, bytes: Uint8Array, deliver: (b: Uint8Array) => void): Promise<void> {
    this.stats.sent++
    this.stats.bytes += bytes.length
    if (bytes.length > this.cond.maxPacket) throw new Error(`packet ${bytes.length}B exceeds MTU ${this.cond.maxPacket}`)
    const lost = this.blackhole || this.rnd() * 100 < this.cond.lossPct
    // Copy: SendQueue hands out subarray views over a buffer it may reuse, and
    // a delayed delivery must not observe later mutations.
    const copy = new Uint8Array(bytes)
    if (!lost) {
      const jitter = (this.rnd() * 2 - 1) * this.cond.jitterMs
      let delay = Math.max(0, this.cond.latencyMs + jitter)
      if (this.cond.ordered !== false) {
        // A single BLE connection delivers in order: a jittered packet can be
        // late but can never overtake the one in front of it.
        const at = Math.max(Date.now() + delay, (this.lastDelivery.get(dir) ?? 0) + 0.5)
        this.lastDelivery.set(dir, at)
        delay = Math.max(0, at - Date.now())
      }
      setTimeout(() => {
        this.stats.delivered++
        deliver(this.tamper ? this.tamper(copy) : copy)
      }, delay)
    } else {
      this.stats.dropped++
    }
    if (this.cond.perPacketMs > 0) await sleep(this.cond.perPacketMs)
  }

  addClient(
    name: string,
    input: InputSource,
    opts: { newPeerIdOnReconnect?: boolean } = {},
  ): {
    session: NetClientSession
    connect: () => void
    /** Hard link loss: both ends see peerDisconnected (BLE supervision timeout). */
    drop: () => void
    peerId: () => PeerId
  } {
    let peer: PeerId = `central-${this.centrals.size + 1}`
    let generation = 0
    let clientHandler: ((e: TransportEvent) => void) | null = null

    const register = (): void => {
      this.centrals.set(peer, (bytes) => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    }
    register()

    const clientTransport: Transport = {
      role: 'client',
      maxPacket: this.cond.maxPacket,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p, bytes) => {
        if (!this.centrals.has(peer)) throw new Error('link down')
        return this.transmit(`c2h:${peer}`, bytes, (b) => this.hostHandler?.({ type: 'data', peer, bytes: b }))
      },
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => (this.centrals.has(peer) ? ['host'] : []),
      // Modelled on BleClientTransport.reconnect: re-establish the GATT link.
      // On BLE the deviceId (peer id) is stable across a reconnect; the WS relay
      // hands out a NEW id. Both are worth exercising.
      reconnect: async () => {
        if (this.blackhole) throw new Error('still out of range')
        generation++
        if (opts.newPeerIdOnReconnect) peer = `central-${peer}-r${generation}`
        register()
        await sleep(this.cond.latencyMs)
        this.hostHandler?.({ type: 'peerConnected', peer })
        clientHandler?.({ type: 'peerConnected', peer: 'host' })
      },
    }

    const session = new NetClientSession(name, input, clientTransport)
    return {
      session,
      connect: () => {
        this.hostHandler?.({ type: 'peerConnected', peer })
        clientHandler?.({ type: 'peerConnected', peer: 'host' })
      },
      drop: () => {
        this.centrals.delete(peer)
        this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' })
        clientHandler?.({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
      },
      peerId: () => peer,
    }
  }
}

// -------------------------------------------------------------- input stubs

/** An input source a scenario can steer tick by tick. */
class ScriptedInput implements InputSource {
  cmd: InputCmd = emptyInput()
  sample(): InputCmd {
    return { ...this.cmd }
  }
  set(patch: Partial<InputCmd>): void {
    this.cmd = { ...emptyInput(), ...patch }
  }
}

// ---------------------------------------------------------------- comparison

/** Identity as a player would see it: what the thing IS, not where it is.
 * `archetype` is the exact field the wire encodes as an ARCHETYPES index, so a
 * mismatch here IS the "spore pod renders as a second Ranger" bug. */
const identityOf = (e: Entity): string => `${e.kind}:${e.archetype}`

interface Divergence {
  code: string
  /** Stable identity of THIS divergence, so we can tell whether it persists. */
  key: string
  detail: string
}

/** Samples are taken every 6 ticks (0.2s). A divergence must survive this many
 * consecutive samples to count: below it, we are just looking at flight time and
 * snapshot cadence, which is normal networking, not desync. */
const PERSIST_SAMPLES = 10 // 2.0s

/**
 * Compare what the two screens show. Interest filtering means the client
 * legitimately sees a SUBSET, so the sound assertions are:
 *   client ⊆ host with identical identity, and everything well inside the
 *   client's interest box is present on the client.
 */
const compareViews = (host: RenderView, client: RenderView, posTolerance: number): Divergence[] => {
  const out: Divergence[] = []
  const hostById = new Map(host.entities.map((e) => [e.id, e]))

  // 1. Ghosts + identity. This is the ARCHETYPES-index bug class.
  for (const ce of client.entities) {
    const he = hostById.get(ce.id)
    if (!he) {
      out.push({ code: 'GHOST', key: `GHOST:${ce.id}`, detail: `client renders entity ${ce.id} (${identityOf(ce)}) that the host does not have` })
      continue
    }
    if (identityOf(he) !== identityOf(ce)) {
      out.push({
        code: 'IDENTITY',
        key: `IDENTITY:${ce.id}`,
        detail: `entity ${ce.id}: host shows "${identityOf(he)}", client shows "${identityOf(ce)}"`,
      })
    }
    const d = Math.hypot(he.pos.x - ce.pos.x, he.pos.y - ce.pos.y)
    if (d > posTolerance) {
      out.push({ code: 'POSITION', key: `POSITION:${ce.id}`, detail: `entity ${ce.id} (${identityOf(ce)}) is ${d.toFixed(1)} tiles apart` })
    }
    const hostAlive = (he.health?.hp ?? 1) > 0
    const clientAlive = (ce.health?.hp ?? 1) > 0
    if (hostAlive !== clientAlive) {
      out.push({ code: 'ALIVE', key: `ALIVE:${ce.id}`, detail: `entity ${ce.id} (${identityOf(ce)}): host alive=${hostAlive}, client alive=${clientAlive}` })
    }
    if (he.door && ce.door && he.door.open !== ce.door.open) {
      out.push({ code: 'DOOR', key: `DOOR:${ce.id}`, detail: `door ${ce.id}: host open=${he.door.open}, client open=${ce.door.open}` })
    }
  }

  // 2. Coverage: the host's view of what the client's avatar can see.
  //    Margin of 3 tiles inside the radius absorbs movement during flight time.
  const avatar = client.self
  if (avatar) {
    const clientIds = new Set(client.entities.map((e) => e.id))
    for (const he of host.entities) {
      const inside =
        Math.abs(he.pos.x - avatar.pos.x) < INTEREST_RADIUS - 3 && Math.abs(he.pos.y - avatar.pos.y) < INTEREST_RADIUS - 3
      if (inside && !clientIds.has(he.id)) {
        out.push({ code: 'MISSING', key: `MISSING:${he.id}`, detail: `host entity ${he.id} (${identityOf(he)}) is in the client's interest box but absent on the client` })
      }
    }
  }

  // 3. Globals both screens must agree on.
  if (host.floor !== client.floor) out.push({ code: 'FLOOR', key: 'FLOOR', detail: `host floor ${host.floor}, client floor ${client.floor}` })
  if (host.missionComplete !== client.missionComplete)
    out.push({ code: 'OBJECTIVE', key: 'OBJECTIVE', detail: `host missionComplete=${host.missionComplete}, client=${client.missionComplete}` })
  if (host.gameOver !== client.gameOver)
    out.push({ code: 'GAMEOVER', key: 'GAMEOVER', detail: `host gameOver=${host.gameOver}, client=${client.gameOver}` })
  if (!!host.alert !== !!client.alert) out.push({ code: 'ALERT', key: 'ALERT', detail: `host alert=${host.alert}, client=${client.alert}` })

  return out
}

// ------------------------------------------------------------------ scenario

interface Profile {
  name: string
  cond: Conditions
  /** Seconds of play to sample over. */
  seconds: number
  /** Optional mid-run event, fired at the given second. */
  event?: {
    atSec: number
    kind: 'blackhole' | 'hard-drop'
    /** For blackhole: how long we stay out of range. */
    durSec?: number
    newPeerIdOnReconnect?: boolean
  }
  /** Tolerance in tiles for shared-entity position agreement. */
  posTolerance: number
  /** Make every player unkillable, so the run never reaches game over. Isolates
   * "the link degraded" from "everybody died and the death path misbehaves". */
  immortal?: boolean
}

interface Result {
  profile: string
  ok: boolean
  notes: string[]
  worst: Map<string, string>
  stats: LinkStats
  samples: number
  clientPhase: string
  transient: Map<string, number>
}

const runProfile = async (p: Profile, tamper: ((b: Uint8Array) => Uint8Array) | null): Promise<Result> => {
  const hub = new ConditionedHub(p.cond)
  hub.tamper = tamper
  const hostInput = new ScriptedInput()
  const clientInput = new ScriptedInput()

  const host = new NetHostSession(20260808, 'HostPhone', hostInput, hub.hostTransport)
  const c = hub.addClient('FriendPhone', clientInput, { newPeerIdOnReconnect: p.event?.newPeerIdOnReconnect })

  const notes: string[] = []
  /** Divergences that survived PERSIST_SAMPLES consecutive samples. */
  const worst = new Map<string, string>()
  /** Divergences seen at least once but that healed — normal network lag. */
  const transient = new Map<string, number>()
  const streak = new Map<string, number>()
  const record = (ds: Divergence[]): void => {
    const present = new Set(ds.map((d) => d.key))
    for (const k of [...streak.keys()]) if (!present.has(k)) streak.delete(k)
    for (const d of ds) {
      const n = (streak.get(d.key) ?? 0) + 1
      streak.set(d.key, n)
      if (n === 1) transient.set(d.code, (transient.get(d.code) ?? 0) + 1)
      if (n >= PERSIST_SAMPLES && !worst.has(d.code)) {
        worst.set(d.code, `${d.detail} — persisted ${((n * 6 * TICK_MS) / 1000).toFixed(1)}s+`)
      }
    }
  }

  await host.start()
  await c.session.start()
  c.connect()

  // Let the Hello/Welcome handshake settle over the conditioned link.
  const joinDeadline = Date.now() + 8000
  while (Date.now() < joinDeadline && host.lobbyPlayers().length < 2) await sleep(20)
  const joined = host.lobbyPlayers().length >= 2
  if (!joined) notes.push('JOIN FAILED: the client never appeared in the host lobby')

  host.beginGame()

  // Wait for the client to actually reach 'playing'.
  const playDeadline = Date.now() + 10000
  while (Date.now() < playDeadline && c.session.phase !== 'playing') {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  const playing = c.session.phase === 'playing'
  if (!playing) notes.push(`CLIENT NEVER REACHED PLAY: stuck in phase '${c.session.phase}'`)

  if (p.immortal) {
    for (const e of host.world.entities) {
      if (e.playerCtl && e.health) {
        e.health.hp = 1e6
        e.health.max = 1e6
      }
    }
  }

  // Give both players some motion so snapshots are not a static scene.
  hostInput.set({ moveX: 1, moveY: 0.3, aimX: 1, aimY: 0 })
  clientInput.set({ moveX: -0.6, moveY: 1, aimX: 0, aimY: 1 })

  let samples = 0
  let lastClientEntitySig = ''
  let staleSamples = 0
  let maxStale = 0
  let eventFired = false
  let eventCleared = false

  const start = Date.now()
  const endAt = start + p.seconds * 1000
  let t = 0
  while (Date.now() < endAt) {
    t++
    const elapsedSec = (Date.now() - start) / 1000

    if (p.event && !eventFired && elapsedSec >= p.event.atSec) {
      eventFired = true
      if (p.event.kind === 'blackhole') {
        hub.setBlackhole(true)
        notes.push(`t=${elapsedSec.toFixed(1)}s: walked out of range (link up, nothing delivered)`)
      } else {
        c.drop()
        notes.push(`t=${elapsedSec.toFixed(1)}s: hard link drop (both ends see peerDisconnected)`)
      }
    }
    if (p.event?.kind === 'blackhole' && eventFired && !eventCleared && elapsedSec >= p.event.atSec + (p.event.durSec ?? 3)) {
      eventCleared = true
      hub.setBlackhole(false)
      notes.push(`t=${elapsedSec.toFixed(1)}s: back in range`)
    }

    host.tick()
    c.session.tick()

    // Sample the two screens a few times a second, once play is under way.
    if (t % 6 === 0 && c.session.phase === 'playing') {
      const hv = host.renderView()
      const cv = c.session.renderView()
      // Exhaustive, live check: does every archetype this world actually spawns
      // survive the wire registry, or does it silently become 'player'?
      for (const he of hv.entities) {
        archetypeSeen.add(he.archetype)
        if (!ARCHETYPE_SET.has(he.archetype)) archetypeGaps.add(he.archetype)
      }
      // Suppress comparison while deliberately partitioned or reconnecting —
      // divergence there is expected; what matters is that it CONVERGES after.
      const partitioned = eventFired && !eventCleared && p.event?.kind === 'blackhole'
      const settling = c.session.phase !== 'playing'
      if (!partitioned && !settling) {
        samples++
        record(compareViews(hv, cv, p.posTolerance))
      }
      const sig = cv.entities
        .map((e) => `${e.id}@${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)}`)
        .sort()
        .join('|')
      // Only meaningful while the host is still simulating a live run: once the
      // host hits game over the world legitimately stops moving.
      if (hv.gameOver) {
        staleSamples = 0
      } else if (sig === lastClientEntitySig) {
        staleSamples++
        maxStale = Math.max(maxStale, staleSamples)
      } else staleSamples = 0
      lastClientEntitySig = sig
    }

    await sleep(TICK_MS)
  }

  // Convergence window: after any disruption, give the link time to resync and
  // then demand agreement. A world that never re-converges is the real bug.
  if (p.event) {
    hub.setBlackhole(false)
    const convDeadline = Date.now() + 12000
    while (Date.now() < convDeadline && c.session.phase === 'reconnecting') {
      host.tick()
      c.session.tick()
      await sleep(TICK_MS)
    }
    for (let i = 0; i < 90; i++) {
      host.tick()
      c.session.tick()
      await sleep(TICK_MS)
    }
    const hv = host.renderView()
    const cv = c.session.renderView()
    notes.push(`after disruption: client phase='${c.session.phase}', client entities=${cv.entities.length}, host entities=${hv.entities.length}`)
    if (c.session.phase === 'playing') {
      // Sample repeatedly so the persistence filter applies here too.
      streak.clear()
      let lastPost: Divergence[] = []
      for (let i = 0; i < PERSIST_SAMPLES + 6; i++) {
        for (let k = 0; k < 6; k++) {
          host.tick()
          c.session.tick()
          await sleep(TICK_MS)
        }
        lastPost = compareViews(host.renderView(), c.session.renderView(), p.posTolerance)
        record(lastPost)
      }
      if (lastPost.length === 0) notes.push('world RE-CONVERGED after the disruption')
    } else {
      notes.push(`DID NOT RECOVER: client ended in phase '${c.session.phase}' (a player would have to restart)`)
    }
  }

  // Liveness: a wedged StreamReader shows up as the client's entity set going
  // permanently static while the host keeps simulating.
  const staleSec = (maxStale * 6 * TICK_MS) / 1000
  notes.push(`longest interval with a frozen client world: ${staleSec.toFixed(1)}s`)
  if (staleSec > 2.5) notes.push(`CLIENT STALLED: entity set unchanged for ${staleSec.toFixed(1)}s (possible wedged stream)`)

  const gated = (code: string): boolean => worst.has(code) && !ALLOWED.has(code)
  const hardFail =
    !joined ||
    !playing ||
    gated('GHOST') ||
    gated('IDENTITY') ||
    gated('ALIVE') ||
    gated('DOOR') ||
    gated('FLOOR') ||
    gated('OBJECTIVE') ||
    gated('GAMEOVER') ||
    gated('ALERT') ||
    gated('MISSING') ||
    gated('POSITION') ||
    staleSec > 2.5 ||
    (!!p.event && c.session.phase !== 'playing')

  return {
    profile: p.name,
    ok: !hardFail,
    notes,
    worst,
    stats: hub.stats,
    samples,
    clientPhase: c.session.phase,
    transient,
  }
}

// -------------------------------------------------------------------- driver

const PROFILES: Profile[] = [
  { name: 'pristine', cond: { ...BLE_BASE, latencyMs: 5, jitterMs: 0, perPacketMs: 1 }, seconds: 8, posTolerance: 2.5 },
  { name: 'ble-typical', cond: { ...BLE_BASE }, seconds: 8, posTolerance: 3 },
  { name: 'high-latency-200ms', cond: { ...BLE_BASE, latencyMs: 200, jitterMs: 30 }, seconds: 8, posTolerance: 6 },
  { name: 'heavy-jitter', cond: { ...BLE_BASE, latencyMs: 120, jitterMs: 110 }, seconds: 8, posTolerance: 6 },
  { name: 'loss-2pct', cond: { ...BLE_BASE, lossPct: 2 }, seconds: 10, posTolerance: 4 },
  { name: 'loss-10pct', cond: { ...BLE_BASE, lossPct: 10 }, seconds: 10, posTolerance: 5 },
  { name: 'loss-30pct', cond: { ...BLE_BASE, lossPct: 30 }, seconds: 10, posTolerance: 8 },
  { name: 'congested-slow-link', cond: { ...BLE_BASE, perPacketMs: 30, latencyMs: 80 }, seconds: 10, posTolerance: 6 },
  // Soaks: does a realistically lossy radio freeze the joining player's screen
  // for good within a few minutes of play? This is the campfire question.
  { name: 'soak-loss-1pct-60s', cond: { ...BLE_BASE, lossPct: 1 }, seconds: 60, posTolerance: 5 },
  { name: 'soak-loss-5pct-60s', cond: { ...BLE_BASE, lossPct: 5 }, seconds: 60, posTolerance: 5 },
  { name: 'soak-clean-60s', cond: { ...BLE_BASE }, seconds: 60, posTolerance: 4 },
  // Controls: identical but with an explicitly REORDERING link, to separate
  // "loss wedges the stream" from "my model reordered packets".
  { name: 'ctl-reordering-clean-60s', cond: { ...BLE_BASE, jitterMs: 40, ordered: false }, seconds: 60, posTolerance: 5 },
  { name: 'ctl-ordered-clean-60s', cond: { ...BLE_BASE, jitterMs: 40, ordered: true }, seconds: 60, posTolerance: 5 },
  { name: 'ctl-ordered-loss1-60s', cond: { ...BLE_BASE, jitterMs: 40, lossPct: 1, ordered: true }, seconds: 60, posTolerance: 5 },
  // Same again but nobody can die: isolates link behaviour from the death /
  // game-over path, which also stops the world and empties snapshots.
  { name: 'ctl-immortal-clean-60s', cond: { ...BLE_BASE, jitterMs: 40, ordered: true }, seconds: 60, posTolerance: 5, immortal: true },
  { name: 'ctl-immortal-loss1-60s', cond: { ...BLE_BASE, jitterMs: 40, lossPct: 1, ordered: true }, seconds: 60, posTolerance: 5, immortal: true },
  {
    name: 'out-of-range-3s',
    cond: { ...BLE_BASE },
    seconds: 10,
    posTolerance: 4,
    event: { atSec: 4, kind: 'blackhole', durSec: 3 },
  },
  {
    name: 'hard-drop-rejoin-same-id',
    cond: { ...BLE_BASE },
    seconds: 10,
    posTolerance: 4,
    event: { atSec: 4, kind: 'hard-drop' },
  },
  {
    name: 'hard-drop-rejoin-new-id',
    cond: { ...BLE_BASE },
    seconds: 10,
    posTolerance: 4,
    event: { atSec: 4, kind: 'hard-drop', newPeerIdOnReconnect: true },
  },
]

/** Divergence codes excluded from the exit-code gate via --allow. Reported
 * regardless — suppressing a finding from the gate must never hide it. */
const ALLOWED = new Set<string>()

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const selfTest = args.includes('--self-test')
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null
  const allowIdx = args.indexOf('--allow')
  if (allowIdx >= 0) for (const c of (args[allowIdx + 1] ?? '').split(',')) if (c) ALLOWED.add(c.toUpperCase())

  // --self-test corrupts the archetype byte of every snapshot entity record,
  // reproducing the ARCHETYPES-index desync. If the harness reports green under
  // this, the harness is worthless and we exit non-zero saying so.
  // Surgical on purpose: only the FIRST CHUNK of a Snapshot message is touched,
  // and only inside the entity records. The Hello/Welcome/GameStart handshake is
  // left intact, so the run still joins and plays — which forces the failure to
  // come from the world COMPARATOR rather than from a dead connection. A
  // self-test that merely breaks the handshake would not prove the comparator
  // can see desync.
  const tamper = selfTest
    ? (b: Uint8Array): Uint8Array => {
        const isSnapshotHead = b.length > 16 && b[2] === MsgType.Snapshot
        if (!isSnapshotHead) return b
        const out = new Uint8Array(b)
        out[out.length - 3] = (out[out.length - 3] + 7) & 0xff
        return out
      }
    : null

  const chosen = only ? PROFILES.filter((p) => p.name === only) : PROFILES
  if (chosen.length === 0) {
    console.error(`no profile named "${only}"`)
    process.exit(2)
  }

  console.log(`[net-cond] ${chosen.length} profile(s), BLE framing at ${BLE_MAX_PACKET}B/packet${selfTest ? ' — SELF-TEST (wire deliberately corrupted)' : ''}`)
  const results: Result[] = []
  for (const p of chosen) {
    process.stdout.write(`\n[net-cond] ${p.name}: lat=${p.cond.latencyMs}±${p.cond.jitterMs}ms loss=${p.cond.lossPct}% tx=${p.cond.perPacketMs}ms/pkt\n`)
    let r: Result
    try {
      r = await runProfile(p, tamper)
    } catch (err) {
      r = {
        profile: p.name,
        ok: false,
        notes: [`THREW: ${(err as Error)?.stack ?? String(err)}`],
        worst: new Map(),
        stats: { sent: 0, dropped: 0, delivered: 0, bytes: 0 },
        samples: 0,
        clientPhase: 'n/a',
        transient: new Map(),
      }
    }
    results.push(r)
    const s = r.stats
    console.log(`    link: ${s.sent} packets sent, ${s.dropped} dropped, ${(s.bytes / 1024).toFixed(1)}KB, ${r.samples} comparison samples, client phase '${r.clientPhase}'`)
    for (const n of r.notes) console.log(`    note: ${n}`)
    const tr = [...r.transient].filter(([c]) => !r.worst.has(c))
    if (tr.length > 0) console.log(`    transient-only (healed within ${(PERSIST_SAMPLES * 6 * TICK_MS) / 1000}s, i.e. normal lag): ${tr.map(([c, n]) => `${c}x${n}`).join(' ')}`)
    for (const [code, detail] of r.worst) console.log(`    PERSISTENT DIVERGENCE[${code}] ${detail}`)
    console.log(`    ${r.ok ? 'PASS' : 'FAIL'} ${p.name}`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[net-cond] ${results.length - failed.length}/${results.length} profiles passed`)
  console.log(`[net-cond] archetypes observed live: ${archetypeSeen.size}`)
  if (archetypeGaps.size > 0) {
    console.error(`[net-cond] WIRE REGISTRY GAP — ${archetypeGaps.size} archetype(s) the host spawned are absent from ARCHETYPES and therefore arrive at the other phone as 'player':`)
    for (const a of [...archetypeGaps].sort()) console.error(`    - ${a}`)
  }
  if (ALLOWED.size > 0) console.log(`[net-cond] NOTE: ${[...ALLOWED].join(',')} were excluded from the exit gate via --allow (still reported above)`)

  if (selfTest) {
    // Inverted gate: a corrupted wire MUST produce failures.
    if (failed.length === 0) {
      console.error('[net-cond] SELF-TEST FAILED: the harness stayed green with a deliberately corrupted wire. It cannot detect desync; treat every green result as meaningless.')
      process.exit(1)
    }
    console.log(`[net-cond] SELF-TEST OK: corrupted wire produced ${failed.length} failing profile(s) — the harness can go red.`)
    process.exit(0)
  }

  if (failed.length > 0) {
    console.error(`[net-cond] FAILING PROFILES: ${failed.map((f) => f.profile).join(', ')}`)
    process.exit(1)
  }
  console.log('[net-cond] all profiles passed')
  process.exit(0)
}

main().catch((e) => {
  console.error('[net-cond] harness crashed:', e)
  process.exit(2)
})
