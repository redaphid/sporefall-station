// The touch-controls show/hide policy: last actor wins, pad wins ties.
// Exhaustive over the capability × pad-joined × pad-active × touch matrix,
// plus the couch handover, flapping pads, multiple pads, and idle-at-boot pads.

import { describe, expect, it } from 'vitest'
import type { CoopDebugPad } from './gamepadCoop'
import type { PadState } from './readPad'
import {
  anyPadProducing,
  detectTouchCaps,
  initialVisibility,
  padStateActive,
  stepVisibility,
  sticksVisible,
  type StickVisibilityState,
  type TouchCaps,
  type VisibilityFrame,
} from './stickVisibility'

const PHONE: TouchCaps = { touchCapable: true, coarsePrimary: true }
const TOUCH_LAPTOP: TouchCaps = { touchCapable: true, coarsePrimary: false }
const DESKTOP: TouchCaps = { touchCapable: false, coarsePrimary: false }

const idle: PadState = {
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  attack: false,
  interact: false,
  special: false,
  roll: false,
  pause: false,
  throwItem: false,
  hotbarPrev: false,
  hotbarNext: false,
}

const pad = (slot: number | null, state: Partial<PadState> = {}): CoopDebugPad => ({
  padIndex: 0,
  id: 'Test Pad (STANDARD GAMEPAD)',
  slot,
  state: { ...idle, ...state },
})

const quiet: VisibilityFrame = { padJoined: false, padActivity: false, touchActivity: false }

/** Run a sequence of frames from boot; return the final state. */
const run = (frames: VisibilityFrame[]): StickVisibilityState =>
  frames.reduce(stepVisibility, initialVisibility())

describe('capability gate', () => {
  it('no touch capability → never visible, whatever happens', () => {
    const frames: VisibilityFrame[] = [
      quiet,
      { padJoined: true, padActivity: true, touchActivity: false },
      { padJoined: true, padActivity: false, touchActivity: true },
      { padJoined: false, padActivity: false, touchActivity: true },
    ]
    let s = initialVisibility()
    for (const f of frames) {
      s = stepVisibility(s, f)
      expect(sticksVisible(s, DESKTOP)).toBe(false)
    }
  })

  it('phone boot default: visible before anyone does anything', () => {
    expect(sticksVisible(initialVisibility(), PHONE)).toBe(true)
  })

  it('touchscreen laptop boot default: hidden until a finger actually touches', () => {
    expect(sticksVisible(initialVisibility(), TOUCH_LAPTOP)).toBe(false)
    const s = run([{ ...quiet, touchActivity: true }])
    expect(sticksVisible(s, TOUCH_LAPTOP)).toBe(true)
  })
})

describe('pad takeover and couch handover', () => {
  it('a joined pad producing input hides the sticks', () => {
    const s = run([{ padJoined: true, padActivity: true, touchActivity: false }])
    expect(sticksVisible(s, PHONE)).toBe(false)
  })

  it('a pad joined at some point but now idle keeps them hidden (no flicker)', () => {
    const s = run([
      { padJoined: true, padActivity: true, touchActivity: false },
      { padJoined: true, padActivity: false, touchActivity: false },
      { padJoined: true, padActivity: false, touchActivity: false },
    ])
    expect(sticksVisible(s, PHONE)).toBe(false)
  })

  it('touching the screen re-shows them even while the pad stays joined', () => {
    const s = run([
      { padJoined: true, padActivity: true, touchActivity: false },
      { padJoined: true, padActivity: false, touchActivity: true },
    ])
    expect(sticksVisible(s, PHONE)).toBe(true)
  })

  it('…until the pad NEXT produces input, which hides them again', () => {
    const s = run([
      { padJoined: true, padActivity: true, touchActivity: false },
      { padJoined: true, padActivity: false, touchActivity: true },
      { padJoined: true, padActivity: true, touchActivity: false },
    ])
    expect(sticksVisible(s, PHONE)).toBe(false)
  })

  it('pad wins a same-frame tie (stray palm during a pad fight)', () => {
    const s = run([{ padJoined: true, padActivity: true, touchActivity: true }])
    expect(sticksVisible(s, PHONE)).toBe(false)
  })

  it('touch keeps them visible through repeated touches, no pad', () => {
    const s = run([
      { ...quiet, touchActivity: true },
      quiet,
      { ...quiet, touchActivity: true },
    ])
    expect(sticksVisible(s, PHONE)).toBe(true)
  })
})

