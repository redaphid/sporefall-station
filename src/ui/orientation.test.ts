// @vitest-environment happy-dom
//
// Landscape-always: the rotation decision, the coordinate mapping, and — the
// part that matters — proof that INPUT rotates with the view.
//
// THE BUG THIS FILE EXISTS TO CATCH: if the stage rotates and the input mapping
// does not, every control is 90° out (press left, go up). It looks perfect on a
// desktop, which is never rotated, and is broken on every phone. So the last
// describe block drives REAL pointer events through the REAL touch controls and
// asserts on the sampled InputCmd, with the unrotated case asserted alongside as
// the contrast: the same physical swipe must mean different things, or nothing
// rotated at all.

import { describe, expect, it, vi } from 'vitest'
import {
  canLockOrientation,
  clientToStage,
  currentRotation,
  installStage,
  lockLandscape,
  pickRotation,
  safeAreaVar,
  safeAreaVars,
  stageSize,
  stageTransform,
  toStage,
  type StageRotation,
} from './orientation'
import { createTouch } from '../input/touch'

/** A window stand-in with a fixed viewport and inert listener plumbing. */
const fakeWin = (vw: number, vh: number): Window =>
  ({
    innerWidth: vw,
    innerHeight: vh,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as Window

/** Install the ambient stage at a given viewport; returns the stage element. */
const stageAt = (vw: number, vh: number, coarsePrimary = true): HTMLElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  installStage(el, { coarsePrimary }, fakeWin(vw, vh))
  return el
}

describe('pickRotation — when the game turns itself sideways', () => {
  it('rotates a coarse-pointer device that is presenting portrait', () => {
    expect(pickRotation({ vw: 400, vh: 800, coarsePrimary: true })).toBe(90)
  })

  it('leaves a phone already in landscape alone — the lock and the fallback compose', () => {
    expect(pickRotation({ vw: 800, vh: 400, coarsePrimary: true })).toBe(0)
  })

  it('treats square as landscape enough — never rotate for a 1px difference', () => {
    expect(pickRotation({ vw: 600, vh: 600, coarsePrimary: true })).toBe(0)
  })

  it('NEVER rotates a fine-pointer device: a tall desktop window is not a phone', () => {
    expect(pickRotation({ vw: 400, vh: 800, coarsePrimary: false })).toBe(0)
    expect(pickRotation({ vw: 1, vh: 4000, coarsePrimary: false })).toBe(0)
  })

  it('degenerate viewports do not throw or rotate', () => {
    expect(pickRotation({ vw: 0, vh: 0, coarsePrimary: true })).toBe(0)
  })
})

describe('stage geometry', () => {
  it('swaps the box when rotated so a landscape stage fills a portrait screen', () => {
    expect(stageSize(400, 800, 90)).toEqual({ w: 800, h: 400 })
    expect(stageSize(400, 800, 0)).toEqual({ w: 400, h: 800 })
  })

  it('translates the rotated box back over the viewport', () => {
    // rotate(90deg) maps local (x,y) → (-y,x), putting the box off-screen left;
    // the translate by vw brings it back.
    expect(stageTransform(400, 90)).toBe('translate(400px, 0px) rotate(90deg)')
    expect(stageTransform(400, 0)).toBe('none')
  })

  it('installStage applies the swapped box and transform to the element', () => {
    const el = stageAt(400, 800)
    expect(el.style.width).toBe('800px')
    expect(el.style.height).toBe('400px')
    expect(el.style.transform).toBe('translate(400px, 0px) rotate(90deg)')
    expect(currentRotation()).toBe(90)
  })

  it('installStage leaves a landscape viewport untransformed', () => {
    const el = stageAt(800, 400)
    expect(el.style.width).toBe('800px')
    expect(el.style.height).toBe('400px')
    expect(el.style.transform).toBe('none')
    expect(currentRotation()).toBe(0)
  })

  it('onChange fires when the rotation flips, so the renderer can re-measure', () => {
    const el = document.createElement('div')
    const win = { innerWidth: 800, innerHeight: 400, addEventListener: () => {}, removeEventListener: () => {} }
    const stage = installStage(el, { coarsePrimary: true }, win as unknown as Window)
    const onChange = vi.fn()
    stage.onChange = onChange
    win.innerWidth = 400
    win.innerHeight = 800
    stage.refresh()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(el.style.transform).toBe('translate(400px, 0px) rotate(90deg)')
    // Re-running with nothing changed must not churn the renderer every frame.
    stage.refresh()
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('clientToStage — the one conversion the whole input layer funnels through', () => {
  it('is the identity when the stage is not rotated', () => {
    expect(clientToStage(123, 456, 400, 0)).toEqual({ x: 123, y: 456 })
  })

  it('maps each viewport corner onto the right stage corner (400x800 portrait)', () => {
    const at = (cx: number, cy: number): { x: number; y: number } => clientToStage(cx, cy, 400, 90)
    // The stage is 800x400. Turning the phone counter-clockwise puts the
    // viewport's top-RIGHT corner under the player's top-left.
    expect(at(400, 0)).toEqual({ x: 0, y: 0 }) // viewport top-right  → stage top-left
    expect(at(400, 800)).toEqual({ x: 800, y: 0 }) // viewport bottom-right → stage top-right
    expect(at(0, 800)).toEqual({ x: 800, y: 400 }) // viewport bottom-left → stage bottom-right
    expect(at(0, 0)).toEqual({ x: 0, y: 400 }) // viewport top-left  → stage bottom-left
  })

  it('never maps a point inside the viewport to one outside the stage box', () => {
    const vw = 400
    const vh = 800
    const { w, h } = stageSize(vw, vh, 90)
    for (let cx = 0; cx <= vw; cx += 40)
      for (let cy = 0; cy <= vh; cy += 40) {
        const p = clientToStage(cx, cy, vw, 90)
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(w)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(h)
      }
  })

  it('the ambient toStage() follows the installed stage', () => {
    stageAt(800, 400)
    expect(toStage(10, 20)).toEqual({ x: 10, y: 20 }) // unrotated → identity
    stageAt(400, 800)
    expect(toStage(10, 20)).toEqual({ x: 20, y: 390 })
  })
})

describe('safe-area insets follow the rotation', () => {
  it('is a straight pass-through when unrotated', () => {
    expect(safeAreaVars(0)).toEqual({
      '--sf-safe-top': 'env(safe-area-inset-top, 0px)',
      '--sf-safe-right': 'env(safe-area-inset-right, 0px)',
      '--sf-safe-bottom': 'env(safe-area-inset-bottom, 0px)',
      '--sf-safe-left': 'env(safe-area-inset-left, 0px)',
    })
  })

  it('re-points each stage edge at the physical edge it now occupies', () => {
    // Rotated, the game's "top" is the phone's RIGHT edge — so a HUD anchored to
    // the stage top must dodge the inset on the right, not the notch above it.
    expect(safeAreaVars(90)).toEqual({
      '--sf-safe-top': 'env(safe-area-inset-right, 0px)',
      '--sf-safe-right': 'env(safe-area-inset-bottom, 0px)',
      '--sf-safe-bottom': 'env(safe-area-inset-left, 0px)',
      '--sf-safe-left': 'env(safe-area-inset-top, 0px)',
    })
  })

  it('the mapping is a rotation, not a reshuffle: every physical edge used once', () => {
    for (const rot of [0, 90] as StageRotation[]) {
      const used = Object.values(safeAreaVars(rot))
      expect(new Set(used).size).toBe(4)
    }
  })

  it('installStage publishes the vars onto the element', () => {
    const el = stageAt(400, 800)
    expect(el.style.getPropertyValue(safeAreaVar('top'))).toBe('env(safe-area-inset-right, 0px)')
  })
})

describe('orientation lock capability', () => {
  it('is false on iOS Safari, which exposes screen.orientation but no lock()', () => {
    // Safari 16.4 shipped type/angle/onchange and deliberately not lock — this
    // is precisely why the render-rotation fallback is mandatory, not defensive.
    expect(canLockOrientation({ type: 'portrait-primary' })).toBe(false)
  })

  it('is false when there is no ScreenOrientation at all', () => {
    expect(canLockOrientation(undefined)).toBe(false)
  })

  it('is true where lock() exists (Android Chrome)', () => {
    expect(canLockOrientation({ lock: async () => {} })).toBe(true)
  })

  it('asks for landscape when it can', () => {
    const lock = vi.fn(async () => {})
    lockLandscape({ lock })
    expect(lock).toHaveBeenCalledWith('landscape')
  })

  it('a refused lock never throws — the rotation fallback is standing by', () => {
    expect(() => lockLandscape({ lock: () => Promise.reject(new Error('not fullscreen')) })).not.toThrow()
    expect(() => lockLandscape(undefined)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('THE TRAP: input mapping rotates with the view', () => {
  /** Wire up real touch controls and hand back the left (move) stick zone. */
  const moveStick = (): { touch: ReturnType<typeof createTouch>; zone: HTMLElement } => {
    document.body.innerHTML = ''
    const root = document.createElement('div')
    document.body.appendChild(root)
    const touch = createTouch(root)
    const zone = [...root.querySelectorAll<HTMLElement>('div')].find(
      (z) => z.style.width === '50%' && z.style.left === '0px',
    )!
    zone.setPointerCapture = (): void => {}
    zone.releasePointerCapture = (): void => {}
    return { touch, zone }
  }

  const PE = (): typeof PointerEvent => (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent

  /** Drag from one VIEWPORT point to another and read the resulting move vector. */
  const drag = (from: [number, number], to: [number, number]): { moveX: number; moveY: number } => {
    const { touch, zone } = moveStick()
    const P = PE()
    zone.dispatchEvent(new P('pointerdown', { pointerId: 1, clientX: from[0], clientY: from[1] }))
    zone.dispatchEvent(new P('pointermove', { pointerId: 1, clientX: to[0], clientY: to[1] }))
    const cmd = touch.sample()
    return { moveX: Math.round(cmd.moveX), moveY: Math.round(cmd.moveY) }
  }

  it('UNROTATED: swiping toward larger clientX walks RIGHT (the baseline)', () => {
    stageAt(800, 400) // landscape viewport → no rotation
    expect(drag([200, 400], [300, 400])).toEqual({ moveX: 1, moveY: 0 })
  })

  it('ROTATED: the SAME physical swipe walks UP, because the screen turned under it', () => {
    stageAt(400, 800) // portrait viewport on a phone → rotated 90°
    // Turning the phone counter-clockwise puts the viewport's +X under the
    // player's "up". If input had NOT rotated this would still read moveX:1 —
    // which is the shipped-broken case this test exists to fail on.
    expect(drag([200, 400], [300, 400])).toEqual({ moveX: 0, moveY: -1 })
  })

  it('ROTATED: "press left" means dragging toward the phone\'s physical TOP', () => {
    stageAt(400, 800)
    // The stage's left edge sits at clientY 0. Decreasing clientY is game-left.
    expect(drag([200, 400], [200, 300])).toEqual({ moveX: -1, moveY: 0 })
  })

  it('ROTATED: all four game headings come out of the four physical swipes', () => {
    stageAt(400, 800)
    expect(drag([200, 400], [300, 400])).toEqual({ moveX: 0, moveY: -1 }) // +clientX → up
    expect(drag([200, 400], [100, 400])).toEqual({ moveX: 0, moveY: 1 }) // -clientX → down
    expect(drag([200, 400], [200, 500])).toEqual({ moveX: 1, moveY: 0 }) // +clientY → right
    expect(drag([200, 400], [200, 300])).toEqual({ moveX: -1, moveY: 0 }) // -clientY → left
  })

  it('ROTATED: the aim stick rotates too — aiming is not a separate code path', () => {
    stageAt(400, 800)
    document.body.innerHTML = ''
    const root = document.createElement('div')
    document.body.appendChild(root)
    const touch = createTouch(root)
    const aimZone = [...root.querySelectorAll<HTMLElement>('div')].find(
      (z) => z.style.width === '50%' && z.style.right === '0px',
    )!
    aimZone.setPointerCapture = (): void => {}
    const P = PE()
    aimZone.dispatchEvent(new P('pointerdown', { pointerId: 2, clientX: 200, clientY: 400 }))
    aimZone.dispatchEvent(new P('pointermove', { pointerId: 2, clientX: 300, clientY: 400 }))
    const cmd = touch.sample()
    expect(cmd.attack).toBe(true) // a deflected aim stick still fires
    expect(Math.round(cmd.aimX)).toBe(0)
    expect(Math.round(cmd.aimY)).toBe(-1) // aims UP, matching what the player sees
  })

  it('ROTATED: the stick art is drawn under the finger, in stage space', () => {
    stageAt(400, 800)
    const { zone } = moveStick()
    const P = PE()
    zone.dispatchEvent(new P('pointerdown', { pointerId: 3, clientX: 200, clientY: 400 }))
    // toStage(200,400) = (400, 200); the 110px base is centred on it (−55).
    const base = [...document.querySelectorAll<HTMLElement>('div')].find(
      (d) => d.style.width === '110px' && d.style.display === 'block',
    )!
    expect(base.style.left).toBe('345px')
    expect(base.style.top).toBe('145px')
  })
})
