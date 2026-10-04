// The routing brain of the WS multiplayer relay, as PURE functions over an
// explicit snapshot of the room's connections. The Durable Object (roomDO.ts) is
// a thin adapter: on every event it rebuilds the snapshot from its live sockets,
// asks this module what to do, and dispatches the returned actions. Keeping the
// logic here — with no Workers globals, no sockets, no hidden state — means the
// whole membership/routing model is exercised by plain vitest (roomRelay.test.ts)
// and survives Durable Object hibernation for free (nothing to persist: state is
// always derived from the current sockets, never held between calls).
//
// Model: one HOST + N CLIENTS per room, exactly like the BLE/BroadcastChannel
// transports. A client only ever talks to the host; the host addresses each
// client by its peer id. See wsWire.ts for the frame format.

import { MAX_PLAYERS } from '../net/types'
import {
  decodeAddressed,
  encodeAddressed,
  MAX_PEER_ID_LEN,
  parseHostCommand,
  type DropReason,
  type WsControl,
} from '../net/transport/wsWire'

/** One live connection in the room. `conn` is an opaque, stable handle the DO
 * maps back to a WebSocket; `clientId` is the peer id the host addresses (unset
 * for the host itself). */
export interface Conn {
  conn: string
  role: 'host' | 'client'
  /** Present iff role === 'client'. The host's view of this peer. */
  clientId?: string
}

/** What the DO should do with a socket. `data` is a text control frame (object,
 * the DO JSON-stringifies it) or a binary data frame (Uint8Array). */
export type Action =
  | { kind: 'send'; conn: string; data: WsControl | Uint8Array }
  | { kind: 'close'; conn: string; code: number; reason: string }

/** WS close code for a second host trying to claim an occupied room. */
export const CLOSE_HOST_TAKEN = 4001
/** WS close code for a client the host refused (it sent a `drop`). */
export const CLOSE_REJECTED = 4003
/** RFC 6455 "message too big". */
export const CLOSE_TOO_BIG = 1009

/** Clients one room admits: the game's own ceiling. The game seats
 * MAX_PLAYERS - 1 clients; the spare seat lets a rejoin land while its old
 * socket is still closing, and the host refuses anything past its own limit. */
export const MAX_ROOM_CLIENTS = MAX_PLAYERS
/** Largest binary frame: a WsTransport packet (64 KiB) plus the host's peer-id
 * header. Nothing the game sends comes near it. */
export const MAX_DATA_FRAME = 65536 + 1 + MAX_PEER_ID_LEN
/** Largest text frame: a host command is a few dozen bytes. */
export const MAX_CONTROL_FRAME = 1024

/** Room names the relay serves: an optional beta slug, then the room. Anything
 * else is a hand-made URL, refused before it can create a Durable Object. */
export const ROOM_NAME_RE = /^([a-z0-9-]+~)?[A-Za-z0-9-]{1,64}$/

export type Admission = { ok: true } | { ok: false; status: 409; reason: string }

/** Should the relay accept this upgrade? Decided before the socket exists, so a
 * refusal is a clean HTTP status rather than a close code lost mid-upgrade. */
export const admit = (state: readonly Conn[], role: 'host' | 'client'): Admission => {
  if (role === 'host') {
    return state.some((c) => c.role === 'host') ? { ok: false, status: 409, reason: 'room already has a host' } : { ok: true }
  }
  return clients(state).length >= MAX_ROOM_CLIENTS ? { ok: false, status: 409, reason: 'room is full' } : { ok: true }
}

/**
 * Any frame from `senderConn`. Oversized frames close their sender; a host's
 * `drop` closes that client; other text is ignored; binary is routed by
 * {@link planData}.
 */
