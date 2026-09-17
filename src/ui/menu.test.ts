// @vitest-environment happy-dom
// The start-menu Settings entry: opens the settings panel OVER the menu
// without resolving the mode promise, and hands the panel the pad (the menu's
// own navigator suppression is exercised in gamepadMenu.test.ts).

import { describe, expect, it, vi } from 'vitest'
import { pickMode, type SettingsControl } from './menu'

const mount = (): HTMLElement => {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const fakeSettings = (): SettingsControl & { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } => {
  let open = false
  const s = {
    open: vi.fn(() => {
      open = true
    }),
    close: vi.fn(() => {
      open = false
    }),
    isOpen: () => open,
  }
  return s
}

const menuButtons = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button'))

describe('pickMode — the Settings entry', () => {
  it('without a settings control there are exactly the three mode buttons (no dead entry)', () => {
    const root = mount()
    void pickMode(root)
    expect(menuButtons(root)).toHaveLength(3)
    expect(root.querySelector('[data-role="menu-settings"]')).toBeNull()
  })

  it('with a settings control a fourth Settings entry appears', () => {
    const root = mount()
    void pickMode(root, undefined, fakeSettings())
    const btns = menuButtons(root)
    expect(btns).toHaveLength(4)
    expect(root.querySelector('[data-role="menu-settings"]')?.textContent).toContain('Settings')
  })

  it('clicking Settings opens the panel and does NOT resolve the mode or remove the menu', async () => {
    const root = mount()
    const settings = fakeSettings()
    let resolved: string | null = null
    void pickMode(root, undefined, settings).then((m) => (resolved = m))
    root.querySelector<HTMLButtonElement>('[data-role="menu-settings"]')!.click()
    await flush()
    expect(settings.open).toHaveBeenCalledTimes(1)
    expect(resolved).toBeNull()
    expect(root.querySelector('[data-role="menu-settings"]')).not.toBeNull() // menu still up
  })

  it('picking a mode resolves, removes the menu, and CLOSES a still-open settings panel', async () => {
    const root = mount()
    const settings = fakeSettings()
    const onPick = vi.fn()
    let resolved: string | null = null
    void pickMode(root, onPick, settings).then((m) => (resolved = m))
    root.querySelector<HTMLButtonElement>('[data-role="menu-settings"]')!.click()
    expect(settings.isOpen()).toBe(true)
    menuButtons(root)[0]!.click() // Solo run
    await flush()
    expect(resolved).toBe('solo')
    expect(onPick).toHaveBeenCalledWith('solo')
    expect(settings.close).toHaveBeenCalled()
    expect(root.querySelector('button')).toBeNull() // overlay gone
  })
})
