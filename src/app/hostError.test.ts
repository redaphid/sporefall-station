import { describe, expect, it } from 'vitest'
import { hostFailureMessage } from './hostError'

describe('hostFailureMessage', () => {
  it("keeps the plugin's own words, because they name the actual cause", () => {
    // These are the real strings BluetoothLowEnergyPlugin.java rejects with.
    expect(hostFailureMessage(new Error('Bluetooth advertiser not available'))).toBe(
      "Can't host: Bluetooth advertiser not available",
    )
    expect(hostFailureMessage(new Error('Permission denied: BLUETOOTH_ADVERTISE'))).toBe(
      "Can't host: Permission denied: BLUETOOTH_ADVERTISE",
    )
    expect(hostFailureMessage(new Error('Failed to set Bluetooth adapter name for advertising'))).toBe(
      "Can't host: Failed to set Bluetooth adapter name for advertising",
    )
  })

  it('accepts a bare string throw', () => {
    expect(hostFailureMessage('GATT server is only available in peripheral mode')).toBe(
      "Can't host: GATT server is only available in peripheral mode",
    )
  })

  it('collapses whitespace so a multi-line reject still fits one status line', () => {
    expect(hostFailureMessage(new Error('Permission denied:\n  BLUETOOTH_CONNECT'))).toBe(
      "Can't host: Permission denied: BLUETOOTH_CONNECT",
    )
  })

  it.each([
    ['an Error with no message', new Error('')],
    ['an Error with only whitespace', new Error('   ')],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { code: 7 }],
    ['an empty string', ''],
  ])('never renders an empty status for %s', (_label, thrown) => {
    const msg = hostFailureMessage(thrown)
    expect(msg).toBe("Can't host: Bluetooth failed without saying why")
    // The point of the whole change is that SOMETHING legible appears.
    expect(msg.trim().length).toBeGreaterThan(0)
  })

  it('always announces itself as a hosting failure', () => {
    for (const thrown of [new Error('boom'), 'boom', null, { a: 1 }]) {
      expect(hostFailureMessage(thrown).startsWith("Can't host:")).toBe(true)
    }
  })
})
