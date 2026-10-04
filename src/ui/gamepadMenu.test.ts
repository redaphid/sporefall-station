// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  emptyNavMemory,
  installGamepadMenuNav,
  MENU_STICK_DEADZONE,
  readMenuPad,
  stepMenuNav,
  type NavFocus,
  type PadLike,
  type PadReading,
} from './gamepadMenu'

/** Build a PadLike with the given pressed button indices and axis values. */
const pad = (down: number[], axes: number[] = []): PadLike => ({
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })),
  axes,
})

const idle = emptyNavMemory()
const r = (over: Partial<PadReading>): PadReading => ({ ...idle, ...over })

describe('readMenuPad', () => {
  it('is inert for a null pad or a pad at rest', () => {
    expect(readMenuPad(null)).toEqual(idle)
    expect(readMenuPad(pad([], [0, 0, 0, 0]))).toEqual(idle)
  })

  it('maps the d-pad to the four directions', () => {
    expect(readMenuPad(pad([12]))).toEqual(r({ up: true }))
    expect(readMenuPad(pad([13]))).toEqual(r({ down: true }))
    expect(readMenuPad(pad([14]))).toEqual(r({ left: true }))
    expect(readMenuPad(pad([15]))).toEqual(r({ right: true }))
  })

  it('maps the left stick past the deadzone', () => {
    const dz = MENU_STICK_DEADZONE
    expect(readMenuPad(pad([], [0, -dz]))).toEqual(r({ up: true }))
    expect(readMenuPad(pad([], [0, dz]))).toEqual(r({ down: true }))
    expect(readMenuPad(pad([], [-dz, 0]))).toEqual(r({ left: true }))
    expect(readMenuPad(pad([], [dz, 0]))).toEqual(r({ right: true }))
  })

  it('ignores sub-deadzone drift (a resting stick never navigates)', () => {
    expect(readMenuPad(pad([], [0.2, -0.3]))).toEqual(idle)
  })

  it('does NOT read the high hat axis some pads park at -1 while idle', () => {
    // 8BitDo Lite 2 parks its d-pad hat on axis 9 at -1 when idle.
    expect(readMenuPad(pad([], [0, 0, 0, 0, 0, 0, 0, 0, 0, -1]))).toEqual(idle)
  })

  it('treats any face button or Start as confirm by default, and nothing as back', () => {
    for (const i of [0, 1, 2, 3, 9]) expect(readMenuPad(pad([i]))).toEqual(r({ confirm: true }))
  })

  it('honours caller-chosen confirm and back buttons', () => {
    expect(readMenuPad(pad([0]), [0], [1])).toEqual(r({ confirm: true }))
    expect(readMenuPad(pad([1]), [0], [1])).toEqual(r({ back: true }))
    expect(readMenuPad(pad([9]), [0], [1])).toEqual(idle)
  })
})

