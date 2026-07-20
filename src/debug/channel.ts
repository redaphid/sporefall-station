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
import type { DebugMsg, HelloMsg } from './protocol'
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
  /** Stable label sent in `hello` so the hub can identify/route this game. */
  name?: string
  /** Renderer hook for the `theme` verb (presentation-only hot-swap); absent in
   * headless contexts, where the verb reports itself unavailable. */
  setTheme?: (id: string) => void
  /** Liveness heartbeat interval in ms (default 1000; 0 disables). */
  heartbeatMs?: number
  /** Injectable page-lifecycle source for tests; defaults to the real DOM
   * (window `pagehide`/`beforeunload` + document `visibilitychange`). */
  lifecycle?: LifecycleTarget
}

/** The subset of page-lifecycle the channel needs to self-remove when the webview
 * is backgrounded or unloaded. Real builds derive it from window/document; tests
 * inject a fake and fire events by hand. */
export interface LifecycleTarget {
  addEventListener(type: string, cb: () => void): void
  removeEventListener(type: string, cb: () => void): void
  /** Is the page currently hidden (backgrounded)? */
  hidden(): boolean
}

const MAX_EVENTS = 256

interface Conn {
  send(msg: DebugMsg): void
  /** Intentionally close + stop re-dialing, but stay resumable (page hidden). */
  pause(): void
  /** Re-open after a `pause` (page visible again). No-op once stopped. */
  resume(): void
  /** Permanent teardown — never re-dials. */
  stop(): void
}

/** Real-DOM lifecycle source, or `undefined` when not in a browser (Node harness
 * host has no window, so it simply skips lifecycle self-removal). `visibilitychange`
 * lives on `document`; `pagehide`/`beforeunload` on `window`. */
const domLifecycle = (): LifecycleTarget | undefined => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
  const target = (type: string): EventTarget => (type === 'visibilitychange' ? document : window)
  return {
    addEventListener: (type, cb) => target(type).addEventListener(type, cb),
    removeEventListener: (type, cb) => target(type).removeEventListener(type, cb),
    hidden: () => document.visibilityState === 'hidden',
  }
}

