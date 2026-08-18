// @vitest-environment happy-dom
// The screen wake lock is the difference between a co-op session and a room of
// frozen phones — if the HOST sleeps, the authoritative sim stops and everyone
// stops with it. These tests pin the two properties that actually matter on a
// phone: it comes back after the page is backgrounded, and no failure of the API
// is ever allowed to reach the game.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepScreenAwake, type WakeLockHandle } from './wakeLock'

class FakeSentinel extends EventTarget {
  release = vi.fn(() => Promise.resolve())
}

const setVisibility = (state: 'visible' | 'hidden'): void => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Let the `request()` promise settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('keepScreenAwake', () => {
  let sentinels: FakeSentinel[]
  let request: ReturnType<typeof vi.fn>
  let open: WakeLockHandle[]

  /** Every handle must be released, or its `visibilitychange` listener survives
   *  on this environment's shared `document` and answers the NEXT test's events. */
  const start = (): WakeLockHandle => {
    const h = keepScreenAwake()
    open.push(h)
    return h
  }

  beforeEach(() => {
    sentinels = []
    open = []
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    request = vi.fn(() => {
      const s = new FakeSentinel()
      sentinels.push(s)
      return Promise.resolve(s)
    })
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true })
  })

  afterEach(() => {
    for (const h of open) h.release()
    Reflect.deleteProperty(navigator, 'wakeLock')
  })

  it('takes a screen lock as soon as gameplay starts', async () => {
    start()
    await flush()
    expect(request).toHaveBeenCalledWith('screen')
  })

  it('re-acquires when the page comes back, because backgrounding drops the lock', async () => {
    start()
    await flush()
    expect(request).toHaveBeenCalledTimes(1)

    setVisibility('hidden') // browser releases the lock here
    await flush()
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not stack locks while the page simply stays visible', async () => {
    start()
    await flush()
    setVisibility('visible')
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never requests while hidden — that always rejects', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    start()
    await flush()
    expect(request).not.toHaveBeenCalled()
  })

  it('survives a denied request: battery saver must not break the game', async () => {
    request.mockRejectedValue(new Error('wake lock denied by user agent'))
    const handle = start()
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    expect(() => handle.release()).not.toThrow()
  })

  it('survives a request that throws synchronously', async () => {
    request.mockImplementation(() => {
      throw new Error('nope')
    })
    expect(() => start()).not.toThrow()
    await flush()
  })

  it('no-ops on a WebView with no Screen Wake Lock at all', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock')
    const handle = start()
    await flush()
    expect(request).not.toHaveBeenCalled()
    expect(() => handle.release()).not.toThrow()
  })

  it('releases on request and then stops re-acquiring', async () => {
    const handle = start()
    await flush()
    handle.release()
    expect(sentinels[0].release).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('is safe to release twice', async () => {
    const handle = start()
    await flush()
    handle.release()
    expect(() => handle.release()).not.toThrow()
    expect(sentinels[0].release).toHaveBeenCalledTimes(1)
  })

  it('releases a lock that arrives after release() was already called', async () => {
    let resolveLate: (s: FakeSentinel) => void = () => {}
    const late = new FakeSentinel()
    request.mockImplementation(() => new Promise((r) => (resolveLate = r as (s: FakeSentinel) => void)))
    const handle = start()
    handle.release() // player quits before the OS answers
    resolveLate(late)
    await flush()
    expect(late.release).toHaveBeenCalledTimes(1)
  })
})
