// @vitest-environment happy-dom
// The pause menu driven by a controller alone, through the real input path: a
// scripted standard pad feeds both the session's co-op reader (Start pauses)
// and the menu navigator, and every assertion reads the session or the DOM.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import { emptyInput } from '../game/types'
import { arm } from '../game/testkit'
import { createGamepadCoop } from '../input/gamepadCoop'
import { createModSwapQueue } from '../input/modSwapQueue'
import { FOCUS_SHADOW } from './gamepadMenu'
import { createPauseOverlay } from './pauseOverlay'

const A = 0
const B = 1
const X = 2
const START = 9
const UP = 12
const DOWN = 13
const LEFT = 14
const RIGHT = 15

const padOf = (held: readonly number[]): Gamepad =>
  ({
    index: 0,
    id: 'Scripted pad (STANDARD GAMEPAD)',
    mapping: 'standard',
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i), touched: held.includes(i), value: held.includes(i) ? 1 : 0 })),
  }) as unknown as Gamepad

let pads: (Gamepad | null)[] = [null]
let rafs: FrameRequestCallback[] = []
const saved = {
  getGamepads: navigator.getGamepads,
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
  offsetParent: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent'),
}

beforeEach(() => {
  pads = [null]
  rafs = []
  document.body.innerHTML = ''
  ;(navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => pads
  globalThis.requestAnimationFrame = (cb) => rafs.push(cb)
  globalThis.cancelAnimationFrame = () => {}
  // happy-dom lays nothing out: a control is on screen when no ancestor is display:none.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[style*="display: none"], [style*="display:none"]') ? null : this.parentElement
    },
  })
})
afterEach(() => {
  ;(navigator as unknown as { getGamepads: typeof saved.getGamepads }).getGamepads = saved.getGamepads
  globalThis.requestAnimationFrame = saved.raf
  globalThis.cancelAnimationFrame = saved.caf
  if (saved.offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', saved.offsetParent)
})

/** A solo run wired the way main.ts wires it, with a pistol carrying three mods. */
const rig = () => {
  const session = new HostSession(18, { sample: () => emptyInput() }, createGamepadCoop(() => pads))
  arm(session.self, 'pistol').mods = [
    { id: 'frost', stacks: 1 },
    { id: 'heavy', stacks: 1 },
    { id: 'shock', stacks: 1 },
  ]
  const swaps = createModSwapQueue()
  const calls: string[] = []
  const overlay = createPauseOverlay(document.body, {
    onResume: () => {
      calls.push('resume')
      session.isPaused = false
    },
    onNewSeed: () => {
      calls.push('newSeed')
      session.restart(session.currentSeed + 1)
    },
    onRestart: () => {
      calls.push('restart')
      session.restart()
    },
    onRefresh: () => calls.push('refresh'),
    onShare: () => {
      calls.push('share')
      return new Promise(() => {})
    },
    modSwaps: swaps,
  })
  /** One app frame: the pad state, a sim tick, the overlay repaint, then the menu poll. */
  const frame = (held: readonly number[] | null): void => {
    pads[0] = held === null ? null : padOf(held)
    session.tick()
    overlay.update(session.isPaused ?? false, session.renderView())
    const due = rafs
    rafs = []
    for (const cb of due) cb(0)
  }
  /** Press and release, one frame each. */
  const press = (...buttons: number[]): void => {
    frame(buttons)
    frame([])
  }
  const focused = (): string => (document.activeElement as HTMLElement | null)?.textContent ?? ''
  const rings = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('button')].filter((b) => b.style.boxShadow === FOCUS_SHADOW)
  const newSeedBtn = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-role="pause-new-seed"]')!
  frame([])
  press(A) // the first press joins the pad to the local player's slot
  return { session, swaps, calls, frame, press, focused, rings, newSeedBtn, open: () => press(START) }
}

describe('pause menu with only a controller', () => {
  it('Start opens it with the cursor on Resume, and exactly one cursor on screen', () => {
    const r = rig()
    r.open()
    expect(r.session.isPaused).toBe(true)
    expect(r.focused()).toBe('Resume')
    expect(r.rings().map((b) => b.textContent)).toEqual(['Resume'])
  })

  it('Right walks every action in order and wraps; Left wraps back', () => {
    const r = rig()
    r.open()
    const seen = [r.focused()]
    for (let i = 0; i < 5; i++) {
      r.press(RIGHT)
      seen.push(r.focused())
    }
    expect(seen).toEqual(['Resume', '🎲 New Seed', 'Run it back', '⟳ Refresh', '🔗 Share state', 'Resume'])
    r.press(LEFT)
    expect(r.focused()).toBe('🔗 Share state')
    expect(r.calls).toEqual([])
  })

  it('Up reaches the wand strip and Down returns to the actions; both wrap', () => {
    const r = rig()
    r.open()
    r.press(UP)
    expect(document.activeElement?.closest('[data-role="mod-sequence"]')).not.toBeNull()
    r.press(DOWN)
    expect(r.focused()).toBe('Resume')
    r.press(DOWN) // two rows: down from the bottom wraps to the strip
    expect(document.activeElement?.closest('[data-role="mod-sequence"]')).not.toBeNull()
  })

  it('A on two chips swaps them, and the actions row is untouched', () => {
    const r = rig()
    r.open()
    r.press(UP) // chip 0
    r.press(A)
    r.press(RIGHT)
    r.press(RIGHT)
    r.press(A) // chip 2: swap
    expect(r.swaps.pending()).toEqual([{ a: 0, b: 2 }])
    expect(r.calls).toEqual([])
    expect(r.session.isPaused).toBe(true)
  })

  it('A on Resume resumes, and the sim runs again', () => {
    const r = rig()
    r.open()
    const tick = r.session.world.tick
    r.press(A)
    expect(r.calls).toEqual(['resume'])
    r.frame([])
    expect(r.session.world.tick).toBeGreaterThan(tick)
  })

  it('B resumes from anywhere on the menu, the strip included', () => {
    const r = rig()
    r.open()
    r.press(UP)
    r.press(B)
    expect(r.calls).toEqual(['resume'])
    expect(r.session.isPaused).toBe(false)
  })

  it('X, Y and Start never press the focused action', () => {
    const r = rig()
    r.open()
    r.press(RIGHT) // New Seed
    r.press(X)
    r.press(3)
    expect(r.calls).toEqual([])
    r.press(START) // Start closes the menu: the session toggles pause, nothing is pressed
    expect(r.session.isPaused).toBe(false)
    expect(r.calls).toEqual([])
  })
})

