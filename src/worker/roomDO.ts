// The multiplayer relay as a Durable Object — one instance per room. It is a THIN
// adapter over the pure planner in roomRelay.ts: on every socket event it rebuilds
// the room snapshot from its live sockets, asks the planner what to do, and
// dispatches. No membership state is held between calls, so the WebSocket
// Hibernation API works with zero persistence — a hibernated instance wakes,
// re-reads its sockets, and is immediately correct.
//
// Each socket carries its identity in `serializeAttachment` (survives hibernation)
// so the snapshot is always reconstructable. Role is chosen by the client via the
// `?role=host|client` query on connect (see wsTransport.ts / index.ts).

import { DurableObject } from 'cloudflare:workers'
import { type Action, type Conn, planClose, planData, planOpen } from './roomRelay'
import type { DropReason, WsControl } from '../net/transport/wsWire'

/** What we stash on each socket via serializeAttachment. */
interface Attachment {
  connId: string
  role: 'host' | 'client'
  /** Present iff role === 'client'. */
  clientId?: string
}

export class RoomDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const role = new URL(request.url).searchParams.get('role')
    if (role !== 'host' && role !== 'client') {
      return new Response('missing/invalid ?role (host|client)', { status: 400 })
    }

    // One host per room. Reject a second host at the HTTP layer, BEFORE upgrading:
    // closing a hibernation socket synchronously mid-upgrade drops the close code
    // (the client just sees an abnormal 1006), so a clean 409 is the reliable
    // signal. The room's membership is exactly its currently-accepted sockets.
    if (role === 'host' && this.snapshot().some((c) => c.role === 'host')) {
      return new Response('room already has a host', { status: 409 })
    }

    const connId = crypto.randomUUID()
    const attachment: Attachment = {
      connId,
      role,
      // The host's addressable id for this client. Prefixed + shortened so it's
      // legible in logs but still unique per connection.
      clientId: role === 'client' ? `c-${connId.slice(0, 8)}` : undefined,
    }

    const { 0: client, 1: server } = new WebSocketPair()
    server.serializeAttachment(attachment)
    // Hibernation API: the runtime, not an addEventListener, delivers events to
    // webSocketMessage/webSocketClose/webSocketError below.
    this.ctx.acceptWebSocket(server, [role])

    // The new socket is now part of getWebSockets(); introduce it to the room.
    this.dispatch(planOpen(this.snapshot(), connId))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // Transports only ever send binary DATA frames; a text frame is not part of
    // the protocol and is ignored (control flows relay→transport only).
    if (typeof message === 'string') return
    const att = ws.deserializeAttachment() as Attachment | null
    if (!att) return
    this.dispatch(planData(this.snapshot(), att.connId, new Uint8Array(message)))
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, wasClean: boolean): Promise<void> {
    this.onGone(ws, wasClean ? 'remote' : 'error')
    try {
      ws.close()
    } catch {
      /* already closing */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws, 'error')
  }

  /** A socket departed (clean close or error): notify the rest of the room. */
  private onGone(ws: WebSocket, reason: DropReason): void {
    const att = ws.deserializeAttachment() as Attachment | null
    if (!att) return
    // The closing socket may or may not still appear in getWebSockets(); planClose
    // needs it present in the snapshot to read its role/clientId, so ensure it is.
    const state = this.snapshot()
    if (!state.some((c) => c.conn === att.connId)) {
      state.push({ conn: att.connId, role: att.role, clientId: att.clientId })
    }
    this.dispatch(planClose(state, att.connId, reason))
  }

  /** Current room membership, rebuilt from the live sockets' attachments. */
  private snapshot(): Conn[] {
    const out: Conn[] = []
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att) out.push({ conn: att.connId, role: att.role, clientId: att.clientId })
    }
    return out
  }

  /** Map a planner action's `conn` back to a live socket and carry it out. */
  private dispatch(actions: Action[]): void {
    if (actions.length === 0) return
    const byConn = new Map<string, WebSocket>()
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att) byConn.set(att.connId, ws)
    }
    for (const a of actions) {
      const ws = byConn.get(a.conn)
      if (!ws) continue
      try {
        if (a.kind === 'close') ws.close(a.code, a.reason)
        else if (a.data instanceof Uint8Array) ws.send(a.data)
        else ws.send(JSON.stringify(a.data satisfies WsControl))
      } catch {
        /* socket races a close — drop */
      }
    }
  }
}
