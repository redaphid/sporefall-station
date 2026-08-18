import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BLE_SERVICE_UUID } from '../types'
import { ADVERTISE_PDU_MAX, HOST_LABEL_PREFIX, advertisementBytes, toAdvertiseName } from './hostName'

// The BLE plugin is a native bridge; mock it so we can assert on exactly what the
// host ASKS Android to broadcast. This is the only part of discovery that can be
// checked without a phone — and it is the part that was wrong.
interface AdvertiseCall {
  name: string
  services: string[]
  includeName: boolean
}

const mocks = vi.hoisted(() => ({
  requestPermissions: vi.fn(async () => {}),
  // The host pre-flights the radio before it advertises (bleTransport.ts);
  // a healthy radio is the precondition for every case in this file.
  isAvailable: vi.fn(async () => ({ available: true })),
  isEnabled: vi.fn(async () => ({ enabled: true })),
  initialize: vi.fn(async () => {}),
  addGattService: vi.fn(async () => {}),
  addListener: vi.fn(async () => ({ remove: async () => {} })),
  startAdvertising: vi.fn<(options: AdvertiseCall) => Promise<void>>(async () => {}),
}))

vi.mock('@capgo/capacitor-bluetooth-low-energy', () => ({ BluetoothLowEnergy: mocks }))

const { BleHostTransport } = await import('./bleTransport')

/** Start a host and return the options it handed to the plugin's startAdvertising. */
const advertiseOptionsFor = async (displayName: string): Promise<AdvertiseCall> => {
  await new BleHostTransport(displayName).start()
  const call = mocks.startAdvertising.mock.calls.at(-1)?.[0]
  expect(call, 'host never called startAdvertising').toBeDefined()
  return call as AdvertiseCall
}

