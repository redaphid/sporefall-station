// @vitest-environment happy-dom
// Controller zoom: view-only, remap-driven, inert during bind capture. The
// module reads the LIVE user map (remap.ts), so these tests drive it through
// the real setButtonMap path a settings-panel bind would take.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { padZoomFactor, ZOOM_DEFAULT, type ZoomSink } from '../render/zoomModel'
import { createPadZoom, readPadZoomHeld } from './padZoom'
import { bindButton, defaultButtonMap, resetButtonMapCacheForTest, setButtonMap, setPadCapture } from './remap'

// happy-dom's localStorage is method-less under current Node; give remap.ts a
// real (in-memory) Storage so setButtonMap can persist.
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

const pad = (down: number[] = []): Gamepad =>
  ({
    index: 0,
    id: 'Fake Pad',
    mapping: 'standard',
    connected: true,
    buttons: Array.from({ length: 18 }, (_, i) => ({ pressed: down.includes(i), touched: false, value: down.includes(i) ? 1 : 0 })),
    axes: [0, 0, 0, 0],
  }) as unknown as Gamepad

describe('readPadZoomHeld', () => {
  const map = { zoomIn: [4], zoomOut: [5] }
  it('no pads / null slots → nothing held', () => {
    expect(readPadZoomHeld([], map)).toEqual({ zoomIn: false, zoomOut: false })
    expect(readPadZoomHeld([null, null], map)).toEqual({ zoomIn: false, zoomOut: false })
  })
  it('a bound button held on ANY pad counts (the view is shared on a couch)', () => {
    expect(readPadZoomHeld([null, pad([4])], map)).toEqual({ zoomIn: true, zoomOut: false })
    expect(readPadZoomHeld([pad([5]), null], map)).toEqual({ zoomIn: false, zoomOut: true })
  })
  it('opposite directions can come from different pads (both held → later cancels)', () => {
    expect(readPadZoomHeld([pad([4]), pad([5])], map)).toEqual({ zoomIn: true, zoomOut: true })
  })
  it('unbound actions are never held, whatever is pressed', () => {
    expect(readPadZoomHeld([pad([0, 1, 2, 3, 4, 5])], { zoomIn: [], zoomOut: [] })).toEqual({
      zoomIn: false,
      zoomOut: false,
    })
  })
  it('an exotic bound index past the pad’s button array is bounds-safe', () => {
    expect(readPadZoomHeld([pad([])], { zoomIn: [63], zoomOut: [] })).toEqual({ zoomIn: false, zoomOut: false })
  })
})

describe('createPadZoom.update', () => {
  const DT = 1 / 60
  let sink: ZoomSink & { z: number; sets: [number, number, number][] }
  let pads: (Gamepad | null)[]

  const makeSink = (): typeof sink => {
    const s = {
      z: 1,
      sets: [] as [number, number, number][],
      get: () => s.z,
      set: (z: number, ax: number, ay: number) => {
        s.z = z
        s.sets.push([z, ax, ay])
      },
      reset: () => {
        s.z = ZOOM_DEFAULT
      },
    }
    return s
  }
  const centre = (): { x: number; y: number } => ({ x: 400, y: 300 })

  beforeEach(() => {
    localStorage.clear()
    resetButtonMapCacheForTest()
    setPadCapture(false)
    sink = makeSink()
    pads = []
  })
  afterEach(() => setPadCapture(false))

  it('with zoom unbound (the default), never touches the sink — and never even polls the pads', () => {
    const getPads = vi.fn(() => pads)
    const pz = createPadZoom(sink, centre, getPads)
    pads = [pad([0, 1, 2, 3, 4, 5, 6, 7])]
    pz.update(DT)
    expect(sink.sets).toEqual([])
    expect(getPads).not.toHaveBeenCalled()
  })

  it('holding the bound zoomIn button multiplies the target up, anchored on the screen centre', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'zoomIn', 4))
    const pz = createPadZoom(sink, centre, () => pads)
    pads = [pad([4])]
    pz.update(DT)
    expect(sink.sets).toEqual([[padZoomFactor(true, false, DT), 400, 300]])
  })

  it('holding the bound zoomOut button multiplies the target down', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'zoomOut', 4))
    const pz = createPadZoom(sink, centre, () => pads)
    pads = [pad([4])]
    sink.z = 2
    pz.update(DT)
    expect(sink.z).toBeCloseTo(2 * padZoomFactor(false, true, DT), 12)
  })

  it('steps COMPOUND across frames (held button keeps zooming)', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'zoomIn', 4))
    const pz = createPadZoom(sink, centre, () => pads)
    pads = [pad([4])]
    for (let i = 0; i < 10; i++) pz.update(DT)
    expect(sink.z).toBeCloseTo(padZoomFactor(true, false, DT) ** 10, 9)
  })

  it('both directions held cancel to a no-op (no set at all — no anchor churn)', () => {
    let m = bindButton(defaultButtonMap(), 'zoomIn', 4)
    m = bindButton(m, 'zoomOut', 5)
    setButtonMap(m)
    const pz = createPadZoom(sink, centre, () => pads)
    pads = [pad([4, 5])]
    pz.update(DT)
    expect(sink.sets).toEqual([])
  })

  it('goes fully inert while the settings panel is capturing a bind', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'zoomIn', 4))
    const getPads = vi.fn(() => pads)
    const pz = createPadZoom(sink, centre, getPads)
    pads = [pad([4])]
    setPadCapture(true)
    pz.update(DT)
    expect(sink.sets).toEqual([])
    expect(getPads).not.toHaveBeenCalled() // not even a poll: the press is spent on the capture
    setPadCapture(false)
    createPadZoom(sink, centre, () => pads).update(DT)
    expect(sink.sets.length).toBe(1)
  })

  it('a rebind applies on the NEXT update — no reload, no re-create', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'zoomIn', 4))
    const pz = createPadZoom(sink, centre, () => pads)
    pads = [pad([10])]
    pz.update(DT)
    expect(sink.sets).toEqual([]) // 10 is not the binding
    setButtonMap(bindButton(defaultButtonMap(), 'zoomIn', 10))
    pz.update(DT)
    expect(sink.sets.length).toBe(1)
  })

  it('degenerate dt never moves the zoom', () => {
    setButtonMap(bindButton(defaultButtonMap(), 'zoomIn', 4))
    const pz = createPadZoom(sink, centre, () => pads)
    pads = [pad([4])]
    for (const dt of [0, -1, NaN, Infinity]) pz.update(dt)
    expect(sink.sets).toEqual([])
  })
})
