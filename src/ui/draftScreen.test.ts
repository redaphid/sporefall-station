// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createDraftScreen } from './draftScreen'

const OFFER = ['pierce', 'frost', 'overload']

const mount = () => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const picked: number[] = []
  const screen = createDraftScreen(el, (i) => picked.push(i))
  const cards = () => [...el.querySelectorAll<HTMLButtonElement>('.draft-card')]
  return { el, screen, picked, cards }
}

describe('draft screen', () => {
  it('stays hidden with no hand or no local seat', () => {
    const { screen, cards } = mount()
    screen.update(null, [{ playerId: 0, cursor: 0 }], 20)
    screen.update(OFFER, [], 20)
    screen.update([], [{ playerId: 0, cursor: 0 }], 20)
    expect(screen.visible).toBe(false)
    expect(cards()).toHaveLength(0)
  })

  it('draws one card per offered mod and marks each seat on its cursor card', () => {
    const { screen, cards } = mount()
    screen.update(OFFER, [{ playerId: 0, cursor: 1 }, { playerId: 1, cursor: 1 }, { playerId: 2, cursor: 2 }], 12)
    expect(screen.visible).toBe(true)
    expect(cards().map((c) => c.dataset.modId)).toEqual(OFFER)
    expect(cards().map((c) => [...c.querySelectorAll('span')].map((s) => s.textContent))).toEqual([[], ['P1', 'P2'], ['P3']])
    expect(cards()[0].style.outline).toMatch(/^none/)
    expect(cards()[1].style.outline).toContain('solid')
  })

  it('moves the marks without rebuilding the cards, and hides on null', () => {
    const { screen, cards } = mount()
    screen.update(OFFER, [{ playerId: 0, cursor: 0 }], 12)
    const first = cards()[0]
    screen.update(OFFER, [{ playerId: 0, cursor: 2 }], 11)
    expect(cards()[0]).toBe(first)
    expect(cards()[2].textContent).toContain('P1')
    screen.update(null, [], 0)
    expect(screen.visible).toBe(false)
    expect(cards()).toHaveLength(0)
  })

  it('a tap reports the card index and leaves the loadout to the sim', () => {
    const { screen, cards, picked } = mount()
    screen.update(OFFER, [{ playerId: 0, cursor: 0 }], 12)
    cards()[2].click()
    expect(picked).toEqual([2])
    expect(screen.visible).toBe(true) // it closes when the sim closes the hand
  })

  it('drops unknown mod ids rather than drawing a blank card', () => {
    const { screen, cards } = mount()
    screen.update(['frost', 'no-such-mod'], [{ playerId: 0, cursor: 0 }], 12)
    expect(cards().map((c) => c.dataset.modId)).toEqual(['frost'])
  })
})
