// Wire envelope shared by the hub, the in-app DebugChannel, the CLI, and the
// MCP bridge. Deliberately tiny and JSON-only: every message is one line of
// JSON over a WebSocket. A verb is a single line of text (`set 5 {...}`), so
// payloads that contain spaces/newlines are base64-wrapped with a `b64:` prefix
// to keep the verb grammar line-safe — mirroring the sibling C# harness.

export const DEFAULT_HUB_PORT = 7810
export const DEFAULT_MCP_PORT = 7811

export type Role = 'game' | 'debugger'

/** Register the connection's role right after the socket opens. */
export interface HelloMsg {
  t: 'hello'
  role: Role
  /** Optional stable label for a `game` (e.g. `?debug=<name>`, a session id, or a
   * player name). Older game clients omit it; the hub falls back to connection
   * order (`g1`, `g2`, …) so they still register and route. */
  name?: string
  /** Optional STABLE per-browser/tab game id the client persists in localStorage
   * (`sporefall.debugGameId`). It survives reload, New-Seed, and death, so the hub
   * treats every re-registration under this id as a RECONNECTION of the SAME logical
   * game — reusing the id (no `g#` churn across a death) and evicting the prior
   * socket. Older clients omit it and fall back to connection-order ids. */
  gameId?: string
}
/** Debugger → game: run one verb line. `id` correlates the reply. `target` picks
 * which connected game to route to (id or name); omitted → the debugger's sticky
 * selection, else the single live game. */
export interface ReqMsg {
  t: 'req'
  id: number
  verb: string
  target?: string
}
/** Game → hub: periodic liveness heartbeat. `tick` (in-app world only) lets the
 * hub flag a *frozen* sim whose tick has stopped advancing — a backgrounded/
 * throttled webview — independent of socket health. The headless harness omits
 * `tick` (it advances only when driven), so it stays live purely on freshness. */
export interface PingMsg {
  t: 'ping'
  tick?: number
  gameOver?: boolean
}
/** Game → debugger: the reply to a `req`. `body` is text (usually JSON). */
export interface RepMsg {
  t: 'rep'
  id: number
  ok: boolean
  body: string
}
/** Game → all debuggers: a pushed sim event (NDJSON-style, one per frame). */
export interface EventMsg {
  t: 'event'
  body: string
}

export type DebugMsg = HelloMsg | ReqMsg | RepMsg | EventMsg | PingMsg

/** One row of the hub's `games` listing: what a debugger sees when it asks which
 * games are connected and which are safe to drive. */
export interface GameInfo {
  id: string
  name: string
  /** Alive (fresh heartbeat, and — for a real-time game — tick still advancing). */
  live: boolean
  /** Tick advancing? `null` for the headless harness, which reports no tick. */
  ticking: boolean | null
  tick: number | null
  gameOver: boolean
  /** ms since the last message from this game. */
  lastSeenMs: number
  /** ms since it connected. */
  ageMs: number
}

export const hubUrl = (host: string, port = DEFAULT_HUB_PORT): string => `ws://${host}:${port}`

// UTF-8-safe base64, portable across the browser webview and Node (both expose
// btoa/atob + TextEncoder/TextDecoder). Used for verb payloads with whitespace.
export const toB64 = (s: string): string =>
  btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(''))
export const fromB64 = (s: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

/** Wrap a verb argument in `b64:` when it carries spaces/newlines. */
export const encodeArg = (s: string): string => (/\s/.test(s) ? `b64:${toB64(s)}` : s)
/** Undo `encodeArg` — accepts a raw or `b64:`-wrapped payload. */
export const decodeArg = (s: string): string => (s.startsWith('b64:') ? fromB64(s.slice(4)) : s)
