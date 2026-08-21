import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransportEvent } from '../types'

/**
 * The BLE plugin is a native bridge, so these tests mock it and assert on the
 * JS-side behaviour that has to survive a hostile radio. What they cover is
 * exactly what a loopback transport can never reach: what happens when the
 * plugin does NOT answer.
 *
 * The failure being defended against is specific and verified in the plugin's
 * source: `onConnectionStateChange` resolves the pending connect call only on
 * STATE_CONNECTED, and on STATE_DISCONNECTED it emits an event and drops the
 * call without ever reading `status`. So "connect never settles" below is not a
 * hypothetical — it is the shipped behaviour when a peripheral refuses.
 */
const mocks = vi.hoisted(() => {
  const listeners = new Map<string, ((ev: { deviceId: string }) => void)[]>()
  return {
    listeners,
    requestPermissions: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => ({ available: true })),
    isEnabled: vi.fn(async () => ({ enabled: true })),
    initialize: vi.fn(async () => {}),
    addGattService: vi.fn(async () => {}),
    startAdvertising: vi.fn(async () => {}),
    stopAdvertising: vi.fn(async () => {}),
    removeGattService: vi.fn(async () => {}),
    removeAllListeners: vi.fn(async () => {}),
    addListener: vi.fn(async (name: string, cb: (ev: { deviceId: string }) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), cb])
      return { remove: async (): Promise<void> => {} }
    }),
    connect: vi.fn<(o: { deviceId: string }) => Promise<void>>(async () => {}),
    disconnect: vi.fn<(o: { deviceId: string }) => Promise<void>>(async () => {}),
    requestMtu: vi.fn<(o: { deviceId: string; mtu: number }) => Promise<{ mtu: number }>>(async () => ({ mtu: 512 })),
    discoverServices: vi.fn(async () => {}),
    startCharacteristicNotifications: vi.fn(async () => {}),
  }
})

vi.mock('@capgo/capacitor-bluetooth-low-energy', () => ({ BluetoothLowEnergy: mocks }))

const { BleClientTransport, BleHostTransport, CONNECT_TIMEOUT_MS, MTU_TIMEOUT_MS } = await import('./bleTransport')

const HOST_ID = 'AA:BB:CC:DD:EE:FF'

/** A promise that never settles — the defect under test. */
const never = <T>(): Promise<T> => new Promise<T>(() => {})

/** Observe settlement without awaiting (awaiting a hang would hang the test). */
const track = <T>(p: Promise<T>): { settled: boolean; error?: unknown } => {
  const out: { settled: boolean; error?: unknown } = { settled: false }
  p.then(
    () => {
      out.settled = true
    },
    (error: unknown) => {
      out.settled = true
      out.error = error
    },
  )
  return out
}

const fire = (name: string, deviceId: string): void => {
  for (const cb of mocks.listeners.get(name) ?? []) cb({ deviceId })
}

