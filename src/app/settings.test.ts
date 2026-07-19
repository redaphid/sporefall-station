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

  it('rejects an unknown shaderFx but keeps a valid one', () => {
    expect(clampSettings({ shaderFx: 'ludicrous' }).shaderFx).toBe(defaultSettings().shaderFx)
    expect(clampSettings({ shaderFx: 42 }).shaderFx).toBe(defaultSettings().shaderFx)
    expect(clampSettings({ shaderFx: 'off' }).shaderFx).toBe('off')
    expect(clampSettings({ shaderFx: 'reduced' }).shaderFx).toBe('reduced')
    expect(clampSettings({ shaderFx: 'full' }).shaderFx).toBe('full')
  })

  it('defaults shaderFx to full for legacy persisted blobs that predate it', () => {
    expect(clampSettings({ hapticsEnabled: false, effectsQuality: 'low' }).shaderFx).toBe('full')
  })

  it('round-trips a fully-valid object', () => {
    const s = {
      hapticsEnabled: false,
      hapticsIntensity: 0.5,
      effectsQuality: 'low' as const,
      shaderFx: 'reduced' as const,
      theme: 'swamp',
    }
    expect(clampSettings(s)).toEqual(s)
  })

  it('defaults theme to city', () => {
    expect(clampSettings({}).theme).toBe('city')
  })

  it('keeps a valid theme id and rejects invalid ones', () => {
    expect(clampSettings({ theme: 'swamp-2' }).theme).toBe('swamp-2')
    expect(clampSettings({ theme: 'Swamp' }).theme).toBe('city') // uppercase
    expect(clampSettings({ theme: '../etc' }).theme).toBe('city') // traversal
    expect(clampSettings({ theme: '' }).theme).toBe('city')
    expect(clampSettings({ theme: 'x'.repeat(65) }).theme).toBe('city')
    expect(clampSettings({ theme: 42 }).theme).toBe('city')
  })
})