export const planFrame = (state: readonly Conn[], senderConn: string, frame: Uint8Array | string): Action[] => {
  const sender = state.find((c) => c.conn === senderConn)
  if (!sender) return []
  if (typeof frame === 'string') {
    if (frame.length > MAX_CONTROL_FRAME) return [{ kind: 'close', conn: senderConn, code: CLOSE_TOO_BIG, reason: 'frame too big' }]
    const cmd = sender.role === 'host' ? parseHostCommand(frame) : null
    const target = cmd ? state.find((c) => c.role === 'client' && c.clientId === cmd.id) : undefined
    return target ? [{ kind: 'close', conn: target.conn, code: CLOSE_REJECTED, reason: 'refused by host' }] : []
  }
  if (frame.length > MAX_DATA_FRAME) return [{ kind: 'close', conn: senderConn, code: CLOSE_TOO_BIG, reason: 'frame too big' }]
  return planData(state, senderConn, frame)
}

const clients = (state: readonly Conn[]): Conn[] => state.filter((c) => c.role === 'client')
const host = (state: readonly Conn[]): Conn | undefined => state.find((c) => c.role === 'host')

/**
 * A connection just opened. `state` INCLUDES the joining connection. Returns the
 * membership notifications to fan out (and, for a duplicate host, a close).
 */
export const planOpen = (state: readonly Conn[], joiningConn: string): Action[] => {
  const joining = state.find((c) => c.conn === joiningConn)
  if (!joining) return []

  if (joining.role === 'host') {
    // One host per room. A second host is a mistake (or a stale reconnect racing
    // a live one) — refuse it rather than silently splitting the room.
    if (state.some((c) => c.role === 'host' && c.conn !== joiningConn)) {
      return [{ kind: 'close', conn: joiningConn, code: CLOSE_HOST_TAKEN, reason: 'room already has a host' }]
    }
    // Host arrived after clients were already waiting: introduce them both ways.
    const out: Action[] = []
    for (const c of clients(state)) {
      out.push({ kind: 'send', conn: joiningConn, data: { t: 'peer+', id: c.clientId! } })
      out.push({ kind: 'send', conn: c.conn, data: { t: 'host+' } })
    }
    return out
  }

  // A client joined. If the host is here, introduce them; else it waits silently
  // and gets 'host+' when the host connects (handled by the host's planOpen).
  const h = host(state)
  if (!h) return []
  return [
    { kind: 'send', conn: h.conn, data: { t: 'peer+', id: joining.clientId! } },
    { kind: 'send', conn: joiningConn, data: { t: 'host+' } },
  ]
}

/**
 * A frame arrived on `senderConn`. Routes one hop: client→host frames are
 * re-addressed with the sender's peer id; host→client frames are stripped to the
 * bare payload and delivered to the addressed client. Unroutable frames (no
 * host, unknown target) are dropped — the relay never buffers.
 */
export const planData = (state: readonly Conn[], senderConn: string, frame: Uint8Array): Action[] => {
  const sender = state.find((c) => c.conn === senderConn)
  if (!sender) return []

  if (sender.role === 'host') {
    const { id, payload } = decodeAddressed(frame)
    const target = state.find((c) => c.clientId === id)
    return target ? [{ kind: 'send', conn: target.conn, data: payload }] : []
  }

  const h = host(state)
  return h ? [{ kind: 'send', conn: h.conn, data: encodeAddressed(sender.clientId!, frame) }] : []
}

/**
 * A connection closed. `state` STILL INCLUDES the leaving connection. If the host
 * left, every client is told the host is gone; if a client left, the host is told
 * that peer dropped. `reason` defaults to a remote-initiated close.
 */
export const planClose = (state: readonly Conn[], leavingConn: string, reason: DropReason = 'remote'): Action[] => {
  const leaving = state.find((c) => c.conn === leavingConn)
  if (!leaving) return []

  if (leaving.role === 'host') {
    return clients(state).map((c) => ({ kind: 'send', conn: c.conn, data: { t: 'host-', reason } }) as Action)
  }

  const h = host(state)
  return h ? [{ kind: 'send', conn: h.conn, data: { t: 'peer-', id: leaving.clientId!, reason } }] : []
}
