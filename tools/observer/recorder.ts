// Persistent, realtime observation recorder for a LIVE human-played game.
//
//   npx tsx tools/observer/recorder.ts          # run until killed
//   npx tsx tools/observer/recorder.ts --once   # one digest, then exit 0
//
// ONE long-lived hub connection replaces the per-verb CLI shell-outs: it
// records every pushed sim event tick-stamped, polls a compact state/player/
// threat extraction every ~1.5s, and continuously recomputes analytics so the
// observing agent reads ONE small file per wake-up:
//
//   .observer/live-digest.md   — atomically rewritten every poll (read this)
//   .observer/wake-events.log  — one line per wake-worthy moment (tail this)
//   .observer/timeline.jsonl   — full tick-stamped record (recreated per start)
//   .observer/outbox.txt       — write lines here; they appear in-game (~1s)
//
// STRICTLY READ-ONLY on the sim: the only verbs issued are `games`, `state`,
// `entities`, and the sanctioned UI channel `annotate`/`clearAnnotations`
// (inert presentation data no system reads). Never set/spawn/kill/teleport/
// step/load. All computation lives in ./digest.ts (pure, unit-tested).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectDebugger, defaultHubUrl, type DebugClient } from '../debug-client'
import { encodeArg, type GameInfo } from '../../src/debug/protocol'
import {
  applyEvent,
  applySample,
  createSession,
  estimateTick,
  extractSample,
  formatWakeLine,
  HEARTBEAT_MS,
  OUTBOX_MS,
  outboxAnnotations,
  pickTarget,
  POLL_MS,
  renderDigest,
  updateIndex,
  type Wake,
} from './digest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OBS_DIR = path.join(REPO_ROOT, '.observer')
const DIGEST_PATH = path.join(OBS_DIR, 'live-digest.md')
const WAKE_PATH = path.join(OBS_DIR, 'wake-events.log')
const TIMELINE_PATH = path.join(OBS_DIR, 'timeline.jsonl')
const OUTBOX_PATH = path.join(OBS_DIR, 'outbox.txt')

const once = process.argv.includes('--once')
const log = (msg: string): void => console.log(`[obs ${new Date().toISOString().slice(11, 19)}] ${msg}`)

// ── State ───────────────────────────────────────────────────────────────────
const session = createSession()
let client: DebugClient
let target: GameInfo | null = null
let eventBuffer: { wallMs: number; ev: unknown }[] = []
let lastOutboxSig = ''
let lastOutboxIds: string[] = []
let noGameLogged = false
let pollBusy = false
let quietPolls = 0

// ── Files ───────────────────────────────────────────────────────────────────
fs.mkdirSync(OBS_DIR, { recursive: true })
fs.writeFileSync(TIMELINE_PATH, '') // recreated per recorder start (spec-sanctioned)
if (!fs.existsSync(OUTBOX_PATH)) fs.writeFileSync(OUTBOX_PATH, '')

const appendTimeline = (obj: Record<string, unknown>): void => {
  try {
    fs.appendFileSync(TIMELINE_PATH, JSON.stringify(obj) + '\n')
  } catch (e) {
    log(`timeline append failed: ${String(e)}`)
  }
}

const writeWakes = (wakes: Wake[], wallMs: number): void => {
  if (!wakes.length) return
  const lines = wakes.map((w) => formatWakeLine(w, wallMs))
  try {
    fs.appendFileSync(WAKE_PATH, lines.join('\n') + '\n')
  } catch (e) {
    log(`wake-log append failed: ${String(e)}`)
  }
  for (const l of lines) log(`WAKE ${l}`)
}

/** Atomic digest rewrite: temp file + rename (rename replaces on Windows too). */
const writeDigest = (): void => {
  const tmp = DIGEST_PATH + '.tmp'
  try {
    fs.writeFileSync(tmp, renderDigest(session, Date.now()))
    fs.renameSync(tmp, DIGEST_PATH)
  } catch (e) {
    log(`digest write failed: ${String(e)}`)
  }
}

// ── Event stream (recorded continuously, folded immediately) ────────────────
const onEvent = (ev: unknown): void => {
  const wallMs = Date.now()
  eventBuffer.push({ wallMs, ev })
  if (eventBuffer.length > 5000) eventBuffer.splice(0, eventBuffer.length - 5000)
  try {
    writeWakes(applyEvent(session, ev, wallMs), wallMs)
  } catch (e) {
    log(`event fold failed: ${String(e)}`)
  }
}

// ── Poll: games → state + entities → analytics → digest ─────────────────────
const flushEvents = (): void => {
  if (!eventBuffer.length) return
  const batch = eventBuffer
  eventBuffer = []
  appendTimeline({ k: 'events', wallMs: Date.now(), list: batch })
}

