// @vitest-environment happy-dom
// A guest whose host leaves while it lies dead, or after the run is over, must
// still get the HOST LEFT menu: the death screen beneath only offers "Waiting
// for the host…", which would wait forever.

import { afterEach, describe, expect, it } from 'vitest'
import type { RenderView } from '../app/session'
import { HostSession } from '../app/hostSession'
import { emptyInput } from '../game/types'
import { createGamepadCoop } from '../input/gamepadCoop'
import { createPauseOverlay } from './pauseOverlay'

afterEach(() => {
  document.body.innerHTML = ''
})

/** A view of a run, optionally with the local player dead or the run over. */
const viewOf = (state: 'alive' | 'dead' | 'gameOver'): RenderView => {
  const session = new HostSession(18, { sample: () => emptyInput() }, createGamepadCoop(() => []))
  if (state === 'dead') session.self.dead = true
  const view = session.renderView()
  return state === 'gameOver' ? { ...view, gameOver: true } : view
}

const overlayWith = (sessionOver?: () => boolean) => {
  const overlay = createPauseOverlay(document.body, {
    onResume: () => {},
    onMainMenu: () => {},
    title: () => 'HOST LEFT',
    ...(sessionOver ? { sessionOver } : {}),
  })
  const el = document.querySelector<HTMLElement>('[data-role="pause-title"]')!.parentElement!
  return { overlay, el }
}

describe('pause overlay when the session is over', () => {
  it.each(['dead', 'gameOver'] as const)('shows over the %s screen, opaque, with its title', (state) => {
    const { overlay, el } = overlayWith(() => true)
    overlay.update(true, viewOf(state))
    expect(el.style.display).toBe('flex')
    expect(el.querySelector('[data-role="pause-title"]')!.textContent).toBe('HOST LEFT')
    expect(el.style.background).not.toBe('rgba(0, 0, 0, 0.6)')
  })

  it.each(['dead', 'gameOver'] as const)('a live session keeps the old rule: never over the %s screen', (state) => {
    for (const sessionOver of [() => false, undefined]) {
      document.body.innerHTML = ''
      const { overlay, el } = overlayWith(sessionOver)
      overlay.update(true, viewOf(state))
      expect(el.style.display).toBe('none')
    }
  })

  it('an alive player in a live session gets the translucent menu as before', () => {
    const { overlay, el } = overlayWith(() => false)
    overlay.update(true, viewOf('alive'))
    expect(el.style.display).toBe('flex')
    const translucent = el.style.background
    document.body.innerHTML = ''
    const over = overlayWith(() => true)
    over.overlay.update(true, viewOf('alive'))
    expect(over.el.style.background).not.toBe(translucent)
  })
})
