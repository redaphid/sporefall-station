import { BluetoothLowEnergy } from '@capgo/capacitor-bluetooth-low-energy'
import {
  BLE_DATA_C2H_UUID,
  BLE_DATA_H2C_UUID,
  BLE_SERVICE_UUID,
  type PeerId,
  type Transport,
  type TransportEvent,
} from '../types'

const MAX_PACKET = 180 // conservative: fits the 185-byte floor after MTU negotiation

const noProps = {
  broadcast: false,
  read: false,
  writeWithoutResponse: false,
  write: false,
  notify: false,
  indicate: false,
  authenticatedSignedWrites: false,
  extendedProperties: false,
}

/**
 * Host = BLE peripheral: advertises the game service; centrals write inputs
 * to DATA_C2H, we push state via directed notifications on DATA_H2C.
 */
export class BleHostTransport implements Transport {
  readonly role = 'host' as const
  readonly maxPacket = MAX_PACKET
  private handlers = new Set<(e: TransportEvent) => void>()
  private connected = new Set<PeerId>()

  constructor(private advertiseName: string) {}

  async start(): Promise<void> {
    await BluetoothLowEnergy.requestPermissions()
    await BluetoothLowEnergy.initialize({ mode: 'peripheral' })
    await BluetoothLowEnergy.addGattService({
      service: BLE_SERVICE_UUID,
      characteristics: [
        { uuid: BLE_DATA_H2C_UUID, properties: { ...noProps, notify: true, read: true } },
        { uuid: BLE_DATA_C2H_UUID, properties: { ...noProps, write: true, writeWithoutResponse: true } },
      ],
    })
    await BluetoothLowEnergy.addListener('centralConnected', (ev) => {
      this.connected.add(ev.deviceId)
      this.emit({ type: 'peerConnected', peer: ev.deviceId })
    })
    await BluetoothLowEnergy.addListener('centralDisconnected', (ev) => {
      if (this.connected.delete(ev.deviceId)) {
        this.emit({ type: 'peerDisconnected', peer: ev.deviceId, reason: 'remote' })
      }
    })
    await BluetoothLowEnergy.addListener('gattCharacteristicWriteRequest', (ev) => {
      if (ev.characteristic.toLowerCase() !== BLE_DATA_C2H_UUID.toLowerCase()) return
      this.emit({ type: 'data', peer: ev.deviceId, bytes: new Uint8Array(ev.value) })
    })
    await BluetoothLowEnergy.startAdvertising({ name: this.advertiseName, services: [BLE_SERVICE_UUID] })
  }

  async stop(): Promise<void> {
    try {
      await BluetoothLowEnergy.stopAdvertising()
      await BluetoothLowEnergy.removeGattService({ service: BLE_SERVICE_UUID })
      await BluetoothLowEnergy.removeAllListeners()
    } catch {
      // teardown best-effort
    }
    for (const peer of this.connected) this.emit({ type: 'peerDisconnected', peer, reason: 'local' })
    this.connected.clear()
  }

  async sendPacket(peer: PeerId, bytes: Uint8Array): Promise<void> {
    if (!this.connected.has(peer)) throw new Error(`central ${peer} not connected`)
    // Awaiting the plugin call is our pacing: it resolves when the stack accepts the notify.
    await BluetoothLowEnergy.notifyGattCharacteristicChanged({
      service: BLE_SERVICE_UUID,
      characteristic: BLE_DATA_H2C_UUID,
      value: [...bytes],
      deviceId: peer,
    })
  }

  on(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  peers(): PeerId[] {
    return [...this.connected]
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e)
  }
}

export interface FoundHost {
  deviceId: string
  name: string
}

/**
 * Client = BLE central: scans for the game service, connects to the chosen
 * host, subscribes to DATA_H2C, writes inputs to DATA_C2H.
 */
export class BleClientTransport implements Transport {
  readonly role = 'client' as const
  maxPacket = MAX_PACKET
  private handlers = new Set<(e: TransportEvent) => void>()
  private hostDeviceId: string | null = null

  private startedOnce = false

  async start(): Promise<void> {
    if (this.startedOnce) return // session.start() re-enters after the scan/connect flow
    this.startedOnce = true
    await BluetoothLowEnergy.requestPermissions()
    await BluetoothLowEnergy.initialize({ mode: 'central' })
  }

  /** Scan for hosts advertising the game service. */
  async scan(onFound: (host: FoundHost) => void): Promise<() => Promise<void>> {
    const listener = await BluetoothLowEnergy.addListener('deviceScanned', (ev) => {
      onFound({ deviceId: ev.device.deviceId, name: ev.device.name ?? 'Unknown host' })
    })
    await BluetoothLowEnergy.startScan({ services: [BLE_SERVICE_UUID] })
    return async () => {
      await listener.remove()
      await BluetoothLowEnergy.stopScan()
    }
  }

  async connect(deviceId: string): Promise<void> {
    await BluetoothLowEnergy.addListener('deviceDisconnected', (ev) => {
      if (ev.deviceId === this.hostDeviceId) {
        this.hostDeviceId = null
        this.emit({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
      }
    })
    await BluetoothLowEnergy.addListener('characteristicChanged', (ev) => {
      if (ev.characteristic.toLowerCase() !== BLE_DATA_H2C_UUID.toLowerCase()) return
      this.emit({ type: 'data', peer: 'host', bytes: new Uint8Array(ev.value) })
    })
    await BluetoothLowEnergy.connect({ deviceId })
    try {
      const { mtu } = await BluetoothLowEnergy.requestMtu({ deviceId, mtu: 512 })
      this.maxPacket = Math.max(20, Math.min(mtu - 3, 244))
    } catch {
      this.maxPacket = MAX_PACKET // stack refused; the 182-byte floor still works
    }
    await BluetoothLowEnergy.discoverServices({ deviceId })
    await BluetoothLowEnergy.startCharacteristicNotifications({
      deviceId,
      service: BLE_SERVICE_UUID,
      characteristic: BLE_DATA_H2C_UUID,
    })
    this.hostDeviceId = deviceId
    this.emit({ type: 'peerConnected', peer: 'host' })
  }

  async stop(): Promise<void> {
    try {
      if (this.hostDeviceId) await BluetoothLowEnergy.disconnect({ deviceId: this.hostDeviceId })
      await BluetoothLowEnergy.removeAllListeners()
    } catch {
      // teardown best-effort
    }
  }

  async sendPacket(_peer: PeerId, bytes: Uint8Array): Promise<void> {
    if (!this.hostDeviceId) throw new Error('not connected to a host')
    await BluetoothLowEnergy.writeCharacteristic({
      deviceId: this.hostDeviceId,
      service: BLE_SERVICE_UUID,
      characteristic: BLE_DATA_C2H_UUID,
      value: [...bytes],
      type: 'withoutResponse',
    })
  }

  on(handler: (e: TransportEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  peers(): PeerId[] {
    return this.hostDeviceId ? ['host'] : []
  }

  private emit(e: TransportEvent): void {
    for (const h of this.handlers) h(e)
  }
}
