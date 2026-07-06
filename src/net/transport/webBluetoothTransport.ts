import { BLE_DATA_C2H_UUID, BLE_DATA_H2C_UUID, BLE_SERVICE_UUID, type PeerId, type Transport, type TransportEvent } from '../types'

// ---------------------------------------------------------------------------
// Minimal ambient Web Bluetooth types (lib.dom doesn't ship them and this
// tsconfig pins "types", so pulling in @types/web-bluetooth would mean
// touching tsconfig for one file's worth of surface).
// ---------------------------------------------------------------------------
interface WebBluetooth {
  requestDevice(options: { filters: { services: string[] }[]; optionalServices?: string[] }): Promise<BluetoothDevice>
}
interface BluetoothDevice extends EventTarget {
  readonly name?: string
  readonly gatt?: BluetoothRemoteGATTServer
}
interface BluetoothRemoteGATTServer {
  readonly connected: boolean
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>
}
interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>
}
interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  /** Optional: older Chrome builds only have writeValue. */
  writeValueWithoutResponse?(value: ArrayBufferView | ArrayBuffer): Promise<void>
  writeValue(value: ArrayBufferView | ArrayBuffer): Promise<void>
}
declare global {
  interface Navigator {
    readonly bluetooth?: WebBluetooth
  }
}

export const isWebBluetoothAvailable = (): boolean => 'bluetooth' in navigator

// Web Bluetooth never exposes the negotiated MTU, so stay at the same
// conservative floor the Capacitor client falls back to.
const MAX_PACKET = 180

/**
 * Laptop-browser client over Web Bluetooth (Chrome central role only):
 * connects to a phone hosting via BleHostTransport, subscribes to DATA_H2C
 * notifications, writes inputs to DATA_C2H without response.
 *
 * Two-phase connect because Chrome's device chooser needs a user gesture:
 *   1. requestDevice() — call directly from a click handler
 *   2. connect()       — GATT connect + subscribe, after the session's
 *                        transport handlers are registered
 */
export class WebBluetoothClientTransport implements Transport {
  readonly role = 'client' as const
  readonly maxPacket = MAX_PACKET
  private handlers = new Set<(e: TransportEvent) => void>()
  private device: BluetoothDevice | null = null
  private gatt: BluetoothRemoteGATTServer | null = null
  private c2h: BluetoothRemoteGATTCharacteristic | null = null
  private connected = false
  private writeChain: Promise<void> = Promise.resolve()

  /** MUST run inside a user-gesture handler: opens Chrome's device chooser. */
  async requestDevice(): Promise<void> {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser')
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
      optionalServices: [BLE_SERVICE_UUID],
    })
  }

  /** GATT connect + subscribe; emits peerConnected. No gesture needed here. */
  async connect(): Promise<void> {
    const device = this.device
    if (!device?.gatt) throw new Error('no device picked — call requestDevice() from a click first')
    device.addEventListener('gattserverdisconnected', () => {
      if (!this.connected) return
      this.connected = false
      this.emit({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
    })
    this.gatt = await device.gatt.connect()
    const service = await this.gatt.getPrimaryService(BLE_SERVICE_UUID)
    const h2c = await service.getCharacteristic(BLE_DATA_H2C_UUID)
    this.c2h = await service.getCharacteristic(BLE_DATA_C2H_UUID)
    h2c.addEventListener('characteristicvaluechanged', (ev) => {
      const view = (ev.target as BluetoothRemoteGATTCharacteristic).value
      if (!view) return
      // Copy: Chrome reuses the underlying buffer across notifications.
      this.emit({ type: 'data', peer: 'host', bytes: new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)) })
    })
    await h2c.startNotifications()
    this.connected = true
    this.emit({ type: 'peerConnected', peer: 'host' })
  }

  async start(): Promise<void> {
    // Connection is driven by requestDevice()/connect(); session.start()
    // re-enters here afterwards, so this stays a no-op.
  }

  async stop(): Promise<void> {
    const wasConnected = this.connected
    this.connected = false
    try {
      this.gatt?.disconnect()
    } catch {
      // teardown best-effort
    }
    if (wasConnected) this.emit({ type: 'peerDisconnected', peer: 'host', reason: 'local' })
  }

  async sendPacket(_peer: PeerId, bytes: Uint8Array): Promise<void> {
    const c2h = this.c2h
    if (!this.connected || !c2h) throw new Error('not connected to a host')
    // Chrome rejects overlapping GATT operations, so serialize writes.
    const write = this.writeChain.then(() =>
      c2h.writeValueWithoutResponse ? c2h.writeValueWithoutResponse(bytes) : c2h.writeValue(bytes),
    )
    this.writeChain = write.catch(() => {})
    await write
  }

  on(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  peers(): PeerId[] {
    return this.connected ? ['host'] : []
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e)
  }
}
