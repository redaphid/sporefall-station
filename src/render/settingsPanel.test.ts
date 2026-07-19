// @vitest-environment happy-dom
// The settings gear/panel — the "can't tap the gear" regression class.
// The gear is interactive UI CHROME: it (and its panel) must carry
// data-ui-chrome so the touch layer's press classification never eats its taps
// (chrome.ts), and its click toggle must actually open/close the panel with
// the theme picker reachable inside.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultButtonMap,
  isPadCaptureActive,
  PAD_ACTIONS,
  resetButtonMapCacheForTest,
  setPadCapture,
} from '../input/remap'
import { createSettingsPanel } from './settingsPanel'

const mount = (): HTMLElement => {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const gearOf = (root: HTMLElement): HTMLButtonElement => root.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
const panelOf = (root: HTMLElement): HTMLElement => gearOf(root).nextElementSibling as HTMLElement

const THEMES = [
  { id: 'city', name: 'City' },
  { id: 'swampspace', name: 'Sporefall Station' },
]

describe('settings gear — press-exempt chrome', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = mount()
  })

  it('gear AND panel are marked data-ui-chrome (the press classifier must never see their taps)', () => {
    createSettingsPanel(root, false, () => {}, THEMES)
    expect(gearOf(root).matches('[data-ui-chrome]')).toBe(true)
    expect(panelOf(root).matches('[data-ui-chrome]')).toBe(true)
  })

  it('every interactive element INSIDE the panel is inside chrome (closest() covers descendants)', () => {
    createSettingsPanel(root, false, () => {}, THEMES)
    for (const el of panelOf(root).querySelectorAll('select,input'))
      expect(el.closest('[data-ui-chrome]')).not.toBeNull()
  })

  it('clicking the gear toggles the panel open and closed', () => {
    createSettingsPanel(root, false, () => {}, THEMES)
    const gear = gearOf(root)
    const panel = panelOf(root)
    expect(panel.style.display).toBe('none')
    gear.click()
    expect(panel.style.display).toBe('block')
    gear.click()
    expect(panel.style.display).toBe('none')
  })

  it('the theme picker is present with >1 theme and reports a change', () => {
    const onChange = vi.fn()
    createSettingsPanel(root, false, onChange, THEMES)
    const th = panelOf(root).querySelector<HTMLSelectElement>('#th')!
    expect(th).toBeTruthy()
    th.value = 'swampspace'
    th.dispatchEvent(new Event('change'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'swampspace' }))
  })

  it('no theme picker with a single installed theme (nothing to pick)', () => {
    createSettingsPanel(root, false, () => {}, [{ id: 'city', name: 'City' }])
    expect(panelOf(root).querySelector('#th')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The Controller (button remap) section: rows, capture flow, swap, resets.
// Fake timers drive the 50ms capture poll; fake pads stand in for getGamepads.
// ---------------------------------------------------------------------------
// happy-dom's localStorage is method-less under current Node; give remap.ts a
// real (in-memory) Storage so persistence assertions actually persist.
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

describe('settings panel — controller remap section', () => {
  let root: HTMLElement
  let pads: (Gamepad | null)[]

  const fakePad = (over: { pressed?: number[]; values?: Record<number, number> } = {}) =>
    ({
      index: 0,
      id: 'Fake Pad',
      mapping: 'standard',
      connected: true,
      buttons: Array.from({ length: 18 }, (_, i) => {
        const v = over.values?.[i] ?? (over.pressed?.includes(i) ? 1 : 0)
        return { pressed: over.pressed?.includes(i) ?? false, touched: false, value: v }
      }),
      axes: [0, 0, 0, 0],
    }) as unknown as Gamepad

  const create = () => createSettingsPanel(root, false, () => {}, THEMES, () => pads)
  const bindBtn = (action: string) => panelOf(root).querySelector<HTMLButtonElement>(`[data-remap-action="${action}"]`)!
  const resetBtn = (action: string) => panelOf(root).querySelector<HTMLButtonElement>(`[data-remap-reset="${action}"]`)!
  const storedMap = () => JSON.parse(localStorage.getItem('sor.padmap') ?? 'null')?.map

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    resetButtonMapCacheForTest()
    setPadCapture(false)
    pads = []
    root = mount()
  })
  afterEach(() => {
    setPadCapture(false)
    vi.useRealTimers()
  })

  it('renders one row per remappable action, all inside chrome', () => {
    create()
    for (const a of PAD_ACTIONS) {
      expect(bindBtn(a)).toBeTruthy()
      expect(bindBtn(a).closest('[data-ui-chrome]')).not.toBeNull()
      expect(resetBtn(a)).toBeTruthy()
    }
  })

  it('shows the canonical names of the default bindings', () => {
    create()
    expect(bindBtn('attack').textContent).toBe('A · RB · L2 · R2')
    expect(bindBtn('interact').textContent).toBe('B')
    expect(bindBtn('pause').textContent).toBe('Start')
  })

  it('states the swap rule in the UI copy', () => {
    create()
    expect(panelOf(root).textContent).toContain('swaps')
  })

  it('tapping a row enters capture: prompt text + the gameplay-inertness flag', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    expect(bindBtn('attack').textContent).toBe('press a button…')
    expect(isPadCaptureActive()).toBe(true)
  })

  it('with NO pads exposed, capture explains the Chrome press-to-appear rule', () => {
    create()
    bindBtn('attack').click()
    expect(bindBtn('attack').textContent).toContain('no controller detected')
  })

  it('the next button press binds, persists, and ends capture', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    pads = [fakePad({ pressed: [1] })] // press B
    vi.advanceTimersByTime(60)
    expect(bindBtn('attack').textContent).toBe('B')
    expect(isPadCaptureActive()).toBe(false)
    expect(storedMap().attack).toEqual([1])
  })

  it('binding a taken button SWAPS: the other row updates too', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    pads = [fakePad({ pressed: [1] })]
    vi.advanceTimersByTime(60)
    expect(bindBtn('interact').textContent).toBe('A · RB · L2 · R2')
    expect(storedMap().interact).toEqual([0, 5, 6, 7])
  })

  it('an exotic index shows as Button N', () => {
    create()
    pads = [fakePad()]
    bindBtn('roll').click()
    pads = [fakePad({ pressed: [17] })]
    vi.advanceTimersByTime(60)
    expect(bindBtn('roll').textContent).toBe('Button 17')
  })

  it('a button already held when capture opens does not instantly bind', () => {
    create()
    pads = [fakePad({ pressed: [0] })]
    bindBtn('interact').click() // first poll baselines the held A
    vi.advanceTimersByTime(120)
    expect(isPadCaptureActive()).toBe(true) // still capturing
    pads = [fakePad()] // release…
    vi.advanceTimersByTime(60)
    pads = [fakePad({ pressed: [0] })] // …then press again
    vi.advanceTimersByTime(60)
    expect(bindBtn('interact').textContent).toBe('A')
  })

  it('axis wiggle alone never binds (buttons only)', () => {
    create()
    pads = [
      { ...fakePad(), axes: [1, -1, -1, -1] } as unknown as Gamepad,
    ]
    bindBtn('attack').click()
    vi.advanceTimersByTime(500)
    expect(isPadCaptureActive()).toBe(true)
    expect(bindBtn('attack').textContent).toBe('press a button…')
  })

  it('Escape cancels capture and restores the row label', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(isPadCaptureActive()).toBe(false)
    expect(bindBtn('attack').textContent).toBe('A · RB · L2 · R2')
  })

  it('a click anywhere else cancels capture (tap-away)', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    document.body.click()
    expect(isPadCaptureActive()).toBe(false)
  })

  it('the click that STARTS capture does not self-cancel through the document listener', () => {
    create()
    pads = [fakePad()]
    const btn = bindBtn('attack')
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) // bubbles to document
    expect(isPadCaptureActive()).toBe(true)
  })

  it('tapping the capturing row again cancels (toggle)', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    bindBtn('attack').click()
    expect(isPadCaptureActive()).toBe(false)
  })

  it('switching to another row moves the capture there', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    bindBtn('roll').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(isPadCaptureActive()).toBe(true)
    expect(bindBtn('attack').textContent).toBe('A · RB · L2 · R2')
    expect(bindBtn('roll').textContent).toBe('press a button…')
  })

  it('capture times out (~8s) and re-arms nothing', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    vi.advanceTimersByTime(8100)
    expect(isPadCaptureActive()).toBe(false)
    expect(bindBtn('attack').textContent).toBe('A · RB · L2 · R2')
    pads = [fakePad({ pressed: [1] })]
    vi.advanceTimersByTime(200)
    expect(bindBtn('attack').textContent).toBe('A · RB · L2 · R2') // dead machine binds nothing
  })

  it('closing the panel with the gear ends capture', () => {
    create()
    pads = [fakePad()]
    gearOf(root).click() // open
    bindBtn('attack').click()
    gearOf(root).click() // close
    expect(isPadCaptureActive()).toBe(false)
  })

  it('per-row reset restores that action, reclaiming its default buttons from the swap partner', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    pads = [fakePad({ pressed: [1] })] // swap: attack=B, interact=A·RB·L2·R2
    vi.advanceTimersByTime(60)
    resetBtn('attack').click()
    expect(bindBtn('attack').textContent).toBe('A · RB · L2 · R2')
    expect(bindBtn('interact').textContent).toBe('—') // its buttons were reclaimed; its own reset restores it
    resetBtn('interact').click()
    expect(bindBtn('interact').textContent).toBe('B')
  })

  it('an action stripped bare by a reclaim renders as unbound (—)', () => {
    create()
    pads = [fakePad()]
    bindBtn('interact').click()
    pads = [fakePad({ pressed: [5] })] // interact takes RB; attack swaps to B
    vi.advanceTimersByTime(60)
    expect(bindBtn('attack').textContent).toBe('B')
    resetBtn('attack').click() // attack reclaims A/RB/L2/R2 → interact left with nothing
    expect(bindBtn('interact').textContent).toBe('—')
  })

  it('Reset to defaults restores every row and the stored map', () => {
    create()
    pads = [fakePad()]
    bindBtn('attack').click()
    pads = [fakePad({ pressed: [1] })]
    vi.advanceTimersByTime(60)
    panelOf(root).querySelector<HTMLButtonElement>('#ctl-reset')!.click()
    expect(bindBtn('attack').textContent).toBe('A · RB · L2 · R2')
    expect(bindBtn('interact').textContent).toBe('B')
    expect(storedMap()).toEqual(defaultButtonMap())
  })

  it('a panel created after a previous session shows the PERSISTED bindings', () => {
    localStorage.setItem('sor.padmap', JSON.stringify({ v: 1, map: { ...defaultButtonMap(), attack: [1], interact: [0, 5, 6, 7] } }))
    resetButtonMapCacheForTest()
    create()
    expect(bindBtn('attack').textContent).toBe('B')
    expect(bindBtn('interact').textContent).toBe('A · RB · L2 · R2')
  })
})
