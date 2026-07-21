// Wire format spoken between a WsTransport and the RoomDO relay (Cloudflare
// Durable Object). Two disjoint frame kinds share one socket:
//
//   • CONTROL frames — WebSocket TEXT frames carrying JSON (WsControl). Lobby /
//     membership churn: who joined, who left. Low volume, human-legible.
//   • DATA frames — WebSocket BINARY frames carrying the existing net protocol
//     bytes verbatim (snapshots/inputs/lobby, see src/net/protocol). The relay
//     never inspects these; it only ROUTES them.
//
// Addressing asymmetry (mirrors BLE/BroadcastChannel's 'host' sentinel): a
// CLIENT socket only ever talks to the host, so its binary frames are the bare
// payload. The HOST socket talks to many clients, so its binary frames are
// ADDRESSED — a short peer-id header in front of the payload — telling the relay
// which client a packet is for (host→client) or which client it came from
// (client→host). This module is pure (no DOM, no Workers globals) so both ends
// and the tests share exactly one framing.

import { ByteReader, ByteWriter } from '../framing/codec'

/** Why a peer link dropped — mirrors TransportEvent's `reason`. */
export type DropReason = 'remote' | 'local' | 'error'

/**
 * Control messages, sent as JSON text frames. Prefixed variants are directional:
 * a host socket receives peer±; a client socket receives host±.
 */
export type WsControl =
  | { t: 'peer+'; id: string } //         relay→host: a client joined (its peer id)
  | { t: 'peer-'; id: string; reason: DropReason } // relay→host: that client left
  | { t: 'host+' } //                     relay→client: the host is present
  | { t: 'host-'; reason: DropReason } //  relay→client: the host went away

/** A control frame is any text frame; parse it back to a WsControl (or null). */
export const parseControl = (text: string): WsControl | null => {
  try {
    const m = JSON.parse(text) as WsControl
    if (m && (m.t === 'peer+' || m.t === 'peer-' || m.t === 'host+' || m.t === 'host-')) return m
    return null
  } catch {
    return null
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Longest peer id the 1-byte length header can carry. */
export const MAX_PEER_ID_LEN = 255

/**
 * Host-side binary frame: [idLen:u8][id utf8][payload…]. `id` is the client peer
 * the payload is addressed to (host→relay) or came from (relay→host).
 */
export const encodeAddressed = (id: string, payload: Uint8Array): Uint8Array => {
  const idBytes = enc.encode(id)
  if (idBytes.length === 0 || idBytes.length > MAX_PEER_ID_LEN) {
    throw new RangeError(`peer id must be 1..${MAX_PEER_ID_LEN} bytes, got ${idBytes.length}`)
  }
  return new ByteWriter(1 + idBytes.length + payload.length).u8(idBytes.length).bytes(idBytes).bytes(payload).finish()
}

/** Inverse of {@link encodeAddressed}. `payload` is a detached copy. */
export const decodeAddressed = (frame: Uint8Array): { id: string; payload: Uint8Array } => {
  const r = new ByteReader(frame)
  const n = r.u8()
  const id = dec.decode(r.bytes(n))
  return { id, payload: frame.slice(1 + n) }
}