const startedClient = async (): Promise<InstanceType<typeof BleClientTransport>> => {
  const t = new BleClientTransport()
  await t.start()
  return t
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  // clearAllMocks keeps implementations, so restore every default explicitly —
  // otherwise one test's "never settles" leaks into the next and turns a real
  // failure into a passing test for the wrong reason.
  mocks.isAvailable.mockImplementation(async () => ({ available: true }))
  mocks.isEnabled.mockImplementation(async () => ({ enabled: true }))
  mocks.connect.mockImplementation(async () => {})
  mocks.disconnect.mockImplementation(async () => {})
  mocks.requestMtu.mockImplementation(async () => ({ mtu: 512 }))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('pre-flight: is there a radio, and is it on?', () => {
  it('join refuses with a fixable instruction when Bluetooth is off', async () => {
    mocks.isEnabled.mockImplementation(async () => ({ enabled: false }))

    await expect(new BleClientTransport().start()).rejects.toThrow('Bluetooth is off — turn it on and try again')
  })

  it('host refuses with the same instruction when Bluetooth is off', async () => {
    mocks.isEnabled.mockImplementation(async () => ({ enabled: false }))

    await expect(new BleHostTransport('Player-42').start()).rejects.toThrow(
      'Bluetooth is off — turn it on and try again',
    )
  })

  it('names the real problem when the phone has no radio at all', async () => {
    mocks.isAvailable.mockImplementation(async () => ({ available: false }))

    await expect(new BleClientTransport().start()).rejects.toThrow('no Bluetooth radio')
    // ...and does not go on to ask about the switch on a radio that isn't there.
    expect(mocks.isEnabled).not.toHaveBeenCalled()
  })

  it('stops BEFORE advertising, so a dead host is never half-started', async () => {
    mocks.isEnabled.mockImplementation(async () => ({ enabled: false }))

    await new BleHostTransport('Player-42').start().catch(() => {})

    expect(mocks.initialize).not.toHaveBeenCalled()
    expect(mocks.addGattService).not.toHaveBeenCalled()
    expect(mocks.startAdvertising).not.toHaveBeenCalled()
  })

  it('runs AFTER requestPermissions, because isEnabled() needs BLUETOOTH_CONNECT', async () => {
    // On Android 12+ BluetoothAdapter.isEnabled() is @RequiresPermission(BLUETOOTH_CONNECT)
    // and throws SecurityException without it. Asking first turns a helpful check
    // into a new crash, so the ORDER is the fix, not an incidental detail.
    await new BleClientTransport().start()

    expect(mocks.requestPermissions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.isEnabled.mock.invocationCallOrder[0],
    )
  })

  it('proceeds normally when the radio is present and on', async () => {
    await new BleClientTransport().start()

    expect(mocks.initialize).toHaveBeenCalledWith({ mode: 'central' })
  })
})

describe('connect: a refusal must not hang forever', () => {
  it('rejects once the deadline passes when the plugin never settles', async () => {
    mocks.connect.mockImplementation(() => never<void>())
    const t = await startedClient()

    const seen = track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)

    expect(seen.settled).toBe(true)
    expect((seen.error as Error).message).toContain("couldn't connect to the host")
    expect((seen.error as Error).message).toContain('the host did not answer')
  })

  it('is still waiting just before the deadline', async () => {
    mocks.connect.mockImplementation(() => never<void>())
    const t = await startedClient()

    const seen = track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1)

    expect(seen.settled).toBe(false)
  })

  it('tears the half-open GATT client down on timeout', async () => {
    // Android keeps a failed connection attempt alive; leaving it behind makes the
    // NEXT connect fail too, which is how one bad join poisons every retry.
    mocks.connect.mockImplementation(() => never<void>())
    const t = await startedClient()

    track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)

    expect(mocks.disconnect).toHaveBeenCalledWith({ deviceId: HOST_ID })
  })

  it('still reports the failure when the teardown itself throws', async () => {
    mocks.connect.mockImplementation(() => never<void>())
    mocks.disconnect.mockImplementation(async () => {
      throw new Error('Device not connected')
    })
    const t = await startedClient()

    const seen = track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)

    expect((seen.error as Error).message).toContain('the host did not answer')
  })

  it('fails FAST on the disconnect event instead of waiting out the deadline', async () => {
    // The event is the only place the truth lives, since the plugin never rejects.
    // It used to be filtered by `ev.deviceId === this.hostDeviceId`, and
    // hostDeviceId is assigned only AFTER a connect succeeds — so during a failing
    // connect it was null and this event was thrown away.
    mocks.connect.mockImplementation(() => never<void>())
    const t = await startedClient()

    const seen = track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(0) // let connect() reach its in-flight state
    fire('deviceDisconnected', HOST_ID)
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.settled).toBe(true)
    expect((seen.error as Error).message).toContain('the host refused the connection')
  })

  it('leaves no timer behind after failing fast', async () => {
    mocks.connect.mockImplementation(() => never<void>())
    const t = await startedClient()

    track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(0)
    fire('deviceDisconnected', HOST_ID)
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a disconnect from a DIFFERENT device while connecting', async () => {
    // Other phones' radios come and go mid-scan; only our target may fail our connect.
    mocks.connect.mockImplementation(() => never<void>())
    const t = await startedClient()

    const seen = track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(0)
    fire('deviceDisconnected', '11:22:33:44:55:66')
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.settled).toBe(false)
  })

  it('registers the disconnect listener before any connect is attempted', async () => {
    await startedClient()

    expect(mocks.listeners.get('deviceDisconnected')?.length).toBe(1)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('completes the handshake when the radio behaves', async () => {
    const t = await startedClient()

    await t.connect(HOST_ID)

    expect(mocks.discoverServices).toHaveBeenCalledWith({ deviceId: HOST_ID })
    expect(mocks.startCharacteristicNotifications).toHaveBeenCalled()
    expect(t.peers()).toEqual(['host'])
  })

  it('still reports a mid-game drop after a SUCCESSFUL connect', async () => {
    // Regression guard: the new in-flight branch must not swallow the event that
    // drives the reconnect loop.
    const t = await startedClient()
    const events: TransportEvent[] = []
    t.on((e) => events.push(e))

    await t.connect(HOST_ID)
    fire('deviceDisconnected', HOST_ID)

    expect(events.map((e) => e.type)).toEqual(['peerConnected', 'peerDisconnected'])
    expect(t.peers()).toEqual([])
  })
})

