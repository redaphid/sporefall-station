// @vitest-environment happy-dom
// The run-over screen has a way back to the main menu, for a host and for a
// client alike, and it takes two presses like every run-ending button.

import { beforeEach, describe, expect, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import { emptyInput } from '../game/types'
import { createScreens } from './screens'

const gameOverView = () => ({ ...new HostSession(5, { sample: () => emptyInput() }).renderView(), gameOver: true })
const mainMenu = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('[data-role="gameover-main-menu"]')

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('run-over screen: Main menu', () => {
  it('a host gets it next to Run it back and New Seed; one press arms, the second quits', () => {
    let quits = 0
    const screens = createScreens(document.body, () => {}, undefined, () => {}, undefined, () => quits++)
    screens.update(gameOverView())
    const mm = mainMenu()!
    expect(mm.textContent).toBe('Main menu')
    mm.click()
    expect(quits).toBe(0)
    expect(mm.textContent).toBe('Quit to the menu? Press again')
    mm.click()
    expect(quits).toBe(1)
  })

  it('a client, who cannot restart, still has a way out', () => {
    let quits = 0
    const screens = createScreens(document.body, undefined, undefined, undefined, undefined, () => quits++)
    screens.update(gameOverView())
    const mm = mainMenu()!
    expect(mm.disabled).toBe(false)
    mm.click()
    mm.click()
    expect(quits).toBe(1)
  })

  it('a tap-armed Main menu does not carry over to the next time the screen comes up', () => {
    let quits = 0
    const screens = createScreens(document.body, () => {}, undefined, () => {}, undefined, () => quits++)
    screens.update(gameOverView())
    mainMenu()!.click() // a tap: armed, never focused, so never blurred
    expect(mainMenu()!.dataset.armed).toBe('')
    screens.update({ ...gameOverView(), gameOver: false }) // revived: the screen goes away
    screens.update(gameOverView()) // downed again later
    expect(mainMenu()!.textContent).toBe('Main menu')
    mainMenu()!.click()
    expect(quits).toBe(0)
  })

  it('a held Enter on it cannot quit', () => {
    const screens = createScreens(document.body, () => {}, undefined, () => {}, undefined, () => {})
    screens.update(gameOverView())
    const mm = mainMenu()!
    expect(mm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }))).toBe(false)
  })
})
