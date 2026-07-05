import { frameMessage } from '../framing/chunkedStream'
import type { PeerId, Transport } from '../types'

/**
 * Two-lane send queue per peer:
 * - reliable FIFO: never dropped (events, lobby, control)
 * - snapshot slot (capacity 1): a newer snapshot REPLACES a stale queued one
 * One packet in flight at a time; awaiting the transport's sendPacket paces us
 * to the link's real throughput, so the BLE stack can never be flooded.
 */
export class SendQueue {
  private reliable: Uint8Array[] = []
  private snapshotSlot: Uint8Array | null = null
  private inflight = false
  private stopped = false
  /** Stale-snapshot replacements in a row — backpressure signal. */
  overwrites = 0

  constructor(
    private transport: Transport,
    private peer: PeerId,
    private onFatal: (err: unknown) => void,
  ) {}

  queueReliable(msg: Uint8Array): void {
    this.reliable.push(msg)
    void this.pump()
  }

  queueSnapshot(msg: Uint8Array): void {
    if (this.snapshotSlot !== null) this.overwrites++
    else this.overwrites = 0
    this.snapshotSlot = msg
    void this.pump()
  }

  stop(): void {
    this.stopped = true
    this.reliable.length = 0
    this.snapshotSlot = null
  }

  private takeNext(): Uint8Array | null {
    if (this.reliable.length > 0) return this.reliable.shift()!
    if (this.snapshotSlot !== null) {
      const s = this.snapshotSlot
      this.snapshotSlot = null
      return s
    }
    return null
  }

  private async pump(): Promise<void> {
    if (this.inflight || this.stopped) return
    this.inflight = true
    try {
      for (let msg = this.takeNext(); msg !== null; msg = this.takeNext()) {
        for (const packet of frameMessage(msg, this.transport.maxPacket)) {
          if (this.stopped) return
          try {
            await this.transport.sendPacket(this.peer, packet)
          } catch {
            // One retry after a beat; a second failure is a dead link.
            await new Promise((r) => setTimeout(r, 50))
            try {
              await this.transport.sendPacket(this.peer, packet)
            } catch (err) {
              this.stop()
              this.onFatal(err)
              return
            }
          }
        }
      }
    } finally {
      this.inflight = false
    }
    // A message may have arrived while we were finishing the last packet.
    if (!this.stopped && (this.reliable.length > 0 || this.snapshotSlot !== null)) void this.pump()
  }
}
