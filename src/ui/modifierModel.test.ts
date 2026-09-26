import { describe, expect, it } from 'vitest'
import { FLOOR_MODIFIER_KINDS } from '../game/floorModifiers'
import { modifierKey, modifierStripText, modifierToast } from './modifierModel'

describe('floor modifier strip', () => {
  it('is empty on a clean floor', () => {
    expect(modifierStripText(undefined, true)).toBe('')
    expect(modifierKey(3, undefined)).toBe('')
  })

  it('announces every kind in full, then shrinks to its name', () => {
    for (const kind of FLOOR_MODIFIER_KINDS) {
      const full = modifierStripText({ kind }, true)
      const short = modifierStripText({ kind }, false)
      expect(full.length).toBeGreaterThan(short.length)
      expect(full.startsWith(short.split(' · ')[0])).toBe(true)
    }
  })

  it('reads the tide and the hunt live once the announcement is over', () => {
    expect(modifierStripText({ kind: 'bogTide', flooded: true }, false)).toContain('TIDE IN')
    expect(modifierStripText({ kind: 'bogTide', flooded: false }, false)).toBe('🌊 BOG TIDE')
    expect(modifierStripText({ kind: 'hunted', huntIn: 12 }, false)).toBe('🐺 HUNTED · pack in 12s')
    expect(modifierStripText({ kind: 'hunted' }, false)).toBe('🐺 HUNTED · they have your scent')
  })

  it('re-announces on a new floor or a new modifier, not every frame', () => {
    expect(modifierKey(2, { kind: 'hunted', huntIn: 5 })).toBe(modifierKey(2, { kind: 'hunted', huntIn: 4 }))
    expect(modifierKey(2, { kind: 'hunted' })).not.toBe(modifierKey(3, { kind: 'hunted' }))
    expect(modifierKey(2, { kind: 'hunted' })).not.toBe(modifierKey(2, { kind: 'brownout' }))
  })

  it('toasts the rising tide and the hunters landing, nothing else', () => {
    expect(modifierToast({ type: 'tide', rising: true })).toBeDefined()
    expect(modifierToast({ type: 'tide', rising: false })).toBeUndefined()
    expect(modifierToast({ type: 'huntersArrive', groupId: 1, x: 0, y: 0, count: 3, targetId: 1 })).toBeDefined()
    expect(modifierToast({ type: 'floorModifier', kind: 'brownout' })).toBeUndefined()
  })
})
