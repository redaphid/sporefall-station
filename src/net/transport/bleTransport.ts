import { BluetoothLowEnergy } from '@capgo/capacitor-bluetooth-low-energy'
import {
  BLE_DATA_C2H_UUID,
  BLE_DATA_H2C_UUID,
  BLE_SERVICE_UUID,
  type PeerId,
  type Transport,
  type TransportEvent,
} from '../types'
import { toAdvertiseName, toHostLabel } from './hostName'
import { withTimeout } from './withTimeout'

const MAX_PACKET = 180 // conservative: fits the 185-byte floor after MTU negotiation

/**
 * The payload a link is guaranteed to carry when MTU negotiation has NOT
 * happened: the BLE spec's mandatory ATT_MTU floor is 23 bytes, of which 3 are
 * the ATT opcode + handle, leaving 20 for us.
 *
 * This is the fallback when `requestMtu` fails, and getting it wrong is
 * invisible until it is fatal. The old fallback was 180 — the value we use after
 * a SUCCESSFUL negotiation — which has the logic exactly backwards: the whole
 * meaning of a failed negotiation is that the link is still at 23. Writing 180
 * bytes into a 20-byte window does not throw; Android silently truncates the
 * write to ATT_MTU-3. Our framing then loses bytes out of the middle of every
 * packet, permanently, and the run dies as protocol corruption rather than as
 * the legible "MTU refused" it actually was.
 */
const MIN_PACKET = 20

/** How long to wait for a GATT connect before declaring the host unreachable.
 * Android's own GATT connect timeout is ~30s, far past a player's patience. */
export const CONNECT_TIMEOUT_MS = 10_000

/** MTU negotiation is a single round trip; if it has not answered in 5s the
 * peer is not going to. We keep the link and fall back to the 20-byte floor. */
export const MTU_TIMEOUT_MS = 5_000

/**
 * Pre-flight: is there a radio, and is it switched on?
 *
 * The plugin has exposed `isAvailable()`/`isEnabled()` all along and nothing
 * called them, so "Bluetooth is off" surfaced as whatever the first real call
 * happened to reject with — for hosting that is "Bluetooth is not available on
 * this device", which reads like a broken phone rather than a flipped switch,
 * and for joining it was an empty scan list that never fills and never explains.
 *
 * Called AFTER requestPermissions() on purpose: on Android 12+ `isEnabled()` is
 * annotated @RequiresPermission(BLUETOOTH_CONNECT) and throws SecurityException
 * without it, which would turn a helpful check into a new crash. `isAvailable()`
 * is safe at any time — the plugin reads the adapter in load(), at app start.
 */
