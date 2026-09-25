// @vitest-environment happy-dom
// Zoom-preference persistence: hostile stored data, clamping, the save/load
// round-trip, and the debounced ZoomSink wrapper that feeds it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, type ZoomSink } from './zoomModel'
import { loadZoom, parseStoredZoom, persistZoomSink, saveZoom, ZOOM_SAVE_DEBOUNCE_MS } from './zoomPersist'

// happy-dom's localStorage is method-less under current Node; give the module
// a real (in-memory) Storage so persistence is actually exercised.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
})

beforeEach(() => localStorage.clear())

describe('parseStoredZoom — hostile persisted data', () => {
  it.each([
    ['null', null],
    ['a bare number', 2],
    ['a string', '2'],
    ['an array', [2]],
    ['empty object (no version)', {}],
    ['wrong version', { v: 2, zoom: 2 }],
    ['version without zoom', { v: 1 }],
    ['zoom as a string', { v: 1, zoom: '2' }],
    ['zoom as NaN', { v: 1, zoom: NaN }],
    ['zoom as Infinity', { v: 1, zoom: Infinity }],
    ['zoom as null', { v: 1, zoom: null }],
    ['zoom as an object', { v: 1, zoom: {} }],
  ])('%s falls back to the default zoom', (_name, raw) => {
    expect(parseStoredZoom(raw)).toBe(ZOOM_DEFAULT)
  })
  it('a valid envelope passes its zoom through', () => {
    expect(parseStoredZoom({ v: 1, zoom: 2.5 })).toBe(2.5)
  })
  it('a finite out-of-range zoom is CLAMPED, not rejected (older builds may have had wider bounds)', () => {
    expect(parseStoredZoom({ v: 1, zoom: 100 })).toBe(ZOOM_MAX)
    expect(parseStoredZoom({ v: 1, zoom: 0.01 })).toBe(ZOOM_MIN)
    expect(parseStoredZoom({ v: 1, zoom: -3 })).toBe(ZOOM_MIN)
  })
})

describe('loadZoom / saveZoom', () => {
  it('round-trips: save → load returns the same zoom', () => {
    saveZoom(1.7)
    expect(loadZoom()).toBe(1.7)
  })
  it('defaults when nothing is stored', () => {
    expect(loadZoom()).toBe(ZOOM_DEFAULT)
  })
  it('defaults from corrupt JSON', () => {
    localStorage.setItem('sporefall.zoom', '{not json')
    expect(loadZoom()).toBe(ZOOM_DEFAULT)
  })
  it('defaults from valid-JSON garbage', () => {
    localStorage.setItem('sporefall.zoom', JSON.stringify({ v: 1, zoom: 'big' }))
    expect(loadZoom()).toBe(ZOOM_DEFAULT)
  })
  it('save clamps before writing (a wild value never lands on disk)', () => {
    saveZoom(999)
    expect(JSON.parse(localStorage.getItem('sporefall.zoom')!)).toEqual({ v: 1, zoom: ZOOM_MAX })
  })
  it('persists under a versioned envelope', () => {
    saveZoom(2)
    expect(JSON.parse(localStorage.getItem('sporefall.zoom')!)).toEqual({ v: 1, zoom: 2 })
  })
})

describe('persistZoomSink — the debounced save wrapper', () => {
  /** A fake camera-backed sink whose target we can watch. */
  const fakeSink = (): ZoomSink & { z: number } => {
    const s = {
      z: 1,
      get: () => s.z,
      set: (z: number) => {
        s.z = z
      },
      reset: () => {
        s.z = ZOOM_DEFAULT
      },
    }
    return s
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('forwards get/set/reset to the inner sink (behavior unchanged)', () => {
    const inner = fakeSink()
    const wrapped = persistZoomSink(inner, () => {})
    wrapped.set(2, 10, 20)
    expect(inner.z).toBe(2)
    expect(wrapped.get()).toBe(2)
    wrapped.reset()
    expect(inner.z).toBe(ZOOM_DEFAULT)
  })

  it('saves the target after the debounce window, not immediately', () => {
    const save = vi.fn()
    const wrapped = persistZoomSink(fakeSink(), save)
    wrapped.set(2, 0, 0)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ZOOM_SAVE_DEBOUNCE_MS + 10)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(2)
  })

  it('a continuous gesture collapses to ONE save carrying the LAST value', () => {
    const save = vi.fn()
    const wrapped = persistZoomSink(fakeSink(), save)
    for (let i = 0; i < 30; i++) {
      wrapped.set(1 + i * 0.05, 0, 0)
      vi.advanceTimersByTime(16) // < debounce between steps: keeps deferring
    }
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ZOOM_SAVE_DEBOUNCE_MS + 10)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(1 + 29 * 0.05)
  })

  it('reset also schedules a save (the double-tap reset must persist too)', () => {
    const save = vi.fn()
    const wrapped = persistZoomSink(fakeSink(), save)
    wrapped.set(3, 0, 0)
    wrapped.reset()
    vi.advanceTimersByTime(ZOOM_SAVE_DEBOUNCE_MS + 10)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(ZOOM_DEFAULT)
  })

  it('two separate gestures produce two saves', () => {
    const save = vi.fn()
    const wrapped = persistZoomSink(fakeSink(), save)
    wrapped.set(2, 0, 0)
    vi.advanceTimersByTime(ZOOM_SAVE_DEBOUNCE_MS + 10)
    wrapped.set(3, 0, 0)
    vi.advanceTimersByTime(ZOOM_SAVE_DEBOUNCE_MS + 10)
    expect(save.mock.calls).toEqual([[2], [3]])
  })
})
