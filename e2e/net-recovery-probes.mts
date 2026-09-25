/**
 * MEASUREMENT TOOL (analysis, not a gate). Three probes that quantify the
 * protocol's recovery gaps, over the same 180-byte BLE link model as
 * `net-conditions.mts`.
 *
 *  A) JOIN RELIABILITY. Welcome/GameStart/Go ride the "reliable" lane, which is
 *     only reliable in the sense that the SendQueue never drops it — the BLE
 *     notification underneath is unacknowledged and there is no retransmit. Run
 *     N independent joins per loss level and count how many reach 'playing'.
 *
 *  B) INPUT SEQ WRAP. `encodeInput` masks cmd.seq to u16, but the client keeps
 *     an unmasked counter and prunes with `p.seq > lastAckedSeq`. Fast-forward
 *     the counter to just under 2^16 and watch what happens to the pending-input
 *     backlog and to reconciliation.
 *
 *  C) DELTA HEADROOM. Decode every snapshot the host emits and count how many
 *     entity records are byte-identical to that peer's previous snapshot. This
 *     is the ceiling on what delta encoding could save.
 *
 * Run: npx tsx e2e/net-recovery-probes.mts [--probe a|b|c]
 */
import { emptyInput, type InputCmd } from '../src/game/types'
import type { InputSource } from '../src/input/input'
import { NetClientSession } from '../src/app/netClient'
import { NetHostSession } from '../src/app/netHost'
import { decodeSnapshot } from '../src/net/protocol/messages'
import { isKnownMsgType, MsgType, type PeerId, type Transport, type TransportEvent } from '../src/net/types'
import { StreamReader } from '../src/net/framing/chunkedStream'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const TICK_MS = 1000 / 30
const BLE_MAX_PACKET = 180

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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
  /** Every h2c message the host emitted, in order (send-side shadow). */
  onTxMessage: ((m: Uint8Array) => void) | null = null
  private shadowTx = new StreamReader({ isValidStart: isKnownMsgType })

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
    if (dir.startsWith('h2c') && this.onTxMessage) this.shadowTx.push(new Uint8Array(bytes), this.onTxMessage)
    const lost = this.rnd() * 100 < this.cond.lossPct
    const copy = new Uint8Array(bytes)
    if (!lost) {
      const jitter = (this.rnd() * 2 - 1) * this.cond.jitterMs
      let delay = Math.max(0, this.cond.latencyMs + jitter)
      const at = Math.max(Date.now() + delay, (this.lastDelivery.get(dir) ?? 0) + 0.5)
      this.lastDelivery.set(dir, at)
      delay = Math.max(0, at - Date.now())
      this.enqueue(dir, Date.now() + delay, () => deliver(copy))
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

// ------------------------------------------------------- A) join reliability

const oneJoin = async (lossPct: number, seed: number): Promise<string> => {
  const hub = new Hub({ latencyMs: 25, jitterMs: 5, lossPct, perPacketMs: 4 }, seed)
  const host = new NetHostSession(20260808, 'HostPhone', new ScriptedInput(), hub.hostTransport)
  const c = hub.addClient('FriendPhone', new ScriptedInput())
  await host.start()
  await c.session.start()
  c.connect()
  const joinDeadline = Date.now() + 3000
  while (Date.now() < joinDeadline && host.lobbyPlayers().length < 2) await sleep(10)
  if (host.lobbyPlayers().length < 2) return 'host-never-saw-hello'
  host.beginGame()
  const playDeadline = Date.now() + 4000
  while (Date.now() < playDeadline && c.session.phase !== 'playing') {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  // Keep simulating: does the client EVER dig itself out on its own?
  const healDeadline = Date.now() + 4000
  while (Date.now() < healDeadline && c.session.phase !== 'playing') {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  return c.session.phase === 'playing' ? 'ok' : `stuck:${c.session.phase}`
}

const probeA = async (): Promise<void> => {
  console.log('\n=== A) JOIN RELIABILITY (handshake has no retransmit) ===')
  console.log('loss%   attempts   reached-playing   failures (phase after 4s extra of host still simulating)')
  for (const loss of [0, 2, 5, 10, 20, 30]) {
    const N = 16
    const outcomes = new Map<string, number>()
    for (let i = 0; i < N; i++) {
      const r = await oneJoin(loss, 0x1000 + i * 7919 + loss * 131)
      outcomes.set(r, (outcomes.get(r) ?? 0) + 1)
    }
    const ok = outcomes.get('ok') ?? 0
    const fails = [...outcomes].filter(([k]) => k !== 'ok')
    console.log(
      `${String(loss).padStart(4)}   ${String(N).padStart(8)}   ${String(ok).padStart(15)}   ${((1 - ok / N) * 100).toFixed(0)}% fail  ${fails.map(([k, v]) => `${k} x${v}`).join(', ')}`,
    )
  }
}

// -------------------------------------------------------- B) input seq wrap

const probeB = async (): Promise<void> => {
  console.log('\n=== B) INPUT SEQ u16 WRAP (client keeps an unmasked counter) ===')
  const hub = new Hub({ latencyMs: 25, jitterMs: 5, lossPct: 0, perPacketMs: 2 })
  const hostInput = new ScriptedInput()
  const clientInput = new ScriptedInput()
  const host = new NetHostSession(20260808, 'HostPhone', hostInput, hub.hostTransport)
  const c = hub.addClient('FriendPhone', clientInput)
  await host.start()
  await c.session.start()
  c.connect()
  while (host.lobbyPlayers().length < 2) await sleep(10)
  host.beginGame()
  while (c.session.phase !== 'playing') {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  for (const e of host.world.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 }
  clientInput.set({ moveX: 1, moveY: 0.2 })
  const anyC = c.session as unknown as Record<string, unknown>

  const settle = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      host.tick()
      c.session.tick()
      await sleep(TICK_MS)
    }
  }
  await settle(60)
  const before = (anyC.pendingInputs as unknown[]).length
  console.log(`baseline (seq ~${anyC.inputSeq}): pendingInputs backlog = ${before}, lastAckedSeq = ${anyC.lastAckedSeq}`)

  // Fast-forward BOTH ends to just under the u16 boundary. The host's guard
  // (`cmd.seq > lastInputSeq || lastInputSeq - cmd.seq > 30000`) tolerates the
  // wrap; this probe is about the CLIENT's unmasked counter.
  anyC.inputSeq = 65500
  const hostPeer = [...host.peersBySlot.values()][0] as unknown as Record<string, unknown>
  hostPeer.lastInputSeq = 65500
  await settle(150) // walk across 65536
  const after = (anyC.pendingInputs as unknown[]).length
  console.log(`after crossing 2^16 (seq now ${anyC.inputSeq}): pendingInputs backlog = ${after}, lastAckedSeq = ${anyC.lastAckedSeq}`)
  console.log(
    after >= 60
      ? `RESULT: backlog PINNED at the ${after}-entry cap. reconcile() now replays ${after} inputs on EVERY snapshot (~${(after / 30).toFixed(1)}s of movement, ~${(after * 4.5 * (1 / 30)).toFixed(1)} tiles) instead of the 2-3 it should.`
      : `RESULT: backlog stayed healthy at ${after} — the wrap is handled.`,
  )
  console.log(`Wrap arrives after 65536 client ticks at 30Hz = ${(65536 / 30 / 60).toFixed(1)} minutes of play.`)
}

// ----------------------------------------------------- C) delta-encoding headroom

const probeC = async (): Promise<void> => {
  console.log('\n=== C) DELTA HEADROOM (how many entity records repeat verbatim) ===')
  const hub = new Hub({ latencyMs: 25, jitterMs: 5, lossPct: 0, perPacketMs: 2 })
  const hostInput = new ScriptedInput()
  const clientInput = new ScriptedInput()
  const host = new NetHostSession(20260808, 'HostPhone', hostInput, hub.hostTransport)
  const c = hub.addClient('FriendPhone', clientInput)

  let prev = new Map<number, string>()
  let totalRecords = 0
  let unchanged = 0
  let snaps = 0
  let entSum = 0
  let entMax = 0
  let byteSum = 0
  hub.onTxMessage = (m) => {
    if (m[0] !== MsgType.Snapshot) return
    const s = decodeSnapshot(m)
    snaps++
    entSum += s.entities.length
    byteSum += m.length
    if (s.entities.length > entMax) entMax = s.entities.length
    const now = new Map<number, string>()
    for (const e of s.entities) {
      // Exactly the bytes the wire carries for this record.
      const sig = `${e.archetype}|${e.flags}|${Math.round(e.x * 32)}|${Math.round(e.y * 32)}|${Math.round(e.facing * (256 / (Math.PI * 2))) & 0xff}|${Math.round(e.hpPct * 255)}`
      now.set(e.id, sig)
      totalRecords++
      if (prev.get(e.id) === sig) unchanged++
    }
    prev = now
  }

  await host.start()
  await c.session.start()
  c.connect()
  while (host.lobbyPlayers().length < 2) await sleep(10)
  host.beginGame()
  while (c.session.phase !== 'playing') {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  for (const e of host.world.entities) if (e.playerCtl && e.health) { e.health.hp = 1e6; e.health.max = 1e6 }
  hostInput.set({ moveX: 1, moveY: 0.3, attack: true })
  clientInput.set({ moveX: -0.6, moveY: 1, attack: true })
  const endAt = Date.now() + 30000
  while (Date.now() < endAt) {
    host.tick()
    c.session.tick()
    await sleep(TICK_MS)
  }
  console.log(`snapshots: ${snaps}, avg ${(entSum / snaps).toFixed(1)} entities (max ${entMax}), avg ${(byteSum / snaps).toFixed(0)}B on the wire`)
  console.log(
    `entity records byte-identical to the previous snapshot: ${unchanged}/${totalRecords} = ${((unchanged / totalRecords) * 100).toFixed(1)}%`,
  )
  const avgEnt = entSum / snaps
  const changed = avgEnt * (1 - unchanged / totalRecords)
  // Delta form: 10B header + 6B id-bitmap (48 bits) + 10B per CHANGED entity.
  const deltaBytes = 10 + 6 + changed * 10
  console.log(
    `projected delta snapshot: 10B header + 6B present-bitmap + ${changed.toFixed(1)} changed x 10B = ${deltaBytes.toFixed(0)}B vs ${(byteSum / snaps).toFixed(0)}B full = ${(((byteSum / snaps - deltaBytes) / (byteSum / snaps)) * 100).toFixed(0)}% smaller`,
  )
}

const main = async (): Promise<void> => {
  const i = process.argv.indexOf('--probe')
  const which = i >= 0 ? process.argv[i + 1] : 'abc'
  if (which.includes('a')) await probeA()
  if (which.includes('b')) await probeB()
  if (which.includes('c')) await probeC()
  process.exit(0)
}

void main()