/** Bytes actually put on the air for a given advertise request. */
const pduBytesOf = (call: AdvertiseCall): number =>
  advertisementBytes({
    // includeName:false means no local-name AD structure at all.
    name: call.includeName ? call.name : null,
    serviceUuids: call.services.length,
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('host advertisement byte budget', () => {
  // These names are all >8 chars, i.e. all of them overflow the name budget if the
  // name is on the air. 'Player-42' is the shipped default (src/main.ts).
  const names = ['Player-42', 'Player-9', 'Aaron', 'Mireclaw Stalker Prime', 'Dave 🎮', 'José', '']

  it.each(names)('fits inside the 31-byte legacy PDU for %j', async (displayName) => {
    const call = await advertiseOptionsFor(displayName)
    expect(pduBytesOf(call)).toBeLessThanOrEqual(ADVERTISE_PDU_MAX)
  })

  it('advertises the service UUID, which is how centrals actually find us', async () => {
    const call = await advertiseOptionsFor('Player-42')
    expect(call.services).toEqual([BLE_SERVICE_UUID])
  })

  it('does not ask Android to put a device name on the air', async () => {
    // Regression guard for #35. includeName:true is NOT equivalent to "advertise
    // this 8-char string": the capgo plugin implements it as
    // bluetoothAdapter.setName(name) + AdvertiseData.setIncludeDeviceName(true),
    // and setName returns true on ACCEPTED, not applied. The stack substitutes the
    // adapter's CURRENT name when it assembles the PDU, so losing that race puts
    // the phone's real name ("Pixel 8 Pro") in the packet instead of ours.
    //
    // We cannot measure that race from here — which is exactly why the name stays
    // off the advertisement rather than relying on winning it.
    const call = await advertiseOptionsFor('Player-42')
    expect(call.includeName).toBe(false)
  })

  it('leaves real headroom rather than sitting on the limit', async () => {
    // With the name off the air: flags(3) + 128-bit UUID(18) = 21 of 31.
    // Sitting at exactly 31 is what made this fragile enough to break on a
    // single extra AD field or a lost rename race.
    const call = await advertiseOptionsFor('Player-42')
    expect(pduBytesOf(call)).toBe(21)
  })
})

describe('advertisementBytes', () => {
  it('counts the flags field and each 128-bit service UUID', () => {
    expect(advertisementBytes({ serviceUuids: 0 })).toBe(3)
    expect(advertisementBytes({ serviceUuids: 1 })).toBe(21)
  })

  it('measures the name in UTF-8, not UTF-16 code units', () => {
    // 'ab' is 2 code units and 2 bytes; '🎮' is 2 code units but 4 bytes.
    expect(advertisementBytes({ name: 'ab', serviceUuids: 1 })).toBe(25)
    expect(advertisementBytes({ name: '🎮', serviceUuids: 1 })).toBe(27)
  })
})

describe("why the game's name is NOT the broadcast name", () => {
  // The obvious request is "make the host advertise 'Sporefall'". It does not fit,
  // and this is the arithmetic that says so. flags(3) + 128-bit service UUID(18)
  // = 21, plus 2 bytes of local-name header = 23, leaving 8 of the 31-byte PDU.
  it("cannot fit 'Sporefall' — 9 bytes into an 8-byte hole", () => {
    expect(advertisementBytes({ name: 'Sporefall', serviceUuids: 1 })).toBe(32) // one over
    expect(advertisementBytes({ name: 'Sporefall', serviceUuids: 1 })).toBeGreaterThan(ADVERTISE_PDU_MAX)
  })

  it("cannot fit 'Sporefall Station' either — 17 bytes, missing by nine", () => {
    expect(advertisementBytes({ name: 'Sporefall Station', serviceUuids: 1 })).toBe(40)
  })

  it('has room for exactly 8 bytes of name, and the 9th overflows', () => {
    expect(advertisementBytes({ name: '12345678', serviceUuids: 1 })).toBe(ADVERTISE_PDU_MAX)
    expect(advertisementBytes({ name: '123456789', serviceUuids: 1 })).toBeGreaterThan(ADVERTISE_PDU_MAX)
  })

  it('drops the service UUID if we spent the space on a name — which would break discovery outright', () => {
    // The only way 'Sporefall' fits is by giving up the one field centrals
    // actually match on (startScan({services}) / requestDevice({filters})).
    // Stated as a test so nobody re-derives it as a good idea.
    expect(advertisementBytes({ name: 'Sporefall', serviceUuids: 0 })).toBeLessThanOrEqual(ADVERTISE_PDU_MAX)
  })

  it('keeps the join-list tag off the air entirely', async () => {
    // 'Sporefall' reaches the player through toHostLabel on the SCANNING phone,
    // never through the advertiser. If this ever shows up in an advertise call,
    // the budget above is blown and the host goes silently off the air.
    const call = await advertiseOptionsFor('Player-42')
    expect(call.includeName).toBe(false)
    expect(call.name).not.toContain(HOST_LABEL_PREFIX)
  })
})

describe('KNOWN GAP — toAdvertiseName truncates by code unit, not by byte', () => {
  it('keeps ASCII names inside the budget', () => {
    expect(advertisementBytes({ name: toAdvertiseName('Player-42'), serviceUuids: 1 })).toBeLessThanOrEqual(
      ADVERTISE_PDU_MAX,
    )
  })

  it.each(['Dave 🎮', 'Joséphine', 'Ünterberg'])(
    'STILL OVERFLOWS for the non-ASCII name %j — documents an unfixed defect',
    (raw) => {
      // toAdvertiseName slices to 8 UTF-16 code units, but the air format is UTF-8,
      // and the name budget is exactly 8 BYTES. Any multi-byte character overflows.
      //
      // This is deliberately asserted as still-broken so the defect cannot be lost.
      // It does not affect discovery today because the name is off the air
      // (includeName:false) — it is latent, and it will bite the moment anyone puts
      // the name back. When truncation is fixed to count UTF-8 bytes, flip this to
      // toBeLessThanOrEqual and this suite becomes the proof.
      expect(advertisementBytes({ name: toAdvertiseName(raw), serviceUuids: 1 })).toBeGreaterThan(ADVERTISE_PDU_MAX)
    },
  )
})
