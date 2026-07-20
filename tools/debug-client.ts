// Shared debugger-side client used by the CLI and the MCP bridge. Connects to
// the hub as a `debugger`, correlates each verb with its reply by id, and fans
// pushed events out to subscribers. Uses Node's built-in global WebSocket
// (Node 22+) so it needs no dependency of its own.
//
// Resilience: the bridge NEVER blocks startup on the hub being up, and it heals
// itself. It connects in the background with bounded exponential backoff and
// keeps retrying forever — so the MCP server can bind its HTTP port while the
// hub is down, and transparently resume once the hub appears (or reappears after
// a drop). While disconnected, `raw()` fails FAST with a clear error instead of
// hanging until the per-verb timeout. Timers/backoff are fine here: the
// determinism ban (`Date.now`/`Math.random`) covers `src/game/`, not `tools/`.

import { DEFAULT_HUB_PORT, hubUrl, type DebugMsg, type GameInfo } from '../src/debug/protocol'

export interface RawOpts {
  timeoutMs?: number
  /** Route this verb to the game with this id/name (else the hub's default). */
  target?: string
}

export interface DebugClient {
  /** Send one verb line; resolve with the game's text reply (reject on error). */
  raw(verb: string, opts?: RawOpts): Promise<string>
  /** List the games connected to the hub (a hub control verb). */
  games(): Promise<GameInfo[]>
  onEvent(cb: (event: unknown) => void): void
  close(): void
}

export const defaultHubUrl = (): string =>
  process.env.DEBUG_HUB_URL ?? hubUrl('127.0.0.1', Number(process.env.DEBUG_HUB_PORT ?? DEFAULT_HUB_PORT))

/** Reconnect backoff bounds. Start fast, cap at a few seconds, retry forever. */
export const RECONNECT_BASE_MS = 250
export const RECONNECT_CAP_MS = 5000

export interface DebugClientOpts {
  /** First reconnect delay (doubles each failure up to `capMs`). Tests drive it fast. */
  baseMs?: number
  /** Maximum reconnect delay. */
  capMs?: number
}

/** Build the self-healing bridge. Starts connecting immediately in the
 * background; the returned client is usable right away (verbs fail fast until a
 * connection is live). */
export const createDebugClient = (url = defaultHubUrl(), opts: DebugClientOpts = {}): DebugClient => {
  const baseMs = opts.baseMs ?? RECONNECT_BASE_MS
  const capMs = opts.capMs ?? RECONNECT_CAP_MS
  const waiters = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>()
  const eventCbs: Array<(e: unknown) => void> = []
  let seq = 1
  let ws: WebSocket | null = null
  let connected = false
  let closed = false
  let backoff = baseMs
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** Reject every in-flight verb — the socket carrying their replies is gone. */
  const failPending = (message: string): void => {
    for (const w of waiters.values()) w.reject(new Error(message))
    waiters.clear()
  }

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    // Grow toward the cap; reset to base on a successful open.
    backoff = Math.min(backoff * 2, capMs)
  }

  const connect = (): void => {
    if (closed) return
    let sock: WebSocket
    try {
      sock = new WebSocket(url)
    } catch {
      // Constructor can throw on a malformed URL — treat like a failed attempt.
      scheduleReconnect()
      return
    }
    ws = sock

    // 'error' and 'close' both fire on a dropped/refused socket; collapse them
    // into a single teardown + reschedule (guarded so we act once per socket).
    const onDown = (): void => {
      if (ws !== sock) return
      connected = false
      ws = null
      failPending(`hub connection lost at ${url} (retrying)`)
      scheduleReconnect()
    }

    sock.addEventListener('open', () => {
      if (ws !== sock) return
      connected = true
      backoff = baseMs // healthy again → next drop retries quickly
      sock.send(JSON.stringify({ t: 'hello', role: 'debugger' } satisfies DebugMsg))
    })
    sock.addEventListener('error', onDown)
    sock.addEventListener('close', onDown)
    sock.addEventListener('message', (ev) => {
      let msg: DebugMsg
      try {
        msg = JSON.parse(String((ev as MessageEvent).data)) as DebugMsg
      } catch {
        return
      }
      if (msg.t === 'rep') {
        const w = waiters.get(msg.id)
        if (!w) return
        waiters.delete(msg.id)
        msg.ok ? w.resolve(msg.body) : w.reject(new Error(msg.body))
      } else if (msg.t === 'event') {
        for (const cb of eventCbs) cb(JSON.parse(msg.body))
      }
    })
  }

  const client: DebugClient = {
    raw: (verb, { timeoutMs = 5000, target } = {}) =>
      new Promise((res, rej) => {
        if (!connected || !ws) return rej(new Error(`not connected to the hub at ${url} (retrying)`))
        const id = seq++
        waiters.set(id, { resolve: res, reject: rej })
        try {
          ws.send(JSON.stringify({ t: 'req', id, verb, ...(target ? { target } : {}) } satisfies DebugMsg))
        } catch {
          waiters.delete(id)
          return rej(new Error(`not connected to the hub at ${url} (retrying)`))
        }
        setTimeout(() => {
          if (waiters.delete(id)) rej(new Error(`verb timed out (${timeoutMs}ms): ${verb}`))
        }, timeoutMs)
      }),
    games: async () => JSON.parse(await client.raw('games')) as GameInfo[],
    onEvent: (cb) => eventCbs.push(cb),
    close: () => {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      failPending('debug client closed')
      connected = false
      if (ws) {
        try {
          ws.close()
        } catch {
          // already closing/closed
        }
        ws = null
      }
    },
  }

  connect()
  return client
}

/** Backward-compatible entry point. Resolves IMMEDIATELY with a self-healing
 * client — it no longer rejects when the hub is down, so callers (the MCP
 * server, the CLI) can start disconnected and heal in the background. */
export const connectDebugger = (url = defaultHubUrl(), opts?: DebugClientOpts): Promise<DebugClient> =>
  Promise.resolve(createDebugClient(url, opts))
