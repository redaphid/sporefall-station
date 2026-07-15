import { describe, expect, it } from 'vitest'
import { selectAim } from './aim'

describe('selectAim', () => {
  it('uses the aim stick when it is deflected past the deadzone', () => {
    const a = selectAim(1, 0, 0, -0.9)
    expect(a).toEqual({ x: 0, y: -0.9 })
  })

  it('ignores an aim stick still inside the deadzone', () => {
    const a = selectAim(1, 0, 0.05, 0.05)
    expect(a).toEqual({ x: 1, y: 0 })
  })

  it('falls back to the movement vector when there is no aim input', () => {
    const a = selectAim(-0.7, 0.3)
    expect(a).toEqual({ x: -0.7, y: 0.3 })
  })

  it('returns a centred (0,0) vector when neither stick is deflected', () => {
    const a = selectAim(0, 0)
    expect(a).toEqual({ x: 0, y: 0 })
  })
})
