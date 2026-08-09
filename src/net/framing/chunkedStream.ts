/**
 * Message framing over an ordered byte stream: [u16 LE length][message bytes].
 * Messages may span packets freely. Discard stream state on disconnect —
 * a fresh connection starts a fresh stream.
 *
 * PACKET LOSS. BLE gives us ordered delivery but NOT guaranteed delivery: the
 * host→client direction is a GATT notification and the client→host direction is
 * writeWithoutResponse, both unacknowledged. Losing a whole single-packet
 * message is harmless — the stream stays aligned. Losing ONE PACKET OF A
 * MULTI-PACKET MESSAGE used to be fatal: the reader satisfied the missing
 * bytes from the next messages, emitted garbage, then read a "length" out of
 * the middle of a payload and waited for up to 65535 bytes. It never
 * resynchronised, and because the transport link was still up, nothing
 * triggered a reconnect — the remote player's world simply froze forever.
 *
 * The recovery below needs no protocol change and no reconnect, and relies on
 * one property of the sender: `frameMessage` slices from offset 0, and
 * SendQueue sends those slices in order, so EVERY MESSAGE STARTS AT A PACKET
 * BOUNDARY. Once we know we are lost we can therefore throw away whole packets
 * until one of them looks like a real message start, and carry on.
 */

/** Largest message we will ever legitimately frame. A 48-entity snapshot is
 * ~1.2KB; the JSON cold path (lobby/events/inventory) is the only thing that
 * can get big. Anything beyond this is a misparsed length, not a message. */
export const MAX_MESSAGE_BYTES = 16384

/** Slice one framed message into packet-sized chunks for the transport. */
export const frameMessage = (msg: Uint8Array, maxPacket: number): Uint8Array[] => {
  const framed = new Uint8Array(2 + msg.length)
  framed[0] = msg.length & 0xff
  framed[1] = (msg.length >> 8) & 0xff
  framed.set(msg, 2)
  const packets: Uint8Array[] = []
  for (let off = 0; off < framed.length; off += maxPacket) {
    packets.push(framed.subarray(off, Math.min(off + maxPacket, framed.length)))
  }
  return packets
}

export interface StreamReaderOptions {
  /** Reject a declared length above this as a misparse. */
  maxMessage?: number
  /** Does this first byte name a real message? Lets the reader tell a genuine
   * message start from payload bytes that happen to parse as a length. Without
   * it, only the length bound is available. */
  isValidStart?: (msgType: number) => boolean
  /** Called when the stream is found to be desynchronised, and again when it
   * recovers. Wire this to telemetry — silent recovery still means packets were
   * lost, and that is worth knowing. */
  onDesync?: (reason: string) => void
  onResync?: (packetsDiscarded: number) => void
}

/** Reassembles messages from incoming packets. One per peer. */
export class StreamReader {
  private buffer = new Uint8Array(0)
  /** Lost the message boundary: discard packets until one looks like a start. */
  private resyncing = false
  private discarded = 0
  /** Lengths of the packets currently buffered, so we can check that a message
   * ends where a packet ended. */
  private packetLens: number[] = []
  /** Largest packet seen from this sender. Non-final packets of a multi-packet
   * message are always exactly the sender's MTU, so this converges to it and
   * lets us spot a gap the moment a short packet arrives mid-message — rather
   * than waiting for the corrupt message to finish assembling. Inferred rather
   * than configured, because the two ends can negotiate different MTUs. */
  private senderMtu = 0

  constructor(private opts: StreamReaderOptions = {}) {}

  /** Could this packet be the first packet of a message? Used only while lost. */
  private looksLikeStart(packet: Uint8Array): boolean {
    if (packet.length < 3) return false
    const len = packet[0] | (packet[1] << 8)
    if (len === 0 || len > (this.opts.maxMessage ?? MAX_MESSAGE_BYTES)) return false
    // A message that fits in one packet ends exactly at the packet end; one that
    // spans packets overflows it. Either way the framed size cannot be SHORTER
    // than the packet — if it is, these bytes are payload, not a header.
    if (2 + len < packet.length) return false
    return this.opts.isValidStart ? this.opts.isValidStart(packet[2]) : true
  }

  private desync(reason: string): void {
    if (this.resyncing) return
    this.resyncing = true
    this.discarded = 0
    this.buffer = new Uint8Array(0)
    this.packetLens.length = 0
    this.opts.onDesync?.(reason)
  }

  push(packet: Uint8Array, onMessage: (msg: Uint8Array) => void): void {
    if (this.resyncing) {
      if (!this.looksLikeStart(packet)) {
        this.discarded++
        return
      }
      this.resyncing = false
      this.opts.onResync?.(this.discarded)
      this.buffer = new Uint8Array(0)
      this.packetLens.length = 0
    }

    const next = new Uint8Array(this.buffer.length + packet.length)
    next.set(this.buffer)
    next.set(packet, this.buffer.length)
    this.buffer = next
    this.packetLens.push(packet.length)
    if (packet.length > this.senderMtu) this.senderMtu = packet.length

    while (this.buffer.length >= 2) {
      const len = this.buffer[0] | (this.buffer[1] << 8)
      // A zero-length or absurd length means we are reading payload as a header.
      if (len === 0 || len > (this.opts.maxMessage ?? MAX_MESSAGE_BYTES)) {
        this.desync(`implausible message length ${len}`)
        return
      }
      const framed = 2 + len
      if (this.buffer.length < framed) {
        // Still assembling. Every packet before the last one of a message is a
        // full MTU, so a SHORT packet that does not complete the message means
        // a packet went missing in the middle of it. Catching it here costs the
        // corrupt message only, instead of the several messages that would be
        // eaten while padding it out to its declared length.
        if (packet.length < this.senderMtu) {
          this.desync(`short packet (${packet.length}B < ${this.senderMtu}B MTU) left a ${framed}B message incomplete at ${this.buffer.length}B — a packet was lost mid-message`)
        }
        break
      }

      // ALIGNMENT INVARIANT. The sender frames each message on its own and never
      // packs two into one packet, so a message always ends exactly where some
      // packet ended. If this one does not, bytes went missing mid-message and
      // we have been filling the gap from the messages behind it. This catches
      // the corruption on the FIRST message after the loss, instead of waiting
      // for a garbage length to look implausible several messages later.
      let acc = 0
      let k = 0
      while (k < this.packetLens.length && acc < framed) acc += this.packetLens[k++]
      if (acc !== framed) {
        this.desync(`message of ${framed}B does not end on a packet boundary (nearest ${acc}B) — a packet was lost mid-message`)
        return
      }

      const msg = this.buffer.slice(2, framed)
      // A well-sized frame whose type byte is nonsense is also a misparse.
      if (this.opts.isValidStart && !this.opts.isValidStart(msg[0])) {
        this.desync(`unknown message type ${msg[0]}`)
        return
      }
      this.buffer = this.buffer.slice(framed)
      this.packetLens.splice(0, k)
      onMessage(msg)
    }
  }

  reset(): void {
    this.buffer = new Uint8Array(0)
    this.packetLens.length = 0
    this.resyncing = false
    this.discarded = 0
  }
}