describe('disconnects and flapping pads', () => {
  it('the hiding pad unplugging restores the boot default (phone: visible)', () => {
    const s = run([
      { padJoined: true, padActivity: true, touchActivity: false },
      quiet, // pad gone, nothing joined
    ])
    expect(s.lastActor).toBe(null)
    expect(sticksVisible(s, PHONE)).toBe(true)
    expect(sticksVisible(s, TOUCH_LAPTOP)).toBe(false) // laptop stays bare
  })

  it('a flapping pad (join→unplug→rejoin idle→input) tracks each transition', () => {
    let s = initialVisibility()
    s = stepVisibility(s, { padJoined: true, padActivity: true, touchActivity: false })
    expect(sticksVisible(s, PHONE)).toBe(false)
    s = stepVisibility(s, quiet) // unplugged
    expect(sticksVisible(s, PHONE)).toBe(true)
    s = stepVisibility(s, { padJoined: true, padActivity: true, touchActivity: false }) // rejoin press
    expect(sticksVisible(s, PHONE)).toBe(false)
  })

  it('unplugging does NOT override a touch claim (touch stays the last actor)', () => {
    const s = run([
      { padJoined: true, padActivity: true, touchActivity: false },
      { padJoined: true, padActivity: false, touchActivity: true },
      quiet, // pad unplugs after the touch handover
    ])
    expect(s.lastActor).toBe('touch')
    expect(sticksVisible(s, PHONE)).toBe(true)
  })

  it('one pad unplugging while another stays joined keeps them hidden', () => {
    const s = run([
      { padJoined: true, padActivity: true, touchActivity: false },
      { padJoined: true, padActivity: false, touchActivity: false }, // other pad still holds a slot
    ])
    expect(sticksVisible(s, PHONE)).toBe(false)
  })
})

describe('anyPadProducing / padStateActive — what counts as "in use"', () => {
  it('no pads → false', () => {
    expect(anyPadProducing([])).toBe(false)
  })

  it('a pad connected at boot but never joined, even mashing buttons → false', () => {
    expect(anyPadProducing([pad(null, { attack: true, moveX: 1 })])).toBe(false)
  })

  it('a joined pad at rest → false (idle in a slot is not "in use")', () => {
    expect(anyPadProducing([pad(0)])).toBe(false)
  })

  it('a joined pad with a deflected stick or any held button → true', () => {
    expect(anyPadProducing([pad(0, { moveY: -0.7 })])).toBe(true)
    expect(anyPadProducing([pad(0, { attack: true })])).toBe(true)
    expect(anyPadProducing([pad(0, { hotbarNext: true })])).toBe(true)
  })

  it('multiple pads: one idle joined + one producing unjoined → false; producing joined → true', () => {
    expect(anyPadProducing([pad(0), pad(null, { moveX: 1 })])).toBe(false)
    expect(anyPadProducing([pad(0), { ...pad(1, { aimX: 0.9 }), padIndex: 1 }])).toBe(true)
  })

  it('padStateActive covers every field of PadState — a new field cannot be silently ignored', () => {
    expect(padStateActive(idle)).toBe(false)
    for (const key of Object.keys(idle) as (keyof PadState)[]) {
      const s = { ...idle, [key]: typeof idle[key] === 'number' ? 1 : true }
      expect(padStateActive(s), `field ${key} should count as activity`).toBe(true)
    }
  })
})

describe('detectTouchCaps — capability detection, no UA sniffing', () => {
  it('desktop: no touch points, fine pointer', () => {
    expect(detectTouchCaps({ maxTouchPoints: 0 }, () => ({ matches: false }))).toEqual({
      touchCapable: false,
      coarsePrimary: false,
    })
  })

  it('phone: touch points + coarse primary pointer', () => {
    const mm = (q: string) => ({ matches: q === '(pointer: coarse)' })
    expect(detectTouchCaps({ maxTouchPoints: 5 }, mm)).toEqual({ touchCapable: true, coarsePrimary: true })
  })

  it('touchscreen laptop: touch points but fine primary pointer', () => {
    expect(detectTouchCaps({ maxTouchPoints: 10 }, () => ({ matches: false }))).toEqual({
      touchCapable: true,
      coarsePrimary: false,
    })
  })

  it('no matchMedia available → coarsePrimary safely false', () => {
    expect(detectTouchCaps({ maxTouchPoints: 5 })).toEqual({ touchCapable: true, coarsePrimary: false })
  })
})
