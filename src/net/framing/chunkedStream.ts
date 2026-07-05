/**
 * Message framing over an ordered byte stream: [u16 LE length][message bytes].
 * Messages may span packets freely. Discard stream state on disconnect —
 * a fresh connection starts a fresh stream.
 */

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

/** Reassembles messages from incoming packets. One per peer. */
export class StreamReader {
  private buffer = new Uint8Array(0)

  push(packet: Uint8Array, onMessage: (msg: Uint8Array) => void): void {
    const next = new Uint8Array(this.buffer.length + packet.length)
    next.set(this.buffer)
    next.set(packet, this.buffer.length)
    this.buffer = next

    while (this.buffer.length >= 2) {
      const len = this.buffer[0] | (this.buffer[1] << 8)
      if (this.buffer.length < 2 + len) break
      onMessage(this.buffer.slice(2, 2 + len))
      this.buffer = this.buffer.slice(2 + len)
    }
  }

  reset(): void {
    this.buffer = new Uint8Array(0)
  }
}