const assertRadioReady = async (): Promise<void> => {
  const { available } = await BluetoothLowEnergy.isAvailable()
  if (!available) throw new Error('this phone has no Bluetooth radio')
  const { enabled } = await BluetoothLowEnergy.isEnabled()
  if (!enabled) throw new Error('Bluetooth is off — turn it on and try again')
}

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
  /**
   * KNOWN GAP — the host never learns the real MTU, so this is a bet, not a fact.
   *
   * ATT_MTU is negotiated once per LINK, so when the joining central's
   * requestMtu succeeds (the normal case) 180-byte notifications are genuinely
   * safe. When it does NOT, the link stays at the 23-byte floor and every
   * notification we send is silently truncated to 20 bytes by the stack — the
   * same corruption the client's MIN_PACKET fallback now avoids in the c2h
   * direction, still unfixed in the h2c direction.
   *
   * We cannot detect it from here: Android surfaces the negotiated value to a
   * peripheral through BluetoothGattServerCallback.onMtuChanged, and the plugin's
   * gattServerCallback does not implement that method (it has only
   * onConnectionStateChange, onCharacteristicRead/WriteRequest and
   * onDescriptorWriteRequest), so the value never reaches JS at all. Fixing it
   * means patching the plugin or carrying the client's negotiated maxPacket in
   * the Hello message — deliberately out of scope here.
   */
  readonly maxPacket = MAX_PACKET
  private handlers = new Set<(e: TransportEvent) => void>()
  private connected = new Set<PeerId>()

  private sawWrite = new Set<PeerId>()

  private advertiseName: string

  constructor(
    displayName: string,
    private log: (s: string) => void = () => {},
  ) {
    // Truncate to the advertisement budget up front so what we log matches what
    // goes on the air (see toAdvertiseName for the 31-byte PDU math).
    this.advertiseName = toAdvertiseName(displayName)
  }

  async start(): Promise<void> {
    this.log('host: requesting BLE permissions')
    await BluetoothLowEnergy.requestPermissions()
    await assertRadioReady() // fails with words the player can act on, before anything else
    this.log('host: initialize(peripheral)')
    await BluetoothLowEnergy.initialize({ mode: 'peripheral' })
    this.log('host: addGattService')
    await BluetoothLowEnergy.addGattService({
      service: BLE_SERVICE_UUID,
      characteristics: [
        { uuid: BLE_DATA_H2C_UUID, properties: { ...noProps, notify: true, read: true } },
        { uuid: BLE_DATA_C2H_UUID, properties: { ...noProps, write: true, writeWithoutResponse: true } },
      ],
    })
    await BluetoothLowEnergy.addListener('centralConnected', (ev) => {
      this.log(`host: central connected ${ev.deviceId}`)
      this.connected.add(ev.deviceId)
      this.emit({ type: 'peerConnected', peer: ev.deviceId })
    })
    await BluetoothLowEnergy.addListener('centralDisconnected', (ev) => {
      this.log(`host: central disconnected ${ev.deviceId}`)
      if (this.connected.delete(ev.deviceId)) {
        this.emit({ type: 'peerDisconnected', peer: ev.deviceId, reason: 'remote' })
      }
    })
    await BluetoothLowEnergy.addListener('gattCharacteristicWriteRequest', (ev) => {
      if (ev.characteristic.toLowerCase() !== BLE_DATA_C2H_UUID.toLowerCase()) return
      if (!this.sawWrite.has(ev.deviceId)) {
        this.sawWrite.add(ev.deviceId)
        this.log(`host: first write from ${ev.deviceId} (${ev.value.length}B) — Hello received`)
      }
      this.emit({ type: 'data', peer: ev.deviceId, bytes: new Uint8Array(ev.value) })
    })
    // The name is deliberately kept OUT of the advertisement. #35 put it in
    // (includeName:true) to label the join list; that broke discovery outright,
    // because the budget maths only works in the best case and the best case is
    // not what ships:
    //
    //   flags (3B) + 128-bit service UUID (18B) + name header (2B) = 23B of the
    //   31-byte legacy PDU, leaving exactly 8 bytes of name. Zero headroom.
    //
    // Worse, includeName does not put OUR string on the air. The capgo plugin
    // implements it as bluetoothAdapter.setName(name) followed immediately by
    // AdvertiseData.setIncludeDeviceName(true) — and setName returns true when the
    // rename is ACCEPTED, not when it has taken effect. setIncludeDeviceName makes
    // the stack substitute the adapter's CURRENT name at PDU-assembly time, so
    // losing that race puts the phone's real name ("Pixel 8 Pro", 11B) in the
    // packet and blows the budget.
    //
    // Android then answers ADVERTISE_FAILED_DATA_TOO_LARGE *silently*: AOSP's
    // BluetoothLeAdvertiser calls postStartFailure() and returns WITHOUT throwing,
    // so the plugin's call.resolve() runs, this await succeeds, onStartFailure
    // fires later into a handler that only restores the adapter name — and the
    // host sits on "waiting for a central to join" while nothing is on the air.
    //
    // Centrals discover us by service UUID and label hosts from the deviceId
    // (toHostLabel); the real player name arrives after connect, in the lobby.
    // Keeping the name off the air also stops hosting from renaming the user's
    // phone globally, which setName does and only undoes on a clean stopAdvertising.
    this.log(`host: startAdvertising svc=${BLE_SERVICE_UUID.slice(0, 8)}… (name off adv)`)
    await BluetoothLowEnergy.startAdvertising({
      name: this.advertiseName,
      services: [BLE_SERVICE_UUID],
      includeName: false,
    })
    this.log('host: advertising — waiting for a central to join')
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

  constructor(private log: (s: string) => void = () => {}) {}

  async start(): Promise<void> {
    if (this.startedOnce) return // session.start() re-enters after the scan/connect flow
    this.startedOnce = true
    this.log('join: requesting BLE permissions')
    await BluetoothLowEnergy.requestPermissions()
    await assertRadioReady() // fails with words the player can act on, before anything else
    this.log('join: initialize(central)')
    await BluetoothLowEnergy.initialize({ mode: 'central' })
    // Listeners go up here, before any connect can be attempted — see connect().
    await this.ensureListeners()
  }

  /** Scan for hosts advertising the game service. */
  async scan(onFound: (host: FoundHost) => void): Promise<() => Promise<void>> {
    const listener = await BluetoothLowEnergy.addListener('deviceScanned', (ev) => {
      const name = toHostLabel(ev.device.name, ev.device.deviceId)
      this.log(`join: found ${name} (${ev.device.deviceId})`)
      onFound({ deviceId: ev.device.deviceId, name })
    })
    this.log(`join: scanning for svc=${BLE_SERVICE_UUID.slice(0, 8)}…`)
    await BluetoothLowEnergy.startScan({ services: [BLE_SERVICE_UUID] })
    return async () => {
      await listener.remove()
      await BluetoothLowEnergy.stopScan()
    }
  }

  private lastDeviceId: string | null = null
  private listenersAdded = false
  /** Rejector for a connect that is in flight right now, so the disconnect
   * event can fail it. Null whenever no connect is outstanding. */
  private pendingConnect: { deviceId: string; fail: (err: Error) => void } | null = null

  /**
   * Register the GATT event listeners exactly once.
   *
   * Split out of connect() and called from start() as well, because the
   * `deviceDisconnected` listener has to exist BEFORE a connect is attempted to
   * be of any use — and because of the ordering bug below it was useless even
   * when it did exist.
   */
  private async ensureListeners(): Promise<void> {
    if (this.listenersAdded) return
    this.listenersAdded = true
    await BluetoothLowEnergy.addListener('deviceDisconnected', (ev) => {
      // A FAILED connect is reported as a disconnect — that is the only signal
      // Android gives us, since the plugin never rejects the connect call.
      // This handler used to be gated on `ev.deviceId === this.hostDeviceId`,
      // but hostDeviceId is assigned only after a connect fully succeeds, so
      // during a failing connect it is still null and the one event that could
      // have told us the truth was discarded. Check the in-flight connect first.
      const pending = this.pendingConnect
      if (pending && ev.deviceId === pending.deviceId) {
        this.log(`join: host refused/dropped the connection ${ev.deviceId}`)
        pending.fail(new Error('the host refused the connection'))
        return
      }
      if (ev.deviceId === this.hostDeviceId) {
        this.log(`join: host disconnected ${ev.deviceId}`)
        this.hostDeviceId = null
        this.emit({ type: 'peerDisconnected', peer: 'host', reason: 'remote' })
      }
    })
    await BluetoothLowEnergy.addListener('characteristicChanged', (ev) => {
      if (ev.characteristic.toLowerCase() !== BLE_DATA_H2C_UUID.toLowerCase()) return
      this.emit({ type: 'data', peer: 'host', bytes: new Uint8Array(ev.value) })
    })
  }

  async connect(deviceId: string): Promise<void> {
    this.lastDeviceId = deviceId
    await this.ensureListeners()
    this.log(`join: connect ${deviceId}`)
    // Two independent ways out of a connect that would otherwise hang forever:
    // the disconnect event (fast, and carries the real cause) and the deadline
    // (the backstop for when the radio says nothing at all).
    const refused = new Promise<never>((_, reject) => {
      this.pendingConnect = { deviceId, fail: reject }
    })
    try {
      await withTimeout(
        Promise.race([BluetoothLowEnergy.connect({ deviceId }), refused]),
        CONNECT_TIMEOUT_MS,
        'the host did not answer',
      )
    } catch (err) {
      // Leave no half-open GATT client behind: Android keeps the connection
      // attempt alive and will silently refuse the next one otherwise.
      await BluetoothLowEnergy.disconnect({ deviceId }).catch(() => {})
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`couldn't connect to the host — ${reason}`, { cause: err })
    } finally {
      this.pendingConnect = null
    }
    try {
      const { mtu } = await withTimeout(
        BluetoothLowEnergy.requestMtu({ deviceId, mtu: 512 }),
        MTU_TIMEOUT_MS,
        'MTU request timed out',
      )
      this.maxPacket = Math.max(MIN_PACKET, Math.min(mtu - 3, 244))
      this.log(`join: MTU ${mtu} → maxPacket ${this.maxPacket}`)
    } catch {
      // Negotiation failed, so ATT_MTU is still the 23-byte spec floor and the
      // most we may put in one write is 20. The old fallback of 180 here was
      // backwards and silently corrupted the stream — see MIN_PACKET.
      this.maxPacket = MIN_PACKET
      this.log(`join: MTU refused → maxPacket ${this.maxPacket} (ATT floor)`)
    }
    this.log('join: discoverServices')
    await BluetoothLowEnergy.discoverServices({ deviceId })
    this.log('join: subscribe H2C notifications')
    await BluetoothLowEnergy.startCharacteristicNotifications({
      deviceId,
      service: BLE_SERVICE_UUID,
      characteristic: BLE_DATA_H2C_UUID,
    })
    this.hostDeviceId = deviceId
    this.log('join: connected — sending Hello')
    this.emit({ type: 'peerConnected', peer: 'host' })
  }

  /** Reconnect to the last host after a drop (BLE radios do this a lot in cars). */
  async reconnect(): Promise<void> {
    if (!this.lastDeviceId) throw new Error('never connected')
    await this.connect(this.lastDeviceId)
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
