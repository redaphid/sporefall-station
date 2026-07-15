// In-app debug bridge. Loaded only behind the `?debug` flag (dynamic import in
// main.ts), so it is a no-op — and not even bundled — in normal builds. It opens
// an OUTBOUND WebSocket to the hub on the laptop (the webview can't listen),
// registers as the `game`, and answers verbs against the live world.
//
// Sim-safety: verbs that mutate are queued and drained in `afterTick()` — a safe
// point between the sim step and render — mirroring the C# harness marshaling
// mutations onto the main thread. Reads answer immediately (JS is single-
// threaded: a socket callback never interleaves with a tick or a render).
//
// Reconnect: the socket dies on HMR reloads and idle timeouts during phone
// testing. `connectWithBackoff` transparently re-dials the hub with exponential
// backoff so a long e2e/record session survives drops without losing the game.

import type { SimEvent } from '../game/types'
import type { World } from '../game/world'
import type { GameHarness } from './harness'
import { runHarnessVerb } from './harness'
import type { DebugMsg } from './protocol'
import { runVerb, verbName, WRITE_VERBS } from './verbs'

export interface DebugChannel {
  /** Call once per sim tick, after `session.tick()`: stream this tick's events
   * and drain any queued mutations. */
  afterTick(): void
  stop(): void
}

export interface ChannelOpts {
  /** Auto-reconnect on drop (default true). */
  reconnect?: boolean
  /** First backoff delay in ms (default 500), doubling up to `maxDelayMs`. */
  baseDelayMs?: number
  /** Backoff ceiling in ms (default 8000). */
  maxDelayMs?: number
  /** Injectable WebSocket ctor for tests; defaults to the global. */
  WebSocketImpl?: typeof WebSocket
}

const MAX_EVENTS = 256

interface Conn {
  send(msg: DebugMsg): void
  stop(): void
}

/** Maintain a `game`-role socket to the hub, re-dialing with exponential backoff
 * on close. `onMessage` is rebound to each fresh socket and handed a `send` so
 * handlers need no reference to the (not-yet-constructed) Conn. */
const connectWithBackoff = (
  url: string,
  onMessage: (msg: DebugMsg, send: (m: DebugMsg) => void) => void,
  log: (m: string) => void,
  opts: ChannelOpts,
): Conn => {
  const WS = opts.WebSocketImpl ?? WebSocket
  const base = opts.baseDelayMs ?? 500
  const cap = opts.maxDelayMs ?? 8000
  const reconnect = opts.reconnect !== false
  let ws: WebSocket
  let ready = false
  let stopped = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const send = (msg: DebugMsg): void => {
    if (ready) ws.send(JSON.stringify(msg))
  }

  const open = (): void => {
    ws = new WS(url)
    ws.onopen = () => {
      ready = true
      attempt = 0
      ws.send(JSON.stringify({ t: 'hello', role: 'game' } satisfies DebugMsg))
      log(`[debug] connected to ${url}`)
    }
    ws.onerror = () => log(`[debug] socket error (${url}) — is the hub running?`)
    ws.onclose = () => {
      ready = false
      if (stopped || !reconnect) return
      const delay = Math.min(cap, base * 2 ** attempt++)
      log(`[debug] disconnected — retrying in ${delay}ms`)
      timer = setTimeout(() => {
        if (!stopped) open()
      }, delay)
    }
    ws.onmessage = (ev) => {
      let msg: DebugMsg
      try {
        msg = JSON.parse(String(ev.data)) as DebugMsg
      } catch {
        return
      }
      onMessage(msg, send)
    }
  }

  open()
  return {
    send,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      ws.close()
    },
  }
}

/** Bridge the live world over the hub. Reads answer immediately; writes defer to
 * `afterTick` for sim-safety. */
export const startDebugChannel = (
  world: World,
  url: string,
  log: (m: string) => void = console.log,
  opts: ChannelOpts = {},
): DebugChannel => {
  const pending: Array<() => void> = []
  const recentEvents: SimEvent[] = []

  const onMessage = (msg: DebugMsg, send: (m: DebugMsg) => void): void => {
    if (msg.t !== 'req') return
    const { id, verb } = msg
    const reply = (ok: boolean, body: string): void => send({ t: 'rep', id, ok, body })
    const run = (): void => {
      try {
        reply(true, runVerb(world, verb, { events: recentEvents }))
      } catch (e) {
        reply(false, e instanceof Error ? e.message : String(e))
      }
    }
    if (WRITE_VERBS.has(verbName(verb))) pending.push(run)
    else run()
  }

  const conn = connectWithBackoff(url, onMessage, log, opts)

  const afterTick = (): void => {
    // Drain queued mutations FIRST: they run between ticks (sim-safe) and may
    // push their own events (a `kill` emits `death`) into world.events, which
    // the next tick would otherwise clear before we ever stream them.
    if (pending.length) for (const fn of pending.splice(0)) fn()
    for (const e of world.events) {
      recentEvents.push(e)
      conn.send({ t: 'event', body: JSON.stringify({ tick: world.tick, ...e }) })
    }
    while (recentEvents.length > MAX_EVENTS) recentEvents.shift()
  }

  return { afterTick, stop: () => conn.stop() }
}

/** Bridge a headless GameHarness over the hub — same wire protocol, but verbs go
 * through `runHarnessVerb` (create/join_bot/start_run/tick/record/…) so the CLI
 * and MCP can drive a whole session with no game/phone. The harness self-drives
 * ticks inside the `tick` verb, so its events are streamed right after each verb. */
export const startHarnessChannel = (
  harness: GameHarness,
  url: string,
  log: (m: string) => void = console.log,
  opts: ChannelOpts = {},
): DebugChannel => {
  const recentEvents: SimEvent[] = []

  const flushEvents = (send: (m: DebugMsg) => void): void => {
    for (const tagged of harness.drainStreamEvents()) {
      recentEvents.push(tagged as unknown as SimEvent)
      send({ t: 'event', body: JSON.stringify(tagged) })
    }
    while (recentEvents.length > MAX_EVENTS) recentEvents.shift()
  }

  const onMessage = (msg: DebugMsg, send: (m: DebugMsg) => void): void => {
    if (msg.t !== 'req') return
    const { id, verb } = msg
    try {
      send({ t: 'rep', id, ok: true, body: runHarnessVerb(harness, verb, { events: recentEvents }) })
    } catch (e) {
      send({ t: 'rep', id, ok: false, body: e instanceof Error ? e.message : String(e) })
    }
    flushEvents(send)
  }

  const conn = connectWithBackoff(url, onMessage, log, opts)
  return { afterTick: () => flushEvents(conn.send), stop: () => conn.stop() }
}
