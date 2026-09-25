import { describe, expect, it } from 'vitest'
import { joinFailureMessage } from './joinError'

describe('joinFailureMessage', () => {
  it('keeps the underlying words, because they name the actual cause', () => {
    // The real strings the join path can now throw: our own pre-flight check, our
    // connect deadline, and the plugin's own rejections.
    expect(joinFailureMessage(new Error('Bluetooth is off — turn it on and try again'))).toBe(
      "Can't join: Bluetooth is off — turn it on and try again",
    )
    expect(joinFailureMessage(new Error("couldn't connect to the host — the host did not answer"))).toBe(
      "Can't join: couldn't connect to the host — the host did not answer",
    )
    expect(joinFailureMessage(new Error('Permission denied: BLUETOOTH_SCAN'))).toBe(
      "Can't join: Permission denied: BLUETOOTH_SCAN",
    )
  })

  it('accepts a bare string throw', () => {
    expect(joinFailureMessage('Device not connected')).toBe("Can't join: Device not connected")
  })

  it('collapses whitespace so a multi-line reject still fits one status line', () => {
    expect(joinFailureMessage(new Error('Permission denied:\n  BLUETOOTH_CONNECT'))).toBe(
      "Can't join: Permission denied: BLUETOOTH_CONNECT",
    )
  })

  it.each([
    ['an Error with no message', new Error('')],
    ['an Error with only whitespace', new Error('   ')],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { code: 133 }],
    ['an empty string', ''],
  ])('never renders an empty status for %s', (_label, thrown) => {
    const msg = joinFailureMessage(thrown)
    expect(msg).toBe("Can't join: Bluetooth failed without saying why")
    // The point of the whole change is that SOMETHING legible appears — a blank
    // status line is the dead screen we are trying to eliminate.
    expect(msg.trim().length).toBeGreaterThan(0)
  })

  it('always announces itself as a join failure', () => {
    for (const thrown of [new Error('boom'), 'boom', null, { a: 1 }]) {
      expect(joinFailureMessage(thrown).startsWith("Can't join:")).toBe(true)
    }
  })

  it('never claims to be a hosting failure', () => {
    // Telling a joining player "Can't host" would send them to fix the wrong phone.
    expect(joinFailureMessage(new Error('boom')).startsWith("Can't host")).toBe(false)
  })
})
