import { describe, expect, it } from 'vitest'
import { clampSettings, defaultSettings } from './settings'

describe('clampSettings', () => {
  it('returns defaults for non-objects', () => {
    expect(clampSettings(null)).toEqual(defaultSettings())
    expect(clampSettings(undefined)).toEqual(defaultSettings())
    expect(clampSettings('nope')).toEqual(defaultSettings())
  })

  it('clamps intensity into 0..1', () => {
    expect(clampSettings({ hapticsIntensity: 5 }).hapticsIntensity).toBe(1)
    expect(clampSettings({ hapticsIntensity: -3 }).hapticsIntensity).toBe(0)
    expect(clampSettings({ hapticsIntensity: 0.42 }).hapticsIntensity).toBe(0.42)
  })

  it('falls back for a bad intensity and NaN', () => {
    expect(clampSettings({ hapticsIntensity: 'loud' }).hapticsIntensity).toBe(defaultSettings().hapticsIntensity)
    expect(clampSettings({ hapticsIntensity: NaN }).hapticsIntensity).toBe(defaultSettings().hapticsIntensity)
  })

  it('rejects an unknown effectsQuality but keeps a valid one', () => {
    expect(clampSettings({ effectsQuality: 'ultra' }).effectsQuality).toBe(defaultSettings().effectsQuality)
    expect(clampSettings({ effectsQuality: 'off' }).effectsQuality).toBe('off')
    expect(clampSettings({ effectsQuality: 'low' }).effectsQuality).toBe('low')
  })

  it('honours an explicit hapticsEnabled boolean', () => {
    expect(clampSettings({ hapticsEnabled: false }).hapticsEnabled).toBe(false)
    expect(clampSettings({ hapticsEnabled: 'yes' }).hapticsEnabled).toBe(true) // non-bool → default true
  })

  it('round-trips a fully-valid object', () => {
    const s = { hapticsEnabled: false, hapticsIntensity: 0.5, effectsQuality: 'low' as const }
    expect(clampSettings(s)).toEqual(s)
  })
})
