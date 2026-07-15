// In-process loopback of the offline peer-to-peer link (what BLE gives us on two
// phones), promoted from the netCoop tests so the debug harness and unit tests
// share ONE implementation. A single host "peripheral" accepts N connecting
// "centrals"; every packet is delivered on a microtask (no radio, no timers), so
// ordering is deterministic and a synchronous test can drain it with `flush()`.

import type { PeerId, Transport, TransportEvent } from '../net/types'

const MAX_PACKET = 180

export interface LoopbackClient {
  transport: Transport
  connect(): void
  disconnect(): void
}

export class LoopbackHub {
  readonly hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    const microtask = (fn: (() => void) | undefined): Promise<void> => Promise.resolve().then(() => fn?.())
    this.hostTransport = {
      role: 'host',
      maxPacket: MAX_PACKET,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer, bytes) => microtask(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  private deliverToHost(peer: PeerId, bytes: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes }))
  }

  /** Register a client transport + the connect()/disconnect() that fire the
   * peerConnected / peerDisconnected events on BOTH ends. */
  addCentral(): LoopbackClient {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    this.centrals.set(peer, (bytes) =>
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes })),
    )
    const transport: Transport = {
      role: 'client',
      maxPacket: MAX_PACKET,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p, bytes) => this.deliverToHost(peer, bytes),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    return {
      transport,
      connect: () => {
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
      },
      disconnect: () => {
        this.centrals.delete(peer)
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerDisconnected', peer, reason: 'remote' }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerDisconnected', peer: 'host', reason: 'remote' }))
      },
    }
  }
}

/** Drain the microtask/timer send queues between loopback sessions. */
export const flush = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}
