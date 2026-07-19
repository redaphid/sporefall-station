// @vitest-environment happy-dom
// The press-exempt UI-chrome layer: isUiChrome must recognise marked elements
// and everything inside them, and reject everything else — this predicate is
// what keeps a tap on the settings gear (or any future overlay) out of the
// stick/inspect press classification entirely.

import { beforeEach, describe, expect, it } from 'vitest'
import { isUiChrome, markUiChrome } from './chrome'

describe('ui chrome marking', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('markUiChrome stamps the data attribute', () => {
    const el = document.createElement('button')
    markUiChrome(el)
    expect(el.dataset.uiChrome).toBe('')
    expect(el.matches('[data-ui-chrome]')).toBe(true)
  })

  it('a marked element is chrome', () => {
    const el = document.createElement('button')
    markUiChrome(el)
    document.body.appendChild(el)
    expect(isUiChrome(el)).toBe(true)
  })

  it('a deep descendant of a marked element is chrome — a tap on a label inside a panel is still the panel', () => {
    const panel = document.createElement('div')
    markUiChrome(panel)
    const row = document.createElement('label')
    const input = document.createElement('input')
    row.appendChild(input)
    panel.appendChild(row)
    document.body.appendChild(panel)
    expect(isUiChrome(input)).toBe(true)
  })

  it('an unmarked element is NOT chrome — play-space presses keep classifying', () => {
    const zone = document.createElement('div')
    zone.dataset.stickZone = 'left'
    document.body.appendChild(zone)
    expect(isUiChrome(zone)).toBe(false)
  })

  it('a sibling of chrome is not chrome (no accidental bleed)', () => {
    const gear = document.createElement('button')
    markUiChrome(gear)
    const canvasish = document.createElement('div')
    document.body.append(gear, canvasish)
    expect(isUiChrome(canvasish)).toBe(false)
  })

  it('degenerate targets: null / document / window never throw and are not chrome', () => {
    expect(isUiChrome(null)).toBe(false)
    expect(isUiChrome(document)).toBe(false)
    expect(isUiChrome(window)).toBe(false)
  })
})