const poll = async (): Promise<void> => {
  if (pollBusy) return // never overlap slow polls
  pollBusy = true
  const wallMs = Date.now()
  try {
    let games: GameInfo[]
    try {
      games = await client.games()
    } catch (e) {
      session.noGame = `hub unreachable at ${defaultHubUrl()} (${e instanceof Error ? e.message : String(e)}) — retrying`
      if (!noGameLogged) log(session.noGame)
      noGameLogged = true
      flushEvents()
      writeDigest()
      return
    }
    const next = pickTarget(games)
    if (next?.id !== target?.id) {
      target = next
      log(next ? `target game: ${next.id} (${next.name}) tick=${next.tick} ${next.ticking ? 'ticking' : 'FROZEN'}` : 'target game lost')
    }
    if (!target) {
      session.noGame = `no real-time game connected to the hub (${games.length} connection(s), none with a tick) — retrying`
      if (!noGameLogged) log(session.noGame)
      noGameLogged = true
      flushEvents()
      writeDigest()
      return
    }
    noGameLogged = false
    const frozen = target.ticking === false

    const [stateRaw, entitiesRaw] = await Promise.all([
      client.raw('state', { target: target.id, timeoutMs: 4000 }),
      client.raw('entities', { target: target.id, timeoutMs: 4000 }),
    ])
    const { sample, index } = extractSample(JSON.parse(stateRaw), JSON.parse(entitiesRaw), wallMs, frozen)
    updateIndex(session, index)
    const wakes = applySample(session, sample)
    writeWakes(wakes, wallMs)
    appendTimeline({ k: 'sample', ...sample })
    flushEvents()
    writeDigest()

    // A terse pulse to stdout every ~30s so a tailed task shows life.
    if (wakes.length || ++quietPolls >= 20) {
      quietPolls = 0
      const p = sample.players[0]
      log(`t${sample.tick} seed ${sample.seed} floor ${sample.floor} alarm ${sample.alarm}${p ? ` · P${p.playerId} hp ${p.hp}/${p.maxHp} @ (${p.pos.x.toFixed(0)},${p.pos.y.toFixed(0)})` : ' · no player'}${frozen ? ' · FROZEN' : ''}`)
    }
  } catch (e) {
    log(`poll failed (will retry): ${e instanceof Error ? e.message : String(e)}`)
    flushEvents()
    writeDigest()
  } finally {
    pollBusy = false
  }
}

// ── UI heartbeat (skipped while frozen: a paused world never expires ttls) ──
const heartbeat = async (): Promise<void> => {
  if (!target || !session.lastSample || session.lastSample.frozen) return
  const tick = estimateTick(session, Date.now())
  const ann = { id: 'observer-hb', kind: 'text', text: `OBSERVER live - t${tick}`, x: 16, y: 44, ttlTick: tick + 900 }
  try {
    // Same-id annotate APPENDS (never replaces) — clear the old banner first.
    await client.raw('clearAnnotations observer-hb', { target: target.id, timeoutMs: 4000 })
    await client.raw(`annotate ${encodeArg(JSON.stringify(ann))}`, { target: target.id, timeoutMs: 4000 })
  } catch (e) {
    log(`heartbeat post failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── Outbox: sub-second in-game messaging with zero process startup ──────────
const outboxTick = async (): Promise<void> => {
  let st: fs.Stats
  try {
    st = fs.statSync(OUTBOX_PATH)
  } catch {
    try {
      fs.writeFileSync(OUTBOX_PATH, '')
    } catch { /* transient */ }
    return
  }
  const sig = `${st.mtimeMs}:${st.size}`
  if (sig === lastOutboxSig) return
  const content = fs.readFileSync(OUTBOX_PATH, 'utf8')
  if (content.trim() === '') {
    lastOutboxSig = sig
    return
  }
  if (!target || !session.lastSample) return // keep pending until a game exists
  lastOutboxSig = sig
  const anns = outboxAnnotations(content, estimateTick(session, Date.now()))
  try {
    for (const id of lastOutboxIds) await client.raw(`clearAnnotations ${id}`, { target: target.id, timeoutMs: 4000 })
    await client.raw(`annotate ${encodeArg(JSON.stringify(anns))}`, { target: target.id, timeoutMs: 4000 })
    log(`outbox → ${anns.length} banner(s) posted in-game`)
  } catch (e) {
    // The write may still land when a frozen tab wakes (it is queued sim-side);
    // one attempt per outbox change, so a hung post never spams duplicates.
    log(`outbox post did not confirm (${e instanceof Error ? e.message : String(e)}) — may appear when the game unfreezes`)
  }
  lastOutboxIds = anns.map((a) => a.id)
  try {
    fs.writeFileSync(OUTBOX_PATH, '')
    lastOutboxSig = `${fs.statSync(OUTBOX_PATH).mtimeMs}:0`
  } catch { /* transient */ }
}

// ── Main ────────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  log(`observer recorder starting — hub ${defaultHubUrl()} · out ${OBS_DIR}${once ? ' · --once' : ''}`)
  client = await connectDebugger() // self-healing: reconnects with backoff forever
  client.onEvent(onEvent)

  if (once) {
    // Give the socket a moment to open, produce one digest, exit 0.
    await new Promise((r) => setTimeout(r, 1500))
    await poll()
    log(`digest written to ${DIGEST_PATH}`)
    client.close()
    process.exit(0)
  }

  try {
    fs.appendFileSync(WAKE_PATH, formatWakeLine({ kind: 'recorderStart', tick: 0, detail: `pid ${process.pid}` }, Date.now()) + '\n')
  } catch { /* non-fatal */ }

  await poll()
  const timers = [
    setInterval(() => void poll(), POLL_MS),
    setInterval(() => void heartbeat(), HEARTBEAT_MS),
    setInterval(() => void outboxTick(), OUTBOX_MS),
  ]
  const stop = (): void => {
    for (const t of timers) clearInterval(t)
    flushEvents()
    writeDigest()
    client.close()
    log('recorder stopped')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// Transient errors must never take the recorder down mid-session.
process.on('uncaughtException', (e) => log(`uncaught (recovered): ${e.message}`))
process.on('unhandledRejection', (e) => log(`unhandled rejection (recovered): ${String(e)}`))

void main()
