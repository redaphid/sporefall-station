// @vitest-environment happy-dom
// The start menu's Test scenarios page: the button opens a list of every
// playable scenario (picture, title, subtitle, what it tests, what to look for),
// Play goes to `./?play=<id>`, and Back returns to the menu with the mode
// promise still unresolved. `#test-scenarios` opens the page straight away.

import { describe, expect, it } from 'vitest'
import { PLAYABLES } from '../playable/registry'
import { playHref, SECTIONS, shotPath } from '../playable/types'
import { pickMode } from './menu'
import { openTestScenarios } from './testScenarios'

const mount = (): HTMLElement => {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}
const page = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-role="test-scenarios"]')

describe('the Test scenarios button on the start menu', () => {
  it('is there for everyone (no ?debug) and opens the list over the menu without resolving a mode', async () => {
    const root = mount()
    let resolved: string | undefined
    void pickMode(root).then((m) => (resolved = m))
    const btn = root.querySelector<HTMLButtonElement>('[data-role="menu-test-scenarios"]')!
    expect(btn.textContent).toContain('Test scenarios')
    expect(page(root)).toBeNull()
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(page(root)).not.toBeNull()
    expect(resolved).toBeUndefined()
    expect(root.querySelector('[data-role="start-menu"]')).not.toBeNull()
  })

  it('Back closes the list and leaves the menu up; the button opens it again', () => {
    const root = mount()
    void pickMode(root)
    const btn = root.querySelector<HTMLButtonElement>('[data-role="menu-test-scenarios"]')!
    btn.click()
    root.querySelector<HTMLButtonElement>('[data-role="test-scenarios-back"]')!.click()
    expect(page(root)).toBeNull()
    expect(root.querySelector('[data-role="start-menu"]')).not.toBeNull()
    btn.click()
    btn.click() // a double tap opens one page, not two
    expect(root.querySelectorAll('[data-role="test-scenarios"]')).toHaveLength(1)
  })

  it('opens the list at once when asked (Main menu from inside a scenario)', () => {
    const root = mount()
    void pickMode(root, undefined, undefined, { openScenarios: true })
    expect(page(root)).not.toBeNull()
  })
})

describe('the Test scenarios list', () => {
  it('shows a card per scenario with its picture, title, subtitle, what it tests and what to look for', () => {
    const root = mount()
    const view = openTestScenarios(root, { go: () => {} })
    const cards = root.querySelectorAll<HTMLElement>('[data-playable]:not(button)')
    expect(cards).toHaveLength(PLAYABLES.length)
    for (const p of PLAYABLES) {
      const card = root.querySelector<HTMLElement>(`li[data-playable="${p.id}"]`)!
      expect(card.querySelector('img')!.getAttribute('src')).toBe(shotPath(p.id))
      const text = card.textContent ?? ''
      for (const s of [p.title, p.subtitle, p.tests, p.lookFor]) expect(text).toContain(s)
    }
    expect(view.plays).toHaveLength(PLAYABLES.length)
  })

  it('groups the cards under section headings, New today first', () => {
    const root = mount()
    openTestScenarios(root, { go: () => {} })
    const headings = Array.from(root.querySelectorAll('h2')).map((h) => h.textContent ?? '')
    expect(headings[0]).toContain(SECTIONS.new)
    const used = new Set(PLAYABLES.map((p) => p.section))
    expect(headings).toHaveLength(used.size)
  })

  it('Play launches that scenario at ./?play=<id>', () => {
    const root = mount()
    const went: string[] = []
    const view = openTestScenarios(root, { go: (href) => went.push(href) })
    view.plays[0].click()
    view.plays[view.plays.length - 1].click()
    expect(went).toEqual([playHref(PLAYABLES[0].id), playHref(PLAYABLES[PLAYABLES.length - 1].id)])
  })

  it('renders an empty registry as an empty page with only Back (no crash)', () => {
    const root = mount()
    const view = openTestScenarios(root, { go: () => {}, entries: [] })
    expect(view.plays).toHaveLength(0)
    expect(root.querySelector('[data-role="test-scenarios-back"]')).not.toBeNull()
    view.close()
    view.close() // idempotent
    expect(page(root)).toBeNull()
  })
})
