import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTimeout } from './withTimeout'

// Everything here is about time, so time is fake and advanced explicitly. Real
// timers would make these tests slow, flaky, or both.
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Observe a promise's settlement WITHOUT awaiting it (awaiting a promise that
 * never settles would simply hang the test rather than fail it). */
const track = <T>(p: Promise<T>): { settled: boolean; value?: T; error?: unknown } => {
  const out: { settled: boolean; value?: T; error?: unknown } = { settled: false }
  p.then(
    (value) => {
      out.settled = true
      out.value = value
    },
    (error: unknown) => {
      out.settled = true
      out.error = error
    },
  )
  return out
}

/** The defect this helper exists for: a promise that never settles, ever. */
const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('withTimeout', () => {
  it('rejects with the given message once the deadline passes', async () => {
    const seen = track(withTimeout(never<string>(), 10_000, 'the host did not answer'))

    await vi.advanceTimersByTimeAsync(10_000)

    expect(seen.settled).toBe(true)
    expect(seen.error).toBeInstanceOf(Error)
    expect((seen.error as Error).message).toBe('the host did not answer')
  })

  it('does NOT reject one tick early', async () => {
    // A deadline that fires early would abort connects that were about to work.
    const seen = track(withTimeout(never<string>(), 10_000, 'too soon'))

    await vi.advanceTimersByTimeAsync(9_999)

    expect(seen.settled).toBe(false)
  })

  it('resolves with the underlying value when it beats the deadline', async () => {
    const seen = track(withTimeout(Promise.resolve({ mtu: 247 }), 5_000, 'nope'))

    await vi.advanceTimersByTimeAsync(0)

    expect(seen.settled).toBe(true)
    expect(seen.value).toEqual({ mtu: 247 })
    expect(seen.error).toBeUndefined()
  })

  it("propagates the underlying rejection, not the deadline's message", async () => {
    // The plugin's own words are the useful ones — see hostError.ts. A helper that
    // replaced "Permission denied: BLUETOOTH_CONNECT" with a generic timeout
    // string would destroy the only diagnostic the player can act on.
    const seen = track(withTimeout(Promise.reject(new Error('Device not connected')), 5_000, 'timed out'))

    await vi.advanceTimersByTimeAsync(5_000)

    expect((seen.error as Error).message).toBe('Device not connected')
  })

  it('wraps a non-Error rejection so callers can always read .message', async () => {
    const seen = track(withTimeout(Promise.reject('plain string'), 5_000, 'timed out'))

    await vi.advanceTimersByTimeAsync(0)

    expect(seen.error).toBeInstanceOf(Error)
    expect((seen.error as Error).message).toBe('plain string')
  })

  it('clears its timer when the promise resolves first, leaving nothing pending', async () => {
    // A leaked setTimeout keeps the event loop (and the phone's JS context) alive
    // and fires a rejection at a promise nobody is listening to any more.
    await withTimeout(Promise.resolve('ok'), 30_000, 'nope')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its timer when the promise rejects first', async () => {
    await withTimeout(Promise.reject(new Error('boom')), 30_000, 'nope').catch(() => {})

    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a late resolution instead of settling twice', async () => {
    let release!: (v: string) => void
    const slow = new Promise<string>((r) => (release = r))
    const seen = track(withTimeout(slow, 1_000, 'deadline hit'))

    await vi.advanceTimersByTimeAsync(1_000)
    expect((seen.error as Error).message).toBe('deadline hit')

    release('arrived far too late')
    await vi.advanceTimersByTimeAsync(0)

    // Still the timeout rejection; the late value cannot overwrite it.
    expect(seen.value).toBeUndefined()
    expect((seen.error as Error).message).toBe('deadline hit')
  })

  it('does not raise an unhandled rejection when the promise rejects AFTER the deadline', async () => {
    // This is the realistic BLE shape: the deadline fires, and only later does the
    // stack finally admit failure. If that late rejection were unhandled it would
    // surface as an app-level error event on a phone we cannot attach a debugger to.
    const unhandled: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent | unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      let fail!: (e: Error) => void
      const slow = new Promise<string>((_, reject) => (fail = reject))
      const seen = track(withTimeout(slow, 1_000, 'deadline hit'))

      await vi.advanceTimersByTimeAsync(1_000)
      fail(new Error('GATT 133, eventually'))
      await vi.advanceTimersByTimeAsync(0)
      // Give the host a real macrotask turn: unhandled rejections are reported
      // after the microtask queue drains.
      vi.useRealTimers()
      await new Promise((r) => setTimeout(r, 10))

      expect((seen.error as Error).message).toBe('deadline hit')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
