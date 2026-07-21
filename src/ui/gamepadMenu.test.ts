// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  emptyNavMemory,
  installGamepadMenuNav,
  MENU_STICK_DEADZONE,
  readMenuPad,
  stepMenuNav,
  type PadLike,
} from './gamepadMenu'

/** Build a PadLike with the given pressed button indices and axis values. */
const pad = (down: number[], axes: number[] = []): PadLike => ({
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })),
  axes,
})

describe('readMenuPad', () => {
  it('is inert for a null pad or a pad at rest', () => {
    expect(readMenuPad(null)).toEqual({ prev: false, next: false, confirm: false })
    expect(readMenuPad(pad([], [0, 0, 0, 0]))).toEqual({ prev: false, next: false, confirm: false })
  })

  it('maps d-pad up/left to prev and down/right to next', () => {
    expect(readMenuPad(pad([12])).prev).toBe(true) // up
    expect(readMenuPad(pad([14])).prev).toBe(true) // left
    expect(readMenuPad(pad([13])).next).toBe(true) // down
    expect(readMenuPad(pad([15])).next).toBe(true) // right
  })

  it('maps the left stick past the deadzone', () => {
    const dz = MENU_STICK_DEADZONE
    expect(readMenuPad(pad([], [0, -dz])).prev).toBe(true) // stick up
    expect(readMenuPad(pad([], [0, dz])).next).toBe(true) // stick down
    expect(readMenuPad(pad([], [-dz, 0])).prev).toBe(true) // stick left
    expect(readMenuPad(pad([], [dz, 0])).next).toBe(true) // stick right
  })

  it('ignores sub-deadzone drift (a resting stick never navigates)', () => {
    const r = readMenuPad(pad([], [0.2, -0.3]))
    expect(r.prev).toBe(false)
    expect(r.next).toBe(false)
  })

  it('does NOT read the high hat axis some pads park at -1 while idle', () => {
    // 8BitDo Lite 2: axis 9 rests at -1. We only read axes 0/1, so this is inert.
    const r = readMenuPad(pad([], [0, 0, 0, 0, 0, 0, 0, 0, 0, -1]))
    expect(r).toEqual({ prev: false, next: false, confirm: false })
  })

  it('treats any face button or Start as confirm', () => {
    for (const i of [0, 1, 2, 3, 9]) expect(readMenuPad(pad([i])).confirm).toBe(true)
  })
})

describe('stepMenuNav', () => {
  const mem = emptyNavMemory()

  it('moves next/prev cyclically on a fresh press', () => {
    expect(stepMenuNav({ prev: false, next: true, confirm: false }, mem, 0, 3).index).toBe(1)
    expect(stepMenuNav({ prev: false, next: true, confirm: false }, mem, 2, 3).index).toBe(0) // wrap
    expect(stepMenuNav({ prev: true, next: false, confirm: false }, mem, 0, 3).index).toBe(2) // wrap back
  })

  it('edge-detects: a HELD direction acts once, not every frame', () => {
    let m = emptyNavMemory()
    let idx = 0
    // Frame 1: press down → move.
    let s = stepMenuNav({ prev: false, next: true, confirm: false }, m, idx, 3)
    m = s.mem
    idx = s.index
    expect(idx).toBe(1)
    // Frame 2: still held → no further move.
    s = stepMenuNav({ prev: false, next: true, confirm: false }, m, idx, 3)
    m = s.mem
    idx = s.index
    expect(idx).toBe(1)
    // Frame 3: released then pressed again → moves.
    s = stepMenuNav({ prev: false, next: false, confirm: false }, m, idx, 3)
    m = s.mem
    idx = s.index
    s = stepMenuNav({ prev: false, next: true, confirm: false }, m, idx, 3)
    expect(s.index).toBe(2)
  })

  it('activates once on the confirm edge only', () => {
    let m = emptyNavMemory()
    let s = stepMenuNav({ prev: false, next: false, confirm: true }, m, 0, 2)
    expect(s.activate).toBe(true)
    m = s.mem
    s = stepMenuNav({ prev: false, next: false, confirm: true }, m, 0, 2) // held
    expect(s.activate).toBe(false)
  })

  it('is a no-op with zero items', () => {
    const s = stepMenuNav({ prev: true, next: true, confirm: true }, mem, 0, 0)
    expect(s).toMatchObject({ index: 0, activate: false })
  })
})

describe('installGamepadMenuNav (DOM driver)', () => {
  // A hand-cranked scheduler so we can step frames deterministically.
  const makeClock = (): { schedule: (cb: () => void) => number; cancel: (h: number) => void; tick: () => void } => {
    let pending: (() => void) | null = null
    return {
      schedule: (cb) => {
        pending = cb
        return 1
      },
      cancel: () => {
        pending = null
      },
      tick: () => {
        const cb = pending
        pending = null
        cb?.()
      },
    }
  }

  const setup = (): { a: HTMLButtonElement; b: HTMLButtonElement } => {
    document.body.innerHTML = ''
    const a = document.createElement('button')
    const b = document.createElement('button')
    // offsetParent is null in jsdom by default; force it truthy so liveButtons keeps them.
    Object.defineProperty(a, 'offsetParent', { value: document.body, configurable: true })
    Object.defineProperty(b, 'offsetParent', { value: document.body, configurable: true })
    document.body.append(a, b)
    return { a, b }
  }

  it('clicks the focused button when confirm is pressed', () => {
    const { a, b } = setup()
    let aClicks = 0
    let bClicks = 0
    a.addEventListener('click', () => aClicks++)
    b.addEventListener('click', () => bClicks++)

    const clock = makeClock()
    const pads: (PadLike | null)[] = [null]
    const orig = navigator.getGamepads
    ;(navigator as unknown as { getGamepads: () => (PadLike | null)[] }).getGamepads = () => pads

    const teardown = installGamepadMenuNav(() => [a, b], { schedule: clock.schedule, cancel: clock.cancel })
    try {
      pads[0] = pad([13]) // down → focus b
      clock.tick()
      pads[0] = pad([]) // release
      clock.tick()
      pads[0] = pad([0]) // A → confirm focused (b)
      clock.tick()
      expect(bClicks).toBe(1)
      expect(aClicks).toBe(0)
    } finally {
      teardown()
      ;(navigator as unknown as { getGamepads?: typeof orig }).getGamepads = orig
    }
  })
})
