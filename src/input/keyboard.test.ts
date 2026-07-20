// @vitest-environment happy-dom
// The keyboard input source. The load-bearing assertion here is the AIM path:
// with a mouse-aim provider a keyboard player's shot follows the cursor to ANY
// angle, and WITHOUT one it falls back to the 8-way WASD movement vector (the
// historic reason keyboard fire was 8-directional). The sim already fires along
// the continuous aimX/aimY — this proves the keyboard now FEEDS it a continuous
// aim rather than a compass-quantized one.

import { afterEach, describe, expect, it } from 'vitest'
import { createKeyboard } from './keyboard'
import type { Aim } from './aim'

const press = (code: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }))
}
const release = (code: string): void => {
  window.dispatchEvent(new KeyboardEvent('keyup', { code }))
}

afterEach(() => {
  // Clear any keys still held between cases.
  for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
    release(c)
})

const aimDeg = (cmd: { aimX: number; aimY: number }): number =>
  ((Math.atan2(cmd.aimY, cmd.aimX) * 180) / Math.PI + 360) % 360

describe('keyboard aim', () => {
  it('WITHOUT a mouse provider, aim is the 8-way WASD vector (the legacy bug)', () => {
    const kb = createKeyboard()
    press('KeyD') // east only
    expect(aimDeg(kb.sample())).toBeCloseTo(0, 5)
    press('KeyS') // + south → exact 45° diagonal, no in-between possible
    expect(aimDeg(kb.sample())).toBeCloseTo(45, 5)
  })

  it('WITH a mouse provider, aim follows the cursor to an ARBITRARY angle', () => {
    // Cursor at 100,37 relative to the player → ~20.3°, not a 45° multiple.
    const provider = (): Aim => {
      const m = Math.hypot(100, 37)
      return { x: 100 / m, y: 37 / m }
    }
    const kb = createKeyboard(provider)
    press('KeyW') // moving NORTH, but the mouse must win the aim
    const cmd = kb.sample()
    expect(aimDeg(cmd)).toBeCloseTo(20.303, 2)
    expect(aimDeg(cmd)).not.toBeCloseTo(0, 1)
    expect(aimDeg(cmd)).not.toBeCloseTo(45, 1)
    expect(aimDeg(cmd)).not.toBeCloseTo(270, 1) // NOT the WASD north
  })

  it('a sweep of cursor angles yields correspondingly different, non-bucketed aims', () => {
    const got = [11, 33, 78, 122, 261].map((d) => {
      const r = (d * Math.PI) / 180
      const kb = createKeyboard((): Aim => ({ x: Math.cos(r), y: Math.sin(r) }))
      return aimDeg(kb.sample())
    })
    ;[11, 33, 78, 122, 261].forEach((want, i) => expect(got[i]).toBeCloseTo(want, 3))
  })

  it('falls back to the WASD move vector when the cursor sits on the player', () => {
    const kb = createKeyboard((): Aim => ({ x: 0, y: 0 })) // pointer on player
    press('KeyA') // west
    expect(aimDeg(kb.sample())).toBeCloseTo(180, 5)
  })

  it('a null provider (no mouse yet) is exactly the legacy movement fallback', () => {
    const kb = createKeyboard(() => null)
    press('KeyW')
    expect(aimDeg(kb.sample())).toBeCloseTo(270, 5) // north = -90° = 270°
  })
})