describe('MTU fallback: the floor is 20, not 180', () => {
  it('falls back to the 20-byte ATT floor when negotiation is refused', async () => {
    // The old fallback was 180 — the post-negotiation value — which is exactly
    // backwards: a refused negotiation means ATT_MTU is still 23, so 180-byte
    // writes are silently truncated to 20 and the framing corrupts permanently.
    mocks.requestMtu.mockImplementation(async () => {
      throw new Error('Failed to change MTU')
    })
    const t = await startedClient()

    await t.connect(HOST_ID)

    expect(t.maxPacket).toBe(20)
  })

  it('falls back to 20 when the MTU request never answers', async () => {
    mocks.requestMtu.mockImplementation(() => never<{ mtu: number }>())
    const t = await startedClient()

    const seen = track(t.connect(HOST_ID))
    await vi.advanceTimersByTimeAsync(MTU_TIMEOUT_MS)

    expect(seen.settled).toBe(true)
    expect(seen.error).toBeUndefined() // a refused MTU is survivable, not fatal
    expect(t.maxPacket).toBe(20)
  })

  it('keeps the link up after an MTU failure rather than aborting the join', async () => {
    mocks.requestMtu.mockImplementation(async () => {
      throw new Error('Failed to change MTU')
    })
    const t = await startedClient()

    await t.connect(HOST_ID)

    expect(mocks.discoverServices).toHaveBeenCalled()
    expect(t.peers()).toEqual(['host'])
  })

  it('uses the negotiated size when negotiation succeeds', async () => {
    mocks.requestMtu.mockImplementation(async () => ({ mtu: 247 }))
    const t = await startedClient()

    await t.connect(HOST_ID)

    expect(t.maxPacket).toBe(244) // mtu - 3
  })

  it('caps at 244 even when the peer grants a huge MTU', async () => {
    mocks.requestMtu.mockImplementation(async () => ({ mtu: 512 }))
    const t = await startedClient()

    await t.connect(HOST_ID)

    expect(t.maxPacket).toBe(244)
  })

  it('never goes below 20 even if a peer reports a nonsense MTU', async () => {
    mocks.requestMtu.mockImplementation(async () => ({ mtu: 23 }))
    const t = await startedClient()

    await t.connect(HOST_ID)

    expect(t.maxPacket).toBe(20)
  })
})
