import { frameMessage } from '../framing/chunkedStream'
import type { PeerId, Transport } from '../types'

/**
 * Reliable messages that may go back-to-back before a waiting snapshot gets a
 * turn.
 *
 * Strict reliable-first priority reads as obviously correct and is a trap once
 * the link is OVERSUBSCRIBED — which an 8-player BLE run always is. At the
 * 20-byte MTU floor a 48-entity snapshot is 25 packets, and the host fans one
 * out per peer every 3 ticks on top of 2Hz StateMsg broadcasts; the reliable
 * lane alone outruns the radio. With strict priority `takeNext` then never
 * reaches the snapshot slot at all: control traffic flows perfectly while every
 * client's world FREEZES — the worst failure mode there is, because the game
 * still looks connected. (Measured: 0 snapshots delivered across 60 ticks of
 * sustained reliable traffic — see netScale.test.ts.)
 *
 * Interleaving costs the reliable lane nothing it is promised: reliable is
 * still never dropped and never reordered *relative to other reliable
 * messages*. A snapshot is merely allowed to slot in between two of them. The
 * burst is wide enough that the Welcome/GameStart/Go handshake (3 messages,
 * queued together before any snapshot exists) still goes out contiguously.
 */
const RELIABLE_BURST = 4

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

  /** Reliable messages sent since the snapshot lane last had a turn. */
  private reliableRun = 0

  private takeNext(): Uint8Array | null {
    const snapshotWaiting = this.snapshotSlot !== null
    if (this.reliable.length > 0 && !(snapshotWaiting && this.reliableRun >= RELIABLE_BURST)) {
      this.reliableRun++
      return this.reliable.shift()!
    }
    this.reliableRun = 0
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
