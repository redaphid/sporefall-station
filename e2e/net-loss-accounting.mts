/**
 * MEASUREMENT TOOL (analysis, not a gate). Per-message-type loss accounting for
 * the host->client direction, over the same 180-byte BLE link model that
 * `net-conditions.mts` uses.
 *
 * `net-conditions.mts` answers "do the two screens agree". This answers the
 * question you need before spending bytes on redundancy: WHAT ACTUALLY GETS
 * LOST, per message type, and how much collateral one dropped packet causes.
 *
 * It runs the REAL NetHostSession/NetClientSession and tallies, per MsgType:
 *   • messages the host emitted (fed to a shadow reader at SEND time)
 *   • messages the client's byte stream actually produced (shadow at RECEIVE)
 *   • bytes and packets per message
 *   • framing desyncs, resyncs, and packets discarded while resynchronising
 *   • the client's observed snapshot-tick gaps -> how long a client goes
 *     without fresh full state (the number that decides whether snapshot FEC
 *     could ever pay for itself)
 *
 * Run: npx tsx e2e/net-loss-accounting.mts [--loss 0,2,5,10,30] [--seconds 30]
 */
import { emptyInput, type InputCmd } from '../src/game/types'
import type { InputSource } from '../src/input/input'
import { NetClientSession } from '../src/app/netClient'
import { NetHostSession } from '../src/app/netHost'
import { isKnownMsgType, MsgType, type PeerId, type Transport, type TransportEvent } from '../src/net/types'
import { StreamReader } from '../src/net/framing/chunkedStream'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SIM_HZ = 30
const TICK_MS = 1000 / SIM_HZ
const BLE_MAX_PACKET = 180

const TYPE_NAME = new Map<number, string>(Object.entries(MsgType).map(([k, v]) => [v as number, k]))

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Tally {
  msgs: number
  bytes: number
  packets: number
}
const blank = (): Tally => ({ msgs: 0, bytes: 0, packets: 0 })
const bump = (m: Map<number, Tally>, type: number, len: number): void => {
  const t = m.get(type) ?? blank()
  t.msgs++
  t.bytes += len
  t.packets += Math.ceil((2 + len) / BLE_MAX_PACKET)
  m.set(type, t)
}

class Hub {
  readonly hostTransport: Transport
  sent = 0
  dropped = 0
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (b: Uint8Array) => void>()
  private rnd: () => number
  private lastDelivery = new Map<string, number>()
  private wire = new Map<string, { at: number; fn: () => void }[]>()
  private armed = new Set<string>()

  /** h2c messages as the host EMITTED them. */
  txByType = new Map<number, Tally>()
  /** h2c messages the client's byte stream actually produced. */
  rxByType = new Map<number, Tally>()
  desyncs = 0
  resyncs = 0
  discardedPackets = 0
  /** Snapshot ticks the client's stream actually yielded, in order. */
  snapTicks: number[] = []

  private shadowTx = new StreamReader({ isValidStart: isKnownMsgType })
  private shadowRx = new StreamReader({
    isValidStart: isKnownMsgType,
    onDesync: () => this.desyncs++,
    onResync: (n) => {
      this.resyncs++
      this.discardedPackets += n
    },
  })