/** Maintain a `game`-role socket to the hub, re-dialing with exponential backoff
 * on an *unintentional* close. `pause`/`resume`/`stop` distinguish a page that
 * backgrounds itself (must NOT keep re-dialing a ghost) from a transient drop.
 * `onMessage` is rebound to each fresh socket and handed a `send` so handlers
 * need no reference to the (not-yet-constructed) Conn. */
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
  let ws: WebSocket | undefined
  let ready = false
  let stopped = false
  let paused = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const send = (msg: DebugMsg): void => {
    if (ready && ws) ws.send(JSON.stringify(msg))
  }

  const open = (): void => {
    ws = new WS(url)
    ws.onopen = () => {
      ready = true
      attempt = 0
      const hello: HelloMsg = { t: 'hello', role: 'game', ...(opts.name ? { name: opts.name } : {}) }
      ws!.send(JSON.stringify(hello))
      log(`[debug] connected to ${url}`)
    }
    ws.onerror = () => log(`[debug] socket error (${url}) — is the hub running?`)
    ws.onclose = () => {
      ready = false
      // No re-dial after an intentional close (stop/pause) or when disabled — the
      // reconnect loop must never resurrect a page that removed itself.
      if (stopped || paused || !reconnect) return
      const delay = Math.min(cap, base * 2 ** attempt++)
      log(`[debug] disconnected — retrying in ${delay}ms`)
      timer = setTimeout(() => {
        if (!stopped && !paused) open()
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
    pause: () => {
      if (paused) return
      paused = true
      if (timer) clearTimeout(timer)
      ws?.close()
    },
    resume: () => {
      if (stopped || !paused) return
      paused = false
      attempt = 0
      open()
    },
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      ws?.close()
    },
  }
}

/** Fire `sample` (tick/gameOver snapshot) at a fixed interval so the hub can see
 * this game is alive AND advancing. `unref` (Node-only) keeps the heartbeat from
 * pinning the event loop open in tests/scripts. Returns a stop fn. */
const startHeartbeat = (
  conn: Conn,
  heartbeatMs: number,
  sample: () => { tick?: number; gameOver?: boolean },
): (() => void) => {
  if (heartbeatMs <= 0) return () => {}
  const timer = setInterval(() => conn.send({ t: 'ping', ...sample() }), heartbeatMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
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
        reply(true, runVerb(world, verb, { events: recentEvents, setTheme: opts.setTheme }))
      } catch (e) {
        reply(false, e instanceof Error ? e.message : String(e))
      }
    }
    if (WRITE_VERBS.has(verbName(verb))) pending.push(run)
    else run()
  }

  const conn = connectWithBackoff(url, onMessage, log, opts)

  // Heartbeat carries the world tick so the hub can tell a live, advancing game
  // from a frozen/backgrounded one whose tick has stopped.
  const stopHeartbeat = startHeartbeat(conn, opts.heartbeatMs ?? 1000, () => ({
    tick: world.tick,
    gameOver: world.gameOver,
  }))

  // Self-remove when the webview is backgrounded or unloaded: close the socket
  // AND cancel the reconnect loop so a reloading/suspended page stops re-attaching
  // as a ghost the harness could latch onto. Re-arm when the page is foregrounded.
  const lifecycle = opts.lifecycle ?? domLifecycle()
  const onHide = (): void => conn.pause()
  const onVisibility = (): void => (lifecycle!.hidden() ? conn.pause() : conn.resume())
  if (lifecycle) {
    lifecycle.addEventListener('pagehide', onHide)
    lifecycle.addEventListener('beforeunload', onHide)
    lifecycle.addEventListener('visibilitychange', onVisibility)
  }

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

  const stop = (): void => {
    stopHeartbeat()
    if (lifecycle) {
      lifecycle.removeEventListener('pagehide', onHide)
      lifecycle.removeEventListener('beforeunload', onHide)
      lifecycle.removeEventListener('visibilitychange', onVisibility)
    }
    conn.stop()
  }

  return { afterTick, stop }
}

/** A live debug link that survives a New-Seed / play-again reset. `restart()`
 * swaps `session.world` for a brand-new World object (`createWorld`), so a channel
 * bound to the OLD world would keep heart-beating its now-frozen tick as a zombie
 * while the fresh run went un-bridged and never registered. `rebind` re-establishes
 * the link against the NEW world exactly like a fresh page boot: it STOPS the old
 * channel (closing its socket so the hub drops the stale registration — no zombie)
 * then dials a fresh channel bound to the new world (a new `hello` → the hub
 * immediately sees the live, advancing run). */
export interface DebugLink {
  /** Stream this tick's events + drain queued mutations against the CURRENT world. */
  afterTick(): void
  /** Re-establish the link against a new world after a New-Seed / restart. */
  rebind(world: World): void
  /** Permanent teardown. */
  stop(): void
}

/** Start a rebindable debug link. Wraps `startDebugChannel` and, on `rebind`,
 * tears the old channel down and dials a fresh one against the new world so the
 * in-place New-Seed reset re-registers on the hub the same way a page reload does. */
export const startDebugLink = (
  world: World,
  url: string,
  log: (m: string) => void = console.log,
  opts: ChannelOpts = {},
): DebugLink => {
  let channel = startDebugChannel(world, url, log, opts)
  return {
    afterTick: () => channel.afterTick(),
    rebind: (next: World): void => {
      channel.stop() // close the old socket → hub drops the frozen zombie registration
      channel = startDebugChannel(next, url, log, opts) // fresh hello, bound to the NEW world
    },
    stop: () => channel.stop(),
  }
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
  // Heartbeat WITHOUT a tick: the headless harness advances only when driven, so
  // reporting no tick keeps the hub from ever flagging it "frozen" between verbs.
  const stopHeartbeat = startHeartbeat(conn, opts.heartbeatMs ?? 1000, () => ({}))
  return {
    afterTick: () => flushEvents(conn.send),
    stop: () => {
      stopHeartbeat()
      conn.stop()
    },
  }
}