describe('stepMenuNav', () => {
  const at = (row: number, col: number): NavFocus => ({ row, col })

  it('one row: Up/Left step back and Down/Right step forward, wrapping', () => {
    expect(stepMenuNav(r({ right: true }), idle, at(0, 0), [3]).focus).toEqual(at(0, 1))
    expect(stepMenuNav(r({ down: true }), idle, at(0, 2), [3]).focus).toEqual(at(0, 0))
    expect(stepMenuNav(r({ left: true }), idle, at(0, 0), [3]).focus).toEqual(at(0, 2))
    expect(stepMenuNav(r({ up: true }), idle, at(0, 1), [3]).focus).toEqual(at(0, 0))
  })

  it('several rows: Up/Down change row and wrap, keeping the column where it fits', () => {
    expect(stepMenuNav(r({ up: true }), idle, at(1, 1), [4, 5]).focus).toEqual(at(0, 1))
    expect(stepMenuNav(r({ up: true }), idle, at(1, 4), [2, 5]).focus).toEqual(at(0, 1))
    expect(stepMenuNav(r({ down: true }), idle, at(1, 0), [4, 5]).focus).toEqual(at(0, 0))
    expect(stepMenuNav(r({ right: true }), idle, at(1, 4), [4, 5]).focus).toEqual(at(1, 0))
  })

  it('several rows: an empty row is skipped and never focused', () => {
    expect(stepMenuNav(r({ up: true }), idle, at(2, 0), [3, 0, 2]).focus).toEqual(at(0, 0))
    expect(stepMenuNav(idle, idle, at(1, 0), [3, 0, 2]).focus).toEqual(at(0, 0))
    // with one live row left, Up walks that row instead
    expect(stepMenuNav(r({ up: true }), idle, at(1, 0), [0, 3]).focus).toEqual(at(1, 2))
  })

  it('edge-detects: a HELD direction acts once, not every frame', () => {
    let s = stepMenuNav(r({ right: true }), idle, at(0, 0), [3])
    expect(s.focus).toEqual(at(0, 1))
    s = stepMenuNav(r({ right: true }), s.mem, s.focus, [3])
    expect(s.focus).toEqual(at(0, 1))
    s = stepMenuNav(idle, s.mem, s.focus, [3])
    s = stepMenuNav(r({ right: true }), s.mem, s.focus, [3])
    expect(s.focus).toEqual(at(0, 2))
  })

  it('activates and backs once on the press edge only', () => {
    let s = stepMenuNav(r({ confirm: true, back: true }), idle, at(0, 0), [2])
    expect(s).toMatchObject({ activate: true, back: true })
    s = stepMenuNav(r({ confirm: true, back: true }), s.mem, s.focus, [2])
    expect(s).toMatchObject({ activate: false, back: false })
  })

  it('never activates with zero items, but back still works', () => {
    const s = stepMenuNav(r({ up: true, right: true, confirm: true, back: true }), idle, at(0, 0), [0])
    expect(s).toMatchObject({ focus: at(0, 0), activate: false, back: true })
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

  it('suppress makes the nav inert, and a press consumed while suppressed can NEVER edge-fire on resume', () => {
    const { a, b } = setup()
    let aClicks = 0
    a.addEventListener('click', () => aClicks++)
    let bClicks = 0
    b.addEventListener('click', () => bClicks++)

    const clock = makeClock()
    const pads: (PadLike | null)[] = [null]
    const orig = navigator.getGamepads
    ;(navigator as unknown as { getGamepads: () => (PadLike | null)[] }).getGamepads = () => pads

    let suppressed = true
    const teardown = installGamepadMenuNav(() => [a, b], {
      schedule: clock.schedule,
      cancel: clock.cancel,
      suppress: () => suppressed,
    })
    try {
      pads[0] = pad([0]) // A pressed — but this press belongs to someone else
      clock.tick()
      expect(aClicks).toBe(0)
      expect(a.style.boxShadow).toBe('') // no focus paint while suppressed
      // Suppression lifts WHILE the button is still held (the adversarial case:
      // e.g. the press that closed the other overlay is not yet released).
      suppressed = false
      clock.tick() // resync frame: baseline, paint, no action
      expect(aClicks).toBe(0)
      expect(a.style.boxShadow).not.toBe('') // cursor appears at once
      clock.tick() // still held → still no edge
      expect(aClicks).toBe(0)
      pads[0] = pad([]) // release…
      clock.tick()
      pads[0] = pad([0]) // …then a FRESH press
      clock.tick()
      expect(aClicks).toBe(1)
      expect(bClicks).toBe(0)
    } finally {
      teardown()
      ;(navigator as unknown as { getGamepads?: typeof orig }).getGamepads = orig
    }
  })

  it('clears the focus paint when suppression begins mid-flight', () => {
    const { a } = setup()
    const clock = makeClock()
    const pads: (PadLike | null)[] = [null]
    const orig = navigator.getGamepads
    ;(navigator as unknown as { getGamepads: () => (PadLike | null)[] }).getGamepads = () => pads

    let suppressed = false
    const teardown = installGamepadMenuNav(() => [a], {
      schedule: clock.schedule,
      cancel: clock.cancel,
      suppress: () => suppressed,
    })
    try {
      clock.tick()
      expect(a.style.boxShadow).not.toBe('')
      suppressed = true
      clock.tick()
      expect(a.style.boxShadow).toBe('')
    } finally {
      teardown()
      ;(navigator as unknown as { getGamepads?: typeof orig }).getGamepads = orig
    }
  })

  it('a custom activate receives the focused control instead of .click()', () => {
    const { a, b } = setup()
    let clicks = 0
    b.addEventListener('click', () => clicks++)
    const clock = makeClock()
    const pads: (PadLike | null)[] = [null]
    const orig = navigator.getGamepads
    ;(navigator as unknown as { getGamepads: () => (PadLike | null)[] }).getGamepads = () => pads

    const activated: HTMLElement[] = []
    const teardown = installGamepadMenuNav(() => [a, b], {
      schedule: clock.schedule,
      cancel: clock.cancel,
      activate: (el) => activated.push(el),
    })
    try {
      pads[0] = pad([13]) // down → focus b
      clock.tick()
      pads[0] = pad([])
      clock.tick()
      pads[0] = pad([0]) // confirm
      clock.tick()
      expect(activated).toEqual([b])
      expect(clicks).toBe(0) // the default .click() was replaced, not doubled
    } finally {
      teardown()
      ;(navigator as unknown as { getGamepads?: typeof orig }).getGamepads = orig
    }
  })

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
