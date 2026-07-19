// @vitest-environment happy-dom
// The settings gear/panel — the "can't tap the gear" regression class.
// The gear is interactive UI CHROME: it (and its panel) must carry
// data-ui-chrome so the touch layer's press classification never eats its taps
// (chrome.ts), and its click toggle must actually open/close the panel with
// the theme picker reachable inside.

import { beforeEach, describe, expect, it, vi } from 'vitest'
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
