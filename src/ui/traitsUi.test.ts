// @vitest-environment happy-dom
// The YOU card on the draft screen and the traits on the pause panel. Both
// paint sim state, so these drive a real player through the real draft and
// read what the DOM shows.

import { describe, expect, it } from 'vitest'
import { TRAITS } from '../game/data/traits'
import type { Entity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { draftYou } from '../game/systems/draft'
import { applyTraitPick } from '../game/systems/traits'
import { createWorld } from '../game/world'
import { createDraftScreen } from './draftScreen'
import { buildLoadout } from './loadoutModel'
import { createLoadoutPanel } from './loadoutPanel'

const playerWith = (traits: string[]): Entity => {
  const w = createWorld(1, 1, 'normal', false)
  const p = spawnPlayer(w, 0, 3.5, 3.5)
  for (const t of traits) applyTraitPick(p, t)
  return p
}

const mount = () => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const picked: number[] = []
  const screen = createDraftScreen(el, (i) => picked.push(i))
  const cards = () => [...el.querySelectorAll<HTMLButtonElement>('.draft-card')]
  return { el, screen, picked, cards }
}

const HAND = { offer: ['pierce', 'frost'], trait: 'anchor' }
const SEAT = [{ playerId: 0, cursor: 0 }]

describe('draft screen — the YOU card', () => {
  it('draws two GUN cards and one YOU card, labelled and framed apart', () => {
    const { screen, cards } = mount()
    screen.update(HAND, SEAT, 10)
    expect(cards().map((c) => c.dataset.kind)).toEqual(['mod', 'mod', 'trait'])
    expect(cards().map((c) => c.querySelector('.draft-kind')!.textContent)).toEqual(['🔫 GUN', '🔫 GUN', '🙂 YOU'])
    const [gun, , you] = cards()
    expect(you.dataset.traitId).toBe('anchor')
    expect(you.textContent).toContain(TRAITS.anchor.blurb)
    expect(you.style.borderStyle).not.toBe(gun.style.borderStyle)
    expect(you.style.background).not.toBe(gun.style.background)
  })

  it('a tap on the YOU card sends its hand index, even when a gun card before it was dropped', () => {
    const { screen, cards, picked } = mount()
    screen.update({ offer: ['no-such-mod', 'frost'], trait: 'anchor' }, SEAT, 10)
    expect(cards().map((c) => c.dataset.index)).toEqual(['1', '2'])
    cards()[1].click()
    expect(picked).toEqual([2])
  })

  it('the cursor ring follows the hand index onto the YOU card', () => {
    const { screen, cards } = mount()
    screen.update(HAND, [{ playerId: 1, cursor: 2 }], 10)
    expect(cards()[2].style.outline).toContain('solid')
    expect(cards()[2].textContent).toContain('P2')
    expect(cards()[0].style.outline).toMatch(/^none/)
  })

  it('a trait you already hold reads as inert on its face', () => {
    const { screen, cards } = mount()
    screen.update(HAND, SEAT, 10, 'full', undefined, draftYou(playerWith(['anchor']), []))
    const you = cards()[2]
    expect(you.dataset.inert).toBe('1')
    expect(you.querySelector('.draft-verdict')!.textContent).toBe('YOU HAVE IT')
  })

  it('a co-op trait reads as inert alone and live with a teammate', () => {
    const solo = mount()
    const hand = { offer: ['pierce', 'frost'], trait: 'medicHands' }
    const me = playerWith([])
    solo.screen.update(hand, SEAT, 10, 'full', undefined, { party: 1 })
    expect(solo.cards()[2].querySelector('.draft-verdict')!.textContent).toBe('NEEDS A TEAMMATE')
    const duo = mount()
    duo.screen.update(hand, SEAT, 10, 'full', undefined, draftYou(me, [me, playerWith([])]))
    expect(duo.cards()[2].querySelector('.draft-verdict')).toBeNull()
  })

  it('redraws the YOU card when the verdict changes on the same hand', () => {
    const { screen, cards } = mount()
    screen.update(HAND, SEAT, 10, 'full', undefined, { party: 1 })
    expect(cards()[2].dataset.inert).toBeUndefined()
    screen.update(HAND, SEAT, 9, 'full', undefined, { traits: [{ id: 'anchor', stacks: 1 }], party: 1 })
    expect(cards()[2].dataset.inert).toBe('1')
  })

  it('a hand from an older host with no YOU card still draws its gun cards', () => {
    const { screen, cards } = mount()
    screen.update({ offer: ['pierce', 'frost'] }, SEAT, 10)
    expect(cards().map((c) => c.dataset.kind)).toEqual(['mod', 'mod'])
  })
})

describe('pause panel — your traits', () => {
  it('lists every trait in pick order with its stacks and its line', () => {
    const p = playerWith(['softSteps', 'fireproof', 'softSteps'])
    const model = buildLoadout(p, undefined, 1)!
    expect(model.traits.map((t) => [t.id, t.stacks])).toEqual([
      ['softSteps', 2],
      ['fireproof', 1],
    ])
    const panel = createLoadoutPanel()
    panel.update(model)
    const row = panel.el.querySelector('[data-trait-id="softSteps"]')!
    expect(row.textContent).toContain('Soft Steps ×2')
    expect(row.textContent).toContain(TRAITS.softSteps.blurb)
    expect(panel.el.querySelector('[data-trait-id="fireproof"]')).not.toBeNull()
  })

  it('a co-op trait says it needs a teammate while solo, and not with one', () => {
    const p = playerWith(['taunt'])
    const panel = createLoadoutPanel()
    panel.update(buildLoadout(p, undefined, 1))
    expect(panel.el.querySelector('[data-trait-id="taunt"] .trait-verdict')!.textContent).toBe('needs a teammate')
    panel.update(buildLoadout(p, undefined, 2))
    expect(panel.el.querySelector('[data-trait-id="taunt"] .trait-verdict')).toBeNull()
  })

  it('no traits, no section; an unknown trait id is dropped, not drawn blank', () => {
    const p = playerWith([])
    const panel = createLoadoutPanel()
    panel.update(buildLoadout(p))
    expect(panel.el.textContent).not.toContain('You')
    p.playerCtl!.traits = [{ id: 'wings', stacks: 1 }]
    expect(buildLoadout(p)!.traits).toEqual([])
  })
})