describe('New Seed takes a second press', () => {
  it('the first A arms it and changes nothing; the second A rolls a new seed', () => {
    const r = rig()
    r.open()
    const seed = r.session.currentSeed
    r.press(RIGHT)
    r.press(A)
    expect(r.calls).toEqual([])
    expect(r.session.currentSeed).toBe(seed)
    expect(r.newSeedBtn().textContent).toBe('🎲 Wipe this run? Press again')
    r.press(A)
    expect(r.calls).toEqual(['newSeed'])
    expect(r.session.currentSeed).toBe(seed + 1)
  })

  it('holding A on New Seed arms it once and never fires', () => {
    const r = rig()
    r.open()
    r.press(RIGHT)
    for (let i = 0; i < 30; i++) r.frame([A])
    expect(r.calls).toEqual([])
    expect(r.newSeedBtn().dataset.armed).toBe('')
  })

  it('walking off an armed New Seed disarms it', () => {
    const r = rig()
    r.open()
    r.press(RIGHT)
    r.press(A) // armed
    r.press(RIGHT)
    r.press(LEFT)
    expect(r.newSeedBtn().textContent).toBe('🎲 New Seed')
    r.press(A) // arms again, does not fire
    expect(r.calls).toEqual([])
  })

  it('closing the menu disarms it', () => {
    const r = rig()
    r.open()
    r.press(RIGHT)
    r.press(A) // armed
    r.press(B) // resume
    r.open()
    r.press(RIGHT)
    expect(r.newSeedBtn().textContent).toBe('🎲 New Seed')
    r.press(A)
    expect(r.calls).toEqual(['resume'])
  })

  it('a mouse needs two clicks too, and the pad cursor does not steal focus between them', () => {
    const r = rig()
    r.open()
    const ns = r.newSeedBtn()
    ns.focus()
    ns.click()
    r.frame([])
    r.frame([])
    expect(document.activeElement).toBe(ns)
    expect(r.rings()).toEqual([ns])
    ns.click()
    expect(r.calls).toEqual(['newSeed'])
  })
})

describe('adversarial', () => {
  it('A or B held while Start opens the menu does nothing until released and pressed again', () => {
    const r = rig()
    r.frame([START, A, B])
    expect(r.session.isPaused).toBe(true)
    for (let i = 0; i < 10; i++) r.frame([A, B])
    expect(r.calls).toEqual([])
    r.frame([])
    r.press(B)
    expect(r.calls).toEqual(['resume'])
  })

  it('a pad that drops out mid-menu with A held cannot press on reconnect; a fresh press can', () => {
    const r = rig()
    r.open()
    r.press(RIGHT)
    r.frame([A]) // arms New Seed, and A stays down
    for (let i = 0; i < 5; i++) r.frame(null) // disconnected
    r.frame([A]) // back, A still down
    r.frame([A])
    expect(r.calls).toEqual([])
    expect(r.newSeedBtn().dataset.armed).toBe('')
    r.frame([])
    r.press(A)
    expect(r.calls).toEqual(['newSeed'])
  })

  it('a disconnect leaves the menu open and the cursor where it was', () => {
    const r = rig()
    r.open()
    r.press(RIGHT)
    r.press(RIGHT)
    for (let i = 0; i < 5; i++) r.frame(null)
    expect(r.session.isPaused).toBe(true)
    expect(r.focused()).toBe('Run it back')
    expect(r.rings()).toHaveLength(1)
  })

  it('opening and closing twenty times never presses anything and always lands on Resume', () => {
    const r = rig()
    for (let i = 0; i < 20; i++) {
      r.open()
      expect(r.session.isPaused).toBe(true)
      expect(r.focused()).toBe('Resume')
      expect(r.rings()).toHaveLength(1)
      r.press(RIGHT, UP) // wander before closing
      r.press(START)
      expect(r.session.isPaused).toBe(false)
      expect(r.rings()).toHaveLength(0)
    }
    expect(r.calls).toEqual([])
  })

  it('B does nothing once Refresh has taken the run away', () => {
    const r = rig()
    r.open()
    for (let i = 0; i < 3; i++) r.press(RIGHT)
    r.press(A) // Refresh disables every action
    r.press(B)
    expect(r.calls).toEqual(['refresh'])
    expect(r.session.isPaused).toBe(true)
  })
})
