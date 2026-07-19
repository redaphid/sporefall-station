// @vitest-environment happy-dom
// Adversarial cases for hiding the touch controls (setVisible): a controller
// takes over WHILE a finger is mid-drag on a stick or mid-pinch — the in-flight
// gesture must release cleanly (no stuck movement, no phantom pinch), and the
// hidden wrapper must be hit-test-inert so taps flow to the canvas beneath.

import { beforeEach, describe, expect, it } from 'vitest'
import { createTouch, type TouchInput } from './touch'
import type { ZoomSink } from '../render/zoomModel'

const PE = (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent

const mount = (): HTMLElement => {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const wrapper = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('[data-role="touch-controls"]')!

const zone = (root: HTMLElement, side: 'left' | 'right'): HTMLElement => {
  const z = [...root.querySelectorAll<HTMLElement>('div')].find(
    (d) => d.style.width === '50%' && d.style[side] === '0px',
  )!
  z.setPointerCapture = () => {}
  z.releasePointerCapture = () => {}
  return z
}

const down = (el: HTMLElement, id: number, x: number, y: number): void => {
  el.dispatchEvent(new PE('pointerdown', { pointerId: id, clientX: x, clientY: y }))
}
const move = (el: HTMLElement, id: number, x: number, y: number): void => {
  el.dispatchEvent(new PE('pointermove', { pointerId: id, clientX: x, clientY: y }))
}

describe('setVisible — the wrapper', () => {
  let root: HTMLElement
  let touch: TouchInput
  beforeEach(() => {
    root = mount()
    touch = createTouch(root)
  })

  it('is tagged data-role=touch-controls and starts visible', () => {
    expect(wrapper(root).style.display).not.toBe('none')
  })

  it('hides to display:none (hit-test-inert) and comes back', () => {
    touch.setVisible(false)
    expect(wrapper(root).style.display).toBe('none')
    touch.setVisible(true)
    expect(wrapper(root).style.display).toBe('block')
  })
})

describe('adversarial: pad activates mid-drag', () => {
  let root: HTMLElement
  let touch: TouchInput
  beforeEach(() => {
    root = mount()
    touch = createTouch(root)
  })

  it('a finger dragging the move stick when the controls hide → movement zeroes, nothing sticks', () => {
    const z = zone(root, 'left')
    down(z, 1, 100, 100)
    move(z, 1, 160, 100) // full-deflection drag
    expect(touch.sample().moveX).toBeGreaterThan(0.9)

    touch.setVisible(false) // controller takeover mid-drag
    const cmd = touch.sample()
    expect(cmd.moveX).toBe(0)
    expect(cmd.moveY).toBe(0)

    // The still-down finger keeps moving; the dead claim must not resurrect.
    move(z, 1, 40, 100)
    expect(touch.sample().moveX).toBe(0)
  })

  it('a finger dragging the aim stick mid-fire when the controls hide → attack released', () => {
    const z = zone(root, 'right')
    down(z, 2, 300, 100)
    move(z, 2, 380, 100)
    expect(touch.sample().attack).toBe(true)
    touch.setVisible(false)
    const cmd = touch.sample()
    expect(cmd.attack).toBe(false)
    expect(cmd.aimX).toBe(0)
  })

  it('stick art (base + nub) is hidden with the cancelled claim', () => {
    const z = zone(root, 'left')
    down(z, 1, 100, 100)
    const art = [...root.querySelectorAll<HTMLElement>('div')].filter((d) => d.style.borderRadius === '50%' && d.style.display === 'block')
    expect(art.length).toBeGreaterThan(0)
    touch.setVisible(false)
    for (const a of art) expect(a.style.display).toBe('none')
  })

  it('after re-show, the SAME pointer id claims a fresh stick that works normally', () => {
    const z = zone(root, 'left')
    down(z, 1, 100, 100)
    touch.setVisible(false)
    touch.setVisible(true)
    down(z, 1, 200, 200) // browsers reuse pointer ids — must be a clean fresh claim
    move(z, 1, 200, 140)
    expect(touch.sample().moveY).toBeLessThan(-0.9)
  })

  it('an already-latched button edge still delivers once after hiding (the press was legit)', () => {
    const useBtn = [...root.querySelectorAll<HTMLElement>('div')].find((d) => d.textContent === 'USE')!
    useBtn.dispatchEvent(new PE('pointerdown', { pointerId: 3, clientX: 0, clientY: 0 }))
    touch.setVisible(false)
    expect(touch.sample().interact).toBe(true) // delivered
    expect(touch.sample().interact).toBe(false) // once
  })
})

describe('adversarial: pad activates mid-pinch (tracker reset)', () => {
  it('a half-tracked ghost finger never pairs into a phantom pinch after re-show', () => {
    const root = mount()
    let zoomSet = 0
    const sink: ZoomSink = { get: () => 1, set: () => void zoomSet++, reset: () => {} }
    const touch = createTouch(root, sink)
    const z = zone(root, 'left')

    // Finger 1 lands (fresh claim), controls hide before it lifts: its
    // pointerup will never arrive, leaving a ghost in the pinch tracker.
    down(z, 1, 100, 100)
    touch.setVisible(false)
    touch.setVisible(true)

    // A new finger on the same half must start a plain stick, NOT pinch with
    // the ghost of finger 1.
    down(z, 2, 140, 100)
    move(z, 2, 200, 100)
    expect(zoomSet).toBe(0)
    expect(touch.sample().moveX).toBeGreaterThan(0.9)
  })

  it('an ACTIVE pinch cut short by hiding does not keep zooming after re-show', () => {
    const root = mount()
    let zoomSet = 0
    const sink: ZoomSink = { get: () => 1, set: () => void zoomSet++, reset: () => {} }
    const touch = createTouch(root, sink)
    const z = zone(root, 'left')

    down(z, 1, 100, 100)
    down(z, 2, 140, 100) // same half, both fresh → pinch forms
    const wrapperEl = wrapper(root)
    wrapperEl.dispatchEvent(new PE('pointermove', { pointerId: 2, clientX: 200, clientY: 100 }))
    expect(zoomSet).toBeGreaterThan(0)
    const before = zoomSet

    touch.setVisible(false)
    touch.setVisible(true)
    // Old pinch fingers are forgotten: their moves change nothing.
    wrapperEl.dispatchEvent(new PE('pointermove', { pointerId: 2, clientX: 260, clientY: 100 }))
    expect(zoomSet).toBe(before)
    expect(touch.sample().moveX).toBe(0)
  })
})