  constructor(
    private cond: { latencyMs: number; jitterMs: number; lossPct: number; perPacketMs: number },
    seed = 0x5eed,
  ) {
    this.rnd = mulberry32(seed)
    this.hostTransport = {
      role: 'host',
      maxPacket: BLE_MAX_PACKET,
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

  private enqueue(dir: string, at: number, fn: () => void): void {
    const q = this.wire.get(dir) ?? []
    if (q.length === 0) this.wire.set(dir, q)
    q.push({ at, fn })
    this.drain(dir)
  }

  private drain(dir: string): void {
    if (this.armed.has(dir)) return
    const q = this.wire.get(dir)
    if (!q || q.length === 0) return
    this.armed.add(dir)
    setTimeout(
      () => {
        this.armed.delete(dir)
        const now = Date.now()
        while (q.length > 0 && q[0].at <= now) q.shift()!.fn()
        this.drain(dir)
      },
      Math.max(0, q[0].at - Date.now()),
    )
  }

  private async transmit(dir: string, bytes: Uint8Array, deliver: (b: Uint8Array) => void): Promise<void> {
    this.sent++
    const h2c = dir.startsWith('h2c')
    if (h2c) this.shadowTx.push(new Uint8Array(bytes), (m) => bump(this.txByType, m[0], m.length))
    const lost = this.rnd() * 100 < this.cond.lossPct
    const copy = new Uint8Array(bytes)
    if (!lost) {
      const jitter = (this.rnd() * 2 - 1) * this.cond.jitterMs
      let delay = Math.max(0, this.cond.latencyMs + jitter)
      const at = Math.max(Date.now() + delay, (this.lastDelivery.get(dir) ?? 0) + 0.5)
      this.lastDelivery.set(dir, at)
      delay = Math.max(0, at - Date.now())
      this.enqueue(dir, Date.now() + delay, () => {
        if (h2c) {
          this.shadowRx.push(copy, (m) => {
            bump(this.rxByType, m[0], m.length)
            if (m[0] === MsgType.Snapshot && m.length >= 5) {
              this.snapTicks.push(new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(1, true))
            }
          })
        }
        deliver(copy)
      })
    } else this.dropped++
    if (this.cond.perPacketMs > 0) await sleep(this.cond.perPacketMs)
  }

  addClient(name: string, input: InputSource): { session: NetClientSession; connect: () => void } {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    const t: Transport = {
      role: 'client',
      maxPacket: BLE_MAX_PACKET,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p, bytes) => this.transmit(`c2h:${peer}`, bytes, (b) => this.hostHandler?.({ type: 'data', peer, bytes: b })),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, t)
    return {
      session,
      connect: () => {
        this.hostHandler?.({ type: 'peerConnected', peer })
        clientHandler?.({ type: 'peerConnected', peer: 'host' })
      },
    }
  }
}

class ScriptedInput implements InputSource {
  cmd: InputCmd = emptyInput()
  sample(): InputCmd {
    return { ...this.cmd }
  }
  set(patch: Partial<InputCmd>): void {
    this.cmd = { ...emptyInput(), ...patch }
  }
}

const run = async (lossPct: number, seconds: number): Promise<void> => {
  const hub = new Hub({ latencyMs: 25, jitterMs: 5, lossPct, perPacketMs: 4 })
  const hostInput = new ScriptedInput()
  const clientInput = new ScriptedInput()
  const host = new NetHostSession(20260808, 'HostPhone', hostInput, hub.hostTransport)
  const c = hub.addClient('FriendPhone', clientInput)

  await host.start()
  await c.session.start()
  c.connect()
  const joinDeadline = Date.now() + 8000
  while (Date.now() < joinDeadline && host.lobbyPlayers().length < 2) await sleep(20)
  const joined = host.lobbyPlayers().length >= 2
  host.beginGame()
  const playDeadline = Date.now() + 10000
  while (Date.now() < playDeadline && c.session.phase !== 'playing') {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  const reachedPlay = c.session.phase === 'playing'
  // Immortal: isolate link behaviour from the death/game-over path.
  for (const e of host.world.entities) {
    if (e.playerCtl && e.health) {
      e.health.hp = 1e6
      e.health.max = 1e6
    }
  }
  hostInput.set({ moveX: 1, moveY: 0.3, aimX: 1, aimY: 0, attack: true })
  clientInput.set({ moveX: -0.6, moveY: 1, aimX: 0, aimY: 1, attack: true })

  const endAt = Date.now() + seconds * 1000
  while (Date.now() < endAt) {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  await sleep(300)

  // --- report
  const types = [...new Set([...hub.txByType.keys(), ...hub.rxByType.keys()])].sort((a, b) => a - b)
  console.log(`\n=== loss ${lossPct}% | ${seconds}s | joined=${joined} reachedPlay=${reachedPlay} phase=${c.session.phase} ===`)
  console.log(`link: ${hub.sent} packets sent, ${hub.dropped} dropped (${((hub.dropped / hub.sent) * 100).toFixed(1)}%)`)
  console.log(
    `framing: ${hub.desyncs} desyncs, ${hub.resyncs} resyncs, ${hub.discardedPackets} packets discarded while resyncing; client.streamDesyncs=${c.session.streamDesyncs}`,
  )
  console.log('type          sent    recv    lost   loss%   avgB   pkts/msg')
  let totalLost = 0
  for (const t of types) {
    const tx = hub.txByType.get(t) ?? blank()
    const rx = hub.rxByType.get(t) ?? blank()
    const lost = tx.msgs - rx.msgs
    totalLost += Math.max(0, lost)
    const avg = tx.msgs > 0 ? tx.bytes / tx.msgs : 0
    console.log(
      `${(TYPE_NAME.get(t) ?? `?${t}`).padEnd(12)} ${String(tx.msgs).padStart(6)} ${String(rx.msgs).padStart(7)} ${String(lost).padStart(7)} ${(tx.msgs ? (lost / tx.msgs) * 100 : 0).toFixed(1).padStart(7)} ${avg.toFixed(0).padStart(6)} ${(tx.msgs ? tx.packets / tx.msgs : 0).toFixed(2).padStart(10)}`,
    )
  }
  console.log(
    `AMPLIFICATION: ${totalLost} h2c messages lost for ${hub.dropped} dropped packets = ${hub.dropped ? (totalLost / hub.dropped).toFixed(2) : 'n/a'} messages lost per dropped packet`,
  )

  // Snapshot gap distribution: consecutive delivered snapshots differ by
  // SNAPSHOT_INTERVAL_TICKS (3) when none were lost.
  const gaps = new Map<number, number>()
  let worst = 0
  for (let i = 1; i < hub.snapTicks.length; i++) {
    const missed = Math.max(0, Math.round((hub.snapTicks[i] - hub.snapTicks[i - 1]) / 3) - 1)
    gaps.set(missed, (gaps.get(missed) ?? 0) + 1)
    if (missed > worst) worst = missed
  }
  const total = [...gaps.values()].reduce((a, b) => a + b, 0)
  const parts = [...gaps.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v} (${((v / total) * 100).toFixed(1)}%)`)
  console.log(`snapshot gaps (consecutive snapshots missed): ${parts.join('  ')}`)
  console.log(
    `worst snapshot gap: ${worst} missed = ${((worst + 1) * 100).toFixed(0)}ms of stale world; snapshots applied by client stream: ${hub.snapTicks.length}`,
  )
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const li = args.indexOf('--loss')
  const si = args.indexOf('--seconds')
  const losses = li >= 0 ? args[li + 1].split(',').map(Number) : [0, 2, 5, 10, 30]
  const seconds = si >= 0 ? Number(args[si + 1]) : 30
  for (const l of losses) await run(l, seconds)
  process.exit(0)
}

void main()
