// @vitest-environment happy-dom
// Reordering a wand with only a controller: the pause menu's sequence strip is
// walked with the d-pad and tapped with a face button, two taps swap, and the
// swap goes out through the same callback a finger tap uses. Start never taps
// a chip: it is the button that resumes the run.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { arm } from '../game/testkit'
import { createWorld } from '../game/world'
import type { PadLike } from './gamepadMenu'
import { buildSequence } from './sequenceModel'
import { createSequenceStrip, installStripPadNav } from './sequenceStrip'

const A = 0
const B = 1
const START = 9
const RIGHT = 15
const LEFT = 14

const pad = (down: number[]): PadLike => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })), axes: [0, 0, 0, 0] })

const tech = (mods: WeaponMod[]) => {
  const p = spawnPlayer(createWorld(3, 1), 0, 10.5, 10.5)
  p.loadout!.inventory = []
  arm(p, 'pistol').mods = mods
  return p
}

describe('reordering the pause strip with only a controller', () => {
  let pads: (PadLike | null)[] = [null]
  let frame: (() => void) | null = null
  const origPads = navigator.getGamepads
  const origOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

  beforeEach(() => {
    pads = [null]
    ;(navigator as unknown as { getGamepads: () => (PadLike | null)[] }).getGamepads = () => pads
    // happy-dom lays nothing out; a chip in the document counts as on screen.
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentElement } })
  })
  afterEach(() => {
    ;(navigator as unknown as { getGamepads?: typeof origPads }).getGamepads = origPads
    if (origOffsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', origOffsetParent)
  })

  const rig = () => {
    document.body.innerHTML = ''
    const swaps: [number, number][] = []
    const strip = createSequenceStrip((a, b) => swaps.push([a, b]))
    document.body.appendChild(strip.el)
    strip.update(buildSequence(tech([{ id: 'frost', stacks: 1 }, { id: 'heavy', stacks: 1 }, { id: 'shock', stacks: 1 }]), 0))
    let hidden = true
    const teardown = installStripPadNav(strip, () => hidden, {
      schedule: (cb) => {
        frame = cb
        return 1
      },
      cancel: () => {
        frame = null
      },
    })
    const step = (down: number[]): void => {
      pads[0] = pad(down)
      const cb = frame
      frame = null
      cb?.()
    }
    /** Press and release, one frame each. */
    const press = (button: number): void => {
      step([button])
      step([])
    }
    return { strip, swaps, teardown, step, press, show: () => (hidden = false) }
  }

  it('d-pad to a chip, A, d-pad to another, A: the two chips swap', () => {
    const { swaps, teardown, step, press, show } = rig()
    step([])
    show()
    step([]) // the menu opens: the cursor lands on the first chip
    press(RIGHT)
    press(A) // pick chip 1
    press(RIGHT)
    press(A) // tap chip 2: swap
    expect(swaps).toEqual([[1, 2]])
    teardown()
  })

  it('any face button taps, and the stick-left wraps from the first chip to the last', () => {
    const { swaps, teardown, step, press, show } = rig()
    show()
    step([])
    press(B) // pick chip 0
    press(LEFT) // wrap to chip 2
    press(3) // Y taps: swap
    expect(swaps).toEqual([[0, 2]])
    teardown()
  })

  it('tapping the picked chip again cancels, so no swap goes out', () => {
    const { swaps, teardown, step, press, show } = rig()
    show()
    step([])
    press(A)
    press(A)
    expect(swaps).toEqual([])
    teardown()
  })

  it('Start never taps a chip, and the Start that opened the menu cannot either', () => {
    const { swaps, strip, teardown, step, press, show } = rig()
    step([START]) // Start is held as the pause menu opens
    show()
    step([START])
    step([])
    press(START)
    press(RIGHT)
    press(START)
    expect(swaps).toEqual([])
    expect(strip.el.querySelector('div')!.textContent).not.toContain('tap another')
    teardown()
  })

  it('a hidden strip ignores the pad entirely', () => {
    const { swaps, teardown, press } = rig()
    press(A)
    press(RIGHT)
    press(A)
    expect(swaps).toEqual([])
    teardown()
  })
})
