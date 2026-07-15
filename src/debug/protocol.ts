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
}
/** Debugger → game: run one verb line. `id` correlates the reply. */
export interface ReqMsg {
  t: 'req'
  id: number
  verb: string
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

export type DebugMsg = HelloMsg | ReqMsg | RepMsg | EventMsg

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
